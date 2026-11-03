/**
 * 공통 문(SSE·GET /events)이 클라이언트 봉투만 보내는지 — 모델 호출 0.
 * 가짜 provider로 실제 라우트를 연다. 원본 `msg`와 `"sdk"`/`"codex"` kind가 0건이어야 한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-door-wire-"));

const express = (await import("express")).default;
const { __registerProviderForTest } = await import("../providers/registry");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("door_wire"); // 임시 SQLite 일기
const { streamRouter } = await import("../routes/stream");
const { sessionsRouter } = await import("../routes/sessions");
const { config } = await import("../config");
const mock = await import("./support/mockProvider");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

function takeFrames(buf: string): { rest: string; frames: { event: string; data: string }[] } {
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: { event: string; data: string }[] = [];
  for (const part of parts) {
    let event = "message";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) frames.push({ event, data });
  }
  return { rest, frames };
}

type Envelope = { seq?: number; kind?: string; msg?: unknown; events?: unknown[]; text?: string };

const unregister = __registerProviderForTest(mock.mockEntry);
const app = express();
app.use(express.json());
app.use("/api/sessions", streamRouter);
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const cwd = config.projectRootReal ?? config.projectRoot;

let sessionId: string | undefined;
try {
  const session = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  sessionId = session.id;

  const abort = new AbortController();
  const res = await fetch(`${base}/api/sessions/${session.id}/stream?since=0`, { signal: abort.signal });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE 본문이 없다");
  const decoder = new TextDecoder();
  let buf = "";
  const messages: Envelope[] = [];
  let caughtUp = false;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const taken = takeFrames(buf);
      buf = taken.rest;
      for (const f of taken.frames) {
        if (f.event === "caught_up") caughtUp = true;
        if (f.event !== "message") continue;
        messages.push(JSON.parse(f.data) as Envelope);
      }
    }
  })();

  check(await waitUntil(() => caughtUp), "SSE caught_up가 온다");
  session.push("hello-wire");
  check(
    await waitUntil(() => messages.some((e) => e.kind === "user_msg" && e.text === "hello-wire")),
    "SSE가 사용자 입력을 보낸다",
  );
  check(
    await waitUntil(() => messages.some((e) => e.events?.some((a) => (a as { type?: string; text?: string }).type === "text" && (a as { text?: string }).text === "hello-wire"))),
    "SSE가 정규화 텍스트를 보낸다",
  );

  check(messages.every((e) => !("msg" in e)), "라이브 SSE에 원본 msg가 0건이다", messages.find((e) => "msg" in e));
  check(!messages.some((e) => e.kind === "sdk" || e.kind === "codex" || e.kind === mock.MOCK_PROVIDER), "라이브 SSE에 provider 원본 kind가 0건이다");
  check(messages.some((e) => e.kind === "agent"), "모델 사건의 클라이언트 kind는 agent다");
  check(messages.some((e) => e.kind === "user_msg"), "제어 사건 user_msg는 kind를 유지한다");

  abort.abort();
  await pump.catch(() => {});

  const lastSeq = Math.max(0, ...session.replaySince(0).map((e) => e.seq));
  const pageRes = await fetch(`${base}/api/sessions/${session.id}/events?before=${lastSeq + 1}&limit=300`);
  check(pageRes.status === 200, "GET /events 200", pageRes.status);
  const page = (await pageRes.json()) as { events: Envelope[]; oldestSeq?: unknown };
  check(Array.isArray(page.events) && page.events.length > 0, "GET /events가 봉투를 돌려준다", page.events.length);
  check(
    typeof page.oldestSeq === "number" && page.oldestSeq === page.events[0]?.seq,
    "GET /events의 oldestSeq는 읽은 페이지의 첫 순번이다",
    page.oldestSeq,
  );
  check(page.events.every((e) => !("msg" in e)), "GET /events에 원본 msg가 0건이다", page.events.find((e) => "msg" in e));
  check(!page.events.some((e) => e.kind === "sdk" || e.kind === "codex" || e.kind === mock.MOCK_PROVIDER), "GET /events에 provider 원본 kind가 0건이다");
} finally {
  server.close();
  if (sessionId) sessionManager.delete(sessionId);
  unregister();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} door_wire: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
