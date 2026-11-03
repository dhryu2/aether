/**
 * ProviderEventCodec 계약 검증 (Phase 8d-1 · D2.6). 모델 호출 0 — 판정 로직만 본다.
 *
 * 지키려는 것:
 *   ① endsTurn/isLiveOnly가 8d-1 이전 판정과 정확히 같다(동작 무변경).
 *   ② 영속 축소기는 *세션당 1개*이고 이벤트 간 상태를 든다 — 시크릿을 읽은 도구의 결과가 뒤 이벤트에서 가려진다.
 *      이 상태를 없애고 순수 함수로 바꾸면 시크릿이 디스크에 그대로 남는다(회귀 가드).
 *   ③ 서로 다른 세션의 축소기는 상태를 공유하지 않는다(한 세션의 시크릿 판정이 다른 세션을 오염시키지 않음).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codec-"));

const { claudeCodec } = await import("../sessions/codec/claude");
const { normalizeClaude } = await import("../sessions/normalize/claude");
type AnyEvent = Parameters<typeof normalizeClaude>[0];

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

const sdk = (msg: unknown) => ({ seq: 1, ts: 1, kind: "sdk", msg }) as unknown as AnyEvent;

// ── ① 턴 종료 판정 ──
check(claudeCodec.endsTurn(sdk({ type: "result", subtype: "success" })), "result → 턴 종료");
check(claudeCodec.endsTurn(sdk({ type: "result", is_error: true })), "실패 result도 턴 종료(정상·실패 모두 result로 끝남)");
check(!claudeCodec.endsTurn(sdk({ type: "assistant" })), "assistant → 턴 종료 아님");
check(!claudeCodec.endsTurn(sdk({ type: "stream_event" })), "stream_event → 턴 종료 아님");
check(!claudeCodec.endsTurn({ kind: "status", status: "completed" } as unknown as AnyEvent), "status → 턴 종료 아님(꼬리 판정은 호출부가 따로 본다)");
check(!claudeCodec.endsTurn({ kind: "ctx", totalTokens: 1, maxTokens: 2 } as unknown as AnyEvent), "ctx → 턴 종료 아님");
check(!claudeCodec.endsTurn({ kind: "sdk" } as unknown as AnyEvent), "msg 없는 손상 줄도 안전(턴 종료 아님)");
check(!claudeCodec.endsTurn({} as unknown as AnyEvent), "kind 없는 손상 줄도 안전");

// ── ① 라이브 전용 판정 ──
check(claudeCodec.isLiveOnly(sdk({ type: "stream_event" })), "stream_event → 라이브 전용(영속·replay 제외)");
check(!claudeCodec.isLiveOnly(sdk({ type: "assistant" })), "assistant → 영속 대상");
check(!claudeCodec.isLiveOnly(sdk({ type: "result" })), "result → 영속 대상");
check(!claudeCodec.isLiveOnly({ kind: "user_msg", text: "x" } as unknown as AnyEvent), "user_msg → 영속 대상");
check(!claudeCodec.isLiveOnly({ kind: "notice", notice: "resumed" } as unknown as AnyEvent), "notice → 영속 대상(H3)");

// ── ① 인증 만료 판정(8e — 세션이 원본을 직접 읽지 않게 codec으로 올린 판정) ──
check(
  claudeCodec.isAuthExpired(sdk({ type: "result", is_error: true, errors: ["OAuth token has expired"] })),
  "실패한 턴의 만료 문구 → 인증 만료",
);
check(claudeCodec.isAuthExpired(sdk({ type: "result", subtype: "error_during_execution", result: "401 Unauthorized" })), "401도 인증 만료");
check(!claudeCodec.isAuthExpired(sdk({ type: "result", subtype: "success", result: "401 이야기를 했다" })), "성공한 턴은 본문에 같은 낱말이 있어도 만료가 아니다");
check(!claudeCodec.isAuthExpired(sdk({ type: "result", is_error: true, errors: ["rate limit"] })), "다른 이유로 실패한 턴은 만료가 아니다");
check(!claudeCodec.isAuthExpired(sdk({ type: "assistant" })), "턴 결과가 아닌 이벤트는 만료 판정 대상이 아니다");
check(!claudeCodec.isAuthExpired({} as unknown as AnyEvent), "손상된 줄에도 안전");

// ── normalize 위임 ──
const sample = sdk({ type: "assistant", message: { content: [{ type: "text", text: "안녕" }] } });
check(
  JSON.stringify(claudeCodec.normalize(sample)) === JSON.stringify(normalizeClaude(sample)),
  "codec.normalize는 중앙 normalize와 동일 결과(D2.4 단독 책임 유지)",
);
check(claudeCodec.provider === "claude", "codec이 자기 provider를 밝힌다");

const { grokCodec } = await import("../sessions/codec/grok");
const grok = (msg: unknown) => ({ seq: 1, ts: 1, kind: "grok", msg });
check(grokCodec.endsTurn(grok({ method: "session/prompt_result", params: { stopReason: "end_turn" } })), "Grok prompt_result → 턴 종료");
check(!grokCodec.endsTurn(grok({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } })), "Grok 청크 → 턴 종료 아님");
check(grokCodec.isLiveOnly(grok({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } })), "Grok 청크 → 라이브 전용");
check(grokCodec.isAuthExpired(grok({ method: "error", params: { message: "OAuth token has expired" } })), "Grok 만료 문구 → 인증 만료");
check(!grokCodec.isAuthExpired(grok({ method: "session/prompt_result", params: { stopReason: "end_turn" } })), "Grok 정상 종료는 만료가 아니다");
check(grokCodec.provider === "grok", "Grok codec이 자기 provider를 밝힌다");

// ── Codex 한도 오류 → rate_limit/blocked(Ollama도 같은 실행기·codec을 쓴다) ──
{
  const { codexCodec } = await import("../sessions/codec/codex");
  const err = (codexErrorInfo: unknown, willRetry = false) =>
    ({ seq: 1, ts: 1, kind: "codex", msg: { method: "error", params: { error: { message: "limit", codexErrorInfo, additionalDetails: null }, willRetry, threadId: "t", turnId: "u" } } }) as unknown as AnyEvent;
  const first = (ev: AnyEvent) => codexCodec.normalize(ev)[0] as { type?: string; kind?: string; severity?: string } | undefined;
  for (const [label, info] of [["usageLimitExceeded", "usageLimitExceeded"], ["429 객체", { responseTooManyFailedAttempts: { httpStatusCode: 429 } }]] as const) {
    const n = first(err(info));
    check(n?.type === "provider_notice" && n.kind === "rate_limit" && n.severity === "blocked", `Codex ${label} → rate_limit/blocked`, JSON.stringify(n));
  }
  check(first(err("usageLimitExceeded", true))?.kind === "retry", "재시도 중인 한도 오류는 retry 경고로 남는다");
  check(first(err(null))?.kind === "error", "그 밖의 오류는 error 그대로");
}

// ── ② 영속 축소기의 이벤트 간 상태(시크릿 추적) ──
const filter = claudeCodec.persistFilter();
const readsSecret = sdk({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "toolu_secret", name: "Read", input: { file_path: "/tmp/proj/.env" } }] },
});
const secretResult = sdk({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_secret", content: "OPENAI_API_KEY=sk-verysecretvalue" }] },
});
filter.apply(readsSecret); // 여기서 toolu_secret이 '시크릿 읽음'으로 기록돼야 한다
const redacted = filter.apply(secretResult) as { msg: { message: { content: { content: string }[] } } } | null;
check(!!redacted, "영속 축소기가 이벤트를 버리지 않는다(Claude는 null 반환 없음)");
check(
  !!redacted && !JSON.stringify(redacted).includes("sk-verysecretvalue"),
  "앞 이벤트에서 본 시크릿 도구의 결과가 디스크 영속본에서 가려진다(이벤트 간 상태 필수)",
);

// 재시작 뒤에도 앞선 tool_use 판단을 되살려야 한다. 안 그러면 Read 직후 재시작한 뒤 도착한 tool_result가
// 새 축소기에 의해 평문으로 저장된다.
const restored = claudeCodec.persistFilter();
restored.restore(readsSecret);
const redactedAfterRestart = restored.apply(secretResult);
check(
  !!redactedAfterRestart && !JSON.stringify(redactedAfterRestart).includes("sk-verysecretvalue"),
  "재시작 상태 복원 뒤에도 시크릿 tool_result가 가려진다",
);

// ── ③ 세션 간 상태 격리 ──
const otherSession = claudeCodec.persistFilter();
const leaked = otherSession.apply(secretResult);
check(
  !!leaked && JSON.stringify(leaked).includes("sk-verysecretvalue"),
  "다른 세션의 축소기는 그 판정을 물려받지 않는다(축소기는 세션당 1개)",
);

// ── ④ 등록된 네 codec이 같은 할 일 사건을 같은 내용으로 바꾼다(공통 기능은 provider와 무관하게 동일) ──
{
  const { providerEntry } = await import("../providers/registry");
  const todo = { seq: 7, ts: 70, kind: "todo_list", items: [{ text: "읽기", status: "completed" }, { text: "고치기", status: "in_progress" }] } as unknown as AnyEvent;
  const strip = (evs: { provider: string }[]) => evs.map(({ provider: _p, ...rest }) => rest);
  const results = ["claude", "codex", "grok", "ollama"].map((id) => ({ id, out: providerEntry(id).codec.normalize(todo) }));
  const base = JSON.stringify(strip(results[0].out));
  check(results.every((r) => r.out.length === 1 && r.out[0].type === "plan_update"), "네 provider 모두 todo_list → plan_update 1건");
  check(results.every((r) => JSON.stringify(strip(r.out)) === base), "네 결과가 provider 이름만 다르고 내용(type·items·seq·part)이 같다");
  check(results.every((r) => r.out[0].provider === r.id), "provider 이름은 각자 자기 것으로 찍힌다");
  check(providerEntry("claude").codec.normalize(sdk({ type: "result" })).every((e) => e.type !== "plan_update"), "감싸도 원래 사건 변환은 그대로 위임된다");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} event_codec: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
