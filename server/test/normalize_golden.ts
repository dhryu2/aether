/**
 * Phase 8b — normalize 중앙 모듈 골든 테스트.
 * 실행: tsx test/normalize_golden.ts
 *
 * 검증:
 *   (A) Claude AgentEvent 골든 — normalizeClaude(fixture) 가 계약대로 (seq,part)·필드를 산출.
 *       (툴호출·권한·질문·compact·에러·다중 블록 assistant·병렬 tool_result 케이스 포함)
 *   (B) 색인 동등성 — extractIndexable(fixture) 가 legacy 추출기(이 파일에 동결)와 (role,content) 동일.
 *   (C) 실코퍼스 동등성 — server/data/ 실세션 전수를 legacy vs 신 경로로 대조(로컬만; 없으면 skip).
 *   (D) Codex 스키마 검산 — normalizeCodex(8a 관찰을 중립화한 vendored protocol shape)가
 *       AgentEvent 계약에 매핑됨(8e가 실제 runtime 영속/sanitize와 E2E 카나리 확장).
 *   (E) (seq,part) 무결성 — 한 raw의 파생끼리 part 유일.
 *
 * 픽스처(server/test/fixtures/*.jsonl)는 실 SDKMessage / app-server 알림 shape를 따르되 내용은 중립화(시크릿 0).
 * Codex 픽스처는 vendored CLI 0.145.0 ServerNotification의 실제 중첩/필수 필드에 결박한다 — tokenUsage·error·
 * compact·MCP result가 평탄 shape로 되돌아가면 (D) 골든이 즉시 잡고, toolId 공백도 골든이 금지한다.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isControlEvent, type AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";
import { normalizeClaude } from "../sessions/normalize/claude";
import { normalizeCodex } from "../sessions/normalize/codex";
import { normalizeGrok } from "../sessions/normalize/grok";
import { extractIndexable } from "../search/extract";
import { claudeCodec } from "../sessions/codec/claude";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

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

function readJsonl<T>(file: string): T[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// ── AgentEvent 정규 문자열 투영(골든 비교용, 사람이 읽기 쉽게) ──
function proj(ae: AgentEvent): string {
  const h = `${ae.type}#${ae.part}`;
  switch (ae.type) {
    case "turn_started":
      return h;
    case "user_text":
    case "text":
    case "reasoning":
    case "text_delta":
    case "plan_text":
      return `${h}:${ae.text}`;
    case "plan_update":
      return `${h}:${ae.items.map((i) => `${i.status}:${i.text}`).join("|")}`;
    case "tool_call":
      // 8d-3: 인자 전체(`input`)가 계약에 실린다 — 어떤 키가 살아남았는지까지 투영해야 카드 퇴화를 잡는다.
      return `${h}:${ae.toolId}:${ae.name}/${ae.toolKind}/${ae.target ?? ""}${ae.paths ? `<${ae.paths.join("|")}>` : ""}${ae.input ? `{${Object.keys(ae.input).sort().join(",")}}` : ""}`;
    case "tool_result":
      return `${h}:${ae.toolId}:${ae.isError ? "ERR:" : ""}${ae.output}`;
    case "turn_completed":
      return (
        `${h}:${ae.status}:${ae.error ?? ""}` +
        (ae.outputTokens != null ? `:tok=${ae.outputTokens}` : "") +
        (ae.errors ? `:errs=${ae.errors.join("|")}` : "") +
        (ae.responsePreview ? `:preview=${ae.responsePreview}` : "") +
        (ae.modelTurnCount != null ? `:turns=${ae.modelTurnCount}` : "")
      );
    case "usage_update":
      return `${h}:${ae.totalTokens}/${ae.maxTokens}`;
    case "command_output":
      return `${h}:${ae.text}`;
    case "model_info":
      return `${h}:${ae.model}`;
    case "commands_available":
      return `${h}:${ae.names.join(",")}`;
    case "background_tasks":
      return `${h}:${ae.tasks.map((t) => `${t.id}/${t.kind}/${t.description}`).join(",")}`;
    case "provider_notice":
      return (
        `${h}:${ae.kind}${ae.detail ? ":" + ae.detail : ""}` +
        (ae.severity ? `:${ae.severity}` : "") +
        (ae.limitType ? `:${ae.limitType}` : "") +
        (ae.utilization != null ? `:util=${ae.utilization}` : "") +
        (ae.resetsAt != null ? `:reset=${ae.resetsAt}` : "") +
        (ae.attempt != null ? `:${ae.attempt}/${ae.max}` : "") +
        (ae.originalModel ? `:from=${ae.originalModel}` : "") +
        (ae.category ? `:cat=${ae.category}` : "")
      );
  }
}
const projAll = (evs: AgentEvent[]) => evs.map(proj);

// ═══════════════════════════════════════════════════════════════════
// (A) Claude AgentEvent 골든
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (A) Claude AgentEvent 골든 ===");
const claudeFix = readJsonl<AetherEvent>(path.join(FIX, "claude_events.jsonl"));
const bySeqClaude = new Map(claudeFix.map((e) => [e.seq, e]));
const nc = (seq: number) => normalizeClaude(bySeqClaude.get(seq)!);

const EXPECT_CLAUDE: Record<number, string[]> = {
  1: ["user_text#0:A.py 빌드해줘"], // 앞뒤 공백 trim
  2: ["text#0:실행해볼게요"],
  3: ["reasoning#0:먼저 의존성부터 확인하자"],
  4: ["tool_call#0:toolu_01AA:Bash/bash/python A.py{command}"],
  5: ["tool_result#0:toolu_01AA:ImportError: No module named torch"],
  6: ["text#0:line 12 타입오류를 고칩니다", "tool_call#1:toolu_01BB:Edit/file_change//p/A.py</p/A.py>{file_path}"], // 다중 블록 → part 0,1
  7: ["tool_result#0:toolu_01CC:parallel result ALPHA", "tool_result#1:toolu_01DD:parallel result BETA"], // 병렬 → part 0,1
  8: ["tool_call#0:toolu_01EE:mcp__aether__session_search/mcp/배포 설정{query}"],
  9: ["tool_result#0:toolu_01EE:ERR:"], // 빈 결과 + is_error
  10: [], // 사람 입력 echo(tool_result 없음)
  11: [], // permission_request(중립 제어 이벤트)
  12: [], // permission_resolved
  13: [], // question_request(중립 제어 이벤트)
  14: [], // question_resolved
  15: ["provider_notice#0:compact"], // conversation_reset(/clear) — severity 없음 = 배너 안 뜸
  16: ["provider_notice#0:compact:warn"], // compact_boundary — 사용자가 안 시킨 자동 압축이라 표면화
  17: ["provider_notice#0:model_fallback:claude-opus-4-8:warn:from=claude-fable-5:cat=cyber", "model_info#1:claude-opus-4-8"], // 폴백은 세션 모델을 바꾼다 → 모델 슬롯도 함께
  18: ["provider_notice#0:rate_limit:allowed:five_hour"], // severity 없음 = 정보성(배너 안 뜸)
  19: ["provider_notice#0:retry:overloaded:warn:1/3"],
  20: ["turn_completed#0:failed:실행 중 오류가 발생했습니다:preview=실행 중 오류가 발생했습니다:turns=2"],
  21: ["turn_completed#0:ok::preview=빌드 완료:turns=23"],
  22: ["usage_update#0:50000/200000"],
  23: [], // notice
  24: ["turn_started#0", "model_info#1:claude-opus-4-8"], // system init(이 픽스처엔 slash_commands 없음)
  25: [], // fallback block(미지 블록·모델 필드 없음)
  26: [], // status
  // ── 8d-3에서 계약이 흡수한 것들 ──
  27: ["text#0:모델 이름이 실린 답변", "model_info#1:claude-haiku-4-5"], // ★ model_info는 블록 *뒤* — 색인 part가 안 밀린다
  28: ["text#0:슬래시 명령 합성 답변"], // model="<synthetic>"은 실제 모델이 아니라 무시
  29: ["command_output#0:context: 12k/200k\nusage: 3%"], // 슬래시 명령 출력(이전엔 정규화 자체가 없었다)
  30: ["commands_available#0:review,verify"],
  31: ["provider_notice#0:rate_limit:allowed_warning:warn:seven_day_opus:util=0.87:reset=4102444800"],
  32: ["provider_notice#0:rate_limit:rejected:blocked:five_hour:util=1"],
  33: ["turn_completed#0:failed:실패:tok=128:errs=529 overloaded_error|upstream timeout:preview=실패:turns=1"],
  34: ["background_tasks#0:bg1/agent/코드 조사,bg2/command/sleep 20,bg3/other/x"],
  35: ["background_tasks#0:"],
};
for (const [seqStr, expected] of Object.entries(EXPECT_CLAUDE)) {
  const seq = Number(seqStr);
  eq(`claude seq=${seq}`, projAll(nc(seq)), expected);
}
// 스팟: turn_completed durationMs / provider·seq 보존
ok("seq21 turn_completed durationMs=486345", nc(21)[0].type === "turn_completed" && (nc(21)[0] as { durationMs?: number }).durationMs === 486345);
ok("모든 AgentEvent provider='claude'", claudeFix.every((e) => normalizeClaude(e).every((a) => a.provider === "claude")));
ok("seq/ts 보존", nc(4)[0].seq === 4 && nc(4)[0].ts === 1003);
const boundary = (trigger: string) =>
  projAll(normalizeClaude({ seq: 90, ts: 1090, kind: "sdk", msg: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens: 1 } } } as AetherEvent));
eq("직접 시킨 압축(manual)은 진행 카드가 알리므로 배너를 안 띄운다", boundary("manual"), ["provider_notice#0:compact"]);
eq("자동 압축(auto)은 배너로 알린다", boundary("auto"), ["provider_notice#0:compact:warn"]);

// 서브에이전트 발화의 모델은 세션 모델이 아니다. 도구 호출 등 나머지 파생은 그대로 둔다.
const assistantWithModel = (parent: string | null, blocks: unknown[]): AetherEvent =>
  ({
    seq: 91,
    ts: 1091,
    kind: "sdk",
    msg: {
      type: "assistant",
      parent_tool_use_id: parent,
      message: { model: "claude-haiku-4-5", content: blocks },
    },
  }) as AetherEvent;
eq(
  "본 세션 assistant(parent_tool_use_id null)는 model_info를 낸다",
  projAll(normalizeClaude(assistantWithModel(null, [{ type: "text", text: "본 세션 답변" }]))),
  ["text#0:본 세션 답변", "model_info#1:claude-haiku-4-5"],
);
eq(
  "서브에이전트 assistant(parent_tool_use_id toolu_x)는 model_info를 내지 않고 tool_call은 남긴다",
  projAll(
    normalizeClaude(
      assistantWithModel("toolu_x", [{ type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "/tmp/a.txt" } }]),
    ),
  ),
  ["tool_call#0:toolu_sub:Read/file_read//tmp/a.txt{file_path}"],
);

// ═══════════════════════════════════════════════════════════════════
// (B) 색인 동등성 — legacy 추출기(동결) vs 신 extractIndexable
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (B) 색인 동등성(legacy vs normalize) ===");

// ── legacy extract.ts 로직 동결본(Phase 8b 이전) — 회귀 대조용. 절대 리팩터 금지. ──
const LEGACY_TARGET_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"];
function legacyToolTarget(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of LEGACY_TARGET_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
function legacyTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
  }
  return parts.join("\n");
}
function legacyAssistantToolCalls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const o = b as { type?: unknown; name?: unknown; input?: unknown };
    if (o.type === "tool_use") {
      const name = typeof o.name === "string" ? o.name : "tool";
      const target = legacyToolTarget(o.input);
      out.push(target ? `⚙ ${name}(${target})` : `⚙ ${name}`);
    }
  }
  return out;
}
type RC = { role: "user" | "assistant" | "tool"; content: string };
function legacyExtract(ev: AetherEvent): RC[] {
  if (isControlEvent(ev, "user_msg")) {
    const c = ev.text.trim();
    return c ? [{ role: "user", content: c }] : [];
  }
  if (ev.kind === "sdk" && "msg" in ev) {
    const msg = ev.msg as { type?: string; message?: { content?: unknown } };
    const content = msg?.message?.content;
    if (msg?.type === "assistant") {
      const items: RC[] = [];
      const text = legacyTextFromContent(content).trim();
      if (text) items.push({ role: "assistant", content: text });
      for (const call of legacyAssistantToolCalls(content)) items.push({ role: "tool", content: call });
      return items;
    }
    if (msg?.type === "user" && Array.isArray(content)) {
      const items: RC[] = [];
      for (const b of content) {
        if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "tool_result") continue;
        const text = legacyTextFromContent((b as { content?: unknown }).content).trim();
        if (text) items.push({ role: "tool", content: `▸ ${text}` });
      }
      return items;
    }
  }
  return [];
}
/**
 * 색인 역할을 legacy 표기로 되돌린다. 지금은 모델 텍스트를 일단 전부 '작업 도중의 말'(assistant_interim)로
 * 넣고 턴이 끝날 때 마지막 하나만 최종 답변(assistant)으로 올린다(SearchIndex.promoteFinalAssistant).
 * 이 대조가 지키는 건 "정규화를 거쳐도 색인에 **담기는 내용**이 그대로인가"이므로, 승격 전 이름 차이는
 * 여기서 맞춰 놓고 본다. 승격 규칙 자체는 test/search_fts.ts가 따로 검증한다.
 */
