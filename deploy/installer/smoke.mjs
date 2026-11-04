// 설치 묶음 실기 시험(첫 실행부터 평소 실행까지). 맥·윈도우 공통. 사용: <묶음의 node> smoke.mjs --app <묶음 폴더> --base <빈 임시 폴더>
// 빈 AETHER_APP_BASE로 묶음을 띄워 첫 설정 서버를 확인하고, 설정을 저장한 뒤 평소 서버로 다시 떠서 로그인까지 항목별 PASS/FAIL만 출력한다.
// 운영 데이터·8787에는 닿지 않는다: 데이터·임시 폴더는 모두 --base 아래, 포트는 48800, AETHER_*는 지우고 시작한다.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const app = arg("app") && path.resolve(arg("app"));
const base = arg("base") && path.resolve(arg("base"));
if (!app || !base) { console.error("사용: smoke.mjs --app <묶음 폴더> --base <임시 폴더>"); process.exit(2); }
const PORT = 48800;

let failed = 0;
const check = (name, ok, why = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && why ? ` — ${String(why).split("\n")[0].slice(0, 160)}` : ""}`); if (!ok) failed++; };

const portBusy = () => new Promise((res) => { const s = net.connect(PORT, "127.0.0.1"); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
if (await portBusy()) { console.error(`포트 ${PORT}가 이미 사용 중이라 중단한다.`); process.exit(2); }

if (fs.existsSync(base) && fs.readdirSync(base).length > 0) { console.error("--base가 비어 있지 않아 중단한다(실제 설정을 덮지 않기 위해)."); process.exit(2); }

// ── 임시 폴더 만들기(비밀번호는 무작위, 출력하지 않는다) ──
const dataDir = path.join(base, "data");
const tmpDir = path.join(base, "tmp");
const work = path.join(base, "work");
for (const d of [tmpDir, work]) fs.mkdirSync(d, { recursive: true });
const password = crypto.randomBytes(12).toString("hex");
const serverDir = path.join(app, "server");

// ── 합쳐지지 않고 파일로 남긴 두 패키지가 묶음의 node로 불러와지는지 ──
try {
  const sdk = await import(pathToFileURL(path.join(serverDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")).href);
  check("SDK(sdk.mjs) 동적 import 성공", typeof sdk.query === "function", "query 내보내기 없음");
} catch (e) { check("SDK(sdk.mjs) 동적 import 성공", false, e?.message ?? e); }
// 네이티브 파일은 대상 OS와 시험 실행 OS가 같을 때만 불러올 수 있다(맥 묶음을 윈도우에서 돌리는 경우 등은 건너뜀).
if (fs.existsSync(path.join(serverDir, "node_modules/node-pty/prebuilds", `${process.platform}-${process.arch}`))) {
  try {
    const pty = createRequire(path.join(serverDir, "x.js"))("node-pty");
    check("node-pty 로드 성공", typeof pty.spawn === "function");
    // 로드만으로는 spawn-helper의 실행 권한 누락을 못 잡으므로 짧은 프로세스를 한 번 띄운다.
    const code = await new Promise((res) => { const t = pty.spawn(process.execPath, ["-v"], { cols: 80, rows: 24 }); t.onExit(({ exitCode }) => res(exitCode)); setTimeout(() => res("시간 초과"), 10000); });
    check("node-pty로 프로세스 실행", code === 0, code);
  } catch (e) { check("node-pty 로드 성공", false, e?.message ?? e); }
} else console.log(`INFO node-pty 시험 건너뜀: 이 묶음에 ${process.platform}-${process.arch} 네이티브 파일이 없다(다른 OS 묶음)`);

// ── 묶음 띄우기: 셸 없이 직접, PID를 들고 있다 직접 끈다 ──
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AETHER_") && k !== "PORT"));
Object.assign(baseEnv, { AETHER_APP_BASE: base, AETHER_SETUP_NO_BROWSER: "1", TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir, AETHER_AUTH_MODE: "off" }); // AUTH_MODE=off는 무시되어야 하는 미끼
const childLog = path.join(base, "child.log");
const out = fs.openSync(childLog, "a");
const running = new Set();
function launch(portEnv) {
  const child = spawn(process.execPath, [path.join(serverDir, "index.mjs")], { cwd: base, env: { ...baseEnv, PORT: portEnv }, stdio: ["ignore", out, out], windowsHide: true });
  const h = { child, code: undefined };
  h.exited = new Promise((res) => child.once("exit", (code) => { h.code = code; running.delete(h); res(code); }));
  h.kill = () => { if (h.code === undefined) try { child.kill(); } catch {} };
  running.add(h);
  return h;
}
const killAll = () => { for (const h of running) h.kill(); };
process.on("exit", killAll);
process.on("SIGINT", () => { killAll(); process.exit(130); });
const tail = (f) => { try { console.log(fs.readFileSync(f, "utf8").split("\n").slice(-21).join("\n")); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (h, ms) => Promise.race([h.exited, sleep(ms)]);

// fetch는 Host·Origin을 마음대로 못 정하므로 http로 직접 보낸다.
const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const h = { ...headers, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) };
  const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h, timeout: 15000 }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
  });
  r.on("timeout", () => r.destroy(new Error("요청 시간 초과")));
  r.on("error", reject);
  r.end(data);
});
const get = (p, headers = {}) => req("GET", p, { headers });
async function waitHealth(h) {
  for (let i = 0; i < 120 && h.code === undefined; i++) {
    try { const r = await get("/api/health"); if (r.status === 200) return r.json; } catch { await sleep(500); }
  }
}
const findSqlite = (d) => { try { return fs.readdirSync(d, { withFileTypes: true, recursive: true }).some((e) => e.isFile() && /\.(sqlite|db)(-wal|-shm)?$/.test(e.name)); } catch { return false; } };
const version = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8")).version;

const checkAvailability = (av, label) => {
  const ids = Object.keys(av);
  check(`${label} availability가 네 곳`, ids.length === 4, ids.length);
  check(`${label} availability 각 항목 형식`, ids.every((id) => av[id].available === true || (av[id].available === false && typeof av[id].reason === "string")));
  console.log(`INFO ${label} availability: ${ids.map((id) => `${id}=${av[id].available ? "ok" : av[id].reason}`).join(", ")}`);
};
// ══ 1. 첫 실행: 설정 서버 ══
const origin = `http://127.0.0.1:${PORT}`;
const first = launch(String(PORT)); // 첫 실행의 설정 서버만 PORT를 받는다
let health = await waitHealth(first);
check("첫 실행 부팅 후 /api/health 응답", !!health, first.code !== undefined ? `종료 코드 ${first.code}` : "60초 안에 응답 없음");
if (!health) { tail(path.join(base, "start.log")); tail(childLog); killAll(); process.exit(1); }
try {
check("health에 setup:true, auth:off(미끼 AETHER_AUTH_MODE 무시)", health.setup === true && health.auth === "off", JSON.stringify(health));
check("health 버전이 묶음 package.json과 같다", health.version === version, `${health.version}`);
check("첫 실행에서 DB 파일이 없다", !findSqlite(base));
check("첫 실행에서 config.json이 없다", !fs.existsSync(path.join(base, "config.json")));

check("잘못된 Host의 GET은 403", (await get("/api/health", { host: "evil.example" })).status === 403);
check("잘못된 Host의 /api/fs도 403", (await get("/api/fs/places", { host: "evil.example" })).status === 403);
check("Origin 없는 POST는 403", (await req("POST", "/api/setup/complete", { body: {} })).status === 403);
check("다른 Origin의 POST는 403", (await req("POST", "/api/setup/complete", { headers: { origin: "http://evil.example" }, body: {} })).status === 403);
check("평소 서버 길(/api/sessions)은 404", (await get("/api/sessions")).status === 404);

const web = await get("/");
const webHtml = web.text;
check("GET /는 화면 HTML", web.status === 200 && /<html/i.test(webHtml), web.status);
const jsPath = /src="(\/[^"]+\.js)"/.exec(webHtml)?.[1];
const js = jsPath ? await get(jsPath) : undefined;
check("화면 JS가 제공된다", js?.status === 200 && /javascript/.test(js.headers["content-type"] ?? ""), js?.status ?? "script 태그 없음");

