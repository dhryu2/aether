/**
 * bx_verify_askquestion — AskUserQuestion 질문 흐름 단위 (Claude 모델 호출 0).
 * requestPermission("AskUserQuestion") → question_request(권한 카드 아님), resolveQuestion → canUseTool deny+포맷답변,
 * 멱등, drainPending, 비-AskUserQuestion은 권한 흐름 유지(분기 회귀가드).
 * (spike_f가 실제 모델이 deny-message 답을 받아 진행함을 검증 — 이 테스트는 백엔드 배선만.)
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxq-data-"));

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`); c ? pass++ : fail++; };

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxq-cwd-"));
  const { LiveSession } = await import("../sessions/LiveSession");
  await (await import("./support/tempDb")).useTempDiary("bx_verify_askquestion"); // 임시 SQLite 일기
  const { eventLogFor } = await import("../sessions/eventLog");
  const askId = randomUUID();
  const s = new LiveSession({ id: askId, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(askId) }) as any;
  const ctx = (tid: string, signal: AbortSignal) => ({ signal, toolUseID: tid });
  const { ClaudeRuntime } = await import("../sessions/runtimes/claude");
  // 8d 이후 권한 왕복은 runtime → 세션 콜백으로 흐른다. 실제 배선 그대로 조립해 합성 경로를 검증한다
  // (SDK 형식의 결과 behavior/updatedInput은 runtime이 만든다 — 모델 호출은 없음).
  const rt = new ClaudeRuntime({
    sessionId: "test-session",
    cwd,
    model: "haiku",
    permissionMode: "manual",
    onPermission: (ask: any) => s.requestPermission(ask),
    onQuestion: (ask: any) => s.requestQuestion(ask),
    onResumeKey: () => {},
  }) as any;
  const guard = setTimeout(() => { console.error("타임아웃"); process.exit(1); }, 15000);

  const events: any[] = [];
  s.subscribe((ev: any) => events.push(ev));

  // ── AskUserQuestion → question_request(질문 카드) + pendingQuestions 등록 ──
  const ac = new AbortController();
  const qInput = { questions: [{ question: "저녁 메뉴?", header: "메뉴", multiSelect: false, options: [{ label: "피자", preview: "- 도우" }, { label: "파스타" }] }] };
  const p = rt.requestPermission("AskUserQuestion", qInput, ctx("q1", ac.signal));
  const qreq = events.find((e) => e.kind === "question_request");
  check(!!qreq, "question_request 이벤트 emit");
  check(qreq?.req?.questions?.[0]?.options?.length === 2, "질문/선택지 페이로드 포함");
  check(qreq?.req?.questions?.[0]?.options?.[0]?.preview === "- 도우", "선택지 미리보기가 질문 카드에 실림");
  check(events.every((e) => e.kind !== "permission_request"), "AskUserQuestion은 permission_request로 안 옴(질문으로 분기)");
  check(s.pendingQuestionList().length === 1 && s.pendingPermissions().length === 0, "pendingQuestions에 등록(권한 맵 아님)");

  // ── resolveQuestion → canUseTool deny+포맷답변, question_resolved ──
  const id = qreq.req.id;
  // 8d-3 ⑥ⓒ: 답은 "고른 선택지"와 "직접 입력"이 분리된 모양으로 온다.
  const ok = s.resolveQuestion(id, [{ chosen: ["파스타"] }]);
  const r = await p;
  check(ok === true, "resolveQuestion → true");
  check(r.behavior === "deny" && /파스타/.test(r.message) && /사용자 응답/.test(r.message),
    "답변이 deny message로 모델에 전달(포맷됨)", `msg=${r.message}`);
  check(events.some((e) => e.kind === "question_resolved" && e.id === id && e.answered === true), "question_resolved(answered=true) emit");
  check(
    events.some((e) => e.kind === "question_resolved" && e.id === id && JSON.stringify(e.answers) === JSON.stringify([["파스타"]])),
    "question_resolved에 표시용 답이 남는다",
  );
  check(s.resolveQuestion(id, [{ chosen: ["x"] }]) === false, "멱등 — 두 번째 resolve false");

  // ── 비-AskUserQuestion은 권한 흐름 유지(분기 회귀가드) ──
  const ac2 = new AbortController();
  const p2 = rt.requestPermission("Write", { file_path: "a.txt", content: "x" }, ctx("w1", ac2.signal));
  check(s.pendingPermissions().length === 1, "Write는 권한 흐름(pendingPermissions)");
  check(events.some((e) => e.kind === "permission_request"), "Write는 permission_request emit");
  s.resolvePermission(s.pendingPermissions()[0].id, "deny");
  await p2;

  // ── multiSelect 답 + drainPending이 보류 질문도 정리 ──
  const ac3 = new AbortController();
  const p3 = rt.requestPermission("AskUserQuestion", { questions: [{ question: "여러 개?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] }] }, ctx("q2", ac3.signal));
  check(s.pendingQuestionList().length === 1, "두 번째 질문 보류 등록");
  s.drainPending("세션 종료");
  const r3 = await p3;
  check(r3.behavior === "deny" && /세션 종료/.test(r3.message), "drainPending이 보류 질문도 deny로 정리");
  check(s.pendingQuestionList().length === 0, "drain 후 pendingQuestions 비움");

  clearTimeout(guard);
  void rt.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  console.log("─".repeat(56));
  console.log(`bx_verify_askquestion: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("오류:", e); process.exit(1); });