const asLegacyRole = (role: string): RC["role"] => (role === "assistant_interim" ? "assistant" : (role as RC["role"]));
const newRC = (ev: AetherEvent): RC[] => extractIndexable(ev, claudeCodec).items.map((it) => ({ role: asLegacyRole(it.role), content: it.content }));

for (const ev of claudeFix) {
  eq(`색인 동등 seq=${ev.seq}`, newRC(ev), legacyExtract(ev));
}

// MCP 도구: 색인과 판정이 쓰는 name은 그대로 두고, 화면 이름만 따로 싣는다.
const mcpCall = claudeFix.flatMap((ev) => normalizeClaude(ev)).find((a) => a.type === "tool_call" && a.toolKind === "mcp");
eq("MCP 도구의 화면 이름", mcpCall?.type === "tool_call" ? [mcpCall.name, mcpCall.displayName] : [], ["mcp__aether__session_search", "aether.session_search"]);

// ═══════════════════════════════════════════════════════════════════
// (C) 실코퍼스 동등성 — server/data/ (로컬만, 없으면 skip)
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (C) 실코퍼스 동등성(운영 DB의 임시 사본) ===");
// 운영 DB에 직접 접속하지 않는다. 사본 경로는 GOLDEN_DB_COPY로 받는다.
const COPY = process.env.GOLDEN_DB_COPY ?? "";
const DATA = path.resolve(HERE, "..", "data");
if (!COPY || !fs.existsSync(COPY)) {
  console.log("  ⊘ GOLDEN_DB_COPY(운영 DB의 임시 사본 경로)가 없어 실코퍼스 대조 skip(CI 정상)");
} else if (path.resolve(COPY).startsWith(DATA + path.sep)) {
  console.log("  ⊘ GOLDEN_DB_COPY가 server/data 안이다. 운영 DB로 보고 skip");
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(COPY, { readOnly: true });
  const rows = db.prepare("SELECT session_id, line_text FROM session_event ORDER BY session_id, byte_offset").all() as { session_id: string; line_text: string }[];
  db.close();
  const sessions = new Set<string>();
  let events = 0;
  let mism = 0;
  const samples: string[] = [];
  for (const { session_id: sid, line_text: line } of rows) {
    sessions.add(sid);
    let ev: AetherEvent;
    try {
      ev = JSON.parse(line) as AetherEvent;
    } catch {
      continue;
    }
    events++;
    const a = JSON.stringify(newRC(ev));
    const b = JSON.stringify(legacyExtract(ev));
    if (a !== b) {
      mism++;
      if (samples.length < 3) samples.push(`${sid.slice(0, 8)} seq=${(ev as { seq?: number }).seq}\n    new: ${a}\n    old: ${b}`);
    }
  }
  ok(`실코퍼스 ${sessions.size}세션 ${events}이벤트 (role,content) 동등 (불일치 ${mism})`, mism === 0, samples);
}