const defaults = (await get("/api/setup/defaults")).json ?? {};
check("setup/defaults가 포트와 폴더 기본값을 준다", defaults.port === PORT && typeof defaults.dataDir === "string" && typeof defaults.projectRoot === "string", JSON.stringify(defaults));
checkAvailability((await get("/api/providers/availability")).json?.availability ?? {}, "첫 실행");

const complete = (body) => req("POST", "/api/setup/complete", { headers: { origin }, body });
const input = { terms: true, password, port: PORT, dataDir, projectRoot: work };
const noTerms = await complete({ ...input, terms: false });
check("약관 미동의는 400", noTerms.status === 400 && noTerms.json?.error === "terms_required", noTerms.status);
const saved = await complete(input);
check("저장 요청 200", saved.status === 200 && saved.json?.ok === true, saved.status);
await within(first, 10000);
check("저장 뒤 설정 서버가 코드 1로 끝난다", first.code === 1, first.code);
check("config.json·.env·auth-password.json이 생겼다", ["config.json", ".env"].every((f) => fs.existsSync(path.join(base, f))) && fs.existsSync(path.join(dataDir, "auth-password.json")));
check("저장 뒤에도 DB 파일이 없다", !findSqlite(base));
} catch (e) {
  check("첫 실행 단계가 끝까지 실행됨", false, e?.message ?? e);
  tail(childLog);
}
killAll();
await within(first, 5000);
if (first.code === undefined) { check("첫 실행 서버가 끝났다", false); process.exit(1); }
check("포트가 비었다(첫 실행 뒤)", !(await portBusy()));

