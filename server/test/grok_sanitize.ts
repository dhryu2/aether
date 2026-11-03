/**
 * Grok 이벤트 디스크 저장 정책 (Phase 10c · D2.3) — 모델 호출 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-groksan-"));
process.env.AETHER_PERSIST_MAX_FIELD_CHARS = "256";

const { grokCodec } = await import("../sessions/codec/grok");
type AetherEvent = import("../types").AetherEvent;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}

let seq = 0;
function ev(msg: unknown): AetherEvent {
  return { seq: ++seq, ts: 1000 + seq, kind: "grok", msg } as AetherEvent;
}
function update(sessionUpdate: string, extra: Record<string, unknown> = {}): AetherEvent {
  return ev({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate, ...extra } } });
}

const filter = grokCodec.persistFilter();
function persisted(e: AetherEvent): AetherEvent | null {
  return filter.apply(e);
}

check(grokCodec.isLiveOnly(update("agent_message_chunk", { content: { type: "text", text: "x" } })), "① 메시지 청크는 라이브 전용");
check(grokCodec.isLiveOnly(update("agent_thought_chunk", { content: { type: "text", text: "x" } })), "① 생각 청크는 라이브 전용");
check(grokCodec.isLiveOnly(update("user_message_chunk", { content: { type: "text", text: "x" } })), "① 사용자 글 청크는 라이브 전용");
check(!grokCodec.isLiveOnly(update("agent_message", { content: { type: "text", text: "완성" } })), "① 완성 본문은 영속 대상");
check(grokCodec.endsTurn(ev({ method: "session/prompt_result", params: { stopReason: "end_turn" } })), "① prompt_result가 턴을 끝낸다");
check(!grokCodec.endsTurn(update("agent_message_chunk")), "① 청크는 턴을 끝내지 않는다");

const long = "A".repeat(400);
const shrunk = persisted(update("tool_call", { toolCallId: "t1", title: "Write", rawInput: { file_path: "a.txt", content: long } }));
check(!!shrunk && JSON.stringify(shrunk).length < JSON.stringify(update("tool_call", { rawInput: { content: long } })).length + 200, "② 긴 도구 인자는 잘린다");

const secret = persisted(update("tool_call", { toolCallId: "t2", rawInput: { file_path: "/tmp/proj/.env", content: "SECRET=1" } }));
check(!!secret && !JSON.stringify(secret).includes("SECRET=1"), "③ 비밀 경로의 내용은 가려진다", secret);

const dropped = persisted(ev({ method: "_x.ai/mcp/servers_updated", params: { servers: [] } }));
check(dropped === null, "③ 계정·MCP 확장 알림은 세션 기록에 안 남긴다");

check(grokCodec.isAuthExpired(ev({ method: "error", params: { message: "401 Unauthorized" } })), "④ 401은 인증 만료");
check(!grokCodec.isAuthExpired(ev({ method: "session/prompt_result", params: { stopReason: "end_turn" } })), "④ 정상 종료는 만료가 아니다");

console.log(`\n${fail === 0 ? "✅" : "❌"} grok_sanitize: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
