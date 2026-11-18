/**
 * 관리 앱 약속: 화면 등록 목록, 관리 API(토큰), 부모 감시, 정적 제공의 즉시 반영.
 * 자식 서버는 임시 폴더만 쓴다. 모델 호출 0.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScreenRegistry } from "../routes/screens";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "a".repeat(64);
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tmp = (n: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aether-admin-${n}-`)));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

function fakeDist(): string {
  const d = tmp("dist");
  fs.writeFileSync(path.join(d, "index.html"), "<!doctype html>ADMIN_MARKER");
  return d;
}

console.log("\n=== (a) 화면 등록 목록 ===");
{
  const dir = tmp("reg");
  const dist = fakeDist();
  const file = path.join(dir, "screens.json");
  const on = createScreenRegistry({ file, initial: [{ prefix: "/", dir: dist }] });
  check(on.rootDir() === dist && !fs.existsSync(file), "파일이 없으면 첫 값을 쓰고 파일로 쓰지 않는다");
  check(createScreenRegistry({ file, initial: [] }).rootDir() === null, "첫 값이 비면 rootDir은 null");
  const noIndex = tmp("noindex");
  check((on.replace([{ prefix: "/a", dir: dist }]) as any).error === "prefix_unsupported", "접두어가 /가 아니면 거절");
  check((on.replace([{ prefix: "/", dir: dist }, { prefix: "/", dir: dist }]) as any).error === "prefix_unsupported", "항목이 둘이면 거절");
  check((on.replace([{ prefix: "/", dir: "relative" }]) as any).error === "dir_invalid", "상대경로 거절");
  check((on.replace([{ prefix: "/", dir: noIndex }]) as any).error === "dir_invalid", "index.html 없으면 거절");
  check((on.replace("x") as any).error === "body_invalid", "배열이 아니면 거절");
  check(on.replace([{ prefix: "/", dir: dist }]).ok && createScreenRegistry({ file, initial: [] }).rootDir() === dist, "저장 뒤 다시 읽는다");
  check(on.replace([]).ok && createScreenRegistry({ file, initial: [{ prefix: "/", dir: dist }] }).rootDir() === null, "빈 목록 저장은 첫 값을 이긴다");
  fs.writeFileSync(file, "{깨짐");
  check(createScreenRegistry({ file, initial: [{ prefix: "/", dir: dist }] }).rootDir() === null, "깨진 파일이면 []");
  for (const d of [dir, dist, noIndex]) fs.rmSync(d, { recursive: true, force: true });
}

console.log("\n=== (b) supervision은 환경 변수를 지운다 ===");
{
  process.env.AETHER_ADMIN_TOKEN = TOKEN;
  process.env.AETHER_PARENT_WATCH = "1";
  const sup = await import("../supervision");
  check(process.env.AETHER_ADMIN_TOKEN === undefined && process.env.AETHER_PARENT_WATCH === undefined, "import 뒤 두 환경 변수가 지워졌다");
  check(sup.adminToken === TOKEN, "토큰을 모듈이 들고 있다");
}

// ── 자식 서버 도구 ──
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}
function req(port: number, method: string, p: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (data) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(data)); }
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => { let j: any; try { j = JSON.parse(t); } catch { /* 본문이 JSON이 아님 */ } resolve({ status: res.statusCode ?? 0, text: t, json: j }); });
    });
    r.on("error", reject);
    r.end(data);
  });
}
type Child = { child: ChildProcess; out: () => string; exited: Promise<number | null> };
function launch(base: string, env: Record<string, string>): Child {
  // 운영 데이터를 건드리지 않도록 설정·데이터 모두 임시 base 안에 가둔다.
  if (!path.resolve(base).startsWith(os.tmpdir()) && !fs.realpathSync(base).startsWith(fs.realpathSync(os.tmpdir()))) throw new Error("임시 폴더가 아니다");
  let out = "";
  const child = spawn(path.join(SERVER_DIR, "node_modules", ".bin", "tsx"), ["start.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, AETHER_APP_BASE: base, AETHER_SETUP_NO_BROWSER: "1", AETHER_PARENT_WATCH: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return { child, out: () => out, exited };
}
async function until(f: () => boolean | Promise<boolean>, ms = 25000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await delay(200); }
  return false;
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, delay(ms).then(() => "timeout" as const)]);

