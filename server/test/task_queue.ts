/**
 * 맡겨 두는 작업 대기열 — 관찰 표, 상태 전이, 부팅 규칙, 저장, 라우트, 통합 1건. 모델 호출 0(가짜 창구와 가짜 provider).
 * 운영 데이터는 건드리지 않는다: 임시 데이터 폴더.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PresenceSession } from "../../shared/http";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-tq-data-")));
const SRC = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-tq-src-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-tq-wt-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = SRC;
process.env.AETHER_WORKTREE_DIR = WORK;
const git = (args: string[]) => execFileSync("git", args, { cwd: SRC, encoding: "utf8" });
git(["init"]);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "i"]);

const tq = await import("../sessions/taskQueue");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("task_queue");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const express = (await import("express")).default;
const { createTaskQueueRouter } = await import("../routes/taskQueue");
const { attachNotify } = await import("../notify/coordinator");

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
const file = path.join(DATA, "task-queue.json");
const onDisk = () => JSON.parse(fs.readFileSync(file, "utf8"));

// ── observe ──
console.log("\n=== observe ===");
{
  const p = (o: Partial<PresenceSession>): PresenceSession => ({ id: "s", attention: "idle", status: "active", ...o });
  eq("없음 -> gone", tq.observe(undefined), "gone");
  eq("보관 -> gone", tq.observe(p({ archivedAt: 1 })), "gone");
  eq("포기 -> limit_gave_up", tq.observe(p({ autoResume: { action: { type: "send", text: "x" }, attempts: 3, gaveUp: true } })), "limit_gave_up");
  eq("재시작 끊김 예약은 포기가 아니다", tq.observe(p({ attention: "waiting", attentionKind: "interrupted_request", autoResume: { action: { type: "send", text: "x" }, attempts: 0, gaveUp: true, restartCutAt: 5 } })), "human_wait");
  eq("시각 있는 예약 -> limit_wait", tq.observe(p({ autoResume: { action: { type: "send", text: "x" }, attempts: 1, at: 9 } })), "limit_wait");
  eq("running -> busy", tq.observe(p({ attention: "running" })), "busy");
  eq("background -> busy", tq.observe(p({ attention: "background" })), "busy");
  eq("waiting rate_limit -> limit_wait", tq.observe(p({ attention: "waiting", attentionKind: "rate_limit" })), "limit_wait");
  eq("waiting permission -> human_wait", tq.observe(p({ attention: "waiting", attentionKind: "permission" })), "human_wait");
  eq("waiting question -> human_wait", tq.observe(p({ attention: "waiting", attentionKind: "question" })), "human_wait");
  eq("failed -> failed", tq.observe(p({ attention: "failed" })), "failed");
  eq("done -> finished", tq.observe(p({ attention: "done" })), "finished");
  eq("idle -> finished", tq.observe(p({ attention: "idle" })), "finished");
}

// ── 가짜 창구 ──
type Fake = ReturnType<typeof makeFake>;
function makeFake(ids: string[]) {
  const pres = new Map<string, PresenceSession>(ids.map((id) => [id, { id, attention: "idle", status: "active" } as PresenceSession]));
  const subs = new Set<(p: PresenceSession) => void>();
  const f = {
    pres,
    pushes: [] as { id: string; text: string }[],
    interrupts: [] as string[],
    cancels: [] as string[],
    busy: new Set<string>(),
    external: new Set<string>(),
    notIsolated: new Set<string>(),
    hasInput: new Set<string>(),
    pushFail: false,
    /** interrupt 시점에 파일에 적힌 줄 상태. 저장이 먼저인지 본다. */
    diskAtInterrupt: undefined as unknown,
    emit(id: string, patch: Partial<PresenceSession>) {
      const next = { ...(pres.get(id) as PresenceSession), ...patch };
      pres.set(id, next);
      for (const fn of subs) fn(next);
    },
    port: {} as import("../sessions/taskQueue").TaskQueuePort,
  };
  f.port = {
    snapshot: (id) => pres.get(id),
    isBusy: (id) => f.busy.has(id),
    hasNoInput: (id) => !f.hasInput.has(id),
    isIsolated: (id) => !f.notIsolated.has(id),
    isExternal: (id) => f.external.has(id),
    push: async (id, text) => {
      if (f.pushFail) throw new Error("push 실패");
      f.pushes.push({ id, text });
    },
    interrupt: async (id) => {
      f.diskAtInterrupt = onDisk();
      f.interrupts.push(id);
    },
    cancelAutoResume: (id) => void f.cancels.push(id),
    subscribe: (fn) => (subs.add(fn), () => void subs.delete(fn)),
  };
  return f;
}
const T0 = 1_800_000_000_000;
function setup(ids: string[]) {
  fs.rmSync(file, { force: true });
  const fake = makeFake(ids);
  const clock = { t: T0 };
  const notices: { n: unknown; sessionId: string }[] = [];
  const runner = new tq.TaskQueueRunner(fake.port, (n, sessionId) => notices.push({ n, sessionId }), () => clock.t);
  runner.boot();
  return { fake, clock, notices, runner };
}
const add = (r: import("../sessions/taskQueue").TaskQueueRunner, id: string, text = `글-${id}`) => {
  const x = r.add(id, text);
  if (!x.ok) throw new Error(`add 실패 ${x.code}`);
  return x.item;
};
/** 도는 작업을 바쁨 -> 끝남으로 한 번 돌린다. */
async function runTurn(s: ReturnType<typeof setup>, id: string, end: Partial<PresenceSession> = { attention: "done" }) {
  s.fake.emit(id, { attention: "running" });
  await s.runner.kick();
  s.fake.emit(id, end);
  await s.runner.kick();
}
const stateOf = (r: import("../sessions/taskQueue").TaskQueueRunner, id: string) => r.getState().items.find((i) => i.sessionId === id)?.state;

