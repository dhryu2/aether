/**
 * 공통 문 동시성 (F7·F8·F10) — 모델 호출 0.
 * 같은 세션에 SSE 두 개, 서로 다른 since 재접속, 승인/질문 후발은 404+이미 처리됨.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-door-conc-"));

const express = (await import("express")).default;
const { __registerProviderForTest } = await import("../providers/registry");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("door_concurrency"); // 임시 SQLite 일기
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

type Envelope = { seq?: number; kind?: string; text?: string; events?: { type?: string; text?: string }[] };

class SseClient {
  frames: Envelope[] = [];
  caughtUp = false;
  private abort = new AbortController();
  private buf = "";
  constructor(url: string) {
    void this.run(url);
  }
  private async run(url: string) {
    try {
      const res = await fetch(url, { signal: this.abort.signal });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.buf += decoder.decode(value, { stream: true });
        const taken = takeFrames(this.buf);
        this.buf = taken.rest;
        for (const f of taken.frames) {
          if (f.event === "caught_up") this.caughtUp = true;
          if (f.event === "message") this.frames.push(JSON.parse(f.data) as Envelope);
        }
      }
    } catch {
      /* abort */
    }
  }
  close() {
    this.abort.abort();
  }
  hasUser(text: string): boolean {
    return this.frames.some((e) => e.kind === "user_msg" && e.text === text);
  }
}

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

const ids: string[] = [];
try {
  // ── F7: 같은 세션 SSE 두 개. 한쪽 종료가 다른 쪽을 안 끊는다 ──
  const s7 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  ids.push(s7.id);
  const a = new SseClient(`${base}/api/sessions/${s7.id}/stream?since=0`);
  const b = new SseClient(`${base}/api/sessions/${s7.id}/stream?since=0`);
  check(await waitUntil(() => a.caughtUp && b.caughtUp), "F7 두 연결이 모두 caught_up을 받는다");
  s7.push("alpha");
  check(await waitUntil(() => a.hasUser("alpha") && b.hasUser("alpha")), "F7 두 연결이 같은 사건을 받는다");
  a.close();
  await sleep(50);
  s7.push("beta");
  check(await waitUntil(() => b.hasUser("beta")), "F7 남은 연결은 계속 받는다");
  check(!a.hasUser("beta"), "F7 닫은 연결은 이후 사건을 안 받는다");
  b.close();

  // ── F8: 서로 다른 since로 재접속하면 각자 cursor대로만 받는다 ──
  const s8 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  ids.push(s8.id);
  s8.push("first");
  check(await waitUntil(() => s8.replaySince(0).some((e) => e.kind === "user_msg" && (e as { text?: string }).text === "first")), "F8 첫 입력이 원장에 남는다");
  const firstSeq = s8.replaySince(0).find((e) => e.kind === "user_msg" && (e as { text?: string }).text === "first")!.seq;
  s8.push("second");
  check(await waitUntil(() => s8.replaySince(0).some((e) => e.kind === "user_msg" && (e as { text?: string }).text === "second")), "F8 둘째 입력이 원장에 남는다");
  const full = new SseClient(`${base}/api/sessions/${s8.id}/stream?since=0`);
  const tail = new SseClient(`${base}/api/sessions/${s8.id}/stream?since=${firstSeq}`);
  check(await waitUntil(() => full.caughtUp && tail.caughtUp), "F8 서로 다른 since 두 연결이 붙는다");
  check(full.hasUser("first") && full.hasUser("second"), "F8 since=0은 두 입력을 모두 받는다");
  check(!tail.hasUser("first") && tail.hasUser("second"), "F8 더 큰 since는 앞선 입력을 받지 않는다");
  full.close();
  tail.close();

  // ── F10: 승인 후발은 404 + 이미 처리됨 ──
  const s10 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  ids.push(s10.id);
  void (s10 as unknown as { requestPermission: (ask: unknown) => Promise<unknown> }).requestPermission({
    toolName: "mock_write",
    input: { target: "x" },
    toolUseID: "perm-1",
    signal: new AbortController().signal,
  });
  check(await waitUntil(() => s10.pendingPermissions().length === 1), "F10 승인 카드가 대기한다");
  const permId = s10.pendingPermissions()[0]!.id;
  const permBody = JSON.stringify({ permissionId: permId, decision: "allow" });
  const permHeaders = { "content-type": "application/json" };
  const [p1, p2] = await Promise.all([
    fetch(`${base}/api/sessions/${s10.id}/permission`, { method: "POST", headers: permHeaders, body: permBody }),
    fetch(`${base}/api/sessions/${s10.id}/permission`, { method: "POST", headers: permHeaders, body: permBody }),
  ]);
  const permStatuses = [p1.status, p2.status].sort();
  check(permStatuses[0] === 200 && permStatuses[1] === 404, "F10 승인 첫 성공만 200, 후발은 404", permStatuses);
  const permLate = p1.status === 404 ? p1 : p2;
  const permErr = (await permLate.json()) as { error?: string };
  check(typeof permErr.error === "string" && permErr.error.includes("이미 처리"), "F10 승인 후발 본문이 이미 처리됨을 말한다", permErr);

  // ── F10: 질문 후발도 같다 ──
  void (s10 as unknown as { requestQuestion: (ask: unknown) => Promise<unknown> }).requestQuestion({
    toolUseID: "q-1",
    questions: [{ question: "저녁?", options: [{ label: "피자" }, { label: "파스타" }] }],
    signal: new AbortController().signal,
  });
  check(await waitUntil(() => s10.pendingQuestionList().length === 1), "F10 질문 카드가 대기한다");
  const qid = s10.pendingQuestionList()[0]!.id;
  const qBody = JSON.stringify({ questionId: qid, answers: [["피자"]], custom: [null] });
  const [q1, q2] = await Promise.all([
    fetch(`${base}/api/sessions/${s10.id}/question`, { method: "POST", headers: permHeaders, body: qBody }),
    fetch(`${base}/api/sessions/${s10.id}/question`, { method: "POST", headers: permHeaders, body: qBody }),
  ]);
  const qStatuses = [q1.status, q2.status].sort();
  check(qStatuses[0] === 200 && qStatuses[1] === 404, "F10 질문 첫 성공만 200, 후발은 404", qStatuses);
  const qLate = q1.status === 404 ? q1 : q2;
  const qErr = (await qLate.json()) as { error?: string };
  check(typeof qErr.error === "string" && qErr.error.includes("이미 처리"), "F10 질문 후발 본문이 이미 처리됨을 말한다", qErr);
} finally {
  server.close();
  for (const id of ids) sessionManager.delete(id);
  unregister();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} door_concurrency: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
