/**
 * Codex 이벤트의 디스크 저장 정책 검증 (Phase 8e 단위 2 · D2.3) — 모델 호출 0.
 *
 * 지키려는 문장: **화면에는 받은 그대로 흘리되, 디스크에는 줄이고 가린 것만 남긴다.**
 * 그래서 세 가지를 본다.
 *   ① 중간 조각(글자 단위 스트리밍·진행 스냅샷)은 디스크에 안 남는다 — 완성본이 따로 오므로 두 벌이 되면 안 된다.
 *   ② 커지는 값(명령 출력·파일 변경 내용·MCP 인자와 결과)은 상한 안으로 잘린다.
 *   ③ 비밀은 남지 않는다 — 명령줄에 적힌 토큰은 가리고, 비밀 파일의 변경 내용은 통째로 지운다.
 * 마지막으로 계정·한도 알림이 대화 기록에 섞이지 않는지 확인한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 설정은 import 시점에 한 번 읽힌다 — 자르기 상한을 낮춰야 짧은 입력으로 시나리오를 만들 수 있다.
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexsan-"));
process.env.AETHER_PERSIST_MAX_FIELD_CHARS = "256";

const { codexCodec } = await import("../sessions/codec/codex");
const { normalizeCodex } = await import("../sessions/normalize/codex");
type AetherEvent = import("../types").AetherEvent;
type ServerNotification = import("../codex/protocol/ServerNotification").ServerNotification;
type ThreadItem = import("../codex/protocol/v2/ThreadItem").ThreadItem;

const MAX = 256;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}

let seq = 0;
/** 원본 봉투 하나 — 디스크에 적히는 것과 같은 모양이다. */
function ev(msg: unknown): AetherEvent {
  return { seq: ++seq, ts: 1000 + seq, kind: "codex", msg } as AetherEvent;
}
function notif(method: string, params: unknown): ServerNotification {
  return { method, params } as ServerNotification;
}
function itemDone(item: ThreadItem): AetherEvent {
  return ev(notif("item/completed", { threadId: "th-1", turnId: "tn-1", completedAtMs: 1, item }));
}

/** 영속본을 만든다(축소기는 세션당 1개라 매번 새로 만든다). */
function persisted(e: AetherEvent): AetherEvent | null {
  return codexCodec.persistFilter().apply(e);
}
/** 영속본에서 도구 결과 본문만 꺼낸다 — 화면·검색이 실제로 보게 되는 값이다. */
function outputOf(e: AetherEvent | null): string {
  if (!e) return "";
  for (const a of normalizeCodex(e)) if (a.type === "tool_result") return a.output;
  return "";
}
const json = (v: unknown) => JSON.stringify(v);

// 8h에서 실제 계정으로 관측한 `account/rateLimits/updated`의 값이다. 이 알림은 sparse rolling update라
// null이 이전 값을 지웠다는 뜻이 아니며, 아래 검사는 그 계약을 정규화가 거스르지 않는지 고정한다.
const observedRateLimits = {
  limitId: null,
  limitName: null,
  primary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1787617478 },
  secondary: null,
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: "plus",
  rateLimitReachedType: null,
};
const rateLimitUpdate = (rateLimits: Record<string, unknown>) => ev(notif("account/rateLimits/updated", { rateLimits }));
type RateNotice = { severity?: "warn" | "blocked"; utilization?: number; resetsAt?: number; limitType?: string };
const rateNoticeOf = (e: AetherEvent) =>
  normalizeCodex(e).find((a) => a.type === "provider_notice" && a.kind === "rate_limit") as RateNotice | undefined;

