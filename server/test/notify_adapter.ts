/**
 * 알림 어댑터·판정부 배선 — F4(키 없음)·F5(구독 0)·F6(어댑터 미장착)과
 * 브라우저 payload(tag), 문맥 85% 히스테리시스.
 * 모델 호출 0.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";
import type { NotifyIntent } from "../notify/worthNotifying";
import type { NotifySession } from "../notify/coordinator";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-notify-adapter-"));
delete process.env.AETHER_VAPID_PUBLIC;
delete process.env.AETHER_VAPID_PRIVATE;

const { toBrowserPayload, notifyPush, vapidPublicIfEnabled } = await import("../push");
const { attachNotify, considerNotify } = await import("../notify/coordinator");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("notify_adapter"); // 임시 SQLite 일기
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const { config } = await import("../config");
const express = (await import("express")).default;
const { pushRouter } = await import("../routes/push");

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

const raw = (body: Record<string, unknown>) => ({ seq: 1, ts: 1, ...body }) as AetherEvent;

console.log("\n=== 브라우저 payload 매핑 ===");
eq(
  "권한 의도는 승인 정보 없이 세션 tag만 된다",
  toBrowserPayload({
    title: "배포 작업 · 권한 요청",
    body: "Bash · npm test",
    sessionId: "session-1",
    kind: "permission",
  }),
  {
    title: "배포 작업 · 권한 요청",
    body: "Bash · npm test",
    sessionId: "session-1",
    tag: "session-1",
  },
);
eq(
  "문맥 의도의 tag는 ctx-세션id다",
  toBrowserPayload({
    title: "컨텍스트 한계 임박",
    body: "배포 작업 컨텍스트 90% 사용 — /compact 또는 정리를 권해요",
    sessionId: "session-1",
    topic: "context",
  }),
  {
    title: "컨텍스트 한계 임박",
    body: "배포 작업 컨텍스트 90% 사용 — /compact 또는 정리를 권해요",
    sessionId: "session-1",
    tag: "ctx-session-1",
  },
);

console.log("\n=== 문맥 85% 히스테리시스 ===");
function fakeSession(opts: { name?: string; disposed?: boolean; backgroundTasks?: unknown[] } = {}): NotifySession & { emit: (ev: AetherEvent) => void; markDisposed: () => void } {
  const subs = new Set<(ev: AetherEvent) => void>();
  let disposed = opts.disposed ?? false;
  const session: NotifySession & { emit: (ev: AetherEvent) => void; markDisposed: () => void } = {
    id: "session-1",
    cwd: "/tmp/deploy",
    backgroundTasks: opts.backgroundTasks ?? [],
    name: opts.name,
    provider: "claude",
    get isDisposed() {
      return disposed;
    },
    codec: {
      isLiveOnly: (ev) => (ev as { liveOnly?: boolean }).liveOnly === true,
      normalize: (ev) => ((ev as { events?: AgentEvent[] }).events ?? []),
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    emit(ev) {
      for (const fn of subs) fn(ev);
    },
    markDisposed() {
      disposed = true;
    },
  };
  return session;
}

{
  const state = { ctxWarned: false };
  const s = fakeSession({ name: "배포 작업" });
  const first = considerNotify(s, raw({ kind: "ctx", totalTokens: 85, maxTokens: 100 }), state);
  eq("85% 첫 경고", first, {
    title: "컨텍스트 한계 임박",
    body: "배포 작업 컨텍스트 85% 사용 — /compact 또는 정리를 권해요",
    sessionId: "session-1",
    topic: "context",
  });
  const second = considerNotify(s, raw({ kind: "ctx", totalTokens: 90, maxTokens: 100 }), state);
  eq("85% 이상 재진입은 안 알린다", second, undefined);
  const low = considerNotify(s, raw({ kind: "ctx", totalTokens: 70, maxTokens: 100 }), state);
  eq("75% 아래는 재무장만 한다", low, undefined);
  const again = considerNotify(s, raw({ kind: "ctx", totalTokens: 86, maxTokens: 100 }), state);
  eq("재무장 뒤 다시 85%면 알린다", again?.topic, "context");
  const unnamed = considerNotify(fakeSession(), raw({ kind: "ctx", totalTokens: 90, maxTokens: 100 }), { ctxWarned: false });
  eq("이름 없는 세션은 폴백 이름을 쓴다", unnamed?.body.includes("세션"), true);
}

console.log("\n=== F4 키 없음 ===");
eq("F4 공개키 조회는 비어 있다", vapidPublicIfEnabled(), undefined);
eq("F4 전송은 no-vapid", notifyPush({ title: "t", body: "b", sessionId: "s" }), { attempted: 0, reason: "no-vapid" });

{
  const unregister = __registerProviderForTest(mock.mockEntry);
  const seen: AetherEvent[] = [];
  const sent: NotifyIntent[] = [];
  const cwd = config.projectRootReal ?? config.projectRoot;
  sessionManager.setOnLive((session) => attachNotify(session, (intent) => sent.push(intent)));
  try {
    const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
    live.subscribe((ev) => seen.push(ev));
    void (live as unknown as { requestPermission: (ask: unknown) => Promise<unknown> }).requestPermission({
      toolName: "Bash",
      input: { command: "npm test" },
      toolUseID: "tool-f4",
      signal: new AbortController().signal,
    });
    const perm = seen.find((e) => e.kind === "permission_request");
    check(!!perm, "F4 세션은 권한 사건을 구독자에게 보낸다");
    check(sent.length === 1 && sent[0]?.kind === "permission" && !("action" in sent[0]), "F4 판정부는 승인 행동 없이 의도를 낸다(어댑터 no-op와 별개)");
    check(!("permissionId" in toBrowserPayload(sent[0]!)), "F4 브라우저 payload에 승인 id가 없다");
    eq("F4 어댑터는 여전히 키 없음", notifyPush(toBrowserPayload(sent[0]!)), { attempted: 0, reason: "no-vapid" });
    sessionManager.delete(live.id);
  } finally {
    sessionManager.setOnLive(undefined);
    unregister();
  }
}

console.log("\n=== F5 구독 0개 ===");
process.env.AETHER_VAPID_PUBLIC = "test-public";
process.env.AETHER_VAPID_PRIVATE = "test-private";
eq("F5 키는 켜진 것으로 본다", vapidPublicIfEnabled(), "test-public");
eq("F5 구독 0이면 전송 시도 없음", notifyPush({ title: "t", body: "b", sessionId: "s", tag: "s" }), {
  attempted: 0,
  reason: "no-subscribers",
});
delete process.env.AETHER_VAPID_PUBLIC;
delete process.env.AETHER_VAPID_PRIVATE;

console.log("\n=== F6 어댑터 미장착 ===");
{
  const unregister = __registerProviderForTest(mock.mockEntry);
  const seen: AetherEvent[] = [];
  const sent: NotifyIntent[] = [];
  const cwd = config.projectRootReal ?? config.projectRoot;
  sessionManager.setOnLive(undefined);
  try {
    const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
    live.subscribe((ev) => seen.push(ev));
    void (live as unknown as { requestPermission: (ask: unknown) => Promise<unknown> }).requestPermission({
      toolName: "Bash",
      input: { command: "ls" },
      toolUseID: "tool-f6",
      signal: new AbortController().signal,
    });
    check(
      seen.some((e) => e.kind === "permission_request"),
      "F6 본체는 권한 사건을 그대로 낸다",
    );
    check(sent.length === 0, "F6 살아남 콜백을 안 붙이면 알림 전송이 없다");
    const unsub = attachNotify(live); // send 없음
    void (live as unknown as { requestPermission: (ask: unknown) => Promise<unknown> }).requestPermission({
      toolName: "Bash",
      input: { command: "pwd" },
      toolUseID: "tool-f6b",
      signal: new AbortController().signal,
    });
    check(sent.length === 0, "F6 send 없이 attach해도 전송이 없다");
    unsub();
    sessionManager.delete(live.id);
  } finally {
    unregister();
  }
}

console.log("\n=== GET /api/push/vapid ===");
{
  const app = express();
  app.use("/api/push", pushRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const empty = (await (await fetch(`${base}/api/push/vapid`)).json()) as Record<string, unknown>;
    check(!empty.vapidPublic, "키 없으면 /api/push/vapid가 공개키를 안 준다");
    process.env.AETHER_VAPID_PUBLIC = "test-public";
    process.env.AETHER_VAPID_PRIVATE = "test-private";
    const keyed = (await (await fetch(`${base}/api/push/vapid`)).json()) as { vapidPublic?: string };
    eq("키 있으면 /api/push/vapid가 공개키를 준다", keyed.vapidPublic, "test-public");
  } finally {
    delete process.env.AETHER_VAPID_PUBLIC;
    delete process.env.AETHER_VAPID_PRIVATE;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

{
  const s = fakeSession({ name: "배포 작업" });
  const sent: NotifyIntent[] = [];
  const stop = attachNotify(s, (intent) => sent.push(intent));
  s.emit(
    raw({
      kind: "permission_request",
      req: { id: "permission-7", toolName: "Bash", displayName: "Bash", input: { command: "npm test" }, toolUseID: "t", createdAt: 1 },
    }),
  );
  eq("판정부가 권한 대상 본문을 만든다", sent[0]?.body, "Bash · npm test");
  s.markDisposed();
  s.emit(
    raw({
      kind: "permission_request",
      req: { id: "permission-8", toolName: "Bash", displayName: "Bash", input: { command: "pwd" }, toolUseID: "t2", createdAt: 1 },
    }),
  );
  check(sent.length === 1, "삭제된 세션은 알리지 않는다");
  stop();
}

{
  const s = fakeSession({ name: "배포 작업" });
  const sent: NotifyIntent[] = [];
  const stop = attachNotify(s, (intent) => sent.push(intent));
  const textEv = { type: "text", text: "마지막 답변입니다", provider: "claude", seq: 1, part: 0, ts: 1 } as AgentEvent;
  const doneEv = { type: "turn_completed", status: "ok", provider: "claude", seq: 2, part: 0, ts: 1 } as AgentEvent;
  s.emit(raw({ kind: "sdk", events: [textEv] }));
  s.emit(raw({ kind: "sdk", events: [doneEv] }));
  eq("판정부가 마지막 답변을 기억해 완료 본문에 넣는다", sent[0]?.body, "마지막 답변입니다");
  stop();
}

{
  const mk = (status: "ok" | "failed") => raw({ kind: "sdk", events: [{ type: "turn_completed", status, provider: "claude", seq: 3, part: 0, ts: 1 } as AgentEvent] });
  const withBg = fakeSession({ name: "배포 작업", backgroundTasks: [{ id: "bg1" }] });
  eq("뒤 작업이 남은 채 턴이 끝나면 완료 알림이 없다", considerNotify(withBg, mk("ok"), { ctxWarned: false }), undefined);
  eq("뒤 작업이 남아도 실패 알림은 그대로", considerNotify(withBg, mk("failed"), { ctxWarned: false })?.kind, "failed");
  eq("뒤 작업이 없으면 완료 알림이 나온다", considerNotify(fakeSession({ name: "배포 작업" }), mk("ok"), { ctxWarned: false })?.kind, "done");
}

console.log("\n=== 조립 팬아웃(웹 푸시 + 데스크톱) ===");
{
  const { emitDesktopNotify, subscribeDesktopNotify } = await import("../notify/desktop");
  const webSent: NotifyIntent[] = [];
  const deskSent: NotifyIntent[] = [];
  const unsub = subscribeDesktopNotify((intent) => deskSent.push(intent));
  const intent: NotifyIntent = { title: "fanout", body: "b", sessionId: "s1" };
  // 조립부 흉내: 같은 의도를 웹 푸시 send와 desktop emit에 각각 1
  const deliverWebPushMock = (i: NotifyIntent) => {
    webSent.push(i);
  };
  deliverWebPushMock(intent);
  emitDesktopNotify(intent);
  check(webSent.length === 1 && webSent[0]?.title === "fanout", "팬아웃: 웹 푸시 send 1");
  check(deskSent.length === 1 && deskSent[0]?.title === "fanout", "팬아웃: desktop emit 1");
  unsub();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} notify_adapter: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
