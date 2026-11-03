/**
 * Claude 배경 작업이 답을 한 벌만 돌려주는지 — 모델 호출 0.
 *
 * 가짜 메시지 흐름을 턴 읽기에 넣는다. 실제 query()는 부르지 않는다.
 */
import { createClaudeMessageInspector } from "../providers/claude/distill";
import { readTurns, TurnFailedError, TurnIncompleteError } from "../providers/turnReader";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

function assistant(parts: unknown[]): unknown {
  return { type: "assistant", message: { role: "assistant", content: parts } };
}
function text(value: string): unknown {
  return { type: "text", text: value };
}
function resultMsg(fields: Record<string, unknown> = {}): unknown {
  return { type: "result", ...fields };
}

async function* asStream(msgs: unknown[]): AsyncIterable<unknown> {
  for (const msg of msgs) yield msg;
}

/** 결과 메시지가 있는 흐름. 기다리기를 먼저 걸어 두고 턴 글을 받는다. */
async function readFinished(msgs: unknown[]): Promise<string[]> {
  const reader = readTurns(asStream(msgs), createClaudeMessageInspector());
  const n = msgs.filter((m) => (m as { type?: string }).type === "result").length;
  const pending = Array.from({ length: n }, () => reader.nextTurn());
  const out: string[] = [];
  for (const p of pending) out.push(await p);
  await reader.done;
  return out;
}

const sameAnswer = "첫째 줄\n둘째 줄";
const doubledSame = await readFinished([
  assistant([text(sameAnswer)]),
  resultMsg({ result: sameAnswer }),
]);
check(doubledSame.length === 1 && doubledSame[0] === sameAnswer, "a. assistant 글과 같은 result 글이면 한 벌", doubledSame[0]);

const pieces = await readFinished([
  assistant([
    text("조각1"),
    { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } },
    text("조각2"),
  ]),
  assistant([text("조각3"), { type: "thinking", thinking: "이건 답이 아니다" }]),
  resultMsg({ result: "최종답-한벌" }),
]);
check(
  pieces.length === 1 && pieces[0] === "최종답-한벌",
  "b. assistant 조각이 여러 개여도 result 글 한 벌",
  pieces[0],
);

const onlyResult = await readFinished([resultMsg({ result: "결과만" })]);
check(onlyResult.length === 1 && onlyResult[0] === "결과만", "c. result 글만 있으면 그 글", onlyResult[0]);

const noField = await readFinished([
  assistant([text("에러여도"), text("보조")]),
  resultMsg({ subtype: "error_during_execution" }),
]);
check(noField.length === 1 && noField[0] === "에러여도보조", "d. result 필드가 없으면 모아 둔 assistant 글", noField[0]);

const blankResult = await readFinished([
  assistant([text("공백이면보조"), { type: "tool_use", id: "tool-2", name: "Read" }]),
  resultMsg({ subtype: "success", result: " \n\t" }),
]);
check(blankResult.length === 1 && blankResult[0] === "공백이면보조", "d. result 글이 공백만이면 assistant 글", blankResult[0]);

const emptyResult = await readFinished([
  assistant([text("빈문자보조")]),
  resultMsg({ result: "" }),
]);
check(emptyResult.length === 1 && emptyResult[0] === "빈문자보조", "d. result 글이 빈 문자열이면 assistant 글", emptyResult[0]);

const notString = await readFinished([
  assistant([text("숫자결과는보조")]),
  resultMsg({ result: null }),
]);
check(notString.length === 1 && notString[0] === "숫자결과는보조", "d. result 글이 문자열이 아니면 assistant 글", notString[0]);

{
  const reader = readTurns(asStream([assistant([text("끝나기전에끊김")])]), createClaudeMessageInspector());
  const pending = reader.nextTurn();
  let err: unknown;
  try {
    await pending;
  } catch (e) {
    err = e;
  }
  await reader.done;
  check(err instanceof TurnIncompleteError, "e. 결과 없이 닫히면 TurnIncompleteError", err instanceof Error ? err.name : err);
  // assistant 글은 공통 버퍼 밖에 모으므로 진단용 부분 글은 비어 있다(의도된 한계).
  check(err instanceof TurnIncompleteError && err.partial === "", "e. 잘린 턴의 진단용 부분 글은 비어 있다", err instanceof TurnIncompleteError ? err.partial : err);
}

const twoTurns = await readFinished([
  assistant([text("고르기보조")]),
  resultMsg({ result: "haiku" }),
  assistant([text("본문조각")]),
  resultMsg({ result: "본답" }),
]);
check(
  twoTurns.length === 2 && twoTurns[0] === "haiku" && twoTurns[1] === "본답",
  "f. 고르기 턴 다음 본 턴 글에 첫 턴 글이 섞이지 않는다",
  twoTurns,
);

const fallbackSecond = await readFinished([
  assistant([text("첫번째보조")]),
  resultMsg({ result: "첫번째답" }),
  assistant([text("두번째"), text("보조")]),
  resultMsg({ subtype: "error_during_execution" }),
]);
check(
  fallbackSecond.length === 2 && fallbackSecond[0] === "첫번째답" && fallbackSecond[1] === "두번째보조",
  "f. 본 턴에 result 글이 없어도 고르기 턴 글이 섞이지 않는다",
  fallbackSecond,
);

{
  // 실측(2026-10-16): 크레딧이 바닥난 모델은 답 대신 안내문을 result 글로 주고 is_error를 참으로 둔다.
  const reader = readTurns(
    asStream([
      assistant([text("You're out of usage credits.")]),
      resultMsg({ result: "You're out of usage credits. Switch to another model", is_error: true }),
      assistant([text("다음 답")]),
      resultMsg({ result: "다음 답" }),
    ]),
    createClaudeMessageInspector(),
  );
  const first = reader.nextTurn();
  const second = reader.nextTurn();
  const err = await first.then(() => null, (e: unknown) => e);
  check(err instanceof TurnFailedError && /out of usage credits/.test((err as Error).message), "오류 표시가 붙은 result는 답이 아니라 실패로 끝난다", String(err));
  check((await second) === "다음 답", "실패한 턴 뒤의 턴은 그대로 읽는다");
  await reader.done;
}

console.log(`\n${fail === 0 ? "✅" : "❌"} claude_distill: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
