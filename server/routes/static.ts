/**
 * 빌드된 프론트(web/dist) 선택 부가 — dist 경로, SPA 우회, 캐시, CSP.
 * 같은 프로세스·같은 포트에 선택 장착. 없거나 꺼져 있거나 깨져 있어도 API·SSE는 뜬다.
 * CORS와 SSE 비압축은 공통 문 정책이라 여기로 옮기지 않는다.
 * ⚠️ 반드시 API/SSE 라우터 + /api 404 가드 *뒤에* mount 할 것(가로채기 방지).
 * ⚠️ Express 5(path-to-regexp v8)는 app.get('*')이 부팅 시 throw → 네임드 와일드카드 /{*splat} 사용.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import type helmet from "helmet";
import { config } from "../config";
import { AGENT_EVENT_CONTRACT_VERSION } from "../../shared/agentEvent";
import { computeWebSourceHash, hasWebSource, type WebBuildInfo } from "../observability/webBuildHash";


export type StaticAddon = {
  helmetOptions(): Parameters<typeof helmet>[0];
  mount(app: Express): void;
  /** 서버 잠금을 잡은 뒤 listen 전에 한 번 부른다. 화면 빌드를 확인하고 필요하면 다시 만든다. */
  prepare(): void;
};

function defaultDistDir(): string {
  return config.webDist;
}

/** dist/build-info.json을 읽는다. 없거나 깨졌으면 null. */
export function readBuildInfo(dist: string): WebBuildInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dist, "build-info.json"), "utf8"));
    return typeof v?.contractVersion === "number" && typeof v?.sourceHash === "string" ? (v as WebBuildInfo) : null;
  } catch {
    return null;
  }
}

export type BuildVerdict = "ok" | "missing" | "contract" | "source";

/** 빌드 결과가 서버와 맞는지 판단한다. sourceHash는 소스가 있는 환경에서만 넘겨 비교한다. */
export function judgeBuild(info: WebBuildInfo | null, serverContract: number, currentSourceHash?: string): BuildVerdict {
  if (!info) return "missing";
  if (info.contractVersion !== serverContract) return "contract";
  if (currentSourceHash !== undefined && info.sourceHash !== currentSourceHash) return "source";
  return "ok";
}

/**
 * web/에서 vite build를 자식 프로세스로 돌린다(타입 검사 없음). launchd PATH에 기대지 않게 node로 vite bin을 직접 실행한다.
 * 같은 볼륨의 임시 폴더(web/.dist-build-<pid>)에 만든 뒤 성공했을 때만 dist와 맞바꿔, 쓰는 도중이나 실패 때 dist가 비지 않게 한다.
 * 실패 원문은 서버 로그에만 남기고, 돌려주는 error는 안내에 쓸 한 줄이다.
 */
