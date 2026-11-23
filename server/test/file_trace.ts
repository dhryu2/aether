/**
 * 파일을 고친 세션 찾기 누적기(createFileTouches) — 모델 호출 0, 파일·DB 없음.
 * provider 표시가 다른 중립 사건을 섞어 넣어도 같은 결과가 나오는지, 경로 열쇠·실패·턴별 지시를 본다.
 */
import assert from "node:assert";
import path from "node:path";
import type { AgentEvent } from "../../shared/agentEvent";
import { createFileTouches } from "../sessions/fileTrace";

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
const ev = (provider: string, seq: number, c: object) => ({ provider, seq, part: 0, ts: seq, ...c }) as AgentEvent;
const edit = (p: string, seq: number, toolId: string, paths: string[]) => ev(p, seq, { type: "tool_call", toolId, name: "x", toolKind: "file_change", paths });
const bash = (p: string, seq: number, toolId: string, target: string) => ev(p, seq, { type: "tool_call", toolId, name: "x", toolKind: "bash", target });
const res = (p: string, seq: number, toolId: string, isError = false) => ev(p, seq, { type: "tool_result", toolId, output: "o", isError });
const user = (p: string, seq: number, text: string) => ev(p, seq, { type: "user_text", text });

// 세션 작업 폴더 /work/copy는 원본 /work/src의 복사본이다. 열쇠는 절대 경로로 풀고 복사본 경로를 원본으로 옮긴다.
const cwd = "/work/copy";
const source = "/work/src";
const keyOf = (p: string) => {
  const abs = path.resolve(cwd, p);
  return abs.startsWith(cwd + "/") ? source + abs.slice(cwd.length) : abs;
};

const t = createFileTouches(keyOf);
for (const e of [
  user("claude", 1, "첫 지시"),
  bash("claude", 2, "b1", "npm test"),
  edit("claude", 3, "e1", ["a.ts"]), res("claude", 4, "e1"),
  edit("codex", 5, "e2", ["/work/copy/a.ts", "b.ts"]), res("codex", 6, "e2"),
  user("grok", 7, "두 번째 지시"),
  edit("ollama", 8, "e3", ["/work/src/a.ts"]), res("ollama", 9, "e3", true), // 실패한 수정
  edit("grok", 10, "e4", ["b.ts"]), res("grok", 11, "e4"),
  bash("grok", 12, "b2", "git diff"),
]) t.add(e);
const r = t.result();
eq("상대·절대·복사본 경로가 같은 열쇠(원본 경로)가 된다", [...r.keys()].sort(), ["/work/src/a.ts", "/work/src/b.ts"]);
eq("a.ts는 첫 턴에서 마지막 수정 순번 5, 지시와 명령이 붙는다", r.get("/work/src/a.ts"), [{ seq: 5, at: 5, prompt: { text: "첫 지시", seq: 1 }, commands: [{ text: "npm test", seq: 2 }] }]);
eq("실패한 수정만 있는 턴은 빠진다", r.get("/work/src/a.ts")?.length, 1);
eq("b.ts는 두 턴 모두에 나오고 턴별 명령이 맞다", r.get("/work/src/b.ts")?.map((x) => [x.seq, x.prompt?.text, x.commands.map((c) => c.text)]), [[5, "첫 지시", ["npm test"]], [10, "두 번째 지시", ["git diff"]]]);
const t2 = createFileTouches((p) => p);
for (let i = 0; i < 8; i++) t2.add(bash("claude", i + 2, `b${i}`, `cmd${i}`));
t2.add(edit("claude", 20, "e", ["/x.ts"]));
eq("턴당 명령은 5개까지", t2.result().get("/x.ts")?.[0].commands.length, 5);
eq("지시 앞의 수정은 지시 없이 나온다", t2.result().get("/x.ts")?.[0].prompt, undefined);

console.log(`\n${fail === 0 ? "✅" : "❌"} file_trace: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
