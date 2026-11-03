/**
 * 와이어 봉투(toWireEvent) 테스트. 실행: `tsx test/wire_events.ts`
 *
 * SSE·`GET /events`가 내보내는 봉투는 정규화 계약(`events`)과 Aether 제어 사건이다. 여기서 확인하는 것:
 *   (A) 어떤 이벤트에 `events`가 붙고 안 붙는가 — 붙어야 할 것이 안 붙으면 그 화면 요소가 조용히 빈다.
 *   (B) 클라이언트 봉투에 provider 원본 `msg`가 0건인가. seq는 유지된다.
 *   (C) 프론트 리더가 계약만으로 콘텐츠를 뽑아내는가 — 원본 모양을 모르는 봉투로도 성립해야 한다.
 *
 * 8c에는 증강을 끄는 legacy 모드가 있어 같은 파일을 두 환경으로 돌렸다. 8d-3에서 그 예비 경로를 지웠으므로
 * (프론트가 원본을 아예 안 읽어 끄면 화면이 빈다) 실행도 한 번이다.
 *
 * 화면 조각까지의 렌더 검증은 `web/test/streamSegments.test.ts`가 맡는다(가짜 두 번째 provider 포함).
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AetherEvent } from "../types";
import type { AetherEvent as ClientEvent } from "../../web/src/lib/types";
import { toWireEvent } from "../sessions/wireEvent";
import { claudeCodec } from "../sessions/codec/claude";
import { collectToolResults, lastUsageOf, modelInfoOf, commandsAvailableOf, renderableContentParts, turnCompletedOf } from "../../web/src/lib/agentEvents";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "claude_events.jsonl");

let pass = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (!cond && extra !== undefined) console.error("  detail:", JSON.stringify(extra));
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
  pass++;
}
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✓ ${name}`);
    pass++;
  } catch {
    console.error(`  ✗ ${name}\n    actual  : ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
    throw new assert.AssertionError({ message: `FAIL: ${name}` });
  }
}

function readEvents(): AetherEvent[] {
  return fs
    .readFileSync(FIX, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AetherEvent);
}

const has = (ev: AetherEvent) => "events" in toWireEvent(ev, claudeCodec);

/** kind/type/subtype/blocks로 픽스처에서 대표 1건 선택. */
function pick(events: AetherEvent[], kind: string, type?: string, subtype?: string, blocks?: string): AetherEvent {
  const found = events.find((e) => {
    if (e.kind !== kind) return false;
    if (kind !== "sdk") return true;
    const m = (e as { msg: { type?: string; subtype?: string; message?: { content?: unknown } } }).msg;
    if (type && m.type !== type) return false;
    if (subtype && m.subtype !== subtype) return false;
    if (blocks) {
      const bs = Array.isArray(m.message?.content) ? (m.message!.content as { type?: string }[]).map((b) => b.type).join(",") : "";
      if (bs !== blocks) return false;
    }
    return true;
  });
  assert.ok(found, `픽스처에 없음: ${kind}/${type}/${subtype}/${blocks}`);
  return found!;
}

const events = readEvents();

// ── (A) 어떤 이벤트에 계약이 실리는가 ──
console.log("(A) toWireEvent 봉투 증강");
ok("assistant(text) → events 有", has(pick(events, "sdk", "assistant", undefined, "text")));
ok("assistant(text,tool_use) → events 有", has(pick(events, "sdk", "assistant", undefined, "text,tool_use")));
ok("assistant(thinking) → events 有(reasoning)", has(pick(events, "sdk", "assistant", undefined, "thinking")));
ok("user(tool_result) → events 有", has(pick(events, "sdk", "user", undefined, "tool_result")));
ok("result → events 有(turn_completed)", has(pick(events, "sdk", "result")));
ok("rate_limit_event → events 有", has(pick(events, "sdk", "rate_limit_event")));
ok("system/compact_boundary → events 有", has(pick(events, "sdk", "system", "compact_boundary")));
ok("system/model_refusal_fallback → events 有", has(pick(events, "sdk", "system", "model_refusal_fallback")));
ok("user_msg → events 有(user_text)", has(pick(events, "user_msg")));
ok("ctx → events 有(usage_update)", has(pick(events, "ctx")));
// 8d-3에서 계약이 흡수한 것들 — 이전엔 전부 events 無였고 프론트가 원본을 직접 읽었다.
ok("system/init → events 有(model_info)", has(pick(events, "sdk", "system", "init")));
ok("system/local_command_output → events 有(command_output)", has(pick(events, "sdk", "system", "local_command_output")));
ok("system/commands_changed → events 有(commands_available)", has(pick(events, "sdk", "system", "commands_changed")));
ok("system/api_retry → events 有(provider_notice retry)", has(pick(events, "sdk", "system", "api_retry")));
// 파생이 없는 것들은 여전히 raw만 — 빈 배열을 실어 보내지 않는다.
ok("assistant(fallback-only) → events 無", !has(pick(events, "sdk", "assistant", undefined, "fallback")));
ok("permission_request → events 無(제어 통과)", !has(pick(events, "permission_request")));
ok("question_request → events 無", !has(pick(events, "question_request")));
ok("status → events 無", !has(pick(events, "status")));

