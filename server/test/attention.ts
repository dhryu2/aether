/**
 * 13a 서버 주의 상태·통로 — 가짜 세션, 모델 호출 0.
 *
 * 대기·완료·본 시각·잠든 세션 미깨움·알림 본문과 미리보기 동일.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";
import type { SessionListItem } from "../../shared/http";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-attention-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-attention-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { computeAttention, isStickyAttentionKind } = await import("../sessions/attention");
const { worthNotifying } = await import("../notify/worthNotifying");
const { attachNotify } = await import("../notify/coordinator");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("attention"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const { config } = await import("../config");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const express = (await import("express")).default;
const { sessionsRouter } = await import("../routes/sessions");
const { streamRouter } = await import("../routes/stream");
const { presenceRouter } = await import("../routes/presence");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    check(true, name);
  } catch {
    check(false, name, { actual, expected });
  }
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

function listOf(id: string): SessionListItem | undefined {
  return sessionManager.list().find((s) => s.id === id);
}

const raw = (body: Record<string, unknown>) => ({ seq: 1, ts: 50, ...body }) as AetherEvent;
const sessionInfo = { id: "s1", name: "배포 작업", providerName: "Claude" };

console.log("\n=== 순수 계산 ===");
eq("대기가 진행·완료보다 앞선다", computeAttention({
  waitingKind: "question",
  waitingPreview: "색?",
  turnOpen: true,
  sticky: { kind: "done", preview: "끝", at: 10 },
}).attention, "waiting");
eq("진행 중은 running", computeAttention({ turnOpen: true }).attention, "running");
eq("대기가 뒤 작업보다 앞선다", computeAttention({ waitingKind: "plan", turnOpen: false, backgroundCount: 2 }).attention, "waiting");
eq("진행 중이 뒤 작업보다 앞선다", computeAttention({ turnOpen: true, backgroundCount: 2 }).attention, "running");
eq("뒤 작업은 background", computeAttention({ turnOpen: false, backgroundCount: 1 }), { attention: "background" });
eq("뒤 작업 중에는 남은 done sticky가 안 보인다", computeAttention({
  turnOpen: false,
  backgroundCount: 1,
  sticky: { kind: "done", preview: "끝", at: 20 },
}).attention, "background");
eq("뒤 작업이 끝나면 안 본 완료가 보인다", computeAttention({
  turnOpen: false,
  backgroundCount: 0,
  sticky: { kind: "done", preview: "끝", at: 20 },
}).attention, "done");
eq("안 본 완료는 done", computeAttention({
  turnOpen: false,
  sticky: { kind: "done", preview: "응답이 끝났습니다", at: 20 },
}).attention, "done");
eq("본 완료는 idle", computeAttention({
  turnOpen: false,
  lastViewedAt: 20,
  sticky: { kind: "done", preview: "응답이 끝났습니다", at: 20 },
}).attention, "idle");
eq("안 본 크래시는 failed", computeAttention({
  turnOpen: false,
  sticky: { kind: "crashed", preview: "세션이 비정상 종료되었습니다", at: 3 },
}), { attention: "failed", attentionKind: "crashed", attentionPreview: "세션이 비정상 종료되었습니다" });
eq("잠든 입력(대기 없음·턴 없음)은 스냅샷만", computeAttention({
  turnOpen: false,
  sticky: { kind: "done", preview: "끝", at: 9 },
}).attention, "done");

console.log("\n=== 막힘(hold) ===");
{
  const hold = { kind: "rate_limit" as const, preview: "한도 막힘", since: 100 };
  const base = { turnOpen: false, now: 500, sticky: { kind: "done" as const, preview: "끝", at: 90 } };
  eq("hold가 백그라운드·완료보다 앞선다", computeAttention({ ...base, backgroundCount: 2, hold }), {
    attention: "waiting", attentionKind: "rate_limit", attentionPreview: "한도 막힘", attentionSince: 100,
  });
  eq("until이 지나면 무시 → 완료로 돌아간다", computeAttention({ ...base, hold: { ...hold, until: 400 } }).attention, "done");
  eq("until 전이면 유지", computeAttention({ ...base, hold: { ...hold, until: 600 } }).attention, "waiting");
  eq("until이 지나고 완료도 없으면 idle", computeAttention({ turnOpen: false, now: 500, hold: { ...hold, until: 400 } }).attention, "idle");
  eq("턴이 열리면 running", computeAttention({ ...base, turnOpen: true, hold }).attention, "running");
  eq("대기 카드가 hold보다 앞서고 since를 싣는다", computeAttention({ ...base, hold, waitingKind: "permission", waitingPreview: "Bash", waitingSince: 300 }), {
    attention: "waiting", attentionKind: "permission", attentionPreview: "Bash", attentionSince: 300,
  });
  eq("rate_limit은 더 이상 sticky가 아니다", isStickyAttentionKind("rate_limit"), false);
  eq("끊긴 요청 hold도 waiting", computeAttention({ turnOpen: false, hold: { kind: "interrupted_request", preview: "Bash · ls", since: 7 } }).attentionKind, "interrupted_request");
}

console.log("\n=== 알림 본문 = 주의 미리보기 ===");
{
  const q = worthNotifying(
    raw({
      kind: "question_request",
      req: { id: "q1", toolUseID: "t", questions: [{ question: "색을 고르세요", options: [] }], createdAt: 1 },
    }),
    [],
    sessionInfo,
  );
  eq("질문 kind", q?.kind, "question");
  eq("질문 본문", q?.body, "색을 고르세요");
  const perm = worthNotifying(
    raw({
      kind: "permission_request",
      req: { id: "p1", toolName: "Bash", displayName: "Bash", input: { command: "npm test" }, toolUseID: "t", createdAt: 1 },
    }),
    [],
    sessionInfo,
  );
  eq("권한 본문", perm?.body, "Bash · npm test");
  eq("권한 kind", perm?.kind, "permission");
  const doneEv = { type: "turn_completed", status: "ok", provider: "claude", seq: 2, part: 0, ts: 1, responsePreview: "배포했습니다" } as AgentEvent;
  const done = worthNotifying(raw({ kind: "sdk" }), [doneEv], sessionInfo);
  eq("완료 kind", done?.kind, "done");
  eq("완료 본문", done?.body, "배포했습니다");
  const crash = worthNotifying(raw({ kind: "status", status: "crashed", error: "boom" }), [], sessionInfo);
  eq("크래시 kind", crash?.kind, "crashed");
  const auth = worthNotifying(raw({ kind: "notice", notice: "auth_expired" }), [], { ...sessionInfo, providerName: "MockProvider" });
  eq("인증 kind", auth?.kind, "auth");
  const rate = worthNotifying(
    raw({ kind: "sdk" }),
    [{ type: "provider_notice", kind: "rate_limit", severity: "blocked", limitType: "사용 한도", provider: "claude", seq: 1, part: 0, ts: 1 } as AgentEvent],
    sessionInfo,
  );
  eq("한도 kind", rate?.kind, "rate_limit");
}

const unregister = __registerProviderForTest(mock.mockEntry);
sessionManager.setOnLive((session) => attachNotify(session, () => {}));
const cwd = config.projectRootReal ?? config.projectRoot;

const app = express();
app.use(express.json());
app.use("/api/sessions", streamRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/presence", presenceRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

console.log("\n=== 살아 있는 세션 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    await live.push("hello-attn");
    eq("턴 시작 직후 running", listOf(live.id)?.attention, "running");
    check(await waitUntil(() => listOf(live.id)?.attention === "done"), "턴이 끝나면 done", listOf(live.id)?.attention);
    eq("완료 kind", listOf(live.id)?.attentionKind, "done");
    eq("완료 미리보기 = 알림 본문", listOf(live.id)?.attentionPreview, "hello-attn");
    check(!listOf(live.id)?.lastViewedAt, "아직 안 열면 lastViewedAt이 없다");

    const abort = new AbortController();
    const res = await fetch(`${base}/api/sessions/${live.id}/stream?since=0`, { signal: abort.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("SSE 본문이 없다");
    const decoder = new TextDecoder();
    let buf = "";
    let caughtUp = false;
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const taken = takeFrames(buf);
        buf = taken.rest;
        for (const f of taken.frames) if (f.event === "caught_up") caughtUp = true;
      }
    })();
    check(await waitUntil(() => caughtUp), "대화 통로 caught_up");
    check(await waitUntil(() => listOf(live.id)?.attention === "idle"), "따라잡으면 idle", listOf(live.id)?.attention);
    abort.abort();
    await pump.catch(() => {});
  } finally {
    sessionManager.delete(live.id);
  }
}

{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    void (live as unknown as { requestQuestion: (ask: unknown) => Promise<unknown> }).requestQuestion({
      toolUseID: "ask-1",
      questions: [{ question: "색을 고르세요", options: [{ label: "빨강" }] }],
      signal: new AbortController().signal,
    });
    eq("질문이면 waiting", listOf(live.id)?.attention, "waiting");
    eq("질문 kind", listOf(live.id)?.attentionKind, "question");
    eq("질문 미리보기 = 알림 본문", listOf(live.id)?.attentionPreview, "색을 고르세요");
  } finally {
    sessionManager.delete(live.id);
  }
}

{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    live.push("ASK:npm test");
    check(await waitUntil(() => (listOf(live.id)?.attention === "waiting")), "권한 대기는 waiting", listOf(live.id)?.attention);
    eq("권한 kind", listOf(live.id)?.attentionKind, "permission");
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 잠든 세션을 깨우지 않는다 ===");
{
  const id = "att-sleep-1";
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      cwd: ROOT,
      createdAt: 1,
      resumeKey: "mock-thread-sleep",
      attentionSticky: { kind: "done", preview: "응답이 끝났습니다", at: 40 },
    }),
  );
  store.appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" } as never);
  const restored = sessionManager.restoreFromDisk();
  check(restored >= 1, "디스크 세션 복원", restored);
  check(sessionManager.get(id) === undefined, "복원만으로 live가 아니다");
  eq("잠든 세션 목록은 done", listOf(id)?.attention, "done");
  eq("잠든 미리보기", listOf(id)?.attentionPreview, "응답이 끝났습니다");
  check(sessionManager.get(id) === undefined, "목록만으로 안 깨운다");

  const abort = new AbortController();
  const pres = await fetch(`${base}/api/presence/stream`, { signal: abort.signal });
  const reader = pres.body?.getReader();
  if (!reader) throw new Error("presence SSE 본문이 없다");
  const decoder = new TextDecoder();
  let buf = "";
  let snapshot: { sessions?: { id: string; attention?: string; req?: unknown; msg?: unknown; events?: unknown }[] } | undefined;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const taken = takeFrames(buf);
      buf = taken.rest;
      for (const f of taken.frames) {
        if (f.event === "snapshot") snapshot = JSON.parse(f.data) as typeof snapshot;
      }
    }
  })();
  check(await waitUntil(() => !!snapshot), "주의 통로 첫 스냅샷");
  const row = snapshot?.sessions?.find((s) => s.id === id);
  eq("스냅샷 주의", row?.attention, "done");
  check(row != null && !("msg" in row) && !("req" in row) && !("events" in row), "스냅샷에 대화·카드 원문이 없다", row);
  check(sessionManager.get(id) === undefined, "주의 통로만으로 안 깨운다");
  abort.abort();
  await pump.catch(() => {});

  const convAbort = new AbortController();
  const conv = await fetch(`${base}/api/sessions/${id}/stream?since=0`, { signal: convAbort.signal });
  const convReader = conv.body?.getReader();
  if (!convReader) throw new Error("대화 SSE 본문이 없다");
  let cbuf = "";
  let caughtUp = false;
  const cpump = (async () => {
    for (;;) {
      const { done, value } = await convReader.read();
      if (done) return;
      cbuf += decoder.decode(value, { stream: true });
      const taken = takeFrames(cbuf);
      cbuf = taken.rest;
      for (const f of taken.frames) if (f.event === "caught_up") caughtUp = true;
    }
  })();
  check(await waitUntil(() => caughtUp), "잠든 세션 대화 통로 caught_up");
  check(await waitUntil(() => listOf(id)?.attention === "idle"), "잠든 세션을 열면 idle", listOf(id)?.attention);
  check(sessionManager.get(id) === undefined, "대화 통로 replay만으로 안 깨운다");
  convAbort.abort();
  await cpump.catch(() => {});
}

console.log("\n=== 막힘(hold)의 수명 ===");
{
  // 한도 막힘: 걸리면 waiting, 새 턴이 열리면 풀리고 메타에서도 사라진다.
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    live.setAttentionHold({ kind: "rate_limit", preview: "한도", since: 5 });
    eq("한도 hold → waiting/rate_limit", [listOf(live.id)?.attention, listOf(live.id)?.attentionKind, listOf(live.id)?.attentionSince], ["waiting", "rate_limit", 5]);
    eq("hold가 meta에 저장된다", JSON.parse(fs.readFileSync(path.join(DATA, live.id, "meta.json"), "utf8")).attentionHold?.since, 5);
    live.push("다시 시도");
    check(await waitUntil(() => listOf(live.id)?.attention !== "waiting"), "다음 턴이 열리면 해제", listOf(live.id)?.attention);
    eq("해제가 meta에도 반영", JSON.parse(fs.readFileSync(path.join(DATA, live.id, "meta.json"), "utf8")).attentionHold, undefined);
  } finally {
    sessionManager.delete(live.id);
  }
}

{
  // until 타이머: 해제 시각에 presence가 한 번 더 나간다.
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    const seen: string[] = [];
    const off = sessionManager.subscribePresence((u) => { if (u.id === live.id) seen.push(u.attention); });
    live.setAttentionHold({ kind: "rate_limit", preview: "한도", since: 5, until: Date.now() + 150 });
    sessionManager.applyAttentionEvent(live.id, { seq: 1, ts: Date.now(), kind: "sdk" } as AetherEvent);
    check(await waitUntil(() => seen.includes("waiting") && seen[seen.length - 1] === "idle"), "until이 지나면 idle로 한 번 더 내보낸다", seen);
    off();
  } finally {
    sessionManager.delete(live.id);
  }
}

{
  // 끊긴 요청: 카드가 남은 채 닫히면 waiting/interrupted_request, since = 카드가 처음 뜬 시각.
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  void (live as unknown as { requestQuestion: (ask: unknown) => Promise<unknown> }).requestQuestion({
    toolUseID: "ask-int",
    questions: [{ question: "색을 고르세요", options: [{ label: "빨강" }] }],
    signal: new AbortController().signal,
  });
  const since = listOf(live.id)?.attentionSince;
  check(typeof since === "number", "대기 카드가 since를 싣는다", since);
  const seenInt: string[] = [];
  const offInt = sessionManager.subscribePresence((u) => { if (u.id === live.id) seenInt.push(`${u.attention}/${u.attentionKind ?? ""}`); });
  live.drainPending("재시작");
  offInt();
  eq("presence 마지막 값이 waiting/interrupted_request", seenInt[seenInt.length - 1], "waiting/interrupted_request");
  eq("카드를 닫으면 끊긴 요청", [listOf(live.id)?.attention, listOf(live.id)?.attentionKind, listOf(live.id)?.attentionPreview, listOf(live.id)?.attentionSince], ["waiting", "interrupted_request", "색을 고르세요", since]);
  live.drainPending("한 번 더");
  eq("닫을 카드가 없으면 hold를 바꾸지 않는다", listOf(live.id)?.attentionSince, since);
  const archived = sessionManager.setArchived(live.id, true);
  check(typeof archived === "object" && typeof archived.archivedAt === "number", "보관은 끊긴 요청 hold에 막히지 않는다", archived);
  eq("보관된 세션은 idle로 나간다", listOf(live.id)?.attention, "idle");
  sessionManager.delete(live.id);
  check(!fs.existsSync(path.join(DATA, live.id)), "삭제된 세션 폴더가 다시 안 생긴다");
}

{
  // 삭제 중 drain: dispose가 부르는 drainPending은 메타를 쓰지 않는다.
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  void (live as unknown as { requestQuestion: (ask: unknown) => Promise<unknown> }).requestQuestion({
    toolUseID: "ask-del",
    questions: [{ question: "?", options: [{ label: "a" }] }],
    signal: new AbortController().signal,
  });
  sessionManager.delete(live.id);
  check(!fs.existsSync(path.join(DATA, live.id)), "카드가 남은 채 삭제해도 폴더가 안 되살아난다");
}

{
  // 재시작: 승인 카드가 걸린 채 끊긴 기록으로 부팅 → 잠든 세션이 waiting/interrupted_request.
  const id = "att-orphan-1";
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: ROOT, createdAt: 1, resumeKey: "mock-thread-orphan" }));
  for (const e of [
    { seq: 1, ts: 1, kind: "user_msg", text: "hi" },
    { seq: 2, ts: 777, kind: "permission_request", req: { id: "p-orphan", toolName: "Bash", displayName: "Bash", input: { command: "ls" }, toolUseID: "t", createdAt: 777 } },
  ]) store.appendEvent(id, e as never);
  sessionManager.restoreFromDisk();
  eq("부팅 뒤 끊긴 요청", [listOf(id)?.attention, listOf(id)?.attentionKind, listOf(id)?.attentionPreview, listOf(id)?.attentionSince], ["waiting", "interrupted_request", "Bash · ls", 777]);
  check(sessionManager.get(id) === undefined, "부팅 표시만으로 안 깨운다");
  sessionManager.markViewed(id);
  eq("보기만 해서는 사라지지 않는다", listOf(id)?.attention, "waiting");
  const woke = sessionManager.getOrResume(id);
  woke.push("이어서");
  check(await waitUntil(() => listOf(id)?.attention !== "waiting"), "다음 턴에 해제", listOf(id)?.attention);
  sessionManager.delete(id);
}

console.log("\n=== 목록 선택 칸 ===");
{
  const listed = await fetch(`${base}/api/sessions`);
  const body = (await listed.json()) as { sessions: SessionListItem[] };
  check(Array.isArray(body.sessions), "GET /api/sessions");
  const item = body.sessions.find((s) => s.id === "att-sleep-1");
  check(item?.attention === "idle", "본 뒤 목록 attention", item?.attention);
  check(typeof item?.status === "string", "수명 status는 그대로");
}

server.close();
unregister();
sessionManager.setOnLive(undefined);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} attention: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
