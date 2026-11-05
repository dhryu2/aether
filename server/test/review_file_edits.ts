/**
 * provider별 파일 변경 조각(fileEdits)과 공통 변환(fileEditPreview) — 모델 호출 0.
 * 원본 모양 지식은 각 codec 안에만 있고, 변환은 조각의 모양만 본다.
 */
import assert from "node:assert";
import { claudeCodec } from "../sessions/codec/claude";
import { codexCodec, codexCodecFor } from "../sessions/codec/codex";
import { grokCodec } from "../sessions/codec/grok";
import { fileEditPreview } from "../sessions/fileEdits";
import { isClampedString } from "../sessions/persistFilter";
import type { AetherEvent } from "../types";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✅ ${name}`);
    pass++;
  } catch {
    console.log(`  ❌ ${name} — ${JSON.stringify({ actual, expected }).slice(0, 400)}`);
    fail++;
  }
}
const ev = (e: object) => e as unknown as AetherEvent;

console.log("\n=== Claude ===");
const asst = (...blocks: object[]) => ev({ kind: "sdk", msg: { type: "assistant", message: { content: blocks } } });
const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
eq("Edit", claudeCodec.fileEdits(asst(use("t1", "Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y", replace_all: true }))), [{ toolId: "t1", path: "/w/a.ts", before: "x", after: "y", replaceAll: true }]);
eq("MultiEdit는 항목마다 하나, 같은 toolId", claudeCodec.fileEdits(asst(use("t2", "MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }))).map((e) => [e.toolId, e.before, e.after]), [["t2", "a", "b"], ["t2", "c", "d"]]);
eq("Write는 after만", claudeCodec.fileEdits(asst(use("t3", "Write", { file_path: "/w/n.ts", content: "hi" }))), [{ toolId: "t3", path: "/w/n.ts", after: "hi" }]);
eq("NotebookEdit는 셀 하나라 조각(before 빈 값)으로", claudeCodec.fileEdits(asst(use("t4", "NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "print(1)" }))), [{ toolId: "t4", path: "/w/n.ipynb", before: "", after: "print(1)" }]);
eq("NotebookEdit 내용 없음은 항목 없음", claudeCodec.fileEdits(asst(use("t5", "NotebookEdit", { notebook_path: "/w/n.ipynb" }))), []);
eq("id 없는 블록·다른 도구·다른 사건은 빈 배열", [claudeCodec.fileEdits(asst({ type: "tool_use", name: "Write", input: { file_path: "/a", content: "x" } })), claudeCodec.fileEdits(asst(use("t6", "Bash", { command: "ls" }))), claudeCodec.fileEdits(ev({ kind: "status", status: "completed" }))], [[], [], []]);

console.log("\n=== Codex · Ollama ===");
const item = (method: string, id: string, changes: object[]) => ev({ kind: "codex", msg: { method, params: { item: { type: "fileChange", id, status: "completed", changes } } } });
const upd = { path: "/w/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" };
const add = { path: "/w/n.ts", kind: { type: "add" }, diff: "line1\nline2\n" };
const del = { path: "/w/d.ts", kind: { type: "delete" }, diff: "gone\n" };
const mv = { path: "/w/o.ts", kind: { type: "update", move_path: "/w/p.ts" }, diff: "@@ -1 +1 @@\n-a\n+b\n" };
const addDiff = { path: "/w/m.ts", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+x\n" };
for (const [label, codec] of [["Codex", codexCodec], ["Ollama", codexCodecFor("ollama")]] as const) {
  eq(`${label}: update는 diff`, codec.fileEdits(item("item/started", "k1", [upd])), [{ toolId: "k1", path: "/w/a.ts", diff: upd.diff }]);
  eq(`${label}: add 본문은 after + isCreate`, codec.fileEdits(item("item/completed", "k2", [add])), [{ toolId: "k2", path: "/w/n.ts", after: add.diff, isCreate: true }]);
  eq(`${label}: delete 본문은 before만`, codec.fileEdits(item("item/completed", "k3", [del])), [{ toolId: "k3", path: "/w/d.ts", before: del.diff }]);
  eq(`${label}: 패치 머리가 있는 add는 diff`, codec.fileEdits(item("item/completed", "k4", [addDiff])), [{ toolId: "k4", path: "/w/m.ts", diff: addDiff.diff }]);
  eq(`${label}: 이름 바꿈은 movePath`, codec.fileEdits(item("item/completed", "k5", [mv]))[0].movePath, "/w/p.ts");
  eq(`${label}: 시작·완료 모두 같은 toolId`, [codec.fileEdits(item("item/started", "k6", [upd]))[0].toolId, codec.fileEdits(item("item/completed", "k6", [upd]))[0].toolId], ["k6", "k6"]);
  eq(`${label}: 파일 변경이 아닌 항목은 빈 배열`, codec.fileEdits(ev({ kind: "codex", msg: { method: "item/started", params: { item: { type: "commandExecution", id: "c" } } } })), []);
}

console.log("\n=== Grok ===");
const gu = (update: object) => ev({ kind: "grok", msg: { method: "session/update", params: { update } } });
eq("ACP diff 블록(oldText 있음)", grokCodec.fileEdits(gu({ sessionUpdate: "tool_call_update", toolCallId: "g1", content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }] })), [{ toolId: "g1", path: "/w/a.ts", before: "a", after: "b" }]);
eq("ACP diff 블록(oldText null)은 새 파일", grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", toolCallId: "g2", kind: "edit", content: [{ type: "diff", path: "/w/n.ts", oldText: null, newText: "hi" }] })), [{ toolId: "g2", path: "/w/n.ts", after: "hi", isCreate: true }]);
eq("rawInput의 old_string/new_string", grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", toolCallId: "g3", kind: "edit", rawInput: { path: "/w/a.ts", old_string: "a", new_string: "b" } })), [{ toolId: "g3", path: "/w/a.ts", before: "a", after: "b" }]);
eq("rawInput의 content는 after만", grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", toolCallId: "g4", title: "write_file", rawInput: { file_path: "/w/n.ts", content: "hi" } })), [{ toolId: "g4", path: "/w/n.ts", after: "hi" }]);
eq("모르는 모양·toolCallId 없음·다른 사건은 빈 배열", [grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", toolCallId: "g5", kind: "edit", rawInput: { foo: 1 } })), grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", rawInput: { path: "/a", content: "x" } })), grokCodec.fileEdits(gu({ sessionUpdate: "agent_message_chunk" }))], [[], [], []]);

eq("파일 변경이 아닌 도구의 rawInput은 조각을 내지 않는다(normalize와 같은 기준)", grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", toolCallId: "g6", kind: "execute", rawInput: { path: "/w/a.ts", content: "x" } })), []);
eq("rawInput 대신 input에 실린 것도 읽는다", grokCodec.fileEdits(gu({ sessionUpdate: "tool_call", toolCallId: "g7", kind: "edit", input: { path: "/w/a.ts", content: "x" } })), [{ toolId: "g7", path: "/w/a.ts", after: "x" }]);

console.log("\n=== Codex: 새 파일 본문 속 @@ ===");
const addAt = { path: "/w/doc.md", kind: { type: "add" }, diff: "intro\n@@ -1 +1 @@\nlook\n" };
eq("본문 중간의 @@ 줄은 패치가 아니다", codexCodec.fileEdits(item("item/completed", "k7", [addAt])), [{ toolId: "k7", path: "/w/doc.md", after: addAt.diff, isCreate: true }]);
const addHdr = { path: "/w/h.ts", kind: { type: "add" }, diff: "--- /dev/null\n+++ b/h.ts\n@@ -0,0 +1 @@\n+x\n" };
eq("---/+++ 머리 다음 @@는 패치", codexCodec.fileEdits(item("item/completed", "k8", [addHdr]))[0].diff, addHdr.diff);

console.log("\n=== 공통 변환 ===");
const p1 = fileEditPreview({ toolId: "a", path: "x", before: "a\nb", after: "a\nc", replaceAll: true }, "x");
eq("전·후는 조각 표시와 replaceAll 유지", [p1.kind, p1.fragment, p1.replaceAll, p1.additions, p1.deletions], ["edit", true, true, 1, 1]);
const p2 = fileEditPreview({ toolId: "a", path: "x", after: "a\n" }, "x");
eq("후만은 write + 수정 전 모름", [p2.kind, p2.beforeUnknown, p2.isCreate], ["write", true, undefined]);
const p3 = fileEditPreview({ toolId: "a", path: "x", after: "a\n", isCreate: true }, "x");
eq("새 파일은 안내 대신 isCreate", [p3.beforeUnknown, p3.isCreate], [undefined, true]);
const p4 = fileEditPreview({ toolId: "a", path: "x", before: "a\n" }, "x");
eq("전만은 삭제 줄", [p4.additions, p4.deletions], [0, 1]);
const p5 = fileEditPreview({ toolId: "a", path: "x", diff: "그냥 글" }, "x");
eq("hunk 없는 diff는 내용 없음", p5.hunks, undefined);
const nl = fileEditPreview({ toolId: "a", path: "x", before: "a", after: "b" }, "x");
eq("줄바꿈 없음 표식 줄은 hunk에서 빠진다", [nl.hunks?.every((h) => h.lines.every((l) => !l.startsWith("\\"))), nl.additions, nl.deletions], [true, 1, 1]);
const ko = "…[Aether: 3000자 중 0K자만 저장]";
const en = "…[Aether: kept 0K of 3000 chars]";
eq("잘림 표식은 끝에 붙은 양쪽 언어만 잡는다", [isClampedString("abc" + ko), isClampedString("abc" + en), isClampedString("평범한 글"), isClampedString("앞 " + ko + " 뒤 본문"), isClampedString("앞 " + en + " 뒤")], [true, true, false, false, false]);
eq("잘린 조각은 hunks 없이 truncated만", fileEditPreview({ toolId: "a", path: "x", after: "abc" + en }, "x"), { kind: "write", path: "x", truncated: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} review_file_edits: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
