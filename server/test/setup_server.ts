/**
 * 첫 설정 전용 서버: 접근 차단, 열린 길, 입력 검사, 저장 순서. 임시 폴더만 쓴다. 모델 호출 0.
 */
import bcrypt from "bcryptjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";
import { TERMS_VERSION } from "../../shared/terms";
import type { AppPaths } from "../setup/paths";
import { createSetupApp } from "../setup/app";
import { pickFolder } from "../setup/desktop";
import { startSetupServer } from "../setup/main";
import { defaultSaveDeps, type SaveDeps } from "../setup/save";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mk = (n: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aether-setup-${n}-`)));

function mkPaths(): AppPaths {
  const d = mk("cfg");
  return { configDir: d, defaultDataDir: path.join(d, "data"), configFile: path.join(d, "config.json"), envFile: path.join(d, ".env"), startLog: path.join(d, "start.log") };
}

const dist = mk("dist");
fs.writeFileSync(path.join(dist, "index.html"), "<html><body>setup</body></html>");

interface Res { status: number; body: any; headers: http.IncomingHttpHeaders }
function request(port: number, method: string, url: string, o: { host?: string | null; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.host !== null) headers.host = o.host ?? `127.0.0.1:${port}`;
    if (o.origin) headers.origin = o.origin;
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (data) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(data)); }
    const r = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => { let b: any = t; try { b = JSON.parse(t); } catch {} resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }); });
    });
    r.on("error", reject);
    r.end(data);
  });
}

async function boot(paths: AppPaths, saveDeps?: SaveDeps, pick?: (signal: AbortSignal) => Promise<string | null>) {
  const exits: number[] = [];
  let port = 0;
  const app = createSetupApp({ paths, getPort: () => port, exit: (c) => exits.push(c), distDir: dist, saveDeps, pickFolder: pick, log: () => {} });
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  port = (server.address() as net.AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const post = (body: unknown) => request(port, "POST", "/api/setup/complete", { origin, body });
  return { port, origin, exits, server, post };
}

const GOOD_PW = "correct-horse-1";
const goodInput = (work: string, data: string, port: number) => ({ terms: true, password: GOOD_PW, port, dataDir: data, projectRoot: work });

const paths = mkPaths();
const a = await boot(paths);

console.log("접근 차단");
for (const url of ["/api/health", "/api/fs/places", "/api/providers", "/", "/api/setup/defaults"]) {
  check((await request(a.port, "GET", url, { host: "evil.example" })).status === 403, `잘못된 Host의 GET ${url}은 403`);
}
check((await request(a.port, "GET", "/api/fs/places", { host: `127.0.0.1:${a.port + 1}` })).status === 403, "다른 포트의 Host는 403");
check((await request(a.port, "GET", "/api/fs/places", { host: "127.0.0.1" })).status === 403, "포트 없는 Host는 403");
check((await request(a.port, "GET", "/api/health", { host: `localhost:${a.port}` })).status === 200, "localhost:포트 Host는 허용");
check((await request(a.port, "POST", "/api/setup/complete", { body: {} })).status === 403, "Origin 없는 POST는 403");
check((await request(a.port, "POST", "/api/setup/complete", { origin: "http://evil.example", body: {} })).status === 403, "다른 Origin의 POST는 403");
check((await request(a.port, "POST", "/api/setup/complete", { origin: "null", body: {} })).status === 403, "Origin이 null인 POST는 403");
check((await request(a.port, "DELETE", "/api/fs/list", { origin: "http://evil.example" })).status === 403, "다른 Origin의 DELETE는 403");
check((await request(a.port, "POST", "/api/setup/complete", { host: "evil.example", origin: a.origin, body: {} })).status === 403, "Origin이 맞아도 Host가 틀리면 403");

check((await request(a.port, "GET", "/api/fs/places", { headers: { "sec-fetch-site": "cross-site" } })).status === 403, "Sec-Fetch-Site가 cross-site인 GET은 403");
check((await request(a.port, "GET", "/api/fs/places", { origin: "http://evil.example" })).status === 403, "다른 Origin의 GET은 403");
check((await request(a.port, "GET", "/api/health", { origin: a.origin, headers: { "sec-fetch-site": "same-origin" } })).status === 200, "같은 Origin·same-origin의 GET은 허용");
const cors = await request(a.port, "POST", "/api/setup/complete", { origin: "http://evil.example", body: {} });
check(!Object.keys(cors.headers).some((k) => k.startsWith("access-control-")), "거절 응답에 Access-Control-* 헤더가 없다");
check(!Object.keys((await request(a.port, "GET", "/api/health")).headers).some((k) => k.startsWith("access-control-")), "정상 응답에도 Access-Control-* 헤더가 없다");

console.log("열린 길");
const h = await request(a.port, "GET", "/api/health");
check(h.status === 200 && h.body.ok === true && h.body.setup === true && h.body.auth === "off" && typeof h.body.version === "string", "health는 setup:true, auth:off", h.body);
const d = await request(a.port, "GET", "/api/setup/defaults");
check(d.body.port === a.port && d.body.dataDir === paths.defaultDataDir && d.body.projectRoot === os.homedir(), "defaults", d.body);
const pr = await request(a.port, "GET", "/api/providers");
check(pr.status === 200 && Array.isArray(pr.body.providers) && pr.body.providers.length === 4, "providers 목록 네 곳", pr.body.providers?.length);
const av = await request(a.port, "GET", "/api/providers/availability");
const ids = Object.keys(av.body.availability ?? {});
check(av.status === 200 && ids.length === 4 && ids.every((id) => av.body.availability[id].available === true || typeof av.body.availability[id].reason === "string"), "availability 네 곳 형식");
check((await request(a.port, "GET", `/api/fs/list?path=${encodeURIComponent(os.tmpdir())}`)).status === 404, "폴더 목록 길은 열지 않는다");
check((await request(a.port, "POST", "/api/setup/pick-folder", {})).status === 403, "Origin 없는 폴더 창 요청은 403");
check((await request(a.port, "POST", "/api/setup/pick-folder", { origin: "http://evil.example" })).status === 403, "다른 Origin의 폴더 창 요청은 403");
{
  let answer: () => Promise<string | null> = async () => "/picked";
  const p = await boot(mkPaths(), undefined, () => answer());
  const pick = () => request(p.port, "POST", "/api/setup/pick-folder", { origin: p.origin });
  const got = await pick();
  check(got.status === 200 && got.body.path === "/picked", "폴더 창: 고른 경로를 돌려준다", got.body);
  answer = async () => null;
  check((await pick()).body.path === null, "폴더 창: 취소는 path null");
  answer = async () => { throw new Error("no gui"); };
  const failed = await pick();
  check(failed.status === 500 && failed.body.error === "picker_failed", "폴더 창: 못 띄우면 500", failed.body);
  let release = (_: string | null) => {};
  answer = () => new Promise((r) => { release = r; });
  const first = pick();
  await new Promise((r) => setTimeout(r, 50));
  check((await pick()).status === 409, "폴더 창: 열려 있는 동안 또 열지 않는다");
  release("/later");
  check((await first).body.path === "/later", "폴더 창: 먼저 연 요청은 끝까지 답한다");
  p.server.close();
}
const pickDarwin = async (out: { stdout?: string; stderr?: string }) => pickFolder(undefined, "darwin", async () => {
  if (out.stdout === undefined) throw out;
  return { stdout: out.stdout };
});
check(await pickDarwin({ stdout: "/Users/me/작업 폴더/\n" }) === "/Users/me/작업 폴더", "맥: 고른 경로의 끝 빗금을 뗀다");
check(await pickDarwin({ stdout: "/\n" }) === "/", "맥: 최상위 폴더는 그대로");
check(await pickDarwin({ stderr: "execution error: User canceled. (-128)" }) === null, "맥: 취소는 null");
check(await pickDarwin({ stderr: "no user interaction allowed" }).then(() => false, () => true), "맥: 창을 못 띄우면 throw");
check(await pickFolder(undefined, "win32", async () => ({ stdout: "C:\\\r\n" })) === "C:\\", "윈도우: 드라이브 최상위는 그대로");
check(await pickFolder(undefined, "win32", async () => ({ stdout: "C:\\work\\폴더\r\n" })) === "C:\\work\\폴더", "윈도우: 경로와 한글 유지");
check(await pickFolder(undefined, "win32", async () => { throw { code: 2 }; }) === null, "윈도우: 취소는 null");
let winScript = "";
await pickFolder(undefined, "win32", async (_c, args) => { winScript = Buffer.from(args.at(-1)!, "base64").toString("utf16le"); return { stdout: "C:\\w\r\n" }; });
check(winScript.includes("IFileOpenDialog") && !winScript.includes("FolderBrowserDialog") && winScript.includes("$ErrorActionPreference='Stop'"), "윈도우: 탐색기 모양 창을 쓰고 실패를 취소로 숨기지 않는다");
check(await pickFolder(undefined, "linux").then(() => false, () => true), "지원하지 않는 운영체제는 throw");
const idx = await request(a.port, "GET", "/");
check(idx.status === 200 && String(idx.body).includes("setup"), "정적 화면 제공");
for (const [m, u] of [["GET", "/api/sessions"], ["GET", "/api/system/restart"], ["POST", "/api/system/restart"], ["GET", "/api/hermes/mcp"], ["POST", "/api/hermes/hook"], ["POST", "/api/auth/login"], ["GET", "/api/errors"], ["GET", "/api/locale"]] as const) {
  check((await request(a.port, m, u, { origin: a.origin })).status === 404, `${m} ${u}은 404`);
}

console.log("입력 거절");
const work = mk("work");
const okData = path.join(mk("data"), "d");
const good = () => goodInput(work, okData, a.port + 1);
const file = path.join(mk("file"), "f");
fs.writeFileSync(file, "x");
const cases: Array<[string, unknown, number, string]> = [
  ["본문 없음", undefined, 400, "invalid_body"],
  ["약관 미동의", { ...good(), terms: false }, 400, "terms_required"],
  ["약관 문자열 true", { ...good(), terms: "true" }, 400, "terms_required"],
  ["비밀번호 7자", { ...good(), password: "1234567" }, 400, "password_invalid"],
  ["비밀번호 73바이트", { ...good(), password: "a".repeat(73) }, 400, "password_invalid"],
  ["비밀번호 숫자", { ...good(), password: 12345678 }, 400, "password_invalid"],
  ["포트 80", { ...good(), port: 80 }, 400, "port_invalid"],
  ["브라우저 금지 포트 6000", { ...good(), port: 6000 }, 400, "port_invalid"],
  ["브라우저 금지 포트 6667", { ...good(), port: 6667 }, 400, "port_invalid"],
  ["포트 65536", { ...good(), port: 65536 }, 400, "port_invalid"],
  ["포트 문자열", { ...good(), port: "48999" }, 400, "port_invalid"],
  ["포트 소수", { ...good(), port: 48999.5 }, 400, "port_invalid"],
  ["데이터 폴더 상대 경로", { ...good(), dataDir: "data" }, 400, "data_dir_invalid"],
  ["데이터 폴더 파일 아래", { ...good(), dataDir: path.join(file, "sub") }, 400, "data_dir_unwritable"],
  ["작업 폴더 상대 경로", { ...good(), projectRoot: "work" }, 400, "project_root_invalid"],
  ["작업 폴더 없음", { ...good(), projectRoot: path.join(work, "nope") }, 400, "project_root_missing"],
  ["작업 폴더가 파일", { ...good(), projectRoot: file }, 400, "project_root_missing"],
  ["작업 폴더 끝 공백", { ...good(), projectRoot: work + " " }, 400, "project_root_invalid"],
  ["작업 폴더에 경로 구분 문자", { ...good(), projectRoot: work + path.delimiter + work }, 400, "project_root_invalid"],
];
if (fs.existsSync(path.join(os.homedir(), "Library"))) cases.push(["보호 폴더(홈의 Library)", { ...good(), projectRoot: path.join(os.homedir(), "Library") }, 400, "project_root_missing"]);
for (const [name, body, status, code] of cases) {
  const r = await a.post(body);
  check(r.status === status && r.body.error === code, `${name} → ${status} ${code}`, r);
}
const busy = net.createServer();
await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
const busyPort = (busy.address() as net.AddressInfo).port;
const rb = await a.post({ ...good(), port: busyPort });
check(rb.status === 409 && rb.body.error === "port_in_use", "쓰는 중인 포트 → 409 port_in_use", rb);
busy.close();
check(!fs.existsSync(paths.configFile) && !fs.existsSync(paths.envFile), "거절된 요청은 아무것도 쓰지 않는다");
const freshData = path.join(mk("fresh"), "new", "data");
const rr = await a.post({ ...good(), dataDir: freshData, projectRoot: path.join(work, "nope") });
check(rr.status === 400 && !fs.existsSync(path.dirname(freshData)), "작업 폴더 거절 때 데이터 폴더를 만들지 않는다", rr);

console.log("저장");
const pwFile = path.join(okData, "auth-password.json");
fs.mkdirSync(okData, { recursive: true });
fs.writeFileSync(pwFile, JSON.stringify({ hash: bcrypt.hashSync("old-password-xx", 4) }));
const failing: SaveDeps = { savePasswordHash: () => { throw new Error("디스크 오류"); }, portFree: async () => true };
const f = await boot(mkPaths(), failing);
const rf = await f.post(goodInput(work, okData, f.port + 1));
check(rf.status === 500 && rf.body.error === "save_failed", "저장 도중 실패는 500", rf);
f.server.close();

const p2 = mkPaths();
const c = await boot(p2, failing);
await c.post(goodInput(work, okData, c.port + 1));
check(!fs.existsSync(p2.configFile), "중간 실패 때 config.json이 없다(다음에 다시 첫 실행)");
const retry = await c.post(goodInput(work, okData, c.port + 1));
check(retry.status === 500, "실패 뒤 재시도는 409가 아니라 다시 시도된다", retry.status);
c.server.close();

const p3 = mkPaths();
fs.writeFileSync(p3.envFile, "FOO=bar\nAETHER_JWT_SECRET=old\n");
const s = await boot(p3);
const savePort = s.port + 1;
const [r1, r2] = await Promise.all([s.post(goodInput(work, okData, savePort)), s.post(goodInput(work, okData, savePort))]);
check([r1.status, r2.status].sort().join() === "200,409", "동시 저장은 하나만 받고 하나는 409", [r1.status, r2.status]);
for (let i = 0; i < 50 && s.exits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
check(s.exits.length === 1 && s.exits[0] === 1, "응답 뒤 종료 콜백이 코드 1로 한 번 불린다", s.exits);
check((await s.post(goodInput(work, okData, savePort))).status === 409, "저장 뒤 요청도 409");
const envText = fs.readFileSync(p3.envFile, "utf8");
check(/^FOO=bar$/m.test(envText) && (envText.match(/AETHER_JWT_SECRET=/g) ?? []).length === 1 && !envText.includes("=old"), ".env는 시크릿 줄만 바꾸고 다른 줄을 유지한다");
if (process.platform !== "win32") check((fs.statSync(pwFile).mode & 0o777) === 0o600, "auth-password.json은 0600");
const stored = JSON.parse(fs.readFileSync(pwFile, "utf8")).hash;
check(await bcrypt.compare("correct-horse-1", stored) && !(await bcrypt.compare("old-password-xx", stored)), "기존 auth-password.json을 덮어쓴다");
const cfg = JSON.parse(fs.readFileSync(p3.configFile, "utf8"));
check(cfg.authMode === "password" && cfg.host === "127.0.0.1" && cfg.port === savePort && cfg.dataDir === okData && cfg.projectRoot === work && cfg.worktreeDir === path.join(okData, "worktrees") && cfg.webAutoBuild === false, "config.json 내용", cfg);
const ta = cfg.termsAccepted;
check(ta?.version === TERMS_VERSION && typeof ta.at === "string" && Math.abs(Date.parse(ta.at) - Date.now()) < 60_000, "config.json에 동의 판과 서버가 정한 시각이 남는다", ta);
if (process.platform !== "win32") check((fs.statSync(p3.envFile).mode & 0o777) === 0o600 && (fs.statSync(p3.configFile).mode & 0o777) === 0o600, ".env와 config.json은 0600");
check(fs.existsSync(path.join(p3.configDir, process.platform === "darwin" ? "Aether.webloc" : "Aether.url")) && fs.readFileSync(path.join(p3.configDir, process.platform === "darwin" ? "Aether.webloc" : "Aether.url"), "utf8").includes(`127.0.0.1:${savePort}`), "바로가기가 저장한 포트를 가리킨다");
s.server.close();

// 응답 전에 연결이 끊겨도 저장은 끝나고 종료 콜백이 한 번 불린다
const p5 = mkPaths();
const dc = await boot(p5);
const dcData = path.join(mk("dc"), "newdata");
const dcBody = JSON.stringify(goodInput(work, dcData, dc.port + 1));
await new Promise<void>((resolve) => {
  const sock = net.connect(dc.port, "127.0.0.1", () => {
    sock.write(`POST /api/setup/complete HTTP/1.1\r\nHost: 127.0.0.1:${dc.port}\r\nOrigin: ${dc.origin}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(dcBody)}\r\n\r\n${dcBody}`, () => { sock.destroy(); resolve(); });
  });
  sock.on("error", () => {});
});
for (let i = 0; i < 100 && dc.exits.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setTimeout(r, 200));
check(fs.existsSync(p5.configFile) && dc.exits.length === 1 && dc.exits[0] === 1, "응답 전 연결이 끊겨도 저장되고 종료 콜백이 한 번 불린다", { cfg: fs.existsSync(p5.configFile), exits: dc.exits });
if (process.platform !== "win32") check((fs.statSync(dcData).mode & 0o777) === 0o700, "새로 만든 데이터 폴더는 0700");
dc.server.close();

const envCheck = spawnSync(process.execPath, ["-e", `process.loadEnvFile(${JSON.stringify(p3.envFile)}); process.stdout.write(String(Buffer.byteLength(process.env.AETHER_JWT_SECRET ?? "")))`], { encoding: "utf8" });
check(Number(envCheck.stdout) >= 32, ".env가 loadEnvFile로 복원되고 시크릿이 32바이트 이상", envCheck.stdout);

// config.ts가 저장 결과를 그대로 받아들이는가(진짜 서버가 첫 부팅에서 거부하지 않는다는 근거)
const probe = path.join(mk("probe"), "probe.mjs");
fs.writeFileSync(probe, `const { config } = await import(${JSON.stringify(path.join(serverDir, "config.ts"))});\nprocess.stdout.write(JSON.stringify({ port: config.port, host: config.host, authMode: config.authMode, dataDir: config.dataDir, projectRoot: config.projectRoot }));\n`);
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AETHER_") && k !== "PORT"));
const cr = spawnSync(process.execPath, ["--import", "tsx", probe], { cwd: serverDir, encoding: "utf8", env: { ...childEnv, AETHER_CONFIG: p3.configFile } });
let loaded: any = {};
try { loaded = JSON.parse(cr.stdout.trim().split("\n").pop() ?? ""); } catch {}
check(loaded.port === savePort && loaded.host === "127.0.0.1" && loaded.authMode === "password" && loaded.dataDir === okData && loaded.projectRoot === work, "config.ts가 저장한 config.json을 규칙대로 읽는다", `${cr.status}|${cr.error?.message}|${cr.stderr.split("\n").slice(0,4).join("|")}|${cr.stdout}`);

console.log("프로그램 폴더 안 거절");
const progDir = mk("prog");
fs.mkdirSync(path.join(progDir, "server"), { recursive: true });
const pp = mkPaths();
const pg = await boot(pp, { ...defaultSaveDeps, programDir: progDir });
const progCases: Array<[string, unknown, string]> = [
  ["데이터 폴더가 프로그램 폴더 안", { ...goodInput(work, path.join(progDir, "server", "data"), pg.port + 1) }, "data_dir_invalid"],
  ["데이터 폴더가 프로그램 폴더 자신", { ...goodInput(work, progDir, pg.port + 1) }, "data_dir_invalid"],
  ["데이터 폴더가 .. 로 프로그램 폴더 안", { ...goodInput(work, path.join(progDir, "x", "..", "data"), pg.port + 1) }, "data_dir_invalid"],
  ["작업 폴더가 프로그램 폴더 안", { ...goodInput(path.join(progDir, "server"), okData, pg.port + 1) }, "project_root_invalid"],
];
if (process.platform === "darwin" || process.platform === "win32") {
  progCases.push(["대소문자만 다른 프로그램 폴더 안(대소문자 무시 파일시스템)", { ...goodInput(work, path.join(progDir.toUpperCase(), "data"), pg.port + 1) }, "data_dir_invalid"]);
}
for (const [name, body, code] of progCases) {
  const r = await pg.post(body);
  check(r.status === 400 && r.body.error === code, `${name} → ${code}`, r);
}
check(!fs.existsSync(path.join(progDir, "server", "data")) && !fs.existsSync(pp.configFile), "거절된 요청은 프로그램 폴더 안에 아무것도 만들지 않는다");
const progLink = path.join(mk("lnk"), "link");
fs.symlinkSync(progDir, progLink);
check((await pg.post(goodInput(work, path.join(progLink, "data"), pg.port + 1))).body.error === "data_dir_invalid", "링크로 프로그램 폴더 안을 가리켜도 거절");
const siblingData = path.join(progDir + "-other", "data");
const ok = await pg.post(goodInput(work, siblingData, pg.port + 1));
check(ok.status === 200, "이름만 비슷한 바깥 폴더는 허용", ok);
fs.rmSync(progDir + "-other", { recursive: true, force: true });
pg.server.close();
const dev = await boot(mkPaths());
check((await dev.post(goodInput(work, path.join(mk("dev"), "d"), dev.port + 1))).status === 200, "묶음 밖(개발 실행)에서는 프로그램 폴더 검사로 막지 않는다");
dev.server.close();

console.log("바인딩과 포트");
process.env.AETHER_SETUP_NO_BROWSER = "1"; // 브라우저를 열지 않는다
const savedHost = process.env.AETHER_HOST;
process.env.AETHER_HOST = "0.0.0.0";
const hold = net.createServer();
await new Promise<void>((r) => hold.listen(0, "127.0.0.1", () => r()));
const holdPort = (hold.address() as net.AddressInfo).port;
const p4 = mkPaths();
const m = await startSetupServer({ paths: p4, startPort: holdPort, log: () => {}, exit: () => {}, distDir: dist });
const addr = m.address() as net.AddressInfo;
check(addr.address === "127.0.0.1", "AETHER_HOST=0.0.0.0이어도 127.0.0.1에만 묶인다", addr.address);
check(addr.port !== holdPort && addr.port > holdPort && addr.port <= holdPort + 20, "시작 포트가 차 있으면 다음 포트를 쓴다", addr.port);
check((await request(addr.port, "GET", "/api/health")).status === 200, "고른 포트에서 응답한다");
check(fs.readFileSync(path.join(p4.configDir, process.platform === "darwin" ? "Aether.webloc" : "Aether.url"), "utf8").includes(`127.0.0.1:${addr.port}`), "시작할 때 바로가기를 쓴다");
m.close();
hold.close();
if (savedHost === undefined) delete process.env.AETHER_HOST; else process.env.AETHER_HOST = savedHost;

const dbFiles = (d: string) => (fs.existsSync(d) ? (fs.readdirSync(d, { recursive: true }) as string[]) : []).filter((n) => /\.(sqlite|db)(-wal|-shm)?$/.test(n));
check(dbFiles(config.dataDir).length === 0 && dbFiles(okData).length === 0 && dbFiles(dcData).length === 0 && dbFiles(paths.configDir).length === 0, "설정 서버는 어느 데이터 폴더에도 DB 파일을 만들지 않는다(재귀)");

a.server.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} setup_server: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
