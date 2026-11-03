/**
 * 플랫폼 경계 게이트 (Phase 9a · D1/D2/D12). 정적 검사 — 서버를 띄우지 않는다.
 *
 * provider 경계(`test:boundary`)와 섞지 않는다. 여기는 기능 본체 / 공통 HTTP 문 / 선택 부가 /
 * 외부 클라이언트 / 최외곽 조립의 의존 방향만 본다.
 *
 * 지키는 것:
 *   ① 기능 본체는 Express·static·web-push·VAPID·`web/`을 새로 import하지 않는다.
 *      지금 있는 결합은 잔여 목록으로만 통과한다. 목록에 없는 결합이 생기면 실패한다.
 *   ② `web/src`는 `server/`를 import하지 않는다.
 *   ③ 잔여 목록의 파일과 패턴은 아직 실재해야 한다. 이미 지워진 항목이 목록에 남으면 실패한다.
 *   ④ 일괄 `npm test`는 `phase2_smoke`를 돌리지 않는다(실제 `web/` 삭제).
 *
 * 잔여 목록은 단계를 지날 때마다 실제로 지운 항목만 뺀다. 목록에 남은 채 패턴이 사라지면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = path.resolve(SERVER_DIR, "..");
const WEB_SRC = path.join(REPO_DIR, "web", "src");

const SKIP_DIRS = ["node_modules", "test", "spikes", "data", "scripts", "codex/protocol"];

/** D1 기능 본체 — 세션·모델·기억·검색·스킬. 문·부가·조립은 여기 넣지 않는다. */
const CORE_DIR_PREFIXES = ["sessions", "providers", "memory", "search", "skill", "knowledge", "activity"];
const CORE_FILES = new Set(["types.ts", "config.ts"]);

/**
 * 9a 잔여 목록. 항목을 몰래 늘려 통과시키면 안 된다 — 새 결합은 여기 없이 실패해야 하고,
 * 여기 적힌 결합이 사라졌는데 목록만 남아 있으면 실패해야 한다(게이트가 헐거워지는 것 방지).
 */
const RESIDUE: { id: string; file: string; re: RegExp; why: string }[] = [
  { id: "index-push-route", file: "index.ts", re: /\/api\/push/, why: "조립부가 웹 푸시 구독 라우트를 공통 문에 붙인다" },
  { id: "jwt-audience-web", file: "auth/jwt.ts", re: /aether-web/, why: "토큰 청중이 웹 클라이언트 이름으로 박혀 있다" },
  { id: "locale-global", file: "i18n/index.ts", re: /let currentLocale/, why: "서버 언어가 전역 하나다" },
  { id: "assembly-express", file: "index.ts", re: /express\(\)/, why: "최외곽 조립이 한 Node 프로세스다" },
];

/** 기능 본체가 웹 푸시 채널 모듈을 import해도 되는 잔여 자리. 9c에서 비움. */
const CORE_PUSH_IMPORT_RESIDUE = new Set<string>();
/** 기능 본체가 VAPID·화면 경로 식별자를 가져도 되는 잔여 자리. 9d에서 비움. */
const CORE_VAPID_RESIDUE = new Set<string>();
/** notifyPush 호출이 남아 있는 본체 자리. 9c에서 비움. */
const CORE_NOTIFY_RESIDUE = new Set<string>();
/** buildPushNotification 정의·호출이 남아 있는 본체 자리. 9c에서 비움. */
const CORE_BUILD_PUSH_RESIDUE = new Set<string>();

const DECOY_REL = path.join("sessions", "_platform_boundary_decoy.ts");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  cond ? pass++ : fail++;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(SERVER_DIR, abs);
    if (SKIP_DIRS.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile() && abs.endsWith(".ts")) out.push(rel);
  }
  return out;
}

function walkWeb(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkWeb(abs, out);
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(path.relative(WEB_SRC, abs));
  }
  return out;
}

/** 소스의 정적·동적 import/export-from 구문 목록 → {specifier, typeOnly}. */
function importsFromSource(src: string): { spec: string; typeOnly: boolean }[] {
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ spec: m[3], typeOnly: !!m[1] });
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  for (let m = bare.exec(src); m; m = bare.exec(src)) out.push({ spec: m[1], typeOnly: false });
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = dynamic.exec(src); m; m = dynamic.exec(src)) out.push({ spec: m[1], typeOnly: false });
  const requireCall = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = requireCall.exec(src); m; m = requireCall.exec(src)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function absOf(rel: string): string {
  return path.resolve(SERVER_DIR, rel);
}