console.log("\n=== 순서대로 돈다 / busy 전의 idle은 끝이 아니다 ===");
{
  const s = setup(["a", "b"]);
  add(s.runner, "a");
  add(s.runner, "b");
  eq("시작", s.runner.startRun({ limitHours: 2 }), "ok");
  await s.runner.kick();
  eq("첫 작업만 보낸다", s.fake.pushes, [{ id: "a", text: "글-a" }]);
  eq("deadlineAt = 지금 + 상한", s.runner.getState().deadlineAt, T0 + 2 * 3_600_000);
  await s.runner.kick();
  eq("busy를 보기 전의 idle은 끝이 아니다", [stateOf(s.runner, "a"), s.fake.pushes.length], ["running", 1]);
  await runTurn(s, "a");
  eq("끝나면 done, 다음 작업", [stateOf(s.runner, "a"), s.fake.pushes.map((p) => p.id)], ["done", ["a", "b"]]);
  await runTurn(s, "b");
  const st = s.runner.getState();
  eq("모두 마치면 stopped(all_done) + 알림", [st.run, st.stopReason, s.notices.map((x) => x.n)], ["stopped", "all_done", [{ type: "finished" }]]);
  s.runner.dispose();
}

console.log("\n=== 예약 시작 ===");
{
  const s = setup(["a"]);
  add(s.runner, "a");
  s.runner.startRun({ startAt: T0 + 600_000, limitHours: 1 });
  await s.runner.kick();
  eq("시각 전에는 push 0회", [s.runner.getState().run, s.fake.pushes.length], ["scheduled", 0]);
  eq("deadlineAt = startAt + 상한", s.runner.getState().deadlineAt, T0 + 600_000 + 3_600_000);
  s.clock.t = T0 + 600_000;
  await s.runner.kick();
  eq("시각에 1회", [s.runner.getState().run, s.fake.pushes.length], ["running", 1]);
  s.runner.dispose();
}

console.log("\n=== 상한 ===");
{
  const s = setup(["a", "b"]);
  add(s.runner, "a");
  add(s.runner, "b");
  s.runner.startRun({ limitHours: 1 });
  await s.runner.kick();
  s.fake.emit("a", { attention: "running" });
  s.clock.t = T0 + 3_600_000;
  await s.runner.kick();
  const d = s.fake.diskAtInterrupt as { run: string; items: { state: string }[] };
  eq("interrupt 시점에 이미 저장돼 있다", [d.run, d.items[0].state], ["stopped", "cut"]);
  eq("interrupt와 자동 재개 취소", [s.fake.interrupts, s.fake.cancels], [["a"], ["a"]]);
  const st = s.runner.getState();
  eq("cut(deadline), stopped(deadline)", [st.items[0].state, st.items[0].reason, st.run, st.stopReason], ["cut", "deadline", "stopped", "deadline"]);
  s.fake.emit("a", { attention: "idle" });
  await s.runner.kick();
  eq("interrupt로 끝난 턴 뒤에 다음 작업을 시작하지 않는다", s.fake.pushes.length, 1);
  eq("알림", s.notices.map((x) => x.n), [{ type: "stopped", reason: "deadline" }]);
  s.runner.dispose();
}

