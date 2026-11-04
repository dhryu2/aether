/**
 * 알림 조립 골든 — 실제 web-push 설정·구독과 분리해 제목/본문/종류/중립 행동을 고정한다.
 * kind는 손길 칩과 같은 사건 종류다(Phase 13a, worthNotifying.ts).
 * 브라우저 tag는 어댑터 테스트(notify_adapter)가 본다.
 * 실행: tsx test/push_notification.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NotifySessionInfo } from "../notify/worthNotifying";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-push-notification-"));

const { worthNotifying } = await import("../notify/worthNotifying");
type AetherEvent = import("../types").AetherEvent;
type AgentEvent = import("../../shared/agentEvent").AgentEvent;

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✅ ${name}`);
    pass++;
  } catch {
    console.error(`  ❌ ${name}\n    actual  : ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
    fail++;
  }
}

const SESSION: NotifySessionInfo = { id: "session-1", name: "배포 작업", providerName: "Claude" };
const base = { sessionId: "session-1" };
const raw = (body: Record<string, unknown>) => ({ seq: 1, ts: 1, ...body }) as AetherEvent;
const agent = (body: Record<string, unknown>) => ({ provider: "claude", seq: 1, part: 0, ts: 1, ...body }) as AgentEvent;
const notify = (ev: AetherEvent, events: AgentEvent[] = [], session = SESSION) => worthNotifying(ev, events, session);

console.log("\n=== Claude 무회귀 골든 ===");
eq(
  "성공 미리보기는 기존 제목·본문과 같다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "ok", responsePreview: "  빌드\n완료  ", modelTurnCount: 1 })]),
  { ...base, title: "배포 작업 · 완료", body: "빌드 완료", kind: "done" },
);
eq(
  "성공 미리보기 없으면 기존 일반 문구다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "ok", modelTurnCount: 1 })]),
  { ...base, title: "배포 작업 · 완료", body: "응답이 끝났어요", kind: "done" },
);
eq(
  "실패 과부하 문구는 기존과 같다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "failed", errors: ["529 overloaded_error", "timeout"] })]),
  { ...base, title: "배포 작업 · 실패", body: "서버 과부하(일시적) — 잠시 후 다시 시도하세요", kind: "failed" },
);
eq(
  "실패 일반 문구는 기존과 같다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "failed", error: "실행 실패" })]),
  { ...base, title: "배포 작업 · 실패", body: "응답에 실패했어요", kind: "failed" },
);
eq(
  "모델이 한 번도 돌지 않은 성공은 알리지 않는다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "ok", responsePreview: "무시", modelTurnCount: 0 })]),
  undefined,
);
eq(
  "인증 오류 실패는 auth_expired notice와 중복 발송하지 않는다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "failed", error: "401 Unauthorized" })]),
  undefined,
);
eq(
  "Claude도 중단 상태를 완료 알림으로 취급한다",
  notify(raw({ kind: "sdk" }), [agent({ type: "turn_completed", status: "interrupted", responsePreview: "중단 전 답변" })]),
  { ...base, title: "배포 작업 · 완료", body: "중단 전 답변", kind: "done" },
);

console.log("\n=== Codex 공통 계약 ===");
eq(
  "완료 미리보기는 세션이 기억한 마지막 text에서 온다",
  notify(raw({ kind: "codex" }), [agent({ type: "turn_completed", status: "ok" })], { ...SESSION, providerName: "Codex", lastText: "마지막 답변입니다" }),
  { ...base, title: "배포 작업 · 완료", body: "마지막 답변입니다", kind: "done" },
);
eq(
  "실패 턴도 공통 완료 이벤트로 알린다",
  notify(raw({ kind: "codex" }), [agent({ type: "turn_completed", status: "failed", error: "모델 오류" })], { ...SESSION, providerName: "Codex" }),
  { ...base, title: "배포 작업 · 실패", body: "응답에 실패했어요", kind: "failed" },
);
eq(
  "차단 레이트리밋도 공통 provider_notice로 알린다",
  notify(raw({ kind: "codex" }), [agent({ type: "provider_notice", kind: "rate_limit", severity: "blocked", limitType: "five_hour" })], { ...SESSION, providerName: "Codex" }),
  { ...base, title: "배포 작업 · 사용 한도 도달", body: "five_hour에 도달했어요. 잠시 후 다시 시도하거나 더 가벼운 모델로 바꾸세요", kind: "rate_limit" },
);
eq(
  "interrupted도 Claude와 같은 완료 알림으로 고정한다",
  notify(raw({ kind: "codex" }), [agent({ type: "turn_completed", status: "interrupted" })], { ...SESSION, providerName: "Codex", lastText: "중단 전 답변" }),
  { ...base, title: "배포 작업 · 완료", body: "중단 전 답변", kind: "done" },
);

console.log("\n=== 기존 공통 알림 무회귀 ===");
eq(
  "권한 요청의 제목·본문(승인 행동 없음, 채널 필드 없음)",
  notify(raw({ kind: "permission_request", req: { id: "permission-7", toolName: "Bash", input: { command: "npm test" }, toolUseID: "tool-7", createdAt: 1 } }), [], { ...SESSION, permissionTarget: "npm test" }),
  { ...base, title: "배포 작업 · 권한 요청", body: "Bash · npm test", kind: "permission" },
);
eq(
  "계획 검토 대기",
  notify(raw({ kind: "plan_request", req: { id: "plan-1", planId: "p1", text: "1. 인증\n2. 세션", createdAt: 1 } })),
  { ...base, title: "배포 작업 · 계획 검토", body: "1. 인증 2. 세션", kind: "plan" },
);
eq(
  "질문 요청",
  notify(raw({ kind: "question_request", req: { id: "question-1", toolUseID: "tool-8", createdAt: 1, questions: [{ header: "배포", question: "계속할까요?", options: [] }, { question: "두 번째", options: [] }] } })),
  { ...base, title: "배포 작업 · 질문", body: "[배포] 계속할까요? (외 1개)", kind: "question" },
);
eq(
  "크래시",
  notify(raw({ kind: "status", status: "crashed", error: "worker died" })),
  { ...base, title: "배포 작업 · 비정상 종료", body: "worker died", kind: "crashed" },
);
eq(
  "인증 만료",
  notify(raw({ kind: "notice", notice: "auth_expired" })),
  { ...base, title: "배포 작업 · Claude 로그인 만료", body: "앱에서 Claude에 다시 로그인하세요", kind: "auth" },
);

console.log("\n=== Grok — 정규화 사건만 본다 ===");
eq(
  "Grok 완료도 정규화 turn_completed로 알린다",
  notify(raw({ kind: "grok" }), [agent({ type: "turn_completed", status: "ok", responsePreview: "Grok 답", modelTurnCount: 1 })], {
    ...SESSION,
    providerName: "Grok",
  }),
  { ...base, title: "배포 작업 · 완료", body: "Grok 답", kind: "done" },
);
eq(
  "Grok 원본만 있고 정규화 사건이 없으면 알리지 않는다",
  notify(raw({ kind: "grok", msg: { method: "session/prompt_result" } }), [], { ...SESSION, providerName: "Grok" }),
  undefined,
);
eq(
  "Grok 계획 대기도 공통 plan_request로 알린다",
  notify(raw({ kind: "plan_request", req: { id: "plan-g", planId: "p", text: "인증 추가", createdAt: 1 } }), [], {
    ...SESSION,
    providerName: "Grok",
  }),
  { ...base, title: "배포 작업 · 계획 검토", body: "인증 추가", kind: "plan" },
);

console.log(`\n${fail === 0 ? "✅" : "❌"} push_notification: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
