/**
 * 작업 검토함 요약(summarizeReview) — 모델 호출 0, 파일·DB 없음.
 * 네 provider(Ollama는 Codex 경로)의 정규화 결과가 같은 요약을 내는지, 재실행 성공·실패한 수정·경로 모양을 본다.
 */
import assert from "node:assert";
import type { AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";
import { claudeCodec } from "../sessions/codec/claude";
import { withAetherEvents } from "../sessions/codec/aetherEvents";
import { codexCodec } from "../sessions/codec/codex";
import { grokCodec } from "../sessions/codec/grok";
import { summarizeReview } from "../sessions/reviewSummary";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✅ ${name}`);
    pass++;
  } catch {
    console.log(`  ❌ ${name} — ${JSON.stringify({ actual, expected })}`);
    fail++;
  }
}

const codecs = { claude: withAetherEvents(claudeCodec), codex: codexCodec, grok: grokCodec };
function neutral(codec: { normalize(ev: AetherEvent): AgentEvent[] }, raws: unknown[]): AgentEvent[] {
  return raws.flatMap((r, i) => codec.normalize({ seq: i + 1, ts: i + 1, ...(r as object) } as AetherEvent));
}
/** 순번을 뺀 모양(provider끼리 비교용). */
const shape = (events: AgentEvent[]) => {
  const s = summarizeReview(events);
  return { files: s.changedFiles.map((f) => f.path), failed: s.failedCommands.map((c) => c.text), todos: s.openTodos.map((t) => t.text) };
};

// ── provider별 원본 모양 ──
const claude = {
  call: (id: string, name: string, input: object) => ({ kind: "sdk", msg: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } } }),
  res: (id: string, err = false) => ({ kind: "sdk", msg: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "out", ...(err ? { is_error: true } : {}) }] } } }),
  bash: (id: string, command: string) => claude.call(id, "Bash", { command }),
  edit: (id: string, p: string) => claude.call(id, "Edit", { file_path: p }),
  plan: (items: [string, string][]) => ({ kind: "todo_list", items: items.map(([text, status]) => ({ text, status })) }),
};
const codex = {
  start: (item: object) => ({ kind: "codex", msg: { method: "item/started", params: { item } } }),
  done: (item: object) => ({ kind: "codex", msg: { method: "item/completed", params: { item } } }),
  bash: (id: string, command: string) => codex.start({ type: "commandExecution", id, command, cwd: "/p", status: "inProgress" }),
  bashEnd: (id: string, command: string, failed: boolean) => codex.done({ type: "commandExecution", id, command, cwd: "/p", status: failed ? "failed" : "completed", aggregatedOutput: "o", exitCode: failed ? 1 : 0 }),
  edit: (id: string, paths: string[]) => codex.start({ type: "fileChange", id, status: "inProgress", changes: paths.map((path) => ({ path, kind: { type: "update" }, diff: "d" })) }),
  editEnd: (id: string, paths: string[], failed: boolean) => codex.done({ type: "fileChange", id, status: failed ? "failed" : "completed", changes: paths.map((path) => ({ path, kind: { type: "update" }, diff: "d" })) }),
  plan: (steps: [string, string][]) => ({ kind: "codex", msg: { method: "turn/plan/updated", params: { threadId: "t", turnId: "u", plan: steps.map(([step, status]) => ({ step, status })) } } }),
};
const grok = {
  upd: (update: object) => ({ kind: "grok", msg: { method: "session/update", params: { update } } }),
  bash: (id: string, command: string) => grok.upd({ sessionUpdate: "tool_call", toolCallId: id, title: "run_terminal_command", rawInput: { command } }),
  edit: (id: string, p: string) => grok.upd({ sessionUpdate: "tool_call", toolCallId: id, title: "search_replace", kind: "edit", rawInput: { file_path: p } }),
  res: (id: string, failed = false) => grok.upd({ sessionUpdate: "tool_call_update", toolCallId: id, status: failed ? "failed" : "completed", content: { type: "text", text: "o" } }),
  plan: (steps: [string, string][]) => grok.upd({ sessionUpdate: "plan", entries: steps.map(([content, status]) => ({ content, status })) }),
};

// 같은 일을 한 기록: 테스트 실패, a.ts 수정 성공, b.ts 수정 실패, "x, y.ts" 수정 성공, 할 일 두 개 중 하나 남음.
const plan: [string, string][] = [["확인", "completed"], ["배포", "pending"]];
const scenario: Record<string, AgentEvent[]> = {
  claude: neutral(codecs.claude, [
    claude.bash("c1", "npm test"), claude.res("c1", true),
    claude.edit("c2", "/p/a.ts"), claude.res("c2"),
    claude.edit("c3", "/p/b.ts"), claude.res("c3", true),
    claude.edit("c4", "/p/x, y.ts"), claude.res("c4"),
    claude.plan(plan),
  ]),
  codex: neutral(codecs.codex, [
    codex.bash("i1", "npm test"), codex.bashEnd("i1", "npm test", true),
    codex.edit("i2", ["/p/a.ts"]), codex.editEnd("i2", ["/p/a.ts"], false),
    codex.edit("i3", ["/p/b.ts"]), codex.editEnd("i3", ["/p/b.ts"], true),
    codex.edit("i4", ["/p/x, y.ts"]), codex.editEnd("i4", ["/p/x, y.ts"], false),
    codex.plan(plan.map(([s, st]) => [s, st === "pending" ? "pending" : st])),
  ]),
  grok: neutral(codecs.grok, [
    grok.bash("g1", "npm test"), grok.res("g1", true),
    grok.edit("g2", "/p/a.ts"), grok.res("g2"),
    grok.edit("g3", "/p/b.ts"), grok.res("g3", true),
    grok.edit("g4", "/p/x, y.ts"), grok.res("g4"),
    grok.plan(plan),
  ]),
};

console.log("\n=== provider별 같은 기록 → 같은 요약 ===");
const expected = { files: ["/p/a.ts", "/p/x, y.ts"], failed: ["npm test"], todos: ["배포"] };
for (const [name, events] of Object.entries(scenario)) eq(`${name} 요약`, shape(events), expected);
eq("Ollama(Codex 경로)도 같다", shape(neutral(codexCodec, [
  codex.bash("i1", "npm test"), codex.bashEnd("i1", "npm test", true),
  codex.edit("i2", ["/p/a.ts"]), codex.editEnd("i2", ["/p/a.ts"], false),
])), { files: ["/p/a.ts"], failed: ["npm test"], todos: [] });

console.log("\n=== 실패와 재실행 ===");
eq("같은 명령이 뒤에서 성공하면 실패에서 빠진다", shape(neutral(codecs.claude, [
  claude.bash("c1", "npm test"), claude.res("c1", true), claude.bash("c2", "npm test"), claude.res("c2"),
])).failed, []);
eq("성공 뒤에 다시 실패하면 남는다", shape(neutral(codecs.claude, [
  claude.bash("c1", "npm test"), claude.res("c1"), claude.bash("c2", "npm test"), claude.res("c2", true),
])).failed, ["npm test"]);
{
  const s = summarizeReview(neutral(codecs.claude, [
    claude.bash("c1", "npm test"), claude.res("c1", true), claude.bash("c2", "ls"), claude.res("c2", true), claude.bash("c3", "npm test"), claude.res("c3", true),
  ]));
  eq("같은 명령의 실패는 마지막 하나만(순번도 마지막)", s.failedCommands, [{ text: "ls", seq: 3 }, { text: "npm test", seq: 5 }]);
}
eq("결과가 아직 없는 명령은 실패가 아니다", shape(neutral(codecs.claude, [claude.bash("c1", "sleep 9")])).failed, []);
{
  // 끝까지 실패한 것과 도중에 실패한 것을 나눈다.
  const s = summarizeReview(neutral(codecs.claude, [
    claude.bash("c1", "grep foo"), claude.res("c1", true),
    claude.bash("c2", "npm test"), claude.res("c2", true),
    claude.bash("c3", "ls"), claude.res("c3"),
    claude.bash("c4", "make"), claude.res("c4", true),
    claude.bash("c5", "npm test"), claude.res("c5", true),
  ]));
  eq("마지막 성공 뒤의 실패만 failedCommands", s.failedCommands.map((c) => c.text), ["make", "npm test"]);
  eq("도중 실패는 otherFailures(끝에도 실패한 명령은 뺀다)", s.otherFailures.map((c) => c.text), ["grep foo"]);
  eq("성공이 하나도 없으면 전부 끝까지 실패", summarizeReview(neutral(codecs.claude, [claude.bash("c1", "a"), claude.res("c1", true), claude.bash("c2", "b"), claude.res("c2", true)])).otherFailures, []);
  eq("도중 실패 뒤 같은 명령이 성공하면 뺀다", summarizeReview(neutral(codecs.claude, [
    claude.bash("c1", "npm test"), claude.res("c1", true), claude.bash("c2", "ls"), claude.res("c2"), claude.bash("c3", "npm test"), claude.res("c3"),
  ])).otherFailures, []);
}

console.log("\n=== 마지막 턴 ===");
const turn = (status: string) => ({ kind: "sdk", msg: { type: "result", subtype: status === "ok" ? "success" : "error_during_execution", is_error: status !== "ok", result: "x" } });
eq("마지막 턴이 실패면 turnFailed", summarizeReview(neutral(codecs.claude, [claude.edit("c1", "/p/a.ts"), claude.res("c1"), turn("failed")])).turnFailed, "failed");
eq("마지막 턴이 정상이면 없다", summarizeReview(neutral(codecs.claude, [turn("failed"), turn("ok")])).turnFailed, undefined);
eq("턴 기록이 없으면 없다", summarizeReview(neutral(codecs.claude, [claude.edit("c1", "/p/a.ts"), claude.res("c1")])).turnFailed, undefined);

console.log("\n=== 어댑터가 채운 경로 ===");
eq("Codex 이름 바꾸기는 새 경로도 바뀐 파일", shape(neutral(codexCodec, [
  codex.start({ type: "fileChange", id: "i1", status: "inProgress", changes: [{ path: "/p/a.ts", kind: { type: "update", move_path: "/p/b.ts" }, diff: "d" }] }),
  codex.done({ type: "fileChange", id: "i1", status: "completed", changes: [{ path: "/p/a.ts", kind: { type: "update", move_path: "/p/b.ts" }, diff: "d" }] }),
])).files, ["/p/a.ts", "/p/b.ts"]);
eq("Grok는 kind를 먼저 보고 locations와 target_file에서 경로를 읽는다", shape(neutral(codecs.grok, [
  grok.upd({ sessionUpdate: "tool_call", toolCallId: "g1", title: "Modify file", kind: "edit", locations: [{ path: "/p/loc.ts" }], rawInput: { target_file: "/p/tf.ts" } }),
  grok.res("g1"),
  grok.upd({ sessionUpdate: "tool_call", toolCallId: "g2", title: "Remove", kind: "delete", rawInput: { path: "/p/gone.ts" } }),
  grok.res("g2"),
  grok.upd({ sessionUpdate: "tool_call", toolCallId: "g3", title: "Do it", kind: "execute", rawInput: { command: "make" } }),
  grok.res("g3", true),
])), { files: ["/p/tf.ts", "/p/loc.ts", "/p/gone.ts"], failed: ["make"], todos: [] } as never);

console.log("\n=== 바뀐 파일 ===");
eq("실패한 수정만 있는 파일은 빠진다", shape(neutral(codecs.claude, [claude.edit("c1", "/p/b.ts"), claude.res("c1", true)])).files, []);
eq("같은 파일은 마지막 변경만 남고 순서가 마지막 기준이다", summarizeReview(neutral(codecs.claude, [
  claude.edit("c1", "/p/a.ts"), claude.res("c1"), claude.edit("c2", "/p/b.ts"), claude.res("c2"), claude.edit("c3", "/p/a.ts"), claude.res("c3"),
])).changedFiles, [{ path: "/p/b.ts", seq: 3 }, { path: "/p/a.ts", seq: 5 }]);
eq("Codex 한 번에 여러 파일은 배열 그대로(쉼표 파일 이름 포함)", shape(neutral(codexCodec, [
  codex.edit("i1", ["/p/x, y.ts", "/p/z.ts"]), codex.editEnd("i1", ["/p/x, y.ts", "/p/z.ts"], false),
])).files, ["/p/x, y.ts", "/p/z.ts"]);
eq("읽기만 한 파일은 바뀐 파일이 아니다", shape(neutral(codecs.claude, [claude.call("c1", "Read", { file_path: "/p/a.ts" }), claude.res("c1")])).files, []);

console.log("\n=== 할 일 ===");
eq("마지막 목록의 끝나지 않은 항목만", shape(neutral(codecs.claude, [
  claude.plan([["a", "pending"], ["b", "completed"]]), claude.plan([["a", "completed"], ["b", "in_progress"], ["c", "pending"]]),
])).todos, ["b", "c"]);
eq("범위 안에 목록이 없으면 할 일도 없다", shape(neutral(codecs.claude, [claude.bash("c1", "ls"), claude.res("c1")])).todos, []);
eq("전부 끝난 목록이면 할 일이 없다", shape(neutral(codecs.claude, [claude.plan([["a", "completed"]])])).todos, []);

console.log(`\n${fail === 0 ? "✅" : "❌"} review_summary: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