// ═══════════════════════════════════════════════════════════════════
// (D) Codex 스키마 검산
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (D) Codex 스키마 검산(vendored protocol shape → AgentEvent) ===");
const codexFix = readJsonl<AetherEvent>(path.join(FIX, "codex_events.jsonl"));
const bySeqCodex = new Map(codexFix.map((e) => [e.seq, e]));
const cx = (seq: number) => normalizeCodex(bySeqCodex.get(seq)!);

const EXPECT_CODEX: Record<number, string[]> = {
  1: ["turn_started#0"],
  // 8g: Codex가 우리가 보낸 입력을 되돌려 주는 항목이다. 사용자가 친 글은 Aether가 자기 이벤트로 이미
  //   남기므로 여기서 또 만들면 같은 글이 화면에 두 번 그려진다(카나리 실측). Claude 쪽 규칙과 같게 맞췄다.
  2: [],
  3: ["reasoning#0:config.toml을 먼저 읽자"],
  4: ["text_delta#0:확인"], // 라이브 델타
  5: ["text#0:deploy 스크립트를 확인했습니다"],
  // 8e: 도구 호출에 인자 전체가 실린다(카드가 명령·경로를 보여주려면 필요 — 8d-3 계약 슬롯).
  6: ["tool_call#0:it-4:commandExecution/bash/ls deploy/{command,cwd}"],
  7: ["tool_result#0:it-4:deploy.sh\nnotify.sh"],
  // 8e: 파일 변경 결과 본문은 상태 문자열이 아니라 실제 diff다(승인 payload엔 diff가 없고 이 항목에만 있다).
  8: ["tool_result#0:it-5:@@ -1,2 +1,2 @@\n-echo old\n+echo new\n"],
  9: ["tool_call#0:it-6:aether.session_search/mcp/{arguments,server,tool}"],
  10: ["tool_result#0:it-6:검색 결과 3건"],
  11: ["tool_call#0:it-7:webSearch/web/codex app-server{query}"],
  12: ["plan_text#0:1. 확인\n2. 수정"],
  // 8e 실측 반영: 문맥 점유량은 대화 누계(total=12000)가 아니라 마지막 요청분(last=1000)이다.
  //   누계로 그리면 대화가 길어질수록 저절로 100%에 닿아 거짓 경고가 나간다.
  13: ["usage_update#0:1000/272000"],
  14: ["turn_completed#0:ok:"],
  15: ["turn_completed#0:interrupted:"],
  16: ["turn_completed#0:failed:모델 오류"],
  // 8e: 심각도를 채운다 — 다시 시도하는 오류는 경고, 그렇지 않은 오류는 막힌 상태다.
  //   심각도가 없으면 화면이 배너를 띄우지 않으므로, 이 값이 곧 "알릴 것인가"의 판정이다.
  17: ["provider_notice#0:retry:rate limited:warn"],
  18: ["provider_notice#0:error:fatal model error:blocked"],
  19: ["provider_notice#0:compact:warn"],
  // 8e: 모델이 바뀌면 알림만으로 부족하다 — 화면의 "지금 모델"도 함께 갱신해야 옛 값에 머물지 않는다.
  20: ["provider_notice#0:model_fallback:gpt-5.6-codex:warn:from=gpt-5.5-codex:cat=highRiskCyberActivity", "model_info#1:gpt-5.6-codex"],
  21: ["provider_notice#0:compact:warn"], // contextCompaction item(신 정본; thread/compacted는 deprecated)
  22: [], // account/updated → 세션 콘텐츠 아님
  23: ["plan_update#0:completed:확인|in_progress:수정|pending:배포"], // turn/plan/updated: inProgress → in_progress, 빈 단계 글은 빠짐
};
for (const [seqStr, expected] of Object.entries(EXPECT_CODEX)) {
  const seq = Number(seqStr);
  eq(`codex seq=${seq}`, projAll(cx(seq)), expected);
}
ok("모든 Codex AgentEvent provider='codex'", codexFix.every((e) => normalizeCodex(e).every((a) => a.provider === "codex")));
const completedCodex = cx(14)[0];
ok(
  "Codex turn/completed durationMs 보존",
  completedCodex.type === "turn_completed" && completedCodex.durationMs === 1000,
);
ok(
  "Codex turn/completed에는 생성 타입에 없는 최종 답변·모델 횟수를 지어내지 않는다",
  completedCodex.type === "turn_completed" && completedCodex.responsePreview === undefined && completedCodex.modelTurnCount === undefined,
);
ok(
  "Codex 도구 이벤트 toolId 비어 있지 않음",
  codexFix.every((e) =>
    normalizeCodex(e).every((a) => (a.type === "tool_call" || a.type === "tool_result" ? a.toolId.length > 0 : true))),
);
// 계약 커버리지: Claude·Codex 합쳐 전 AgentEvent type이 최소 1회 등장했는가
const ALL_TYPES = ["turn_started", "user_text", "text", "text_delta", "reasoning", "tool_call", "tool_result", "plan_update", "plan_text", "turn_completed", "usage_update", "provider_notice", "background_tasks"];
const seenTypes = new Set<string>();
for (const e of claudeFix) for (const a of normalizeClaude(e)) seenTypes.add(a.type);
for (const e of codexFix) for (const a of normalizeCodex(e)) seenTypes.add(a.type);
const missing = ALL_TYPES.filter((t) => !seenTypes.has(t));
ok(`AgentEvent 전 type 골든 커버(누락: ${missing.join(",") || "없음"})`, missing.length === 0);

