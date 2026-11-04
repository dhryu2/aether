/**
 * 영속 필터 순수 단위 (Claude 0). filterSdkForPersist(클램프+시크릿 redact)·collectSecretToolUseIds 검증.
 * 불변식: 라이브 ev 불변(COW), seq/kind/msg.type 보존, assistant 답변 text 무손상, 변경불요 시 동일 참조(no-op).
 */
import { collectSecretToolUseIds, filterSdkForPersist } from "../providers/claude/persistFilter";
import type { AetherEvent } from "../types";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  cond ? pass++ : fail++;
}

const MAX = 20;
const big = "x".repeat(500);
const empty = new Set<string>();

// ── 1. tool_result(문자열) 클램프 ──
const toolResultStr = {
  seq: 1, ts: 1, kind: "sdk",
  msg: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: big, is_error: false }] } },
} as unknown as AetherEvent;
const r1 = filterSdkForPersist(toolResultStr, MAX, empty) as any;
check(r1 !== toolResultStr, "1a 변경 시 새 ev 반환(원본과 다른 참조)");
check(r1.seq === 1 && r1.kind === "sdk" && r1.msg.type === "user", "1b seq/kind/msg.type 보존");
check(r1.msg.message.content[0].content.length < big.length && r1.msg.message.content[0].content.includes("Aether:"), "1c tool_result 클램프 + 마커");
check(r1.msg.message.content[0].content.startsWith("x".repeat(MAX)), "1d 앞 MAX자 유지");
check(r1.msg.message.content[0].tool_use_id === "tu1" && r1.msg.message.content[0].is_error === false, "1e 비콘텐츠 필드(tool_use_id/is_error) 보존");
check((toolResultStr as any).msg.message.content[0].content === big, "1f 원본 ev 불변(COW)");

// ── 2. tool_result(배열 text 블록) 클램프 ──
const toolResultArr = {
  seq: 2, ts: 1, kind: "sdk",
  msg: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: big }] }] } },
} as unknown as AetherEvent;
const r2 = filterSdkForPersist(toolResultArr, MAX, empty) as any;
check(r2.msg.message.content[0].content[0].text.includes("Aether:") && r2.msg.message.content[0].content[0].text.length < big.length, "2a 배열 text 블록 클램프");

// ── 2b. tool_result 내 base64 이미지 → 디스크 stub(라이브는 full base64 유지) ──
const b64 = "A".repeat(2000);
const toolResultImg = {
  seq: 14, ts: 1, kind: "sdk",
  msg: { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "tu3", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
      { type: "text", text: "ok" },
    ] },
  ] } },
} as unknown as AetherEvent;
const r2b = filterSdkForPersist(toolResultImg, MAX, empty) as any;
const imgBlk = r2b.msg.message.content[0].content[0];
check(imgBlk.type === "image" && typeof imgBlk.source.data === "string" && !imgBlk.source.data.includes("AAAA"), "2b 이미지 base64 → stub 치환(원본 data 제거)");
check(imgBlk.source.data.includes("image/png") && imgBlk.source.data.includes("KB") && imgBlk.source.type === "base64", "2c stub에 타입/크기 메타 + source.type 보존");
check(r2b.msg.message.content[0].content[1].text === "ok", "2d 같은 배열 내 text 블록(상한 이내) 보존");
check((toolResultImg as any).msg.message.content[0].content[0].source.data === b64, "2e 원본 ev 불변(COW) — 라이브는 full base64");

// ── 3. assistant 답변 text는 클램프 안 함(스크롤백 보존) ──
const assistantText = {
  seq: 3, ts: 1, kind: "sdk",
  msg: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: big }] } },
} as unknown as AetherEvent;
const r3 = filterSdkForPersist(assistantText, MAX, empty);
check(r3 === assistantText, "3a assistant text는 무손상(동일 참조 no-op)");

// ── 4. assistant tool_use.input(content) 클램프 ──
const toolUseWrite = {
  seq: 4, ts: 1, kind: "sdk",
  msg: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "a.txt", content: big } }] } },
} as unknown as AetherEvent;
const r4 = filterSdkForPersist(toolUseWrite, MAX, empty) as any;
check(r4.msg.message.content[0].input.content.includes("Aether:") && r4.msg.message.content[0].input.file_path === "a.txt", "4a tool_use.input.content 클램프(file_path 보존)");

// ── 5. Bash command 인라인 시크릿은 가리지 않는다(사용자 결정 2026-10-21: 값 가림 제거) ──
const bashSecret = {
  seq: 5, ts: 1, kind: "sdk",
  msg: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "export API_KEY=supersecretvalue && curl -H 'Authorization: Bearer abcdef123456' x" } }] } },
} as unknown as AetherEvent;
const r5 = filterSdkForPersist(bashSecret, MAX * 100, empty) as any; // 길이상한 크게 → 원문 보존만 검증
const cmd5 = r5.msg.message.content[0].input.command;
check(cmd5.includes("supersecretvalue") && cmd5.includes("API_KEY=") && !cmd5.includes("redacted"), "5a export KEY= 값이 가려지지 않고 그대로 남는다");
check(cmd5.includes("abcdef123456"), "5b Authorization 헤더 값이 가려지지 않고 그대로 남는다");