console.log("\n=== 연속 실패 ===");
{
  const s = setup(["a", "b", "c"]);
  for (const id of ["a", "b", "c"]) add(s.runner, id);
  s.runner.startRun({ limitHours: 4 });
  await s.runner.kick();
  await runTurn(s, "a", { attention: "failed" });
  eq("실패 1번이면 다음 작업", [stateOf(s.runner, "a"), s.runner.getState().run, s.fake.pushes.length], ["failed", "running", 2]);
  await runTurn(s, "b", { attention: "failed" });
  const st = s.runner.getState();
  eq("연속 2번이면 멈춘다", [st.run, st.stopReason, stateOf(s.runner, "c"), s.fake.pushes.length], ["stopped", "failures", "waiting", 2]);
  eq("실패 알림", s.notices.map((x) => x.n), [{ type: "stopped", reason: "failures" }]);
  s.runner.dispose();
  const s2 = setup(["a", "b", "c", "d"]);
  for (const id of ["a", "b", "c", "d"]) add(s2.runner, id);
  s2.runner.startRun({ limitHours: 4 });
  await s2.runner.kick();
  await runTurn(s2, "a", { attention: "failed" });
  await runTurn(s2, "b");
  await runTurn(s2, "c", { attention: "failed" });
  eq("성공하면 수가 0으로 돌아간다", [s2.runner.getState().run, s2.fake.pushes.length], ["running", 4]);
  s2.runner.dispose();
  const s3 = setup(["a", "b"]);
  add(s3.runner, "a");
  add(s3.runner, "b");
  s3.fake.pushFail = true;
  s3.runner.startRun({ limitHours: 4 });
  await s3.runner.kick();
  const st3 = s3.runner.getState();
  eq("push 실패는 failed(send_failed), 둘 다 실패면 멈춘다", [st3.items.map((i) => [i.state, i.reason]), st3.run, st3.stopReason], [[["failed", "send_failed"], ["failed", "send_failed"]], "stopped", "failures"]);
  s3.runner.dispose();
  const s4 = setup(["a", "b"]);
  add(s4.runner, "a");
  add(s4.runner, "b");
  s4.fake.pres.delete("a");
  s4.runner.startRun({ limitHours: 4 });
  await s4.runner.kick();
  eq("세션이 사라지면 failed(gone), 다음으로", [stateOf(s4.runner, "a"), s4.runner.getState().items[0].reason, s4.fake.pushes.map((p) => p.id)], ["failed", "gone", ["b"]]);
  s4.runner.dispose();
}

console.log("\n=== 한도 포기 / 사람 기다림 ===");
{
  const s = setup(["a", "b"]);
  add(s.runner, "a");
  add(s.runner, "b");
  s.runner.startRun({ limitHours: 4 });
  await s.runner.kick();
  await runTurn(s, "a", { attention: "idle", autoResume: { action: { type: "send", text: "x" }, attempts: 3, gaveUp: true } });
  const st = s.runner.getState();
  eq("gaveUp이면 failed(limit) + stopped(limit)", [st.items[0].state, st.items[0].reason, st.run, st.stopReason, s.fake.pushes.length], ["failed", "limit", "stopped", "limit", 1]);
  eq("알림", s.notices.map((x) => x.n), [{ type: "stopped", reason: "limit" }]);
  s.runner.dispose();

  const h = setup(["a", "b"]);
  add(h.runner, "a");
  add(h.runner, "b");
  h.runner.startRun({ limitHours: 4 });
  await h.runner.kick();
  await runTurn(h, "a", { attention: "waiting", attentionKind: "permission" });
  eq("승인 대기면 줄 전체가 기다린다", [stateOf(h.runner, "a"), h.runner.getState().run, h.fake.pushes.length, h.notices.length], ["running", "running", 1, 0]);
  h.fake.emit("a", { attention: "done" });
  await h.runner.kick();
  eq("답이 오고 끝나면 이어 간다", [stateOf(h.runner, "a"), h.fake.pushes.length], ["done", 2]);
  h.runner.dispose();
}

