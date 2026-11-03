// 설치 묶음으로 실제 세션을 돌려 보는 실기 시험. 맥·윈도우 공통. 사용: <묶음의 node> installed-session-check.mjs --app <묶음 폴더> --base <빈 임시 폴더>
// smoke.mjs는 세션을 띄우지 않으므로 그 뒤에 돌린다: 진짜 AI 실행, 대화 이어 가기, 중단 뒤 프로세스 잔존, 서버 강제 종료 뒤 복원, 백업과 복원, 부팅 실패 기록, 가상 터미널.
// 운영 데이터에 닿지 않는다: 데이터·임시 폴더는 --base 아래, 포트는 48810. 작은 모델(haiku)로 몇 턴만 쓴다.
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const app = arg("app") && path.resolve(arg("app"));
const base = arg("base") && path.resolve(arg("base"));
if (!app || !base) { console.error("사용: installed-session-check.mjs --app <묶음 폴더> --base <빈 임시 폴더>"); process.exit(2); }
const win = process.platform === "win32";

// 가상 터미널 단독 시험: 멈출 수 있어 별도 프로세스로 돌리고 밖에서 시간을 잰다.
function claudeTarget() {
  if (!win) return execSync("command -v claude", { encoding: "utf8" }).trim();
  const lines = execSync("where.exe claude", { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const exe = lines.find((l) => l.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  const cmd = lines.find((l) => l.toLowerCase().endsWith(".cmd"));
  const m = cmd && [...fs.readFileSync(cmd, "utf8").matchAll(/"%~?dp0%?\\?([^"]*\.exe)"/gi)].pop();
  return m ? path.join(path.dirname(cmd), m[1]) : cmd;
}
if (process.argv.includes("--pty-probe")) {
  const pty = createRequire(path.join(app, "server", "x.js"))("node-pty");
  let out = "";
  const t = pty.spawn(claudeTarget(), ["--version"], { cols: 80, rows: 24 });
  t.onData((d) => { out += d; });
  t.onExit(({ exitCode }) => { console.log(`exit=${exitCode} out=${out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim().slice(0, 60)}`); setTimeout(() => process.exit(0), 3000); });
  setTimeout(() => {}, 25000);
} else {
  await main();
}

async function main() {
if (fs.existsSync(base) && fs.readdirSync(base).length > 0) { console.error("--base가 비어 있지 않아 중단한다."); process.exit(2); }
const PORT = 48810;
const tmp = path.join(base, "tmp"); const work = path.join(base, "work"); const dataDir = path.join(base, "data");
for (const d of [tmp, work]) fs.mkdirSync(d, { recursive: true });
const password = crypto.randomBytes(12).toString("hex");
let failed = 0;
const check = (name, ok, why = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && why ? ` — ${String(why).split("\n")[0].slice(0, 200)}` : ""}`); if (!ok) failed++; };
const info = (s) => console.log(`INFO ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AETHER_") && k !== "PORT"));
Object.assign(env, { AETHER_APP_BASE: base, AETHER_SETUP_NO_BROWSER: "1", TMPDIR: tmp, TEMP: tmp, TMP: tmp, PORT: String(PORT) });
const out = fs.openSync(path.join(base, "child.log"), "a");
let server;
function launch() {
  const child = spawn(process.execPath, [path.join(app, "server", "index.mjs")], { cwd: base, env, stdio: ["ignore", out, out] });
  const h = { child, code: undefined };
  h.exited = new Promise((res) => child.once("exit", (c) => { h.code = c ?? -1; res(c); }));
  server = h;
  return h;
}
process.on("exit", () => { try { server?.child.kill(); } catch {} });
const within = (h, ms) => Promise.race([h.exited, sleep(ms)]);
let cookie = "";
const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 60000, headers: { ...(cookie ? { cookie } : {}), ...headers, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
    const c = []; res.on("data", (x) => c.push(x));
    res.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text, headers: res.headers }); });
  });
  r.on("timeout", () => r.destroy(new Error("요청 시간 초과")));
  r.on("error", reject);
  r.end(data);
});
async function waitHealth(h) {
  for (let i = 0; i < 120 && h.code === undefined; i++) {
    try { const r = await req("GET", "/api/health"); if (r.status === 200) return r.json; } catch {}
    await sleep(500);
  }
}
async function login() {
  cookie = "";
  const r = await req("POST", "/api/auth/login", { password });
  cookie = [r.headers["set-cookie"] ?? []].flat().map((c) => c.split(";")[0]).join("; ");
  return r.status === 200;
}
// 프로세스 목록. 명령줄은 표식 찾기에만 쓰고 출력하지 않는다.
function procs() {
  if (win) {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 1 << 26 });
    return JSON.parse(raw).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine ?? "" }));
  }
  return execSync("ps -axo pid=,ppid=,command=", { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return { pid: +m[1], ppid: +m[2], name: path.basename(m[3].split(" ")[0]), cmd: m[3] };
  });
}
function descendants(root) {
  const all = procs(); const out = []; const seen = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const p of all) if (!seen.has(p.pid) && seen.has(p.ppid)) { seen.add(p.pid); out.push(p); grew = true; } }
  return out;
}
const names = (list) => [...new Set(list.map((p) => p.name))].join(", ") || "(없음)";
const events = async (id) => (await req("GET", `/api/sessions/${id}/events?before=999999999&limit=300`)).text;
async function waitText(id, want, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) { if ((await events(id)).includes(want)) return true; await sleep(2000); }
  return false;
}
const send = (id, text) => req("POST", `/api/sessions/${id}/message`, { text });
const longCmd = (n) => win ? `ping -n ${n} 127.0.0.1` : `sleep ${n}`;
const marked = (n) => procs().filter((p) => (win ? p.cmd.includes(`-n ${n} 127.0.0.1`) : p.cmd.includes(`sleep ${n}`)) && !p.cmd.includes("Run this exact") && !/claude|powershell/i.test(p.name));