// ══ 2. 재실행: 평소 서버 ══
const second = launch("48899"); // 미끼 PORT: 묶음이 물려받은 PORT를 무시하고 config.json 포트를 따라야 한다
health = await waitHealth(second);
check("재실행 후 /api/health 응답(미끼 PORT가 아닌 config 포트)", !!health, second.code !== undefined ? `종료 코드 ${second.code}` : "60초 안에 응답 없음");
if (!health) { tail(path.join(base, "start.log")); tail(childLog); killAll(); process.exit(1); }
try {
check("health auth가 password(미끼 AETHER_AUTH_MODE=off를 무시)", health.auth === "password" && health.setup === undefined, JSON.stringify(health));
check("health database가 up", health.database === "up", health.database);

const login = (pw) => req("POST", "/api/auth/login", { body: { password: pw } });
const bad = await login("x" + password);
check("비밀번호 틀림은 401", bad.status === 401, bad.status);
const good = await login(password);
check("비밀번호 맞음은 200", good.status === 200, good.status);
let cookie = [good.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]).join("; ");
check("로그인 응답이 쿠키를 준다", cookie.length > 0);

check("쿠키 없이 /api/sessions는 401", (await get("/api/sessions")).status === 401);
const authed = await get("/api/sessions", { cookie });
const updateStatus = await get("/api/system/update", { cookie });
check("자동 실행 장치 없이 띄우면 앱 안 업데이트가 꺼져 있다", updateStatus.status === 200 && updateStatus.json.canInstall === false && updateStatus.json.install?.phase === "idle", JSON.stringify(updateStatus.json));
check("앱 안 업데이트 시작은 로그인이 필요하다", (await req("POST", "/api/system/update/install")).status === 401);
const refused = await req("POST", "/api/system/update/install", { headers: { cookie } });
check("꺼져 있으면 앱 안 업데이트를 시작하지 않는다", refused.status === 400, String(refused.status));
check("쿠키로 /api/sessions는 200", authed.status === 200, authed.status);
const pushKey = (await get("/api/push/vapid", { cookie })).json?.vapidPublic;
check("설치본이 푸시 알림 키를 스스로 만든다", typeof pushKey === "string" && pushKey.length > 40, pushKey);
check("푸시 개인키는 .env 밖으로 나가지 않는다", !JSON.stringify((await get("/api/system/info", { cookie })).json).includes("PRIVATE"));
// 잊은 비밀번호: 예전 안내대로 저장 파일을 지우면 로그인이 막힌다. 재설정 도구로 되살아나야 한다.
const dataDirNow = JSON.parse(fs.readFileSync(path.join(base, "config.json"), "utf8")).dataDir;
fs.rmSync(path.join(dataDirNow, "auth-password.json"));
check("저장 파일이 없으면 원래 비밀번호로 로그인할 수 없다", (await login(password)).status === 401);
const tool = (arg, input) => spawnSync(process.execPath, [path.join(serverDir, "index.mjs"), arg], { cwd: base, env: baseEnv, input, encoding: "utf8", timeout: 30000, windowsHide: true });
const newPassword = crypto.randomBytes(12).toString("hex");
check("재설정 도구는 짧은 비밀번호를 거절한다", tool("--reset-password", "short\n").status === 1);
check("재설정 도구는 두 입력이 다르면 거절한다", tool("--reset-password", `${newPassword}\nother-value-1\n`).status === 1);
const reset = tool("--reset-password", `${newPassword}\n${newPassword}\n`);
check("재설정 도구가 성공한다", reset.status === 0, reset.stdout + reset.stderr);
check("실행 중인 서버가 재시작 없이 새 비밀번호를 받는다", (await login(newPassword)).status === 200);
check("재설정 뒤 옛 비밀번호는 401", (await login(password)).status === 401);
check("재설정 뒤 기존 기기의 로그인이 풀린다", (await get("/api/sessions", { cookie })).status === 401);
const remoteOff = tool("--remote-off");
check("삭제 때 쓰는 폰 접속 끄기가 켜 둔 적 없어도 정상 종료한다", remoteOff.status === 0, remoteOff.stderr);
const relogin = await login(newPassword);
const recookie = [relogin.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]).join("; ");
const out_ = await req("POST", "/api/auth/logout", { headers: { cookie: recookie } });
check("로그아웃 응답이 쿠키를 지운다", out_.status === 200 && /aether_session=;/.test([out_.headers["set-cookie"] ?? []].flat().join("; ")), out_.headers["set-cookie"]);
check("로그아웃한 쿠키는 서버에서도 무효(401)", (await get("/api/sessions", { cookie: recookie })).status === 401);
// 아래 단계는 재설정 뒤의 로그인을 쓴다. 로그아웃한 쿠키는 쓸 수 없으니 새로 로그인한다.
cookie = [(await login(newPassword)).headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]).join("; ");
// 새 버전 확인 주소: 묶음 package.json의 aetherUpdateUrl이 있으면 실행 중 서버에서 켜져 있어야 하고(묶음에 박힌 값이 아니라 복사본을 기준으로 비교), 없으면 꺼져 있어야 한다.
const bundledUrl = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8")).aetherUpdateUrl;
const upd = await get("/api/system/update", { cookie });
check(bundledUrl ? "새 버전 확인이 켜져 있고 주소가 묶음 값이다" : "주소 없는 묶음은 새 버전 확인이 꺼져 있다",
  bundledUrl ? upd.json?.enabled === true && upd.json?.pageUrl === `${bundledUrl}/` : upd.status === 200 && upd.json?.enabled === false, JSON.stringify(upd.json));