// ═══════════════════════════════════════════════════════════════════
// (D2) Grok 스키마 검산 (가짜 ACP 원본)
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (D2) Grok 스키마 검산(ACP session/update → AgentEvent) ===");
const grokFix = readJsonl<AetherEvent>(path.join(FIX, "grok_events.jsonl"));
const bySeqGrok = new Map(grokFix.map((e) => [e.seq, e]));
const gx = (seq: number) => normalizeGrok(bySeqGrok.get(seq)!);
const EXPECT_GROK: Record<number, string[]> = {
  1: ["turn_started#0"],
  2: ["reasoning#0:먼저 읽자"],
  3: ["text_delta#0:확인"],
  4: ["text#0:파일을 확인했습니다"],
  5: ["tool_call#0:tc-1:run_terminal_command/bash/ls deploy/{command}"],
  6: ["tool_result#0:tc-1:deploy.sh"],
  7: ["usage_update#0:1000/272000"],
  8: ["turn_completed#0:ok:"],
  9: ["turn_completed#0:interrupted:"],
  10: ["turn_completed#0:failed:모델 오류"],
  11: ["plan_update#0:completed:확인|in_progress:수정|pending:배포"],
  12: [],
  13: ["plan_update#0:pending:알 수 없는 상태"], // 모르는 상태는 대기로 떨어지고 빈 글 항목은 빠진다
};
for (const [seqStr, expected] of Object.entries(EXPECT_GROK)) {
  const seq = Number(seqStr);
  eq(`grok seq=${seq}`, projAll(gx(seq)), expected);
}
ok("모든 Grok AgentEvent provider='grok'", grokFix.every((e) => normalizeGrok(e).every((a) => a.provider === "grok")));
ok(
  "Grok 도구 이벤트 toolId 비어 있지 않음",
  grokFix.every((e) => normalizeGrok(e).every((a) => (a.type === "tool_call" || a.type === "tool_result" ? a.toolId.length > 0 : true))),
);