// ── (B) 클라이언트 봉투는 원본을 안 실는다 ──
console.log("(B) 클라이언트 봉투");
const sample = pick(events, "sdk", "assistant", undefined, "text,tool_use");
const wired = toWireEvent(sample, claudeCodec);
ok("seq 유지", wired.seq === sample.seq);
ok("모델 사건의 kind는 agent", wired.kind === "agent");
ok("원본 msg 없음", !("msg" in wired));
ok("events는 비지 않은 배열", Array.isArray(wired.events) && wired.events.length > 0);

const partial = {
  seq: 999,
  ts: 1999,
  kind: "sdk",
  msg: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "토큰" } } },
} as unknown as AetherEvent;
const partialWire = toWireEvent(partial, claudeCodec);
eq("stream_event text delta → text_delta AgentEvent", partialWire.events?.map((e) => [e.type, "text" in e ? e.text : ""]), [["text_delta", "토큰"]]);

// ── (C) 프론트 리더는 계약만 읽는다 ──
console.log("(C) 프론트 리더(실제 모듈)");
const wiredEvents = events.map((ev) => toWireEvent(ev, claudeCodec) as ClientEvent);
ok("픽스처 전량 msg 0건", wiredEvents.every((ev) => !("msg" in ev)));
ok(
  "제어 사건은 kind를 유지한다",
  toWireEvent(pick(events, "permission_request"), claudeCodec).kind === "permission_request"
    && toWireEvent(pick(events, "user_msg"), claudeCodec).kind === "user_msg",
);

const toolCallEv = wiredEvents.find((ev) => renderableContentParts(ev).some((p) => p.type === "tool_call"))!;
const toolPart = renderableContentParts(toolCallEv).find((p) => p.type === "tool_call")!;
eq("도구 카드 인자는 요약이 아니라 원문 전체", toolPart.type === "tool_call" ? toolPart.input : null, { command: "python A.py" });

const actualResults = collectToolResults(wiredEvents);
ok("tool_result를 toolId로 수집", actualResults.has("toolu_01AA") && actualResults.has("toolu_01EE"));
ok("tool_result 실패 상태 보존", actualResults.get("toolu_01EE")?.is_error === true);

const resultEv = wiredEvents.find((ev) => turnCompletedOf(ev)?.errors)!;
const turn = turnCompletedOf(resultEv)!;
eq("결과 푸터가 쓰는 값(출력 토큰·에러 목록)", [turn.status, turn.outputTokens, turn.errors], [
  "failed",
  128,
  ["529 overloaded_error", "upstream timeout"],
]);

eq("usage_update로 ctx 파생", lastUsageOf(wiredEvents), { totalTokens: 50000, maxTokens: 200000 });
eq("모델 슬롯은 마지막 관측이 유효", wiredEvents.map(modelInfoOf).filter(Boolean).at(-1), "claude-haiku-4-5");
eq("슬래시 명령 이름은 계약에서", wiredEvents.map(commandsAvailableOf).filter(Boolean).at(-1), ["review", "verify"]);

// 두 번째 provider 봉투 — 원본 모양이 Claude와 전혀 달라도 같은 리더가 같은 결과를 낸다.
const foreignEnvelope = {
  seq: 1000,
  ts: 2000,
  kind: "agent",
  events: [
    { provider: "codex", seq: 1000, part: 0, ts: 2000, type: "text", text: "provider-neutral" },
    { provider: "codex", seq: 1000, part: 1, ts: 2000, type: "tool_call", toolId: "codex-tool-1", name: "commandExecution", toolKind: "bash", target: "npm test" },
  ],
} as unknown as ClientEvent;
eq("원본 모양을 몰라도 계약만으로 렌더", renderableContentParts(foreignEnvelope), [
  { type: "text", text: "provider-neutral", part: 0 },
  // input을 못 채우는 provider면 핵심 인자 하나로 최소 모양을 만든다(카드가 비지 않게).
  { type: "tool_call", toolId: "codex-tool-1", name: "commandExecution", input: { command: "npm test" }, part: 1, toolKind: "bash" },
]);

// ── (D) 할 일 목록(todo_list)은 봉투 맨 위에 items를 흘리지 않고 kind:"agent"의 plan_update로만 나간다 ──
console.log("(D) 할 일 목록 봉투");
{
  const { withAetherEvents } = await import("../sessions/codec/aetherEvents");
  const todo = { seq: 55, ts: 550, kind: "todo_list", items: [{ text: "읽기", status: "completed" }] } as unknown as AetherEvent;
  const w = toWireEvent(todo, withAetherEvents(claudeCodec)) as unknown as Record<string, unknown>;
  ok("kind는 agent", w.kind === "agent");
  ok("맨 위에 items가 새지 않는다", !("items" in w));
  eq("events[0] = plan_update + items", (w.events as { type: string; items?: unknown }[]).map((e) => [e.type, e.items]), [["plan_update", [{ text: "읽기", status: "completed" }]]]);
}

console.log(`\n✅ wire_events: ${pass} PASS`);
