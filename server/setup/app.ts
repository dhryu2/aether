/**
 * 첫 설정 전용 서버의 Express 앱. 진짜 서버(index.ts)와 달리 DB·세션·인증 게이트가 없다.
 * 열어 두는 길: health, setup/defaults, setup/pick-folder, setup/complete, providers(AI 준비 확인), 정적 화면.
 * 127.0.0.1에만 묶이므로 첫 설정은 이 컴퓨터에서만 한다. 그래서 폴더는 운영체제의 폴더 창으로 고른다.
 * 모든 요청에 Host 검사를, GET이 아닌 요청에 Origin 검사를 건다.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import { st } from "../i18n";
import { termsUrl } from "../../shared/terms";
import { providersRouter } from "../routes/providers";
import { createStaticAddon } from "../routes/static";
import { pickFolder, writeShortcut } from "./desktop";
import type { AppPaths } from "./paths";
import { defaultSaveDeps, saveSetup, type SaveDeps } from "./save";

export interface SetupAppOptions {
  paths: AppPaths;
  /** 실제로 듣는 포트(포트를 잡은 뒤에 정해지므로 함수로 받는다) */
  getPort: () => number;
  /** 저장 응답을 보낸 뒤 호출. 기본 process.exit(1) — 자동 실행 장치가 진짜 서버로 다시 띄운다. */
  exit?: (code: number) => void;
  distDir?: string;
  saveDeps?: SaveDeps;
  pickFolder?: (signal: AbortSignal) => Promise<string | null>;
  /** 안내 문구를 남길 곳. 기본 console.log */
  log?: (msg: string) => void;
}

export function createSetupApp(opts: SetupAppOptions): Express {
  const { paths, getPort } = opts;
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const log = opts.log ?? ((m: string) => console.log(m));
  const app = express();
  app.disable("x-powered-by");

  const addon = createStaticAddon({ enabled: true, autoBuild: false, distDir: opts.distDir });
  app.use(helmet(addon.helmetOptions()));

  // DNS 재바인딩과 다른 사이트의 요청을 막는다. 주소는 항상 127.0.0.1(또는 localhost)이어야 한다.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const port = getPort();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? "")) {
      res.status(403).json({ error: "forbidden_host" });
      return;
    }
    const safeMethod = req.method === "GET" || req.method === "HEAD";
    const originOk = hosts.some((h) => req.headers.origin === `http://${h}`);
    if (safeMethod ? (req.headers.origin !== undefined && !originOk) || req.headers["sec-fetch-site"] === "cross-site" : !originOk) {
      res.status(403).json({ error: "forbidden_origin" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: pkg.aetherReleaseVersion, serverVersion: pkg.version, auth: "off", setup: true });
  });

  app.get("/api/setup/defaults", (_req, res) => {
    res.json({ port: getPort(), dataDir: paths.defaultDataDir, projectRoot: os.homedir(), termsUrl: termsUrl((pkg as { aetherUpdateUrl?: string }).aetherUpdateUrl) });
  });

  let picking = false;
  app.post("/api/setup/pick-folder", async (_req, res) => {
    if (picking) {
      res.status(409).json({ error: "picker_failed" });
      return;
    }
    picking = true;
    // 화면을 닫거나 새로 고치면 남은 폴더 창도 닫는다.
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    try {
      res.json({ path: await (opts.pickFolder ?? pickFolder)(abort.signal) });
    } catch (err) {
      log(`폴더 창 실패: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "picker_failed" });
    } finally {
      picking = false;
    }
  });

  let saving = false; // 저장 중이거나 저장이 끝나 곧 종료될 때 true. 실패하면 되돌린다.
  app.post("/api/setup/complete", async (req, res) => {
    if (saving) {
      res.status(409).json({ error: "already_saving" });
      return;
    }
    saving = true;
    // finish는 응답을 다 보내야 오므로 저장 중 연결이 끊기면 오지 않는다. close는 어느 쪽이든 오지만 저장보다 먼저 올 수도 있어 미리 걸어 둔다.
    let closed = false;
    let saved = false;
    let exited = false;
    const finishUp = () => {
      if (!closed || !saved || exited) return;
      exited = true;
      log("설정을 저장했습니다. 서버를 종료합니다 — 자동 실행 장치가 있으면 진짜 서버로 다시 뜹니다. 없으면(수동 실행) 직접 다시 실행하세요.");
      exit(1);
    };
    res.once("close", () => { closed = true; finishUp(); });
    const r = await saveSetup(req.body, paths, getPort(), opts.saveDeps ?? defaultSaveDeps);
    if (!r.ok) {
      if (r.detail) log(`저장 실패: ${r.detail}`);
      saving = false;
      res.status(r.status).json({ error: r.error, ...(r.field ? { field: r.field } : {}) });
      return;
    }
    writeShortcut(paths.configDir, r.saved.port);
    saved = true;
    res.json({ ok: true, port: r.saved.port });
    finishUp();
  });

  app.use("/api/providers", providersRouter);
  app.use("/api/{*splat}", (_req, res) => {
    res.status(404).json({ error: st("routes.common.apiNotFound") });
  });

  addon.prepare();
  addon.mount(app);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    res.status(status && status >= 400 && status < 500 ? status : 500).json({ error: status && status < 500 ? "bad_request" : "internal" });
  });
  return app;
}