// ── 6. collectSecretToolUseIds: 시크릿 경로 읽기 탐지 ──
const readEnv = { type: "assistant", message: { content: [
  { type: "tool_use", id: "s1", name: "Read", input: { file_path: ".env" } },
  { type: "tool_use", id: "s2", name: "Bash", input: { command: "cat .env.local" } },
  { type: "tool_use", id: "s3", name: "Read", input: { file_path: "src/app.ts" } }, // 비시크릿
  { type: "text", text: "hi" },
] } };
const secretIds = collectSecretToolUseIds(readEnv);
check(secretIds.includes("s1") && secretIds.includes("s2") && !secretIds.includes("s3"), "6a Read(.env)·Bash(cat .env.local) 탐지, 일반파일 제외");
check(collectSecretToolUseIds({ type: "user", message: { content: [] } }).length === 0, "6b 비-assistant는 빈 배열");
const shellSecret = collectSecretToolUseIds({ type: "assistant", message: { content: [
  { type: "tool_use", id: "m1", name: "Bash", input: { command: "cat .env; echo done" } },
  { type: "tool_use", id: "m2", name: "Read", input: { file_path: "auth.json" } },
] } });
check(shellSecret.includes("m1") && shellSecret.includes("m2"), "6c 셸 기호가 붙은 cat .env; 와 Read auth.json 도 탐지");

// ── 7. filterSdkForPersist: 시크릿 tool_result redact ──
const secretResult = {
  seq: 7, ts: 1, kind: "sdk",
  msg: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "AETHER_JWT_SECRET=plaintext-leaked" }] } },
} as unknown as AetherEvent;
const r7 = filterSdkForPersist(secretResult, MAX * 100, new Set(["s1"])) as any;
check(!JSON.stringify(r7).includes("plaintext-leaked") && r7.msg.message.content[0].content.includes("비밀 정보"), "7a 시크릿 tool_use_id의 tool_result 내용 redact");
check((secretResult as any).msg.message.content[0].content === "AETHER_JWT_SECRET=plaintext-leaked", "7b 원본 ev 불변");

// ── 8. no-op 동일 참조(변경 불요·비대상) ──
const small = {
  seq: 8, ts: 1, kind: "sdk",
  msg: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ok", content: "short" }] } },
} as unknown as AetherEvent;
check(filterSdkForPersist(small, MAX, empty) === small, "8a 상한 이내·비시크릿 → 동일 참조(no-op)");
const nonSdk = { seq: 9, ts: 1, kind: "ctx", totalTokens: 1, maxTokens: 2 } as unknown as AetherEvent;
check(filterSdkForPersist(nonSdk, MAX, empty) === nonSdk, "8b 비-sdk(ctx) → 동일 참조");
const resultMsg = { seq: 10, ts: 1, kind: "sdk", msg: { type: "result", result: big } } as unknown as AetherEvent;
check(filterSdkForPersist(resultMsg, MAX, empty) === resultMsg, "8c sdk:result(비 assistant/user) → 동일 참조(클램프 대상 아님)");

// ── 9. 휘발성 system(thinking_tokens·task_progress) → 디스크 stub ──
const taskProgress = {
  seq: 11, ts: 99, kind: "sdk",
  msg: { type: "system", subtype: "task_progress", task_id: "t", description: big, summary: big, usage: { total_tokens: 1 }, session_id: "s", uuid: "u" },
} as unknown as AetherEvent;
const r9 = filterSdkForPersist(taskProgress, MAX, empty) as any;
check(r9.seq === 11 && r9.ts === 99 && r9.kind === "sdk", "9a stub: seq/ts/kind 보존");
check(r9.msg.type === "system" && r9.msg.subtype === "task_progress" && r9.msg.description === undefined && r9.msg.summary === undefined, "9b stub: type/subtype만 남고 payload 제거");
check(JSON.stringify(r9).length < 120, "9c stub 크기 작음");
const thinking = { seq: 12, ts: 1, kind: "sdk", msg: { type: "system", subtype: "thinking_tokens", estimated_tokens: 5, estimated_tokens_delta: 2, session_id: "s", uuid: "u" } } as unknown as AetherEvent;
check((filterSdkForPersist(thinking, MAX, empty) as any).msg.estimated_tokens === undefined, "9d thinking_tokens stub");
const sysInit = { seq: 13, ts: 1, kind: "sdk", msg: { type: "system", subtype: "init", tools: ["a", "b"] } } as unknown as AetherEvent;
check(filterSdkForPersist(sysInit, MAX, empty) === sysInit, "9e init 등 비휘발성 system은 보존(동일 참조)");

console.log("─".repeat(50));
console.log(`persist filter: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