console.log("\n=== 멈추기 요청 ===");
{
  const s = setup(["a", "b"]);
  add(s.runner, "a");
  add(s.runner, "b");
  s.runner.startRun({ limitHours: 4 });
  await s.runner.kick();
  s.fake.emit("a", { attention: "running" });
  await s.runner.kick();
  s.runner.stop();
  eq("interrupt하지 않는다", [s.fake.interrupts.length, s.runner.getState().run, s.runner.getState().stopReason], [0, "stopped", "manual"]);
  s.fake.emit("a", { attention: "done" });
  await s.runner.kick();
  eq("끝나도 다음을 시작하지 않고, 그 작업은 done으로 기록된다", [stateOf(s.runner, "a"), stateOf(s.runner, "b"), s.fake.pushes.length, s.notices.length], ["done", "waiting", 1, 0]);
  s.runner.dispose();
}

console.log("\n=== 부팅 규칙 ===");
{
  const planAt = { action: { type: "send", text: "x" }, attempts: 1, at: T0 + 999_999 } as const;
  const prep = (state: object, ids: string[]) => {
    fs.writeFileSync(file, JSON.stringify({ limitHours: 4, failStreak: 0, ...state }));
    const fake = makeFake(ids);
    const notices: unknown[] = [];
    const runner = new tq.TaskQueueRunner(fake.port, (n) => notices.push(n), () => T0);
    return { fake, notices, runner };
  };
  const item = (id: string, state: string) => ({ id: `i-${id}`, sessionId: id, text: `글-${id}`, state, addedAt: 1 });
  // 1) 시각 있는 한도 예약 -> 그대로
  let b = prep({ run: "running", deadlineAt: T0 + 1e6, items: [item("a", "running"), item("b", "waiting")] }, ["a", "b"]);
  b.fake.emit("a", { autoResume: planAt });
  b.runner.boot();
  await b.runner.kick();
  eq("시각 있는 예약이 있으면 그대로 둔다", [b.runner.getState().items[0].state, b.fake.pushes.length], ["running", 0]);
  b.runner.dispose();
  // 2) 그 밖 -> cut(restart), 다음 작업
  b = prep({ run: "running", deadlineAt: T0 + 1e6, items: [item("a", "running"), item("b", "waiting")] }, ["a", "b"]);
  b.fake.emit("a", { attention: "waiting", attentionKind: "interrupted_request", autoResume: { action: { type: "send", text: "x" }, attempts: 0, gaveUp: true, restartCutAt: 5 } });
  b.runner.boot();
  await b.runner.kick();
  const s2 = b.runner.getState();
  eq("끊긴 작업은 cut(restart), 글을 다시 보내지 않고 다음으로", [s2.items[0].state, s2.items[0].reason, b.fake.pushes.map((p) => p.id)], ["cut", "restart", ["b"]]);
  b.runner.dispose();
  // 3) scheduled인데 deadline 지남 -> missed
  b = prep({ run: "scheduled", startAt: T0 - 5000, deadlineAt: T0 - 1, items: [item("a", "waiting")] }, ["a"]);
  b.runner.boot();
  await b.runner.kick();
  eq("놓친 예약은 stopped(missed) + 알림", [b.runner.getState().run, b.runner.getState().stopReason, b.notices, b.fake.pushes.length], ["stopped", "missed", [{ type: "stopped", reason: "missed" }], 0]);
  b.runner.dispose();
  // 4) running, deadline 안 지남 -> 이어 간다
  b = prep({ run: "running", deadlineAt: T0 + 1e6, items: [item("a", "done"), item("b", "waiting")] }, ["a", "b"]);
  b.runner.boot();
  await b.runner.kick();
  eq("running이면 이어 간다", [b.runner.getState().run, b.fake.pushes.map((p) => p.id)], ["running", ["b"]]);
  b.runner.dispose();
}

