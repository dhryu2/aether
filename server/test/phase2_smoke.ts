/**
 * Phase 2 백엔드 스모크 (프론트 없이). 서버를 여러 env 모드로 자식프로세스 기동 후 검증.
 *   Mode1 기본(API-only):  T1 부팅무크래시 · T9 helmet · T8a static skip · T2 body limit · T3 에러핸들러
 *   Mode3 가짜 dist:        T8 SPA fallback · asset immutable · /api 404 JSON · CSP(static)
 *   Mode4 compression+partial(+haiku 1턴): T5 SSE 비압축 · T7 partial SSE도착·디스크제외 · T6 replay
 * 실행: npx tsx test/phase2_smoke.ts  (Mode 4는 AETHER_SMOKE_HAIKU=1 일 때만)
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(SERVER_DIR, "data");
const PORT = 8799;
const BASE = { host: "localhost", port: PORT };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let passCount = 0;
let failCount = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? passCount++ : failCount++;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(method: string, p: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ ...BASE, path: p, method, headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/** SSE를 raw http로 열어 파싱된 data 이벤트를 sink로. 반환된 destroy로 닫음. */
function openSSE(p: string, sink: (ev: any) => void, headers?: Record<string, string>): { destroy: () => void; headersP: Promise<http.IncomingHttpHeaders> } {
  let resolveHeaders: (h: http.IncomingHttpHeaders) => void;
  const headersP = new Promise<http.IncomingHttpHeaders>((res) => (resolveHeaders = res));
  const r = http.request({ ...BASE, path: p, method: "GET", headers }, (res) => {
    resolveHeaders(res.headers);
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            try { sink(JSON.parse(line.slice(6))); } catch { /* skip */ }
          }
        }
      }
    });
  });
  r.on("error", () => {});
  r.end();
  return { destroy: () => r.destroy(), headersP };
}

async function waitHealthy(timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await req("GET", "/api/health");
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await delay(300);
  }
  return false;
}

const TEST_DATA_DIR = process.env.AETHER_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "aether-smoke-"));

