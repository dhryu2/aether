/**
 * Grok `_x.ai/ask_user_question` 응답 모양. 실행: npx tsx server/test/grok_ask_question.ts
 *
 * 라이브에서 배열로 내면 `invalid type: sequence, expected a map`으로 도구가 실패했다.
 */
import { grokAskToolSettled, grokAskUserQuestionReply, pickOptionId } from "../sessions/runtimes/grok";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e?: unknown) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c || e === undefined ? "" : " — " + JSON.stringify(e)}`);
  c ? pass++ : fail++;
};

{
  const q = { question: "어디에 배포할까요?", options: [{ label: "운영" }, { label: "테스트" }] };
  const r = grokAskUserQuestionReply([q], { answered: true, answers: [{ chosen: ["운영"] }] });
  check(r.outcome === "accepted", "고르면 outcome accepted");
  check(!Array.isArray(r.answers), "answers는 배열이 아니다", r.answers);
  check(typeof r.answers === "object" && r.answers !== null, "answers는 맵이다");
  const answers = r.answers as Record<string, string[]>;
  check(JSON.stringify(answers["어디에 배포할까요?"]) === JSON.stringify(["운영"]), "질문 본문이 열쇠다", answers);
  check(JSON.stringify(r.partial_answers) === JSON.stringify(r.answers), "partial_answers도 같은 맵이다");
}

{
  const qs = [
    { question: "만들 것인가?", options: [{ label: "만든다" }] },
    { question: "화면은?", options: [{ label: "그대로" }] },
  ];
  const r = grokAskUserQuestionReply(qs, {
    answered: true,
    answers: [{ chosen: ["만든다"] }, { chosen: [], custom: "필요하면 화면을 고친다" }],
  });
  const answers = r.answers as Record<string, string[]>;
  check(JSON.stringify(answers["만들 것인가?"]) === JSON.stringify(["만든다"]), "1번 선택지");
  check(JSON.stringify(answers["화면은?"]) === JSON.stringify(["필요하면 화면을 고친다"]), "직접 입력은 그 질문의 값에 붙는다", answers);
}

{
  const r = grokAskUserQuestionReply([{ question: "색?", options: [] }], { answered: false, reason: "중단" });
  check(r.outcome === "skip_interview", "안 고르면 skip_interview");
  check(r.answers === undefined, "안 고르면 answers 배열을 안 실는다", r);
}

{
  const declined = {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-ask",
    status: "completed",
    rawOutput: { type: "AskUserQuestion", UserAnswered: { message: "User declined to answer the questions." } },
  };
  check(grokAskToolSettled(declined, "tc-ask") === true, "같은 도구 id로 포기하면 카드 대기를 끝낸다");
  check(grokAskToolSettled(declined, "") === true, "id가 없어도 AskUserQuestion 완료는 포기다");
  check(grokAskToolSettled({ sessionUpdate: "tool_call_update", status: "in_progress", title: "ask_user_question" }, "tc-ask") === false, "진행 중은 포기가 아니다");
}

{
  const both = [
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-edits-session", kind: "allow-edits-session" },
  ];
  check(pickOptionId(both, "allow") === "allow-once", "한 번 허용이 있으면 그걸 고른다");
  const sessionOnly = [
    { optionId: "allow-edits-session", kind: "allow-edits-session" },
    { optionId: "reject-once", kind: "reject_once" },
  ];
  check(pickOptionId(sessionOnly, "allow") === "allow-edits-session", "세션 허용만 있으면 그걸 고른다");
  check(pickOptionId(sessionOnly, "deny") === "reject-once", "거부는 reject 계열을 고른다");
}

console.log(`────────────────────────────────────────────────────────`);
console.log(`grok_ask_question: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