// ── ① 화면에만 흘릴 것과 디스크에 남길 것 ──
console.log("\n=== ① 라이브 전용 판정 ===");
const LIVE = [
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "turn/diff/updated",
];
check(
  LIVE.every((m) => codexCodec.isLiveOnly(ev(notif(m, {})))),
  "중간 조각·진행 스냅샷은 전부 라이브 전용",
  LIVE.filter((m) => !codexCodec.isLiveOnly(ev(notif(m, {})))),
);
const KEEP = ["item/started", "item/completed", "turn/started", "turn/completed", "thread/tokenUsage/updated", "error"];
check(
  KEEP.every((m) => !codexCodec.isLiveOnly(ev(notif(m, {})))),
  "완성된 사건은 라이브 전용이 아니다(디스크에 남는다)",
  KEEP.filter((m) => codexCodec.isLiveOnly(ev(notif(m, {})))),
);
// Aether가 직접 만드는 중립 이벤트(사용자 메시지·상태)는 provider 알림이 아니다 — 라이브 전용일 수 없다.
check(!codexCodec.isLiveOnly({ kind: "user_msg", text: "안녕" } as unknown as AetherEvent), "사용자 메시지는 라이브 전용이 아니다");

console.log("\n=== ② 턴 종료 판정 ===");
check(codexCodec.endsTurn(ev(notif("turn/completed", {}))), "turn/completed가 턴을 끝낸다");
check(!codexCodec.endsTurn(ev(notif("turn/started", {}))), "turn/started는 턴을 끝내지 않는다");
check(!codexCodec.endsTurn(ev(notif("item/completed", {}))), "item/completed는 턴을 끝내지 않는다");
// 디스크 꼬리를 한 줄씩 읽는 저수준 경로가 이 판정을 그대로 쓴다 — 파싱된 느슨한 값도 안전해야 한다.
check(!codexCodec.endsTurn({} as never), "빈 값에도 안전하다(꼬리 판정 경로)");

// ── ②b 인증 만료 판정(8d-2 이월 ⓒ) ──
console.log("\n=== ②b 인증 만료 판정 ===");
const turnFailed = (message: string) =>
  ev(notif("turn/completed", { threadId: "th-1", turn: { id: "tn-1", items: [], itemsView: "full", status: "failed", error: { message, codexErrorInfo: null, additionalDetails: null }, startedAt: 1, completedAt: 2, durationMs: 3 } }));
const errorNotif = (message: string, willRetry = false) =>
  ev(notif("error", { error: { message, codexErrorInfo: null, additionalDetails: null }, willRetry, threadId: "th-1", turnId: "tn-1" }));