export function runViteBuild(webDir: string): { ok: boolean; error?: string } {
  const bin = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(bin)) return { ok: false, error: "vite 실행 파일이 없습니다" };
  const tmp = path.join(webDir, `.dist-build-${process.pid}`);
  const dist = path.join(webDir, "dist");
  const old = path.join(webDir, `.dist-old-${process.pid}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    const r = spawnSync(process.execPath, [bin, "build", "--outDir", tmp, "--emptyOutDir"], { cwd: webDir, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) {
      const out = `${r.error?.message ?? ""}\n${r.stderr || ""}\n${r.stdout || ""}`.trim();
      console.error(`[aether] vite build 출력:\n${out}`);
      const line = out.split("\n").find((l) => /error/i.test(l) && !/^error during build/i.test(l.trim()))?.trim().slice(0, 200);
      return { ok: false, error: line || "화면 빌드 중 오류가 났습니다(서버 로그 참고)" };
    }
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
    try {
      fs.renameSync(tmp, dist);
    } catch (e) {
      if (fs.existsSync(old)) fs.renameSync(old, dist); // 맞바꾸기 실패 시 옛 dist 복구
      throw e;
    }
    fs.rmSync(old, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    console.error("[aether] 화면 빌드 교체 실패:", e);
    return { ok: false, error: "빌드 결과를 교체하지 못했습니다(서버 로그 참고)" };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const noticeHtml = (reason: string) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>화면이 서버보다 오래됐습니다</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6">` +
  `<h1 style="font-size:1.25rem">화면과 서버 버전이 맞지 않습니다</h1><p>${reason.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` +
  `<p><a href="/" style="display:inline-block;min-height:44px;line-height:44px;padding:0 1.25rem;border:1px solid currentColor;border-radius:8px;text-decoration:none">다시 불러오기</a></p></body></html>`;

export function createStaticAddon(opts?: {
  enabled?: boolean;
  distDir?: string;
  /** 켜질 때 화면을 자동 빌드할지. 기본은 config.webAutoBuild(운영일 때만 true). */
  autoBuild?: boolean;
  /** 빌드 실행 함수. 시험이 실제 vite 대신 주입한다. */
  runBuild?: (webDir: string) => { ok: boolean; error?: string };
  contractVersion?: number;
  /** 지금 제공할 화면 폴더(없으면 null). 기본은 enabled일 때의 distDir. */
  rootDir?: () => string | null;
}): StaticAddon {
  const enabled = opts?.enabled ?? config.serveStatic;
  const dist = opts?.distDir ?? defaultDistDir();
  /** 지금 제공할 화면 폴더. null이면 제공하지 않는다. 요청마다 불러 등록 변경이 재시작 없이 반영된다. */
  const rootDir = opts?.rootDir ?? (() => (enabled ? dist : null));
  const serverContract = opts?.contractVersion ?? AGENT_EVENT_CONTRACT_VERSION;
  const hasSourceAt = (d: string) => {
    const webDir = path.dirname(d);
    return hasWebSource(path.dirname(webDir)) && path.basename(d) === "dist" && path.basename(webDir) === "web";
  };
  let bootDir: string | null = null; // 부팅 때 확인한 화면 폴더
  let bootReason: string | null = null; // 부팅 때 빌드가 실패했거나 못 한 이유
  const autoBuild = opts?.autoBuild ?? config.webAutoBuild;

  // 서버 잠금을 잡은 뒤 listen 전에 한 번: 화면이 서버와 맞는지 보고, 안 맞으면(운영일 때만) 다시 빌드한다.
  // 어떤 실패도 부팅을 막지 않는다.
  function prepare(): void {
    const root = rootDir();
    if (!root) return;
    bootDir = root;
    const dist = root;
    const webDir = path.dirname(dist);
    const repoRoot = path.dirname(webDir);
    const hasSource = hasSourceAt(dist);
    try {
      const sourceHash = () => (hasSource ? computeWebSourceHash(repoRoot) : undefined);
      const verdict = judgeBuild(readBuildInfo(dist), serverContract, sourceHash());
      if (verdict === "ok") return;
      if (autoBuild && hasSource) {
        console.log(`[aether] 화면 빌드가 서버와 맞지 않아(${verdict}) 다시 빌드합니다`);
        const r = (opts?.runBuild ?? runViteBuild)(webDir);
        const after = judgeBuild(readBuildInfo(dist), serverContract, sourceHash());
        if (r.ok && after === "ok") console.log("[aether] 화면 빌드 완료");
        else {
          bootReason = r.ok ? `빌드 후에도 ${after} 불일치` : (r.error ?? "빌드 실패");
          console.error(`[aether] 화면 빌드 실패: ${bootReason}`);
        }
      } else if (verdict !== "missing") {
        bootReason = autoBuild ? "화면 소스가 없어 다시 빌드할 수 없습니다" : "자동 빌드가 꺼져 있어 다시 빌드하지 않았습니다";
        console.warn(`[aether] 화면 빌드가 서버와 맞지 않음(${verdict}) — ${bootReason}`);
      }
    } catch (e) {
      console.warn("[aether] 화면 빌드 확인을 건너뜁니다:", e);
    }
  }

  // 요청 때 판정: build-info 수정 시각이 같으면 다시 읽지 않는다. build-info가 없으면 막지 않는다.
  let cachedKey = "";
  let cachedBlock: string | null = null;
  function blockReason(dist: string): string | null {
    let mtime: number;
    try { mtime = fs.statSync(path.join(dist, "build-info.json")).mtimeMs; } catch { return null; }
    const key = `${dist}\0${mtime}`;
    if (key !== cachedKey) {
      cachedKey = key;
      const info = readBuildInfo(dist);
      cachedBlock = null;
      if (info && info.contractVersion < serverContract) {
        cachedBlock = `화면이 서버보다 오래됐습니다. ${(dist === bootDir ? bootReason : null) ?? "자동으로 다시 만들지 못했습니다."} (화면 ${info.contractVersion}, 서버 ${serverContract})`;
      } else if (info && info.contractVersion > serverContract) {
        // 화면만 새로 만들고 서버를 아직 다시 켜지 않은 상태 — 막지 않고 그대로 내보낸다(새 화면이 스스로 지킨다).
        console.warn(`[aether] 화면 계약(${info.contractVersion})이 서버(${serverContract})보다 높습니다 — 서버를 다시 켜야 합니다`);
      }
    }
    return cachedBlock;
  }

  function helmetOptions(): Parameters<typeof helmet>[0] {
    return {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'"], // SSE/fetch same-origin
          imgSrc: ["'self'", "data:"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          // helmet 기본값의 upgrade-insecure-requests 제거 — HTTP(tailnet) 서빙 시 에셋을 https로 강제업그레이드해
          // ERR_SSL_PROTOCOL_ERROR로 깨짐. HTTPS(tailscale serve) 환경에선 same-origin이라 불필요.
          upgradeInsecureRequests: null,
        },
      },
    };
  }

  function mount(app: Express): void {
    const root0 = rootDir();
    if (!root0) console.log("[aether] static 서빙 꺼짐 (화면 등록 없음 또는 AETHER_SERVE_STATIC=0)");
    else if (!fs.existsSync(path.join(root0, "index.html")) && !(autoBuild && hasSourceAt(root0))) {
      console.log(`[aether] web/dist 없음 → static 서빙 스킵 (${root0})`);
    } else console.log(`[aether] static 서빙 활성 (${root0})`);

    // 화면 계약이 서버와 다르면 옛 화면 대신 안내를 준다(HTML 경로만. 에셋·build-info.json은 그대로 나간다).
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path === "/api" || req.path.startsWith("/api/")) return next();
      if (req.path !== "/" && req.path !== "/index.html" && path.extname(req.path)) return next();
      const root = rootDir();
      if (!root) return next();
      const reason = blockReason(root);
      if (!reason) return next();
      res.status(503).setHeader("Cache-Control", "no-cache").type("html").send(noticeHtml(reason));
    });

    // 해시된 asset(/assets/*)만 immutable, 그 외(index.html 등)는 no-cache. express.static은 마지막 폴더 하나만 들고 있다가 바뀌면 새로 만든다.
    let staticDir = "";
    let staticHandler: express.RequestHandler | null = null;
    app.use((req, res, next) => {
      const root = rootDir();
      if (!root) return next();
      if (root !== staticDir || !staticHandler) {
        staticDir = root;
        staticHandler = express.static(root, {
          index: false,
          etag: true,
          lastModified: true,
          fallthrough: true,
          setHeaders: (r, p) => {
            const isAsset = p.includes(`${path.sep}assets${path.sep}`);
            r.setHeader("Cache-Control", isAsset ? "public, max-age=31536000, immutable" : "no-cache");
          },
        });
      }
      staticHandler(req, res, next);
    });

    // SPA 딥링크 fallback — GET 한정, /api/ 하위만 통과(앞선 404 가드가 처리), index.html은 캐시 고정 금지.
    // ⚠️ startsWith("/api")는 /apikeys 같은 정상 SPA 경로까지 과매칭 → 정확히 "/api" 또는 "/api/" 하위만.
    app.get("/{*splat}", (req, res, next) => {
      if (req.path === "/api" || req.path.startsWith("/api/")) return next();
      const root = rootDir();
      if (!root) return next();
      const indexHtml = path.join(root, "index.html");
      if (!fs.existsSync(indexHtml)) return next(); // 빌드가 실패해 화면이 없으면 API 쪽 처리로 넘긴다
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(indexHtml);
    });
  }

  return { helmetOptions, mount, prepare };
}
