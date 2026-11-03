/**
 * A1 한도가 풀리면 이어 가기 — 순수 판별, 예약 수명, 재시작 복원, HTTP. 가짜 provider만 쓴다(모델 호출 0).
 * 운영 데이터는 건드리지 않는다: 임시 데이터 폴더.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-autoresume-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-autoresume-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const ar = await import("../sessions/autoResume");
const { worthNotifying, isBlockedRateLimit } = await import("../notify/worthNotifying");
const { attachNotify } = await import("../notify/coordinator");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("auto_resume"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const { config } = await import("../config");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const express = (await import("express")).default;
const { sessionsRouter } = await import("../routes/sessions");
const { autoResumeRouter } = await import("../routes/autoResume");

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

// ── 순수 함수 ──
console.log("\n=== nextAttemptAt ===");
{
  const now = 1_700_000_000_000;
  eq("초 단위 시각 + 60초", ar.nextAttemptAt(0, now / 1000 + 600, now), now + 600_000 + 60_000);
  eq("ms 단위 시각 + 60초", ar.nextAttemptAt(0, now + 600_000, now), now + 600_000 + 60_000);
  eq("시각을 모르면 30분", ar.nextAttemptAt(0, undefined, now), now + 30 * 60_000);
  eq("두 번째는 1시간", ar.nextAttemptAt(1, undefined, now), now + 60 * 60_000);
  eq("세 번째는 2시간", ar.nextAttemptAt(2, undefined, now), now + 120 * 60_000);
  eq("이미 지난 시각이면 간격 규칙", ar.nextAttemptAt(0, now - 10_000, now), now + 30 * 60_000);
}

console.log("\n=== trackAutoResume ===");
{
  const ev = (kind: string) => ({ seq: 1, ts: 1, kind }) as unknown as AetherEvent;
  const blocked = (resetsAt?: number): AgentEvent => ({ type: "provider_notice", kind: "rate_limit", severity: "blocked", ...(resetsAt ? { resetsAt } : {}) }) as AgentEvent;
  const done = (status: "ok" | "failed" | "interrupted"): AgentEvent => ({ type: "turn_completed", status }) as AgentEvent;
  const fresh = (): import("../sessions/autoResume").AutoResumeTrack => ({ turnOpen: false });

  let t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("막힘 알림은 판정을 내지 않는다", ar.trackAutoResume(t, ev("x"), [blocked(2_000_000_000)]), undefined);
  eq("막힘 다음 실패 -> blocked", ar.trackAutoResume(t, ev("x"), [done("failed")]), { type: "blocked", until: 2_000_000_000_000 });

  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("실패 먼저 -> 판정 없음", ar.trackAutoResume(t, ev("x"), [done("failed")]), undefined);
  eq("실패 다음 막힘 -> blocked", ar.trackAutoResume(t, ev("x"), [blocked()]), { type: "blocked", until: undefined });

  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("한 사건 안의 막힘과 실패 -> blocked", ar.trackAutoResume(t, ev("x"), [blocked(), done("failed")]), { type: "blocked", until: undefined });

  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  ar.trackAutoResume(t, ev("x"), [done("ok")]);
  eq("정상 턴 뒤의 막힘은 판정 없음", ar.trackAutoResume(t, ev("x"), [blocked()]), undefined);

  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("ok -> settled", ar.trackAutoResume(t, ev("x"), [done("ok")]), { type: "settled" });
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("interrupted -> settled", ar.trackAutoResume(t, ev("x"), [done("interrupted")]), { type: "settled" });

  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  ar.trackAutoResume(t, ev("x"), [blocked(2_000_000_000)]);
  ar.trackAutoResume(t, ev("x"), [blocked()]);
  eq("두 번째 알림에 시각이 없으면 앞의 until 유지", ar.trackAutoResume(t, ev("x"), [done("failed")]), { type: "blocked", until: 2_000_000_000_000 });

  // 사람 입력 없이 스스로 열린 턴: 정상 턴 뒤 막힘 -> 실패 -> 모델 호출 없는 빈 성공 턴(실제 사고 순서).
  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  ar.trackAutoResume(t, ev("x"), [done("ok")]);
  eq("턴 밖의 막힘은 판정을 내지 않는다", ar.trackAutoResume(t, ev("x"), [blocked(2_000_000_000)]), undefined);
  check(t.blocked === undefined, "턴 밖의 막힘은 턴 안의 막힘으로 치지 않는다(알림을 줄이지 않게)");
  eq("턴 밖 막힘 다음 실패 -> blocked", ar.trackAutoResume(t, ev("x"), [done("failed")]), { type: "blocked", until: 2_000_000_000_000 });
  eq("막힌 뒤 입력 없는 성공 턴은 예약을 지우지 않는다", ar.trackAutoResume(t, ev("x"), [done("ok")]), undefined);
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("입력이 들어온 뒤의 성공은 settled", ar.trackAutoResume(t, ev("x"), [done("ok")]), { type: "settled" });

  t = fresh();
  ar.trackAutoResume(t, ev("user_msg"), []);
  ar.trackAutoResume(t, ev("x"), [blocked(), done("failed")]);
  eq("막힌 뒤 사람이 중단한 턴은 settled", ar.trackAutoResume(t, ev("x"), [done("interrupted")]), { type: "settled" });

  t = fresh();
  ar.trackAutoResume(t, ev("x"), [done("ok")]);
  ar.trackAutoResume(t, ev("x"), [blocked()]);
  eq("턴 밖 막힘 다음 성공은 settled", ar.trackAutoResume(t, ev("x"), [done("ok")]), { type: "settled" });
  eq("끝난 턴의 막힘은 다음 턴으로 넘어가지 않는다", ar.trackAutoResume(t, ev("x"), [done("failed")]), undefined);

  t = fresh();
  ar.trackAutoResume(t, ev("x"), [blocked()]);
  ar.trackAutoResume(t, ev("user_msg"), []);
  eq("새 입력은 턴 밖의 막힘을 지운다", ar.trackAutoResume(t, ev("x"), [done("failed")]), undefined);
}

console.log("\n=== worthNotifying 순서 ===");
{
  const intent = worthNotifying(
    { seq: 1, ts: 1, kind: "x" } as unknown as AetherEvent,
    [{ type: "provider_notice", kind: "rate_limit", severity: "blocked" } as AgentEvent, { type: "turn_completed", status: "failed" } as AgentEvent],
    { id: "s", name: "n", providerName: "P" },
  );
  eq("막힘과 실패가 같이 있으면 rate_limit", intent?.kind, "rate_limit");
  check(isBlockedRateLimit({ type: "provider_notice", kind: "rate_limit", severity: "blocked" } as unknown as AgentEvent), "isBlockedRateLimit 참");
  check(!isBlockedRateLimit({ type: "provider_notice", kind: "rate_limit", severity: "warning" } as unknown as AgentEvent), "isBlockedRateLimit 거짓(경고)");
}

// ── 통합 ──
const unregister = __registerProviderForTest(mock.mockEntry);
const sent: { kind?: string; title: string }[] = [];
const notifyOut = (i: { kind?: string; title: string }) => sent.push(i);
sessionManager.setOnLive((session) => attachNotify(session, notifyOut));
sessionManager.setNotifyOut(notifyOut);
const cwd = config.projectRootReal ?? config.projectRoot;

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
app.use("/api/auto-resume", autoResumeRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const planOf = (id: string) => sessionManager.list().find((s) => s.id === id)?.autoResume;
const userMsgs = (id: string) => store.readRecentEvents(id).filter((e) => e.kind === "user_msg") as unknown as { text: string; sentBy?: string }[];
const metaOf = (id: string) => JSON.parse(fs.readFileSync(path.join(DATA, id, "meta.json"), "utf8")) as { autoResume?: { at?: number; attempts: number; gaveUp?: boolean } };

console.log("\n=== 예약 만들기와 자동 전송 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    sent.length = 0;
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    live.push(`LIMIT:${resetSec}`);
    check(await waitUntil(() => planOf(live.id)?.at !== undefined), "막힌 턴이 끝나면 예약이 생긴다", planOf(live.id));
    eq("시각 = 풀리는 시각 + 60초", planOf(live.id)?.at, resetSec * 1000 + 60_000);
    eq("meta.json에 저장", metaOf(live.id).autoResume?.at, resetSec * 1000 + 60_000);
    eq("presence에도 실린다", sessionManager.presenceSnapshot().find((p) => p.id === live.id)?.autoResume?.at, resetSec * 1000 + 60_000);
    eq("한도·실패 알림이 모두 막힌다", sent, []);

    // 시각을 곧으로 바꾸면 자동 전송이 나가고, 정상으로 끝나면 예약이 지워진다.
    const r = sessionManager.editAutoResume(live.id, { at: Date.now() + 50 });
    check(typeof r === "object", "시각 바꾸기");
    check(await waitUntil(() => userMsgs(live.id).some((m) => m.sentBy === "aether")), "자동 전송에 sentBy 표시");
    check(await waitUntil(() => planOf(live.id) === undefined && !metaOf(live.id).autoResume), "정상으로 끝나면 예약이 지워진다", planOf(live.id));
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 세 번 막히면 포기 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    sent.length = 0;
    live.push("LIMIT:");
    check(await waitUntil(() => planOf(live.id)?.at !== undefined), "예약 생성");
    eq("시각을 모르면 30분 뒤", Math.round(((planOf(live.id)?.at ?? 0) - Date.now()) / 60_000), 30);
    eq("알림 없음", sent, []);
    sessionManager.editAutoResume(live.id, { text: "LIMIT:" });
    for (let n = 1; n <= 3; n++) {
      await sessionManager.fireAutoResume(live.id);
      check(await waitUntil(() => planOf(live.id)?.at !== undefined || planOf(live.id)?.gaveUp === true), `${n}번째 전송 뒤 다시 막힘`);
      eq(`${n}번째 전송 후 횟수`, metaOf(live.id).autoResume?.attempts, n);
    }
    // 3번 보낸 뒤의 막힘은 포기가 아니라 4번째 예약 요청이다: 횟수 3이 이미 찼으므로 포기한다.
    check(planOf(live.id)?.gaveUp === true, "3번 뒤 막히면 gaveUp", planOf(live.id));
    eq("포기 알림은 정확히 한 번", sent.length, 1);
    eq("포기 알림 종류", sent[0]?.kind, "rate_limit");
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 사람 글·보관·일하는 중 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    live.push("LIMIT:");
    check(await waitUntil(() => planOf(live.id)?.at !== undefined), "예약 생성");
    live.push("사람이 보낸 글");
    check(await waitUntil(() => planOf(live.id) === undefined), "사람이 보내면 취소(목록)");
    check(await waitUntil(() => !metaOf(live.id).autoResume), "사람이 보내면 취소(메타)");
    eq("사람이 보내면 취소(presence)", sessionManager.presenceSnapshot().find((p) => p.id === live.id)?.autoResume, undefined);
  } finally {
    sessionManager.delete(live.id);
  }
}
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    live.push("LIMIT:");
    check(await waitUntil(() => planOf(live.id)?.at !== undefined), "예약 생성");
    check(sessionManager.setArchived(live.id, true) !== "busy", "보관");
    eq("보관하면 예약이 지워진다", planOf(live.id), undefined);
    const res = await fetch(`${base}/api/sessions/${live.id}/auto-resume`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    eq("보관된 세션에 PUT은 409", res.status, 409);
  } finally {
    sessionManager.delete(live.id);
  }
}
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    // 사람 글이 아닌(aether) 입력으로 턴을 열어 둔다 — 권한 대기로 일하는 중 상태.
    live.push("ASK:busy", undefined, undefined, undefined, { sentBy: "aether" });
    check(await waitUntil(() => live.isTurnOpen), "턴이 열려 있다");
    live.setAutoResume({ action: { type: "send", text: "x" }, at: Date.now(), attempts: 1 });
    const before = Date.now();
    await sessionManager.fireAutoResume(live.id);
    const p = sessionManager.getAutoResume(live.id);
    eq("일하는 중이면 횟수는 그대로", p?.attempts, 1);
    check((p?.at ?? 0) >= before + 59_000, "60초 미룬다", p);
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 재시작 복원 ===");
{
  const mk = (id: string, autoResume: unknown) => {
    const dir = path.join(DATA, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: ROOT, createdAt: 1, resumeKey: "mock-thread-ar", autoResume }));
    store.appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" } as never);
  };
  mk("ar-past-1", { action: { type: "send", text: "이어서" }, at: 1000, attempts: 1 });
  mk("ar-waiting-1", { action: { type: "send", text: "이어서" }, attempts: 1 });
  mk("ar-gaveup-1", { action: { type: "send", text: "이어서" }, attempts: 3, gaveUp: true });
  sessionManager.restoreFromDisk();
  const now = Date.now();
  const at = planOf("ar-past-1")?.at ?? 0;
  check(at >= now + 25_000 && at <= now + 40_000, "지난 예약은 부팅 30초 뒤로 미룬다", at - now);
  eq("보내고 기다리던 예약은 버린다", planOf("ar-waiting-1"), undefined);
  eq("버린 예약은 메타에서도 지운다", metaOf("ar-waiting-1").autoResume, undefined);
  eq("포기한 예약은 표시용으로 남는다", planOf("ar-gaveup-1")?.gaveUp, true);
  check(sessionManager.get("ar-past-1") === undefined, "복원만으로 깨우지 않는다");
  await sessionManager.fireAutoResume("ar-past-1");
  check(sessionManager.get("ar-past-1") !== undefined, "시각이 되면 세션이 깨어난다");
  check(await waitUntil(() => userMsgs("ar-past-1").some((m) => m.sentBy === "aether" && m.text === "이어서")), "sentBy 사건이 남는다");
  for (const id of ["ar-past-1", "ar-waiting-1", "ar-gaveup-1"]) sessionManager.delete(id);
}

console.log("\n=== 설정을 끄면 ===");
{
  ar.writeAutoResumeSettings({ enabled: false });
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    sent.length = 0;
    live.push("LIMIT:");
    check(await waitUntil(() => sent.some((i) => i.kind === "failed")), "실패 알림이 나간다", sent);
    check(sent.some((i) => i.kind === "rate_limit"), "한도 알림이 나간다", sent);
    eq("예약은 만들지 않는다", planOf(live.id), undefined);
  } finally {
    sessionManager.delete(live.id);
    ar.writeAutoResumeSettings({ enabled: true });
  }
}

console.log("\n=== 잠든 세션 깨우기 실패 ===");
{
  const id = "ar-wakefail-1";
  const work = fs.mkdtempSync(path.join(ROOT, "wf-"));
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: work, name: "잠든 작업", createdAt: 1, resumeKey: "mock-thread-wf", autoResume: { action: { type: "send", text: "이어서" }, at: Date.now() + 3_600_000, attempts: 0 } }));
  store.appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" } as never);
  sessionManager.restoreFromDisk();
  fs.rmSync(work, { recursive: true, force: true }); // 깨울 때 작업 폴더가 없어 실패한다
  sent.length = 0;
  await sessionManager.fireAutoResume(id);
  check(sessionManager.get(id) === undefined, "깨우지 못했다");
  eq("잠든 세션도 전송 실패 알림이 나간다", sent.length, 1);
  check(sent[0]?.title.includes("잠든 작업") === true, "알림에 디스크 메타의 이름이 쓰인다", sent[0]);
  eq("포기 표시", planOf(id)?.gaveUp, true);
  sessionManager.delete(id);
}

console.log("\n=== 설정을 끄면 진행 중 예약도 지운다 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    live.push("LIMIT:");
    check(await waitUntil(() => planOf(live.id)?.at !== undefined), "예약 생성");
    ar.writeAutoResumeSettings({ enabled: false });
    await sessionManager.fireAutoResume(live.id);
    eq("꺼져 있으면 시각이 돼도 보내지 않고 예약을 지운다", [planOf(live.id), userMsgs(live.id).some((m) => m.sentBy === "aether")], [undefined, false]);
  } finally {
    sessionManager.delete(live.id);
    ar.writeAutoResumeSettings({ enabled: true });
  }
}

console.log("\n=== HTTP ===");
{
  const put = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const got = (await (await fetch(`${base}/api/auto-resume`)).json()) as { enabled: boolean; text: string; defaultText: string };
  eq("기본 문장으로 시작", [got.enabled, got.text], [true, got.defaultText]);
  const changed = (await (await put("/api/auto-resume", { text: "계속해", enabled: false })).json()) as typeof got;
  eq("설정 저장", [changed.enabled, changed.text], [false, "계속해"]);
  const reset = (await (await put("/api/auto-resume", { text: "", enabled: true })).json()) as typeof got;
  eq("빈 문장이면 기본으로", [reset.enabled, reset.text], [true, reset.defaultText]);
  eq("2000자 초과는 400", (await put("/api/auto-resume", { text: "가".repeat(2001) })).status, 400);

  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    eq("예약 없으면 404", (await put(`/api/sessions/${live.id}/auto-resume`, { text: "x" })).status, 404);
    live.push("LIMIT:");
    check(await waitUntil(() => planOf(live.id)?.at !== undefined), "예약 생성");
    const url = `/api/sessions/${live.id}/auto-resume`;
    eq("지난 시각은 400", (await put(url, { at: Date.now() - 60_000 })).status, 400);
    eq("31일 초과는 400", (await put(url, { at: Date.now() + 32 * 24 * 3600_000 })).status, 400);
    eq("빈 문장은 400", (await put(url, { text: "  " })).status, 400);
    eq("문자열 시각은 400", (await put(url, { at: "내일" })).status, 400);
    const at = Date.now() + 3600_000;
    eq("정상 편집", (await put(url, { at, text: "다시 해" })).status, 200);
    eq("편집 결과", [planOf(live.id)?.at, (planOf(live.id)?.action as { text?: string } | undefined)?.text], [at, "다시 해"]);
    eq("DELETE 성공", (await fetch(`${base}${url}`, { method: "DELETE" })).status, 200);
    eq("DELETE 뒤 예약 없음", planOf(live.id), undefined);
    eq("없어도 DELETE는 성공", (await fetch(`${base}${url}`, { method: "DELETE" })).status, 200);
  } finally {
    sessionManager.delete(live.id);
  }
}

server.close();
unregister();
console.log(`\n${fail === 0 ? "✅" : "❌"} auto_resume: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
