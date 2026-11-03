/**
 * Phase 8c live canary — 격리 서버 + haiku 1턴으로 실제 SDK→SSE→AgentEvent 배선을 확인한다.
 *
 * 실행: npm run test:wire:live
 * 비결정/비CI 테스트: Claude 로그인·네트워크가 필요하며 짧은 haiku 호출 1회를 사용한다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-8c-live-"));
const PORT = 8798;
const BASE = { host: "127.0.0.1", port: PORT };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type HttpResult = { status: number; body: string };
type Wire = {
  seq?: number;
  kind?: string;
  text?: string;
  totalTokens?: number;
  maxTokens?: number;
  msg?: { type?: string };
  events?: Array<{ type?: string; text?: string; status?: string; totalTokens?: number; maxTokens?: number }>;
};

function request(method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        ...BASE,
        path: urlPath,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openSse(urlPath: string, sink: Wire[]): () => void {
  const req = http.request({ ...BASE, path: urlPath, method: "GET" }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = block.split("\n").find((part) => part.startsWith("data: "));
        if (line) {
          try {
            const parsed = JSON.parse(line.slice(6)) as Wire;
            if (typeof parsed.seq === "number") sink.push(parsed);
          } catch {
            // ping/caught_up 등 데이터 평면 밖 메시지는 무시.
          }
        }
        end = buffer.indexOf("\n\n");
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

async function waitHealthy(timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await request("GET", "/api/health")).status === 200) return;
    } catch {
      // 부팅 중.
    }
    await delay(200);
  }
  throw new Error("격리 서버 health timeout");
}

function stop(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    // 이미 종료.
  }
}

function assert(name: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
}

async function main() {
  let logs = "";
  const child = spawn("node", ["--import", "tsx", "index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      AETHER_DATA_DIR: DATA_DIR,
      AETHER_AUTH_MODE: "off",
      AETHER_SEARCH: "0",
      AETHER_SERVE_STATIC: "0",
      AETHER_PARTIAL: "1",
      AETHER_MODEL: "haiku",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (logs += String(chunk)));
  child.stderr?.on("data", (chunk) => (logs += String(chunk)));

  const events: Wire[] = [];
  let closeSse = () => {};
  try {
    await waitHealthy();
    const created = await request("POST", "/api/sessions", { model: "haiku" });
    assert("세션 생성 201", created.status === 201);
    const id = (JSON.parse(created.body) as { id: string }).id;
    closeSse = openSse(`/api/sessions/${id}/stream?since=0`, events);
    await delay(200);
    const sent = await request("POST", `/api/sessions/${id}/message`, { text: "Reply with only: PONG" });
    assert("메시지 전송 200", sent.status === 200);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const completed = events.some((ev) => ev.events?.some((ae) => ae.type === "turn_completed"));
      const usage = events.some((ev) => ev.events?.some((ae) => ae.type === "usage_update"));
      if (completed && usage) break;
      await delay(150);
    }

    const user = events.find((ev) => ev.kind === "user_msg");
    assert("user_msg raw 보존 + user_text 증강", user?.text?.includes("PONG") === true && user.events?.some((ae) => ae.type === "user_text") === true);

    const deltas = events.filter((ev) => ev.events?.some((ae) => ae.type === "text_delta"));
    assert("실시간 text_delta 수신", deltas.length > 0);
    assert("text_delta에 글자가 있다", deltas.some((ev) => ev.events?.some((ae) => ae.type === "text_delta" && !!ae.text)));
    assert("실시간 통로에 원본 msg가 없다", events.every((ev) => !("msg" in ev)));

    assert(
      "완성 텍스트가 계약으로 온다",
      events.some((ev) => ev.events?.some((ae) => ae.type === "text" && ae.text?.includes("PONG"))),
    );

    const result = events.find((ev) => ev.events?.some((ae) => ae.type === "turn_completed"));
    assert("turn_completed가 계약으로 온다", result?.events?.some((ae) => ae.type === "turn_completed" && ae.status === "ok") === true);

    const ctx = events.find((ev) => ev.kind === "ctx");
    assert(
      "ctx raw 보존 + usage_update 증강",
      typeof ctx?.totalTokens === "number" &&
        ctx.events?.some((ae) => ae.type === "usage_update" && ae.totalTokens === ctx.totalTokens && ae.maxTokens === ctx.maxTokens) === true,
    );
    console.log(`\n✅ wire_live: 실제 SSE ${events.length}건 검증 완료`);
  } catch (error) {
    console.error(logs.split("\n").slice(-30).join("\n"));
    throw error;
  } finally {
    closeSse();
    stop(child);
    await delay(500);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
