/**
 * 작업 검토함 요약 — 중립 사건(AgentEvent) 배열에서 바뀐 파일·실패한 명령·남은 할 일을 모은다.
 *
 * AI도 git도 부르지 않는 순수 함수다. provider 이름이나 도구 원본 이름은 보지 않고
 * 어댑터가 채운 중립 필드(toolKind, paths, isError, plan_update, turn_completed)만 읽는다.
 *
 * 실패 명령은 둘로 나눈다. AI의 탐색 실패(무결과 grep 등)가 대부분이라 전부를 앞에 두면 모든 세션이 "먼저 볼 것"이 된다.
 *  - failedCommands: 범위 안 마지막 성공 명령 뒤에 있는 실패. 일이 실패로 끝났다는 뜻이다.
 *  - otherFailures: 도중에 실패했지만 뒤에 다른 명령이 성공했고 같은 명령이 다시 성공하지도 않은 것.
 * 한계: 사람이 거절한 명령과 실패한 명령은 중립 사건에서 구분되지 않아(둘 다 isError) 함께 실패로 센다.
 */
import type { AgentEvent } from "../../shared/agentEvent";
import type { ReviewSummary } from "../../shared/brain";

const COMMAND_MAX = 1000;

export function summarizeReview(events: readonly AgentEvent[]): ReviewSummary {
  // 도구 결과: toolId → 오류 여부. 같은 id의 마지막 결과가 유효하다.
  const results = new Map<string, boolean>();
  for (const ev of events) if (ev.type === "tool_result") results.set(ev.toolId, ev.isError === true);

  const files = new Map<string, number>();
  const bash: { text: string; seq: number; err: boolean }[] = []; // 결과가 온 명령만, 호출 순서대로
  let todos: { text: string; seq: number }[] = [];
  let lastTurn: "ok" | "interrupted" | "failed" | undefined;
  for (const ev of events) {
    if (ev.type === "plan_update") {
      todos = ev.items.filter((i) => i.status !== "completed").map((i) => ({ text: i.text, seq: ev.seq }));
      continue;
    }
    if (ev.type === "turn_completed") {
      lastTurn = ev.status;
      continue;
    }
    if (ev.type !== "tool_call") continue;
    const isError = results.get(ev.toolId);
    if (ev.toolKind === "file_change" && ev.paths?.length && isError !== true) {
      for (const p of ev.paths) {
        files.delete(p); // 다시 넣어 순서를 마지막 변경 기준으로 맞춘다
        files.set(p, ev.seq);
      }
    } else if (ev.toolKind === "bash" && ev.target?.trim() && isError !== undefined) {
      bash.push({ text: ev.target.trim().slice(0, COMMAND_MAX), seq: ev.seq, err: isError });
    }
  }

  let lastOk = -1;
  bash.forEach((b, i) => { if (!b.err) lastOk = i; });
  // 같은 글은 마지막 하나만 남긴다(Map에 지우고 다시 넣어 순서도 마지막 기준).
  const ended = new Map<string, number>();
  const other = new Map<string, number>();
  bash.forEach((b, i) => {
    if (!b.err) return;
    const bucket = i > lastOk ? ended : other;
    bucket.delete(b.text);
    bucket.set(b.text, b.seq);
  });
  for (const [text, seq] of [...other]) {
    // 같은 명령이 이 실패 뒤에 성공했거나 끝까지 실패로 남았으면 도중 실패에서 뺀다.
    const failIdx = bash.findIndex((b) => b.err && b.seq === seq && b.text === text);
    if (ended.has(text) || bash.some((b, i) => i > failIdx && !b.err && b.text === text)) other.delete(text);
  }
  const list = (m: Map<string, number>) => [...m].map(([text, seq]) => ({ text, seq }));
  return {
    changedFiles: [...files].map(([path, seq]) => ({ path, seq })),
    failedCommands: list(ended),
    otherFailures: list(other),
    ...(lastTurn === "failed" || lastTurn === "interrupted" ? { turnFailed: lastTurn } : {}),
    openTodos: todos,
  };
}