console.log("\n=== 한도가 풀리는 순간(예약 삭제 뒤 idle) ===");
{
  const plan = { action: { type: "send", text: "x" }, attempts: 1, at: T0 + 999_999 } as const;
  // (가) limit_wait -> idle -> running -> done: idle에서 다음 작업을 시작하지 않는다
  const s = setup(["a", "b"]);
  add(s.runner, "a");
  add(s.runner, "b");
  s.runner.startRun({ limitHours: 4 });
  await s.runner.kick();
  s.fake.emit("a", { attention: "running" });
  await s.runner.kick();
  s.fake.emit("a", { attention: "idle", autoResume: plan });
  await s.runner.kick();
  s.fake.emit("a", { attention: "idle", autoResume: undefined });
  await s.runner.kick();
  eq("예약이 지워진 idle은 끝이 아니다", [stateOf(s.runner, "a"), s.fake.pushes.length], ["running", 1]);
  s.fake.emit("a", { attention: "running" });
  await s.runner.kick();
  s.fake.emit("a", { attention: "done" });
  await s.runner.kick();
  eq("재개 턴이 끝나면 다음 작업", [stateOf(s.runner, "a"), s.fake.pushes.map((p) => p.id)], ["done", ["a", "b"]]);
  s.runner.dispose();
  // (나) 부팅 때 시각 있는 예약이 남은 작업도 같은 순서에서 같은 결과
  fs.writeFileSync(file, JSON.stringify({ limitHours: 4, failStreak: 0, run: "running", deadlineAt: T0 + 1e6, items: [{ id: "i-a", sessionId: "a", text: "글-a", state: "running", addedAt: 1 }, { id: "i-b", sessionId: "b", text: "글-b", state: "waiting", addedAt: 1 }] }));
  const fk = makeFake(["a", "b"]);
  const r = new tq.TaskQueueRunner(fk.port, () => undefined, () => T0);
  fk.emit("a", { autoResume: plan });
  r.boot();
  await r.kick();
  fk.emit("a", { autoResume: undefined });
  await r.kick();
  eq("부팅 뒤에도 예약이 지워진 idle은 끝이 아니다", [stateOf(r, "a"), fk.pushes.length], ["running", 0]);
  fk.emit("a", { attention: "running" });
  await r.kick();
  fk.emit("a", { attention: "done" });
  await r.kick();
  eq("부팅 뒤에도 재개 턴이 끝나면 다음 작업", [stateOf(r, "a"), fk.pushes.map((p) => p.id)], ["done", ["b"]]);
  r.dispose();
  // (다) limit_wait 뒤 idle만 오고 끝이면 상한에서 cut(deadline)
  const d = setup(["a", "b"]);
  add(d.runner, "a");
  add(d.runner, "b");
  d.runner.startRun({ limitHours: 1 });
  await d.runner.kick();
  d.fake.emit("a", { attention: "running" });
  d.fake.emit("a", { attention: "idle", autoResume: plan });
  d.fake.emit("a", { attention: "idle", autoResume: undefined });
  await d.runner.kick();
  eq("idle만 오면 기다린다", [stateOf(d.runner, "a"), d.fake.pushes.length], ["running", 1]);
  d.clock.t = T0 + 3_600_000;
  await d.runner.kick();
  eq("상한에서 cut(deadline)", [stateOf(d.runner, "a"), d.runner.getState().items[0].reason], ["cut", "deadline"]);
  d.runner.dispose();
}

console.log("\n=== 보내기 직전 저장 실패 / 입력이 생긴 작업 / 부팅 직후 알림 ===");
{
  const s2 = setup(["a"]);
  add(s2.runner, "a");
  s2.runner.startRun({ limitHours: 4 });
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file); // 이름 바꾸기가 실패하는 저장
  await s2.runner.kick();
  fs.rmSync(file, { recursive: true });
  const st = s2.runner.getState();
  eq("저장 실패면 push 0회, 작업은 waiting, 줄이 멈춘다(failures)", [s2.fake.pushes.length, st.items[0].state, st.run, st.stopReason], [0, "waiting", "stopped", "failures"]);
  s2.runner.dispose();

  const h = setup(["a", "b"]);
  add(h.runner, "a");
  add(h.runner, "b");
  h.fake.hasInput.add("a"); // 넣은 뒤 사람이 먼저 글을 보냈다
  h.runner.startRun({ limitHours: 4 });
  await h.runner.kick();
  eq("입력이 생긴 작업은 보내지 않고 failed(send_failed), 다음으로", [stateOf(h.runner, "a"), h.runner.getState().items[0].reason, h.fake.pushes.map((p) => p.id)], ["failed", "send_failed", ["b"]]);
  h.runner.dispose();

  fs.writeFileSync(file, JSON.stringify({ limitHours: 4, failStreak: 0, run: "running", deadlineAt: T0 + 1e6, items: [{ id: "i-a", sessionId: "a", text: "글-a", state: "running", addedAt: 1 }] }));
  const fk = makeFake(["a"]);
  const notices: unknown[] = [];
  const r = new tq.TaskQueueRunner(fk.port, (n) => notices.push(n), () => T0);
  fk.emit("a", { attention: "waiting", attentionKind: "interrupted_request", autoResume: { action: { type: "send", text: "x" }, attempts: 0, gaveUp: true, restartCutAt: 5 } });
  r.boot();
  await r.kick();
  eq("끊긴 작업만 있으면 알림 없이 멈춘다", [r.getState().run, r.getState().items[0].state, notices], ["stopped", "cut", []]);
  r.dispose();
}