console.log("\n=== (c) 자식 프로세스: 첫 설정 → 일반 서버 ===");
{
  const base = tmp("base");
  const dataDir = path.join(base, "data");
  const dist = fakeDist();
  const killAll: Child[] = [];
  try {
    // 첫 설정 단계
    const p1 = await freePort();
    const a = launch(base, { AETHER_ADMIN_TOKEN: TOKEN, PORT: String(p1) });
    killAll.push(a);
    const re = /aether-listening (\d+) setup/;
    check(await until(() => re.test(a.out())), "첫 설정 서버가 'aether-listening <port> setup'을 쓴다", a.out().slice(-300));
    a.child.stdin!.end();
    check((await within(a.exited, 5000)) !== "timeout", "첫 설정: stdin을 닫으면 5초 안에 끝난다");

    // 일반 단계
    const p2 = await freePort();
    fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ authMode: "off", dataDir, port: p2, webDist: dist, search: false, webAutoBuild: false }));
    check(path.resolve(dataDir).startsWith(path.resolve(base)), "dataDir는 임시 폴더 안");
    const b = launch(base, { AETHER_ADMIN_TOKEN: TOKEN });
    killAll.push(b);
    check(await until(() => b.out().includes(`aether-listening ${p2}\n`)), "일반 서버가 'aether-listening <port>'를 쓴다", b.out().slice(-400));
    check(!/aether-listening \d+ setup/.test(b.out()), "일반 서버는 setup 꼬리표가 없다");
    const auth = { token: TOKEN };
    const g = await req(p2, "GET", "/api/admin/screens", auth);
    check(g.status === 200 && g.json?.screens?.[0]?.dir === dist, "GET screens 200", g.text);
    const st = await req(p2, "GET", "/api/admin/status", auth);
    check(st.status === 200 && st.json?.runningSessions === 0, "GET status 200", st.text);
    check((await req(p2, "GET", "/api/admin/screens", { token: "b".repeat(64) })).status === 401, "틀린 토큰은 401");
    const noTok = await req(p2, "GET", "/api/admin/screens");
    check(noTok.status === 401 && noTok.json?.error === "unauthorized", "토큰이 없으면 401");
    check((await req(p2, "GET", "/")).text.includes("ADMIN_MARKER"), "/ 가 화면 HTML");
    const put0 = await req(p2, "PUT", "/api/admin/screens", { ...auth, body: { screens: [] } });
    check(put0.status === 200 && put0.json?.screens?.length === 0, "PUT [] 200", put0.text);
    const gone = await req(p2, "GET", "/");
    check(gone.status === 404 && gone.json !== undefined, "PUT [] 뒤 / 는 JSON 404(재시작 없이)", gone.text.slice(0, 80));
    const put1 = await req(p2, "PUT", "/api/admin/screens", { ...auth, body: { screens: [{ prefix: "/", dir: dist }] } });
    check(put1.status === 200, "다시 PUT 200", put1.text);
    check((await req(p2, "GET", "/")).text.includes("ADMIN_MARKER"), "다시 등록하면 / 가 HTML");
    const bad = await req(p2, "PUT", "/api/admin/screens", { ...auth, body: { screens: [{ prefix: "/x", dir: dist }] } });
    check(bad.status === 400 && bad.json?.error === "prefix_unsupported", "잘못된 값은 400", bad.text);
    b.child.stdin!.end();
    const code = await within(b.exited, 15000);
    check(code === 0, "일반 서버: stdin을 닫으면 코드 0으로 끝난다", code);
  } finally {
    for (const k of killAll) k.child.kill("SIGKILL");
    await delay(300);
    for (const d of [base, dist]) fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log("\n=== (d) 토큰 없이 띄우면 관리 API가 없다 ===");
{
  const base = tmp("base-notoken");
  const dist = fakeDist();
  let c: Child | undefined;
  try {
    const p = await freePort();
    fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ authMode: "off", dataDir: path.join(base, "data"), port: p, webDist: dist, search: false, webAutoBuild: false }));
    c = launch(base, { AETHER_ADMIN_TOKEN: "short" });
    check(await until(() => c!.out().includes(`aether-listening ${p}\n`)), "서버가 뜬다", c.out().slice(-300));
    const r = await req(p, "GET", "/api/admin/screens", { token: "short" });
    check(r.status === 404, "짧은 토큰은 무시되어 404", r.status);
  } finally {
    c?.child.kill("SIGKILL");
    await delay(300);
    for (const d of [base, dist]) fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log("\n=== (e) 감시가 꺼져 있으면 stdin이 닫혀도 계속 산다(launchd 경로) ===");
{
  const base = tmp("base-nowatch");
  const dist = fakeDist();
  let c: Child | undefined;
  try {
    const p = await freePort();
    fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ authMode: "off", dataDir: path.join(base, "data"), port: p, webDist: dist, search: false, webAutoBuild: false }));
    c = launch(base, { AETHER_PARENT_WATCH: "" });
    const up = () => req(p, "GET", "/api/health").then((r) => r.status === 200, () => false);
    check(await until(up), "서버가 뜬다", c.out().slice(-300));
    c.child.stdin!.end();
    await delay(2000);
    check(c.child.exitCode === null && (await up()), "stdin이 닫혀도 살아 있다");
  } finally {
    c?.child.kill("SIGKILL");
    await delay(300);
    for (const d of [base, dist]) fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log(`\nadmin_screens: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