function read(rel: string): string {
  return fs.readFileSync(absOf(rel), "utf8");
}

function isCore(rel: string): boolean {
  if (CORE_FILES.has(rel)) return true;
  return CORE_DIR_PREFIXES.some((d) => rel === d || rel.startsWith(d + path.sep));
}

/** D2: 본체가 직접 가져오면 안 되는 패키지·경로. */
function isForbiddenPlatformSpec(spec: string): boolean {
  if (spec === "express" || spec === "web-push" || spec === "helmet") return true;
  const norm = spec.replace(/\\/g, "/");
  if (/(^|[./])routes\/static$/.test(norm)) return true;
  // `web-push`는 위에서 이미 걸렀다. 화면 트리(`web/`)만 본다.
  if (/(^|[./])web\//.test(norm) || /(^|[./])web$/.test(norm)) return true;
  return false;
}

function isPushChannelImport(spec: string): boolean {
  const norm = spec.replace(/\\/g, "/");
  return /(^|\/)push$/.test(norm);
}

function coreForbiddenImportOffenders(fileList: string[]): string[] {
  const out: string[] = [];
  for (const rel of fileList) {
    if (!isCore(rel)) continue;
    for (const im of importsFromSource(read(rel))) {
      if (im.typeOnly) continue;
      if (isForbiddenPlatformSpec(im.spec)) out.push(`${rel} → ${im.spec}`);
    }
  }
  return out;
}

function corePushImportOffenders(fileList: string[]): string[] {
  const out: string[] = [];
  for (const rel of fileList) {
    if (!isCore(rel)) continue;
    if (CORE_PUSH_IMPORT_RESIDUE.has(rel)) continue;
    for (const im of importsFromSource(read(rel))) {
      if (im.typeOnly) continue;
      if (isPushChannelImport(im.spec)) out.push(`${rel} → ${im.spec}`);
    }
  }
  return out;
}

const VAPID_RE = /\bwebDistDir\b|\bvapidPublic\b|\bvapidPrivate\b|\bvapidSubject\b/;

function coreVapidOffenders(fileList: string[]): string[] {
  return fileList.filter((rel) => isCore(rel) && !CORE_VAPID_RESIDUE.has(rel) && VAPID_RE.test(stripComments(read(rel))));
}

function coreNotifyOffenders(fileList: string[]): string[] {
  return fileList.filter((rel) => isCore(rel) && !CORE_NOTIFY_RESIDUE.has(rel) && /\bnotifyPush\b/.test(stripComments(read(rel))));
}

function coreBuildPushOffenders(fileList: string[]): string[] {
  return fileList.filter(
    (rel) => isCore(rel) && !CORE_BUILD_PUSH_RESIDUE.has(rel) && /\bbuildPushNotification\b/.test(stripComments(read(rel))),
  );
}

const decoyAbs = absOf(DECOY_REL);
if (fs.existsSync(decoyAbs)) fs.unlinkSync(decoyAbs);

const files = walk(SERVER_DIR);
const coreFiles = files.filter(isCore);
check(files.length > 50, `스캔 대상 파일 ${files.length}개(서버 프로덕션)`);
check(coreFiles.includes("sessions/LiveSession.ts"), "기능 본체 분류에 LiveSession이 들어 있다");
check(coreFiles.includes("sessions/SessionManager.ts"), "기능 본체 분류에 SessionManager가 들어 있다");
check(coreFiles.includes("config.ts"), "기능 본체 인접 분류에 config.ts가 들어 있다");
check(!coreFiles.some((rel) => rel.startsWith("routes" + path.sep)), "공통 HTTP 문(routes/)은 기능 본체가 아니다");
check(!coreFiles.includes("index.ts"), "최외곽 조립(index.ts)은 기능 본체가 아니다");
check(!coreFiles.includes("push.ts"), "웹 푸시 모듈(push.ts)은 기능 본체가 아니다");

const parserProbe = importsFromSource(
  `const a = await import("${["web", "push"].join("-")}"); const b = require("express");`,
);
check(
  parserProbe.some((im) => im.spec === "web-push" && !im.typeOnly) && parserProbe.some((im) => im.spec === "express" && !im.typeOnly),
  "동적 import/require 우회도 런타임 import로 감지",
);

const importOffenders = coreForbiddenImportOffenders(files);
check(importOffenders.length === 0, `기능 본체의 Express/static/web-push/CSP/web import 0건 (새 위반: ${importOffenders.join(", ") || "없음"})`);

const pushImportOffenders = corePushImportOffenders(files);
check(
  pushImportOffenders.length === 0,
  `기능 본체의 웹 푸시 채널 import는 잔여 목록 안에서만 (새 위반: ${pushImportOffenders.join(", ") || "없음"})`,
);
check(
  importsFromSource(read("sessions/LiveSession.ts")).every((im) => im.typeOnly || !isPushChannelImport(im.spec)),
  "LiveSession이 웹 푸시 채널을 import하지 않는다",
);

const vapidOffenders = coreVapidOffenders(files);
check(vapidOffenders.length === 0, `기능 본체의 VAPID·webDist 식별자는 잔여 목록 안에서만 (새 위반: ${vapidOffenders.join(", ") || "없음"})`);

const notifyOffenders = coreNotifyOffenders(files);
check(notifyOffenders.length === 0, `notifyPush 호출은 잔여 목록 안에서만 (새 위반: ${notifyOffenders.join(", ") || "없음"})`);

const buildPushOffenders = coreBuildPushOffenders(files);
check(
  buildPushOffenders.length === 0,
  `buildPushNotification 참조는 잔여 목록 안에서만 (새 위반: ${buildPushOffenders.join(", ") || "없음"})`,
);

const liveNotifyHits = stripComments(read("sessions/LiveSession.ts")).match(/\bnotifyPush\b/g) ?? [];
check(liveNotifyHits.length === 0, `LiveSession의 notifyPush 호출 0건 (관측 ${liveNotifyHits.length})`);
check(!/\bbuildPushNotification\b/.test(stripComments(read("sessions/LiveSession.ts"))), "LiveSession이 buildPushNotification을 부르지 않는다");
check(!/\bvapidPublic\b/.test(stripComments(read("index.ts"))), "조립부 건강 응답이 웹 푸시 공개키 식별자를 모른다");
check(
  !/\bvapidPublic\b|\bvapidPrivate\b|\bvapidSubject\b|\bwebDistDir\b/.test(stripComments(read("config.ts"))),
  "공통 설정이 웹 푸시 키·화면 경로 식별자를 모른다",
);
check(!/\bstaticActive\b/.test(stripComments(read("index.ts"))), "조립부가 HTML 서빙 여부로 CSP를 계산하지 않는다");
check(!/\bstaticActive\b/.test(stripComments(read("middleware/hardening.ts"))), "hardening이 화면 서빙 여부를 모른다");
check(/\bcreateStaticAddon\b/.test(stripComments(read("index.ts"))), "조립부가 static 선택 부가를 장착한다");
check(/\bcontentSecurityPolicy\b/.test(stripComments(read("routes/static.ts"))), "CSP는 static 설치 함수가 가진다");
check(!/\bcompression\b|\bsseSafeCompression\b/.test(stripComments(read("routes/static.ts"))), "static 부가가 compression을 소유하지 않는다");
check(/\bsseSafeCompression\b/.test(stripComments(read("middleware/hardening.ts"))), "SSE 비압축은 공통 문 hardening에 남는다");

const passwordAuth = stripComments(read("middleware/auth.ts"));
check(/\bBearer\b/i.test(passwordAuth) && /\bauthorization\b/i.test(passwordAuth), "password 인증이 쿠키 또는 Bearer를 읽는다");
check(/\baether_session\b/.test(passwordAuth), "password 인증에 쿠키 경로(aether_session)가 남는다");

// 본체(CORE)에 인바운드 Authorization Bearer 파싱(비밀번호 문) 0건 — 문은 middleware/auth만
function coreAuthHeaderOffenders(rels: string[]): string[] {
  // req.headers.authorization + Bearer 접두 검사 패턴(아웃바운드 헤더 설정은 제외)
  const reInbound = /\breq\.headers\??\.authorization\b/i;
  const reBearerPrefix = /\^Bearer\\s\+|\/Bearer\\s\+/;
  return rels.filter((rel) => {
    if (!isCore(rel)) return false;
    const src = stripComments(read(rel));
    return reInbound.test(src) && reBearerPrefix.test(src);
  });
}
check(
  coreAuthHeaderOffenders(files).length === 0,
  `기능 본체의 Authorization/Bearer 파싱 0건 (위반: ${coreAuthHeaderOffenders(files).join(", ") || "없음"})`,
);

// 서버 생산 코드에 Tauri 0
const tauriServerHits = files.filter((rel) => {
  const src = stripComments(read(rel));
  return /@tauri-apps/.test(src) || /tauri::/.test(src);
});
check(tauriServerHits.length === 0, `서버 생산 코드의 Tauri import 0건 (위반: ${tauriServerHits.join(", ") || "없음"})`);

// ── 잔여 목록 실재 ──
check(RESIDUE.length > 0, `잔여 목록이 비어 있지 않다 (${RESIDUE.length}항)`);
check(
  RESIDUE.every((item) => item.id.trim() && item.file.trim()),
  "잔여 목록에 빈 id·경로가 없다",
);
const missingResidue = RESIDUE.filter((item) => !fs.existsSync(absOf(item.file)));
check(missingResidue.length === 0, `잔여 목록의 경로가 전부 실재 (없음: ${missingResidue.map((i) => i.file).join(", ") || "-"})`);
const staleResidue = RESIDUE.filter((item) => {
  if (!fs.existsSync(absOf(item.file))) return false;
  return !item.re.test(stripComments(read(item.file)));
});
check(staleResidue.length === 0, `잔여 목록에 이미 해소된 항목 없음 (지울 것: ${staleResidue.map((i) => i.id).join(", ") || "없음"})`);

const residueIds = RESIDUE.map((item) => item.id);
check(new Set(residueIds).size === residueIds.length, "잔여 목록 id가 중복되지 않는다");

const missingPushResidueFiles = [...CORE_PUSH_IMPORT_RESIDUE, ...CORE_VAPID_RESIDUE, ...CORE_NOTIFY_RESIDUE, ...CORE_BUILD_PUSH_RESIDUE].filter(
  (rel) => !fs.existsSync(absOf(rel)),
);
check(
  missingPushResidueFiles.length === 0,
  `허용 목록의 경로가 전부 실재 (없음: ${missingPushResidueFiles.join(", ") || "-"})`,
);

// ── web/src는 server/를 import하지 않는다 ──
check(fs.existsSync(WEB_SRC), "web/src가 실재한다");
const webFiles = walkWeb(WEB_SRC);
check(webFiles.length > 20, `웹 스캔 대상 ${webFiles.length}개`);
function isServerTreeImport(spec: string): boolean {
  const norm = spec.replace(/\\/g, "/");
  return norm === "server" || /(^|\/)server\//.test(norm) || /\/server$/.test(norm);
}
const webServerOffenders = webFiles.flatMap((rel) => {
  const hits = importsFromSource(fs.readFileSync(path.join(WEB_SRC, rel), "utf8")).filter((im) => isServerTreeImport(im.spec));
  return hits.map((im) => `${rel} → ${im.spec}`);
});
check(webServerOffenders.length === 0, `web/src의 server/ import 0건 (위반: ${webServerOffenders.join(", ") || "없음"})`);
const webDecoyHits = importsFromSource(
  `import { LiveSession } from "../../../server/sessions/LiveSession"; const x = require("../../server/index.ts");`,
).filter((im) => isServerTreeImport(im.spec));
check(webDecoyHits.length >= 2, "web→server import 검사기가 실제 위반 코드를 잡는다(자기 반증)");

// web/src에 @tauri-apps 패키지 import 0 (__TAURI__ / __TAURI_INTERNALS__ 문자열은 허용)
const webTauriPkg = webFiles.filter((rel) => {
  const src = fs.readFileSync(path.join(WEB_SRC, rel), "utf8");
  return /from\s+['"]@tauri-apps/.test(src);
});
check(webTauriPkg.length === 0, `web/src의 @tauri-apps import 0건 (위반: ${webTauriPkg.join(", ") || "없음"})`);

const sharedHttp = path.join(REPO_DIR, "shared", "http.ts");
const sharedBrain = path.join(REPO_DIR, "shared", "brain.ts");
check(fs.existsSync(sharedHttp), "shared/http.ts가 REST·SSE 응답 모양의 한 벌이다");
check(fs.existsSync(sharedBrain), "shared/brain.ts가 Brain REST 응답 모양의 한 벌이다");
const webTypes = fs.readFileSync(path.join(WEB_SRC, "lib", "types.ts"), "utf8");
const webBrain = fs.readFileSync(path.join(WEB_SRC, "lib", "brain.ts"), "utf8");
check(/from\s+['"]@shared\/http['"]/.test(webTypes), "웹 types.ts가 shared/http를 본다");
check(/from\s+['"]@shared\/brain['"]/.test(webBrain), "웹 brain.ts가 shared/brain을 본다");
check(!/export type UsageResponse\s*=\s*\{/.test(webTypes), "웹이 UsageResponse를 손으로 복제하지 않는다");
check(!/export type SearchHit\s*=\s*\{/.test(webBrain), "웹이 SearchHit를 손으로 복제하지 않는다");

// ── decoy: 가짜 위반을 본체 검사 대상에 심고, 반드시 잡힌 뒤에 지운다 ──
const decoySrc = [
  `import express from "express";`,
  `import webpush from "web-push";`,
  `import { notifyPush } from "../push";`,
  `void express; void webpush; void notifyPush;`,
  `const raw = req.headers?.authorization;`,
  `const m = /^Bearer\\s+(\\S+)/i.exec(String(raw ?? ""));`,
  `void m;`,
].join("\n");
fs.writeFileSync(decoyAbs, decoySrc);
try {
  const decoyList = [DECOY_REL];
  check(
    coreForbiddenImportOffenders(decoyList).some((row) => row.startsWith(DECOY_REL)),
    "decoy의 express/web-push import를 본체 위반으로 감지",
  );
  check(
    corePushImportOffenders(decoyList).includes(`${DECOY_REL} → ../push`),
    "decoy의 웹 푸시 채널 import를 본체 위반으로 감지",
  );
  check(coreNotifyOffenders(decoyList).includes(DECOY_REL), "decoy의 notifyPush 호출을 본체 위반으로 감지");
  check(coreAuthHeaderOffenders(decoyList).includes(DECOY_REL), "decoy의 Authorization/Bearer를 본체 위반으로 감지");
} finally {
  if (fs.existsSync(decoyAbs)) fs.unlinkSync(decoyAbs);
}
check(!fs.existsSync(decoyAbs), "decoy 파일이 검사 종료 후 남아 있지 않다");

// ── phase2_smoke는 일괄 npm test에서 빠져 있어야 한다 ──
const runAll = read(path.join("test", "run-all.ts"));
check(/phase2_smoke\s*:/.test(runAll), "run-all.ts가 phase2_smoke를 실모델 제외 목록에 둔다");
check(
  !/SERVER_DIR\s*,\s*["']\.\.["']\s*,\s*["']web["']/.test(read(path.join("test", "phase2_smoke.ts"))),
  "phase2_smoke가 저장소 web/ 경로를 직접 가리키지 않는다",
);
const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
check(pkg.scripts?.test === "tsx test/run-all.ts", "npm test가 run-all 일괄 실행기다");
check(
  typeof pkg.scripts?.["test:platform-boundary"] === "string" && pkg.scripts["test:platform-boundary"].includes("platform_boundary.ts"),
  "npm run test:platform-boundary가 이 파일을 가리킨다",
);
check(
  typeof pkg.scripts?.["test:boundary"] === "string" && pkg.scripts["test:boundary"].includes("provider_boundary.ts"),
  "provider test:boundary는 기존 파일을 그대로 가리킨다",
);
check(!String(pkg.scripts?.["test:boundary"] ?? "").includes("platform"), "provider test:boundary에 플랫폼 규칙을 섞지 않았다");

// Phase 13e — 주의 통로는 REST·SSE 공통 문. 웹만의 소켓·묶음 REST가 생기면 실패.
const presenceRoute = stripComments(read("routes/presence.ts"));
check(/text\/event-stream/.test(presenceRoute), "주의 통로가 SSE(text/event-stream)다");
check(/presenceRouter\.get\(\s*["']\/stream["']/.test(presenceRoute), "주의 통로 경로는 GET /stream 이다");
check(!/\bWebSocket\b/.test(presenceRoute), "주의 통로가 WebSocket이 아니다");

const indexSrc = stripComments(read("index.ts"));
check(/["']\/api\/presence["']/.test(indexSrc) && /\bpresenceRouter\b/.test(indexSrc), "조립부가 /api/presence 를 공통 문에 붙인다");
check(!/\/api\/(?:sessions\/)?(?:fanout|batch)\b/.test(indexSrc), "묶음 시작용 새 REST가 조립부에 없다");

const sessionsRoute = stripComments(read("routes/sessions.ts"));
check(!/\.(?:get|post|put|delete)\(\s*["'][^"']*(?:fanout|batch)/.test(sessionsRoute), "세션 문에 묶음 경로가 없다");

function usesWebSocket(src: string): boolean {
  return /\bnew\s+WebSocket\b/.test(src) || /from\s+["']ws["']/.test(src) || /\brequire\(\s*["']ws["']\s*\)/.test(src);
}
const wsProd = files.filter((rel) => usesWebSocket(stripComments(read(rel))));
check(wsProd.length === 0, `서버 생산 코드의 WebSocket 0건 (위반: ${wsProd.join(", ") || "없음"})`);
check(usesWebSocket(stripComments('import WebSocket from "ws"; const s = new WebSocket("wss://x");')), "검사기가 서버 웹소켓을 잡는다(자기 반증)");

const httpContract = fs.readFileSync(sharedHttp, "utf8");
check(/export type SessionAttention\s*=/.test(httpContract), "목록 주의 칸이 shared/http.ts에 있다");
check(/attention\?:\s*SessionAttention/.test(httpContract), "목록 attention은 선택 칸이다");
check(/GET \/api\/presence\/stream/.test(httpContract), "주의 통로 경로가 공통 계약에 적혀 있다");

// ── Phase 4 — Flutter/Dart는 서버·본체·웹에 0. mobile/은 앱 전용 ──
const FLUTTER_RE = /package:flutter|dart:ui|from\s+["']dart:/;
const flutterServerHits = files.filter((rel) => FLUTTER_RE.test(stripComments(read(rel))));
check(flutterServerHits.length === 0, `서버 생산 코드의 Flutter/Dart 0건 (위반: ${flutterServerHits.join(", ") || "없음"})`);
check(
  !CORE_DIR_PREFIXES.some((d) => d === "flutter" || d.includes("package:flutter")),
  "CORE_DIR_PREFIXES에 flutter/package:flutter 0",
);
const webFlutterHits = webFiles.filter((rel) => FLUTTER_RE.test(fs.readFileSync(path.join(WEB_SRC, rel), "utf8")));
check(webFlutterHits.length === 0, `web/src의 package:flutter 0건 (위반: ${webFlutterHits.join(", ") || "없음"})`);

const MOBILE_DIR = path.join(REPO_DIR, "mobile");
if (fs.existsSync(MOBILE_DIR)) {
  const mobileSkip = new Set(["build", ".dart_tool", "Pods", ".gradle"]);
  const mobileFiles: string[] = [];
  const walkMobile = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (mobileSkip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "ios" || e.name === "android") {
          // ios/android는 로컬 모델 산출만 별도 검사
          continue;
        }
        walkMobile(abs);
      } else if (e.isFile()) {
        mobileFiles.push(abs);
      }
    }
  };
  walkMobile(MOBILE_DIR);
  const bannedConn = [/postgres:\/\//i, /postgresql:\/\//i, /\bDATABASE_URL\b/, /\b5432\b/, /\b5433\b/, /\bWebSocket\b/, /ws:\/\//, /wss:\/\//];
  const connHits = mobileFiles.filter((abs) => {
    const src = fs.readFileSync(abs, "utf8");
    return bannedConn.some((re) => re.test(src));
  });
  check(connHits.length === 0, `mobile/ postgres·WebSocket 0 (위반: ${connHits.map((p) => path.relative(REPO_DIR, p)).join(", ") || "없음"})`);

  const modelRe = /\bllama\b|\.gguf\b|\btflite\b|\bonnx\b|\.mlmodel\b|\bcoreml\b/i;
  const nativeRoots = ["ios", "android"].map((d) => path.join(MOBILE_DIR, d)).filter((d) => fs.existsSync(d));
  const nativeHits: string[] = [];
  for (const root of nativeRoots) {
    const walkN = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "Pods" || e.name === ".gradle" || e.name === "build") continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walkN(abs);
        else if (e.isFile()) {
          const name = e.name;
          const src = fs.readFileSync(abs, "utf8");
          if (modelRe.test(name) || modelRe.test(src)) nativeHits.push(path.relative(REPO_DIR, abs));
        }
      }
    };
    walkN(root);
  }
  check(nativeHits.length === 0, `ios/android 로컬 모델 산출 0 (위반: ${nativeHits.join(", ") || "없음"})`);
  // 자기 반증: 메모리 문자열만 — 파일에는 쓰지 않는다
  check(modelRe.test("model.gguf"), "자기 반증: model.gguf 감지");
}

// decoy: CORE에 flutter 접두를 잠깐 넣지 않고, 검사기가 flutter 문자열을 서버에서 잡는지 확인
{
  const decoyFlutter = 'import "package:flutter/material.dart";\n';
  check(FLUTTER_RE.test(decoyFlutter), "자기 반증: package:flutter 감지");
  check(!CORE_DIR_PREFIXES.includes("flutter"), "decoy 뒤 CORE에 flutter 잔여 0");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} platform_boundary: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