check("평소 서버는 setup/complete를 열지 않는다", (await req("POST", "/api/setup/complete", { headers: { cookie, origin }, body: {} })).status === 404);

checkAvailability((await get("/api/providers/availability", { cookie })).json?.availability ?? {}, "재실행");

const rs = await req("POST", "/api/system/restart", { headers: { cookie } });
check("재시작 API 200", rs.status === 200, rs.status);
await within(second, 10000);
check("재시작 API 뒤 종료 코드 1", second.code === 1, second.code);

// 포트를 먼저 차지해 두고 부팅 실패 이유가 start.log에 남는지 본다.
const hog = net.createServer(); await new Promise((r) => hog.listen(PORT, "127.0.0.1", r));
const startLog = path.join(base, "start.log");
const logSize = fs.statSync(startLog).size;
const blocked = launch(); await within(blocked, 30000);
const logged = fs.readFileSync(startLog).subarray(logSize).toString("utf8");
check("포트가 막히면 서버가 코드 1로 끝난다", blocked.code === 1, blocked.code);
check("start.log만 봐도 포트 충돌 이유를 알 수 있다", /EADDRINUSE/.test(logged), logged.trim().slice(0, 120));
if (blocked.code === undefined) { blocked.child.kill(); await within(blocked, 5000); }
await new Promise((r) => hog.close(r));

} catch (e) {
  check("재실행 단계가 끝까지 실행됨", false, e?.message ?? e);
  tail(childLog);
}

killAll();
await within(second, 5000);
if (second.code === undefined) { for (const h of [second]) try { h.child.kill("SIGKILL"); } catch {} await within(second, 3000); }
check("자식 프로세스가 끝났다", second.code !== undefined);
check("포트가 비었다", !(await portBusy()));
console.log(failed === 0 ? "전체 PASS" : `FAIL ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
