/**
 * static 선택 부가 — dist 없음·꺼짐·손상에서 API·SSE가 사는지,
 * 켠 뒤 SPA 우회·asset immutable·/api 404 JSON·CSP,
 * 테스트가 저장소 web/을 안 지우는지.
 * 모델 호출 0.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { createStaticAddon } from "../routes/static";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.resolve(SERVER_DIR, "..", "web");
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(host: string, port: number, method: string, p: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, path: p, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

function writeFakeDist(dist: string) {
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>SPA_MARKER");
  fs.writeFileSync(path.join(dist, "assets", "app.abc123.js"), "console.log(1)");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitHealthy(port: number, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await req("127.0.0.1", port, "GET", "/api/health");
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await delay(200);
  }
  return false;
}

async function startServer(extraEnv: Record<string, string>): Promise<{ child: ChildProcess; port: number; logs: () => string; dataDir: string }> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-data-"));
  let logs = "";
  const child = spawn("npx", ["tsx", "index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      AETHER_HOST: "127.0.0.1",
      AETHER_DATA_DIR: dataDir,
      AETHER_SEARCH: "0",
      AETHER_AUTH_MODE: "off",
      ...extraEnv,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (logs += d));
  child.stderr?.on("data", (d) => (logs += d));
  const ok = await waitHealthy(port);
  if (!ok) console.log("  ⚠️ 서버가 시간내 안 떴음. 로그:\n" + logs.split("\n").slice(0, 12).join("\n"));
  return { child, port, logs: () => logs, dataDir };
}

async function stopServer(child: ChildProcess, dataDir: string) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await delay(600);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function assertApiSse(port: number, label: string) {
  const health = await req("127.0.0.1", port, "GET", "/api/health");
  check(health.status === 200 && /"ok":\s*true/.test(health.body), `${label} 건강 응답 200`);
  const stream = await req("127.0.0.1", port, "GET", "/api/sessions/nope/stream?since=0");
  check(
    stream.status === 404 && /세션을 찾을 수 없어요/.test(stream.body) && String(stream.headers["content-type"]).includes("json"),
    `${label} SSE 경로가 JSON 404로 살아 있다`,
    `status=${stream.status} ct=${stream.headers["content-type"]}`,
  );
  return health;
}

async function listenApp(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.on("error", reject);
  });
}

const webBefore = fs.existsSync(WEB_DIR);

console.log("\n=== 설치 함수 단위 ===");
{
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-missing-"));
  const addon = createStaticAddon({ enabled: true, distDir: missing });
  check(addon.helmetOptions()?.contentSecurityPolicy !== false, "dist 없어도 CSP 고정(등록이 늦게 생길 수 있다)");
  fs.rmSync(missing, { recursive: true, force: true });
}
{
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-off-"));
  writeFakeDist(dist);
  const addon = createStaticAddon({ enabled: false, distDir: dist });
  check(addon.helmetOptions()?.contentSecurityPolicy !== false, "꺼져 있어도 CSP 고정");
  fs.rmSync(dist, { recursive: true, force: true });
}
{
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-broken-"));
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "1");
  const addon = createStaticAddon({ enabled: true, distDir: dist });
  check(addon.helmetOptions()?.contentSecurityPolicy !== false, "손상 dist도 CSP 고정");
  fs.rmSync(dist, { recursive: true, force: true });
}
{
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-on-"));
  writeFakeDist(dist);
  const addon = createStaticAddon({ enabled: true, distDir: dist });
  const csp = addon.helmetOptions()?.contentSecurityPolicy;
  check(csp !== false && csp !== undefined, "켜진 dist는 CSP 옵션이 있다");
  fs.rmSync(dist, { recursive: true, force: true });
}

console.log("\n=== 설치 함수 미니 서버 (조립 없이) ===");
{
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-mini-"));
  writeFakeDist(dist);
  const addon = createStaticAddon({ enabled: true, distDir: dist });
  const app = express();
  app.use(helmet(addon.helmetOptions()));
  app.use("/api/{*splat}", (_req, res) => {
    res.status(404).json({ error: "API 경로 없음" });
  });
  addon.mount(app);
  const { port, close } = await listenApp(app);
  try {
    const root = await req("127.0.0.1", port, "GET", "/");
    check(root.body.includes("SPA_MARKER") && root.headers["cache-control"] === "no-cache", "미니 / → index.html(no-cache)");
    check(root.headers["content-security-policy"] !== undefined, "미니 static 켜짐 CSP");
    const deep = await req("127.0.0.1", port, "GET", "/deep/link/route");
    check(deep.body.includes("SPA_MARKER"), "미니 딥링크 → index.html");
    const asset = await req("127.0.0.1", port, "GET", "/assets/app.abc123.js");
    check(String(asset.headers["cache-control"] ?? "").includes("immutable"), "미니 asset immutable");
    const api404 = await req("127.0.0.1", port, "GET", "/api/zzz");
    check(api404.status === 404 && /API 경로 없음/.test(api404.body) && String(api404.headers["content-type"]).includes("json"), "미니 /api 404 JSON");
    const apikeys = await req("127.0.0.1", port, "GET", "/apikeys");
    check(apikeys.body.includes("SPA_MARKER"), "미니 /apikeys → index.html");
  } finally {
    await close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

async function main() {
  console.log("\n=== F1 dist 없음 — 조립부 API·SSE ===");
  {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-f1-"));
    const { child, port, logs, dataDir } = await startServer({ AETHER_WEB_DIST: empty });
    try {
      check(/백엔드 기동/.test(logs()), "F1 백엔드 기동");
      check(/static 서빙 스킵/.test(logs()), "F1 static skip 로그");
      const health = await assertApiSse(port, "F1");
      check(health.headers["content-security-policy"] !== undefined, "F1 건강 응답에 CSP 있음");
      const root = await req("127.0.0.1", port, "GET", "/");
      check(!root.body.includes("SPA_MARKER"), "F1 / 가 화면 HTML이 아니다");
    } finally {
      await stopServer(child, dataDir);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }

  console.log("\n=== F2 꺼짐 — 조립부 API·SSE ===");
  {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-f2-"));
    writeFakeDist(dist);
    const { child, port, logs, dataDir } = await startServer({
      AETHER_WEB_DIST: dist,
      AETHER_SERVE_STATIC: "0",
    });
    try {
      check(/백엔드 기동/.test(logs()), "F2 백엔드 기동");
      check(/static 서빙 꺼짐/.test(logs()), "F2 꺼짐 로그");
      const health = await assertApiSse(port, "F2");
      check(health.headers["content-security-policy"] !== undefined, "F2 건강 응답에 CSP 있음");
      const root = await req("127.0.0.1", port, "GET", "/");
      check(!root.body.includes("SPA_MARKER"), "F2 dist가 있어도 화면을 안 붙인다");
    } finally {
      await stopServer(child, dataDir);
      fs.rmSync(dist, { recursive: true, force: true });
    }
  }

  console.log("\n=== F3 손상 dist — 조립부 API·SSE ===");
  {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-f3-"));
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "1");
    const { child, port, logs, dataDir } = await startServer({ AETHER_WEB_DIST: dist });
    try {
      check(/백엔드 기동/.test(logs()), "F3 백엔드 기동");
      check(/static 서빙 스킵/.test(logs()), "F3 손상 dist skip 로그");
      const health = await assertApiSse(port, "F3");
      check(health.headers["content-security-policy"] !== undefined, "F3 건강 응답에 CSP 있음");
    } finally {
      await stopServer(child, dataDir);
      fs.rmSync(dist, { recursive: true, force: true });
    }
  }

  console.log("\n=== static 켜짐 — 조립부 SPA·CSP ===");
  {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-static-on-boot-"));
    writeFakeDist(dist);
    const { child, port, logs, dataDir } = await startServer({ AETHER_WEB_DIST: dist });
    try {
      check(/static 서빙 활성/.test(logs()), "static 활성 로그");
      await assertApiSse(port, "static on");
      const root = await req("127.0.0.1", port, "GET", "/");
      check(root.body.includes("SPA_MARKER") && root.headers["cache-control"] === "no-cache", "조립 / → index.html(no-cache)");
      check(root.headers["content-security-policy"] !== undefined, "조립 static 켜짐 CSP");
      const deep = await req("127.0.0.1", port, "GET", "/deep/link/route");
      check(deep.body.includes("SPA_MARKER"), "조립 딥링크 → index.html");
      const asset = await req("127.0.0.1", port, "GET", "/assets/app.abc123.js");
      check(String(asset.headers["cache-control"] ?? "").includes("immutable"), "조립 asset immutable");
      const api404 = await req("127.0.0.1", port, "GET", "/api/zzz");
      check(
        api404.status === 404 && /API 경로 없음/.test(api404.body) && String(api404.headers["content-type"]).includes("json"),
        "조립 /api 404 JSON",
      );
      const apikeys = await req("127.0.0.1", port, "GET", "/apikeys");
      check(apikeys.body.includes("SPA_MARKER"), "조립 /apikeys → index.html");
    } finally {
      await stopServer(child, dataDir);
      fs.rmSync(dist, { recursive: true, force: true });
    }
  }

  const webAfter = fs.existsSync(WEB_DIR);
  check(webBefore && webAfter, "실행 전후 저장소 web/이 남아 있다");

  console.log("\n" + "─".repeat(56));
  console.log(`static_addon: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("static_addon 오류:", e);
  process.exit(1);
});