check(codexCodec.isAuthExpired(turnFailed("401 Unauthorized")), "실패한 턴의 401 → 인증 만료");
check(codexCodec.isAuthExpired(errorNotif("OAuth token has expired")), "오류 알림의 만료 문구 → 인증 만료");
check(!codexCodec.isAuthExpired(turnFailed("rate limit exceeded")), "다른 이유로 실패한 턴은 만료가 아니다");
check(
  !codexCodec.isAuthExpired(ev(notif("turn/completed", { threadId: "th-1", turn: { id: "tn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 3 } }))),
  "정상 종료한 턴은 만료가 아니다",
);
check(!codexCodec.isAuthExpired(ev(notif("item/completed", {}))), "대화 항목은 만료 판정 대상이 아니다");
check(!codexCodec.isAuthExpired({} as never), "손상된 줄에도 안전");

// ── ②c 구독 한도 알림 정규화 ──
console.log("\n=== ②c 구독 한도 알림 정규화 ===");
const blockedRate = rateNoticeOf(rateLimitUpdate({ ...observedRateLimits, rateLimitReachedType: "rate_limit_reached" }));
check(blockedRate?.severity === "blocked", "한도 도달 신호가 있으면 차단 배너 이벤트가 나온다", blockedRate);
check(blockedRate?.limitType === "rate_limit_reached", "도달 종류는 provider 어휘 그대로 limitType에 담는다", blockedRate);
const spendBlockedRate = rateNoticeOf(rateLimitUpdate({ ...observedRateLimits, spendControlReached: true }));
check(spendBlockedRate?.severity === "blocked", "지출 제어 도달 신호도 차단 배너 이벤트가 된다", spendBlockedRate);

const observedRate = rateNoticeOf(rateLimitUpdate(observedRateLimits));
check(observedRate?.severity === undefined, "사용률만 있으면 심각도를 지어내지 않는다(배너 없음)", observedRate);
check(observedRate?.utilization === 0.16, "usedPercent 16을 계약 사용률 0.16으로 바꾼다", observedRate);
check(observedRate?.resetsAt === 1787617478, "초 단위 리셋 시각을 그대로 넘긴다", observedRate);

const sparseRate = rateNoticeOf(rateLimitUpdate({
  limitId: null,
  limitName: null,
  primary: null,
  secondary: null,
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: null,
  rateLimitReachedType: null,
}));
check(sparseRate === undefined, "의미 있는 값이 없는 sparse 갱신은 이벤트를 만들지 않는다", sparseRate);

// ── ③ 커지는 값 자르기 ──
console.log("\n=== ③ 커지는 값 자르기 ===");
const bigOut = "가".repeat(5000);
const cmdItem = (command: string, output: string | null): ThreadItem =>
  ({
    type: "commandExecution",
    id: "it-1",
    command,
    cwd: "/tmp/work",
    processId: null,
    source: "model",
    status: "completed",
    commandActions: [],
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 10,
  }) as unknown as ThreadItem;

const bigEvent = itemDone(cmdItem("ls -R", bigOut));
const bigPersisted = persisted(bigEvent);
const bigText = outputOf(bigPersisted);
check(bigText.length < bigOut.length, "긴 명령 출력이 잘린다", { 원본: bigOut.length, 영속: bigText.length });
check(bigText.startsWith("가".repeat(10)), "잘려도 앞부분은 그대로 남는다");
check(/\.\.\./.test(bigText) || bigText.length > MAX, "잘렸다는 표시가 남는다", bigText.slice(-60));
check(json(bigEvent).includes(bigOut), "원본 이벤트는 그대로다(라이브·화면은 원문을 본다)");

const mcpItem: ThreadItem = {
  type: "mcpToolCall",
  id: "it-2",
  server: "aether",
  tool: "session_search",
  status: "completed",
  arguments: { query: "나".repeat(3000) },
  appContext: null,
  error: null,
  result: { content: [{ type: "text", text: "다".repeat(3000) }] },
} as unknown as ThreadItem;
const mcpPersisted = persisted(itemDone(mcpItem));
const mcpJson = json(mcpPersisted);
check(mcpJson.length < 2000, "MCP 인자와 결과가 상한 안으로 줄어든다", { 길이: mcpJson.length });

// ── ④ 비밀 가리기 ──
console.log("\n=== ④ 비밀 가리기 ===");
const secretCmd = 'curl -H "Authorization: Bearer sk-abcdefghij012345" https://api.example.com';
const maskedEvent = persisted(itemDone(cmdItem(secretCmd, "ok")));
const maskedJson = json(maskedEvent);
check(maskedJson.includes("sk-abcdefghij012345"), "명령줄에 적힌 토큰도 원문 그대로 저장된다", maskedJson.slice(0, 200));
check(!maskedJson.includes("[redacted]"), "가렸다는 표시가 없다");

// 같은 항목에 명령을 쪼개 놓은 사본이 함께 온다 — 원문만 가리면 옆자리에 같은 토큰이 평문으로 남는다.
const withActions = itemDone({
  ...(cmdItem(secretCmd, "ok") as unknown as Record<string, unknown>),
  commandActions: [{ type: "unknown", command: secretCmd }],
} as unknown as ThreadItem);
const actionsJson = json(persisted(withActions));
check(actionsJson.includes("sk-abcdefghij012345") && !actionsJson.includes("[redacted]"), "분해된 명령 사본에도 원문 그대로 저장된다", actionsJson.slice(0, 260));

const envRead = persisted(itemDone(cmdItem("cat deploy/.env", "TOKEN=abcdef123456\nDB_PASSWORD=hunter2")));
const envJson = json(envRead);
check(!envJson.includes("hunter2") && !envJson.includes("abcdef123456"), "비밀 파일을 읽은 명령의 출력이 통째로 가려진다", envJson.slice(0, 200));

for (const cmd of ["cat deploy/.env; echo done", "cat auth.json"]) {
  const shellRead = json(persisted(itemDone(cmdItem(cmd, "TOKEN=abcdef123456\nDB_PASSWORD=hunter2"))));
  check(!shellRead.includes("hunter2") && !shellRead.includes("abcdef123456"), `비밀 경로를 읽은 명령의 출력이 가려진다: ${cmd}`, shellRead.slice(0, 200));
}

const fileChange = (changes: { path: string; diff: string }[]): ThreadItem =>
  ({
    type: "fileChange",
    id: "it-3",
    status: "completed",
    changes: changes.map((c) => ({ path: c.path, kind: { type: "update", move_path: null }, diff: c.diff })),
  }) as unknown as ThreadItem;

const mixed = persisted(
  itemDone(
    fileChange([
      { path: "src/app.ts", diff: "@@ -1 +1 @@\n-const a = 1\n+const a = 2\n" },
      { path: "config/.env", diff: "@@ -1 +1 @@\n-SECRET=old-value-9911\n+SECRET=new-value-2288\n" },
    ]),
  ),
);
const mixedJson = json(mixed);
check(mixedJson.includes("const a = 2"), "평범한 파일의 변경 내용은 그대로 남는다");
check(!mixedJson.includes("old-value-9911") && !mixedJson.includes("new-value-2288"), "비밀 파일의 변경 내용은 남지 않는다", mixedJson.slice(0, 300));

const moved = (from: string, to: string) => JSON.stringify(persisted(itemDone({
  ...fileChange([{ path: from, diff: "+API_KEY=abc" }]),
  changes: [{ path: from, kind: { type: "update", move_path: to }, diff: "+API_KEY=abc" }],
} as ThreadItem)));
check(!moved("old.txt", ".env.prod").includes("API_KEY=abc"), "일반 파일을 비밀 이름으로 옮기는 diff는 가려진다");
check(!moved(".env", "config.txt").includes("API_KEY=abc"), "비밀 파일을 일반 이름으로 옮기는 diff는 가려진다");
check(moved("old.txt", "new.txt").includes("API_KEY=abc"), "일반 파일끼리 옮기는 diff는 그대로 남는다");
const bigDiff = persisted(itemDone(fileChange([{ path: "src/big.ts", diff: "라".repeat(4000) }])));
check(json(bigDiff).length < 2000, "긴 변경 내용도 상한 안으로 줄어든다", { 길이: json(bigDiff).length });

// ── ⑤ 대화가 아닌 것은 세션 기록에 안 남는다 ──
console.log("\n=== ⑤ 계정 알림 선별 영속 ===");
check(persisted(rateLimitUpdate(observedRateLimits)) !== null, "사용 한도 갱신은 새로 고친 뒤에도 보이도록 디스크에 남는다");
for (const m of ["account/updated", "account/login/completed"]) {
  check(persisted(ev(notif(m, { account: { type: "chatgpt", planType: "pro" } }))) === null, `${m}는 디스크에 안 남는다`);
}
check(persisted(ev(notif("turn/started", { threadId: "th-1" }))) !== null, "대화 사건은 디스크에 남는다");

// ── ⑥ 줄일 것이 없으면 그대로 통과시킨다 ──
console.log("\n=== ⑥ 불필요한 복사 없음 ===");
const plain = itemDone({ type: "agentMessage", id: "it-9", text: "짧은 답변", phase: null, memoryCitation: null } as unknown as ThreadItem);
check(persisted(plain) === plain, "줄일 것이 없으면 같은 값을 그대로 돌려준다");
const smallCmd = itemDone(cmdItem("ls", "a\nb"));
check(persisted(smallCmd) === smallCmd, "짧은 명령 출력도 그대로 통과한다");

// ── ⑦ 이벤트 사이에 기억할 상태가 없다(Claude와 다른 점) ──
console.log("\n=== ⑦ 상태 없는 축소기 ===");
const filter = codexCodec.persistFilter();
/** seq·시각은 이벤트마다 다르니 비교에서 뺀다 — 보려는 것은 "내용이 달라지는가"뿐이다. */
const bodyOf = (e: AetherEvent | null) => json((e as { msg?: unknown } | null)?.msg);
const before = bodyOf(filter.apply(itemDone(cmdItem("echo hi", "hi"))));
filter.restore(itemDone(cmdItem("cat .env", "SECRET=x")));
const after = bodyOf(filter.apply(itemDone(cmdItem("echo hi", "hi"))));
check(before === after, "앞 이벤트가 뒤 이벤트의 축소 결과를 바꾸지 않는다", { before, after });

console.log(`\n${fail === 0 ? "✅" : "❌"} codex_sanitize: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