async function startServer(extraEnv: Record<string, string>): Promise<{ child: ChildProcess; logs: () => string }> {
  let logs = "";
  const child = spawn("npx", ["tsx", "index.ts"], {
    cwd: SERVER_DIR,
    // 운영 데이터 폴더를 쓰면 부팅 복원이 실제 세션 일기에 끼어든다. 단독 실행에서도 임시 폴더를 쓴다.
    env: { ...process.env, PORT: String(PORT), AETHER_MODEL: "haiku", ANTHROPIC_API_KEY: "", AETHER_DATA_DIR: TEST_DATA_DIR, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (logs += d));
  child.stderr?.on("data", (d) => (logs += d));
  const ok = await waitHealthy();
  if (!ok) console.log("  ⚠️ 서버가 시간내 안 떴음. 로그:\n" + logs.split("\n").slice(0, 8).join("\n"));
  return { child, logs: () => logs };
}

async function stopServer(child: ChildProcess) {
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  await delay(600);
}

async function main() {
  // ───────── Mode 1: 기본(API-only, dist 없음) ─────────
  console.log("\n[Mode 1] 기본 (API-only)");
  const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-smoke-nodist-"));
  {
    const { child, logs } = await startServer({ AETHER_WEB_DIST: emptyDist });
    check(/백엔드 기동/.test(logs()) && !/Missing parameter name/.test(logs()), "T1 부팅 무크래시(Express5 와일드카드 OK)");
    const h = await req("GET", "/api/health");
    check(h.headers["x-content-type-options"] === "nosniff", "T9 helmet nosniff");
    check(!/projectRoot/.test(h.body), "T9c health에 projectRoot 경로 미노출");
    check(h.headers["x-powered-by"] === undefined, "T9 X-Powered-By 제거");
    check(h.headers["content-security-policy"] === undefined, "T9 API-only는 CSP 없음");
    check(/static 서빙 스킵/.test(logs()), "T8a web/dist 부재 graceful skip");
    const big = JSON.stringify({ cwd: "x".repeat(300000) });
    const t2 = await req("POST", "/api/sessions", { headers: { "content-type": "application/json" }, body: big });
    check(t2.status === 413, "T2 body limit 256kb 초과 → 413", `status=${t2.status}`);
    const t3 = await req("POST", "/api/sessions/nope/message", { headers: { "content-type": "application/json" }, body: "{}" });
    check(t3.status === 404 || t3.status === 400, "T3 검증 에러 JSON 반환", `status=${t3.status} body=${t3.body.slice(0, 40)}`);
    await stopServer(child);
  }
  fs.rmSync(emptyDist, { recursive: true, force: true });

  // ───────── Mode 3: 가짜 dist(SPA fallback) — 저장소 web/이 아니라 임시 폴더 ─────────
  console.log("\n[Mode 3] 가짜 web/dist (SPA fallback)");
  const tmpStatic = fs.mkdtempSync(path.join(os.tmpdir(), "aether-smoke-static-"));
  {
    const dist = path.join(tmpStatic, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>SPA_MARKER");
    fs.writeFileSync(path.join(dist, "assets", "app.abc123.js"), "console.log(1)");
    const { child } = await startServer({ AETHER_WEB_DIST: dist });
    const root = await req("GET", "/");
    check(root.body.includes("SPA_MARKER") && root.headers["cache-control"] === "no-cache", "T8 / → index.html(no-cache)");
    const deep = await req("GET", "/deep/link/route");
    check(deep.body.includes("SPA_MARKER"), "T8 딥링크 → index.html(SPA fallback)");
    const asset = await req("GET", "/assets/app.abc123.js");
    check(String(asset.headers["cache-control"] ?? "").includes("immutable"), "T8 asset immutable 캐시");
    const api404 = await req("GET", "/api/zzz");
    check(api404.status === 404 && /API 경로 없음/.test(api404.body) && String(api404.headers["content-type"]).includes("json"),
      "T8 /api/* 404는 JSON(HTML 아님)", `ct=${api404.headers["content-type"]}`);
    const apikeys = await req("GET", "/apikeys"); // /api 접두지만 네임스페이스 아님 → SPA여야(과매칭 회귀가드)
    check(apikeys.body.includes("SPA_MARKER"), "T8 /apikeys(api접두 비네임스페이스) → index.html");
    check(root.headers["content-security-policy"] !== undefined, "T9b static 모드 CSP 존재");
    await stopServer(child);
  }
  fs.rmSync(tmpStatic, { recursive: true, force: true });

  // ───────── Mode 4: compression + partial + haiku 1턴 ─────────
  if (process.env.AETHER_SMOKE_HAIKU !== "1") {
    console.log("\n[Mode 4] haiku 실모델 — 기본 건너뜀 (AETHER_SMOKE_HAIKU=1 이면 실행)");
  } else {
  console.log("\n[Mode 4] compression+partial (+haiku 1턴)");
  {
    const { child } = await startServer({ AETHER_COMPRESSION: "1", AETHER_PARTIAL: "1" });
    const created = JSON.parse((await req("POST", "/api/sessions", { headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "haiku" }) })).body);
    const id: string = created.id;

    // T5: SSE 응답이 압축되지 않음(Content-Encoding 부재) — compression 켜져도
    const probe = openSSE(`/api/sessions/${id}/stream?since=0`, () => {}, { "Accept-Encoding": "gzip" });
    const sseHeaders = await probe.headersP;
    check(String(sseHeaders["content-type"]).includes("text/event-stream"), "T5 SSE content-type");
    check(sseHeaders["content-encoding"] === undefined, "T5 compression 켜져도 SSE 비압축(Content-Encoding 부재)", `ce=${sseHeaders["content-encoding"]}`);
    probe.destroy();

    // 본 SSE + haiku 1턴
    const events: any[] = [];
    const sse = openSSE(`/api/sessions/${id}/stream?since=0`, (ev) => events.push(ev));
    await delay(300);
    await req("POST", `/api/sessions/${id}/message`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Reply with only: PONG" }) });
    // result까지 대기(최대 60s)
    const start = Date.now();
    while (!events.some((e) => e.kind === "sdk" && e.msg?.type === "result") && Date.now() - start < 60000) await delay(200);
    await delay(300);
    sse.destroy();

    const streamEvents = events.filter((e) => e.kind === "sdk" && e.msg?.type === "stream_event");
    check(streamEvents.length > 0, "T7 partial(stream_event) SSE로 도착", `count=${streamEvents.length}`);

    const { sessionEventLines } = await import("./support/diaryRows");
    const diskLines = sessionEventLines(path.join(TEST_DATA_DIR, "aether.sqlite"), id);
    const disk = diskLines.join("\n");
    const diskStreamEvents = diskLines.filter((l) => JSON.parse(l).msg?.type === "stream_event").length;
    check(diskStreamEvents === 0, "T7 partial은 일기 영속 제외", `disk stream_event=${diskStreamEvents}`);
    check(/"type":"result"/.test(disk), "T7 완성 메시지(result)는 영속됨");

    // T6: replay since=2 + partial이 replay에 새지 않는지(메모리/디스크 대칭 — 리뷰 #6 회귀가드)
    const replayed: any[] = [];
    const rp = openSSE(`/api/sessions/${id}/stream?since=2`, (ev) => replayed.push(ev));
    await delay(1000);
    rp.destroy();
    check(replayed.length > 0 && replayed.every((e) => e.seq > 2), "T6 ?since=2 replay(전부 seq>2)", `count=${replayed.length}`);
    const replayPartials = replayed.filter((e) => e.kind === "sdk" && e.msg?.type === "stream_event").length;
    check(replayPartials === 0, "T6 replay에 partial 미포함(replaySince 제외)", `partials=${replayPartials}`);

    await stopServer(child);
  }
  }

  console.log("\n" + "─".repeat(56));
  console.log(`Phase 2 스모크: ${passCount} PASS / ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => { console.error("스모크 오류:", e); process.exit(1); });