console.log("\n=== dispose ===");
{
  const s = setup(["a", "b"]);
  add(s.runner, "a");
  add(s.runner, "b");
  s.runner.startRun({ limitHours: 4 });
  await s.runner.kick();
  s.runner.dispose();
  s.fake.emit("a", { attention: "running" });
  s.fake.emit("a", { attention: "done" });
  await sleep(30);
  check(s.fake.pushes.length === 1, "dispose 뒤의 presence는 무시한다(push 0회 추가)");
}

console.log("\n=== 저장 ===");
{
  const s = setup(["a"]);
  add(s.runner, "a", "  지시  ");
  s.runner.startRun({ startAt: T0 + 5000, limitHours: 8 });
  const saved = onDisk();
  const again = tq.readTaskQueue();
  eq("쓰고 다시 읽으면 같다", again, saved);
  eq("지시문은 다듬어 저장한다", again.items[0].text, "지시");
  check(!fs.readdirSync(DATA).some((f) => f.endsWith(".tmp")), "임시 파일이 남지 않는다");
  s.runner.dispose();
  fs.writeFileSync(file, "{깨짐");
  const empty = tq.readTaskQueue();
  eq("깨진 파일이면 빈 줄", [empty.run, empty.items.length], ["stopped", 0]);
  check(fs.existsSync(`${file}.broken`) && fs.readFileSync(`${file}.broken`, "utf8") === "{깨짐", "깨진 파일은 지우지 않고 보존한다");
  fs.rmSync(file);
  eq("파일이 없으면 빈 줄", tq.readTaskQueue().items.length, 0);
}