// ═══════════════════════════════════════════════════════════════════
// (E) (seq,part) 무결성 — 파생끼리 part 유일
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (E) (seq,part) 무결성 ===");
function partsUnique(evs: AgentEvent[]): boolean {
  const s = new Set(evs.map((e) => e.part));
  return s.size === evs.length && evs.every((e, i) => e.part === i);
}
ok("Claude 파생 part 0..N-1 유일", claudeFix.every((e) => partsUnique(normalizeClaude(e))));
ok("Codex 파생 part 0..N-1 유일", codexFix.every((e) => partsUnique(normalizeCodex(e))));
ok("Grok 파생 part 0..N-1 유일", grokFix.every((e) => partsUnique(normalizeGrok(e))));

// ═══════════════════════════════════════════════════════════════════
// (G) 다중 text 블록 경계 — 의도적 분기 명시 락(bx-review Risk A)
//     이 SDK 파이프라인은 assistant 메시지당 content 블록 1개만 방출한다(실측 0건).
//     그래도 "한 메시지에 text 블록 2개+도구" 케이스에 대한 normalize 동작을 명시적으로 고정한다:
//     normalize는 블록별 방출(8c 세그먼트 모델), legacy는 text를 join해 1행 색인 — 이 차이가 알려진·의도된 것임을 락.
// ═══════════════════════════════════════════════════════════════════
console.log("\n=== (G) 다중 text 블록 경계 락(known divergence) ===");
const multiText: AetherEvent = {
  seq: 900,
  ts: 9000,
  kind: "sdk",
  msg: { type: "assistant", message: { content: [{ type: "text", text: "첫 문단" }, { type: "text", text: "둘째 문단" }, { type: "tool_use", id: "toolu_09MT", name: "Bash", input: { command: "echo hi" } }] } },
} as AetherEvent;
eq("다중 text: normalize 블록별 방출(part 0,1,2)", projAll(normalizeClaude(multiText)), ["text#0:첫 문단", "text#1:둘째 문단", "tool_call#2:toolu_09MT:Bash/bash/echo hi{command}"]);
eq("다중 text: 신 색인 = text 2행 + tool 1행(블록별)", newRC(multiText), [
  { role: "assistant", content: "첫 문단" },
  { role: "assistant", content: "둘째 문단" },
  { role: "tool", content: "⚙ Bash(echo hi)" },
]);
eq("다중 text: legacy 색인 = text join 1행 + tool 1행(의도적 차이)", legacyExtract(multiText), [
  { role: "assistant", content: "첫 문단\n둘째 문단" },
  { role: "tool", content: "⚙ Bash(echo hi)" },
]);
ok("다중 text: 실코퍼스 미출현 전제(assistant 메시지당 단일 블록) — (C)가 파수", true);

// 하위 작업 소속 표시 — parent_tool_use_id가 있는 발화에만 subtaskOf가 붙는다.
{
  const mk = (parent: unknown) =>
    normalizeClaude({ seq: 900, ts: 1, kind: "sdk", msg: { type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text: "x" }] } } } as never);
  ok("subtaskOf: 부모 id가 있으면 붙는다", mk("tu-9").every((e) => e.subtaskOf === "tu-9") && mk("tu-9").length > 0);
  ok("subtaskOf: null이면 안 붙는다", mk(null).every((e) => e.subtaskOf === undefined));
}

console.log(`\n✅ 전체 ${pass}개 통과`);