try {
// ── 첫 설정 ──
const first = launch();
check("첫 실행 부팅", !!(await waitHealth(first)), first.code);
const saved = await req("POST", "/api/setup/complete", { terms: true, password, port: PORT, dataDir, projectRoot: work }, { origin: `http://127.0.0.1:${PORT}` });
check("첫 설정 저장", saved.status === 200, saved.text);
await within(first, 10000); if (first.code === undefined) first.child.kill();
await within(first, 5000);

// ── 부팅 실패 기록: 포트를 먼저 차지해 둔다 ──
const hog = net.createServer(); await new Promise((r) => hog.listen(PORT, "127.0.0.1", r));
const startLog = path.join(base, "start.log");
const before = fs.existsSync(startLog) ? fs.statSync(startLog).size : 0;
const blocked = launch(); await within(blocked, 30000);
check("포트가 막히면 서버가 0이 아닌 코드로 끝난다", blocked.code !== undefined && blocked.code !== 0, blocked.code);
const after = fs.existsSync(startLog) ? fs.readFileSync(startLog).subarray(before).toString("utf8") : "";
check("부팅 실패가 start.log에 남는다", after.length > 0);
check("start.log만 봐도 실패 이유(포트 충돌)를 알 수 있다", /EADDRINUSE|포트|port/i.test(after), after.trim().slice(0, 120));
if (blocked.code === undefined) { blocked.child.kill(); await within(blocked, 5000); }
await new Promise((r) => hog.close(r));

// ── 평소 서버 ──
let s = launch();
check("평소 서버 부팅", !!(await waitHealth(s)), s.code);
check("로그인", await login());
const av = (await req("GET", "/api/providers/availability")).json?.availability ?? {};
info(`availability: ${Object.entries(av).map(([k, v]) => `${k}=${v.available ? "ok" : v.reason}`).join(", ")}`);
const usable = (await req("GET", "/api/providers")).status;
info(`providers 응답 ${usable}`);

// ── 진짜 세션: 쓸 수 있는 provider마다 한 턴 ──
const created = await req("POST", "/api/sessions", { provider: "claude", model: "haiku", cwd: work, permissionMode: "full" });
check("Claude 세션 생성", created.status === 201, `${created.status} ${created.text}`);
const id = created.json?.id;
if (id) {
  await send(id, "What is 12345+1? Reply with digits only.");
  check("첫 턴 응답(실제 실행)", await waitText(id, "12346", 120000));
  await send(id, "Add 1 to your previous answer. Reply with digits only.");
  check("둘째 턴이 앞 대화를 기억", await waitText(id, "12347", 120000));

  // ── 중단 뒤 잔존: AI가 오래 걸리는 명령을 돌리는 도중 멈춘다 ──
  console.log("USER 지금부터 약 1분간 화면에 창이 뜨거나 깜빡이는지 봐 주세요.");
  await send(id, `Run this exact shell command with your shell tool and wait for it to finish: ${longCmd(91)}`);
  let seen = false;
  for (const end = Date.now() + 90000; Date.now() < end && !seen;) { seen = marked(91).length > 0; if (!seen) await sleep(2000); }
  check("AI가 긴 명령을 실행했다", seen);
  info(`실행 중 서버 아래 프로세스: ${names(descendants(s.child.pid))}`);
  const ir = await req("POST", `/api/sessions/${id}/interrupt`);
  info(`중단 응답 ${ir.status}`);
  await sleep(8000);
  const left = marked(91);
  check("중단 뒤 긴 명령이 남지 않는다", left.length === 0, `${left.length}개 남음: ${names(left)}`);
  for (const p of left) try { process.kill(p.pid); } catch {}

  // ── 서버 강제 종료 뒤: 남는 프로세스와 세션 복원 ──
  await send(id, `Run this exact shell command with your shell tool and wait for it to finish: ${longCmd(92)}`);
  seen = false;
  for (const end = Date.now() + 90000; Date.now() < end && !seen;) { seen = marked(92).length > 0; if (!seen) await sleep(2000); }
  check("강제 종료 전 긴 명령 실행", seen);
  const under = descendants(s.child.pid);
  s.child.kill("SIGKILL");
  await within(s, 5000); await sleep(5000);
  const alive = new Set(procs().map((p) => p.pid));
  const orphan = under.filter((p) => alive.has(p.pid));
  check("서버가 강제로 꺼지면 아래 프로세스도 꺼진다", orphan.length === 0, `${orphan.length}개 남음: ${names(orphan)}`);
  for (const p of orphan) try { process.kill(p.pid); } catch {}
  s = launch();
  check("강제 종료 뒤 재부팅", !!(await waitHealth(s)), s.code);
  await login();
  const list = (await req("GET", "/api/sessions")).text;
  check("강제 종료 뒤 세션 목록에 남아 있다", list.includes(id));
  await send(id, "Add 1 to the last number you computed by addition earlier in this conversation. Reply with digits only.");
  check("강제 종료 뒤 대화가 이어진다", await waitText(id, "12348", 180000));
}

// ── 백업과 복원 ──
const b = await req("POST", "/api/system/backups");
check("백업 만들기", b.status === 201, `${b.status} ${b.text.slice(0, 120)}`);
const list2 = (await req("GET", "/api/system/backups")).json;
const backupId = list2?.items?.[0]?.id;
const r1 = backupId ? await req("POST", "/api/system/backups/restore", { id: backupId }) : { status: 0 };
check("복원 예약", r1.status === 200, r1.status);
const rs = await req("POST", "/api/system/restart");
check("재시작 API", rs.status === 200, rs.status);
await within(s, 15000);
check("재시작 API 뒤 코드 1로 끝난다", s.code === 1, s.code);
s = launch();
check("복원 적용 뒤 부팅", !!(await waitHealth(s)), s.code);
await login();
const last = (await req("GET", "/api/system/backups")).json?.last;
check("복원이 성공으로 기록된다(열린 파일 교체 포함)", last?.ok === true, JSON.stringify(last));
if (id) check("복원 뒤 세션이 남아 있다", (await req("GET", "/api/sessions")).text.includes(id));
if (id) await req("DELETE", `/api/sessions/${id}`);
await sleep(3000);
info(`세션 삭제 뒤 서버 아래 프로세스: ${names(descendants(s.child.pid))}`);
} catch (e) {
  check("시험이 끝까지 실행됨", false, e?.message ?? e);
}
try { server.child.kill(); } catch {}
await within(server, 8000);

// ── 가상 터미널(로그인 화면에 쓰는 부품): 멈추는지 밖에서 잰다 ──
const self = process.argv[1];
const t0 = Date.now();
const p = spawnSync(process.execPath, [self, "--app", app, "--base", base, "--pty-probe"], { encoding: "utf8", timeout: 40000 });
check("가상 터미널로 claude --version 실행", /exit=0/.test(p.stdout ?? ""), (p.stdout || p.stderr || "").slice(0, 200));
check("가상 터미널 뒤 프로세스가 스스로 끝난다", p.status === 0 && !p.error, p.error?.code ?? p.status);
info(`가상 터미널 ${Date.now() - t0}ms, 출력: ${(p.stdout ?? "").trim().slice(0, 100)}, 오류 첫 줄: ${(p.stderr ?? "").split("\n")[0].slice(0, 160)}`);

console.log(failed === 0 ? "전체 PASS" : `FAIL ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
}