console.log("\n=== 라우트 ===");
{
  const s = setup(["a", "b", "x", "ext", "plain", "typed", "gone"]);
  s.fake.external.add("ext");
  s.fake.notIsolated.add("plain");
  s.fake.hasInput.add("typed");
  s.fake.pres.set("gone", { id: "gone", attention: "idle", status: "active", archivedAt: 1 });
  const app = express();
  app.use(express.json());
  app.use("/api/task-queue", createTaskQueueRouter(s.runner));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/task-queue`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const g = await call("GET", "");
  eq("GET 빈 줄", [g.status, g.body.run, g.body.limitChoices, g.body.maxItems, g.body.items], [200, "stopped", [1, 2, 4, 8, 12], 10, []]);
  eq("글이 비면 400", (await call("POST", "/items", { sessionId: "a", text: "  " })).status, 400);
  eq("2000자를 넘으면 400", (await call("POST", "/items", { sessionId: "a", text: "x".repeat(2001) })).status, 400);
  eq("세션 없음 404", (await call("POST", "/items", { sessionId: "nope", text: "t" })).status, 404);
  eq("보관됨 409", (await call("POST", "/items", { sessionId: "gone", text: "t" })).status, 409);
  eq("외부 세션 409", (await call("POST", "/items", { sessionId: "ext", text: "t" })).status, 409);
  eq("작업 복사본이 아니면 409", (await call("POST", "/items", { sessionId: "plain", text: "t" })).status, 409);
  eq("이미 입력이 있으면 409", (await call("POST", "/items", { sessionId: "typed", text: "t" })).status, 409);
  const ok = await call("POST", "/items", { sessionId: "a", text: "첫 글" });
  eq("정상 추가", [ok.status, ok.body.item.state, ok.body.item.text], [200, "waiting", "첫 글"]);
  eq("이미 줄에 있으면 409", (await call("POST", "/items", { sessionId: "a", text: "t" })).status, 409);
  eq("없는 작업 삭제 404", (await call("DELETE", "/items/zzz")).status, 404);
  eq("시작: 상한이 목록 밖이면 400", (await call("POST", "/start", { limitHours: 3 })).status, 400);
  eq("시작: 48시간 밖이면 400", (await call("POST", "/start", { limitHours: 2, startAt: Date.now() + 49 * 3_600_000 })).status, 400);
  const started = await call("POST", "/start", { limitHours: 2 });
  eq("정상 시작", [started.status, started.body.run], [200, "running"]);
  eq("이미 돌면 시작 409", (await call("POST", "/start", { limitHours: 2 })).status, 409);
  await s.runner.kick();
  eq("도는 작업 삭제 409", (await call("DELETE", `/items/${ok.body.item.id}`)).status, 409);
  const stopped = await call("POST", "/stop");
  eq("정지", [stopped.status, stopped.body.run, stopped.body.stopReason], [200, "stopped", "manual"]);
  eq("기다리는 작업이 없으면 시작 409", (await call("POST", "/start", { limitHours: 2 })).status, 409);
  s.fake.emit("a", { attention: "running" });
  s.fake.emit("a", { attention: "done" });
  await s.runner.kick();
  eq("끝난 작업은 뺄 수 있다", (await call("DELETE", `/items/${ok.body.item.id}`)).status, 200);
  // 10개 제한
  s.fake.pres.clear();
  for (let i = 0; i < 11; i++) s.fake.pres.set(`q${i}`, { id: `q${i}`, attention: "idle", status: "active" });
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await call("POST", "/items", { sessionId: `q${i}`, text: "t" })).status);
  eq("작업 10개까지, 11번째는 409", codes, [...Array(10).fill(200), 409]);
  const sched = await call("POST", "/start", { limitHours: 1, startAt: Date.now() + 3_600_000 });
  eq("예약 시작", [sched.status, sched.body.run], [200, "scheduled"]);
  eq("예약 중 멈추기는 예약을 지운다", [(await call("POST", "/stop")).body.run, (await call("GET", "")).body.startAt], ["stopped", undefined]);
  server.close();
  s.runner.dispose();
}

console.log("\n=== 통합: 작업 복사본 세션 둘 ===");
{
  fs.rmSync(file, { force: true });
  const unregister = __registerProviderForTest(mock.mockEntry);
  sessionManager.setOnLive((session) => attachNotify(session, () => undefined)); // 주의 상태는 알림 판정부가 만든다. index.ts와 같은 배선
  const a = sessionManager.create({ cwd: SRC, provider: mock.MOCK_PROVIDER, isolateWorkspace: true });
  const b = sessionManager.create({ cwd: SRC, provider: mock.MOCK_PROVIDER, isolateWorkspace: true });
  const plain = sessionManager.create({ cwd: SRC, provider: mock.MOCK_PROVIDER });
  const notices: unknown[] = [];
  const runner = new tq.TaskQueueRunner(tq.sessionManagerPort(sessionManager), (n) => notices.push(n));
  runner.boot();
  try {
    eq("작업 복사본이 아닌 세션은 거절", runner.add(plain.id, "t"), { ok: false, code: "notIsolated" });
    add(runner, a.id, "첫째 일");
    add(runner, b.id, "둘째 일");
    runner.startRun({ limitHours: 1 });
    const gotText = async (id: string, text: string) =>
      waitUntil(() => (require_events(id)).some((e) => e.kind === "user_msg" && e.text === text && !e.sentBy));
    function require_events(id: string) {
      return (store.readRecentEvents(id) as unknown as { kind: string; text?: string; sentBy?: string }[]);
    }
    const store = await import("../sessions/persistence");
    check(await gotText(a.id, "첫째 일"), "첫 세션이 첫 글을 받는다(사람 글로, sentBy 없음)");
    check(await gotText(b.id, "둘째 일"), "첫 턴이 끝나면 둘째 세션에 글이 간다");
    check(await waitUntil(() => runner.getState().run === "stopped"), "모두 마치면 멈춘다");
    eq("두 작업 done + 알림", [runner.getState().items.map((i) => i.state), notices], [["done", "done"], [{ type: "finished" }]]);
  } finally {
    runner.dispose();
    for (const id of [a.id, b.id, plain.id]) sessionManager.delete(id);
    unregister();
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} task_queue: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
