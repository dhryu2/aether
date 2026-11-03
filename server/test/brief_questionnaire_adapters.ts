/**
 * 질문 거절 응답 어댑터 시험 — 모델 호출 0, 실제 claude·codex·grok CLI 호출 0.
 *
 * 공통 세션이 질문에 `{ answered: false, reason }`을 돌려줄 때 각 provider 어댑터가 모델에게 무엇을 돌려주는지
 * 현재 동작 그대로 고정한다. 어댑터 코드는 건드리지 않는다.
 *   ① Claude — AskUserQuestion을 거부(deny) 메시지로 돌려주고, 그 메시지는 reason 문장 그대로다.
 *   ② Codex 브릿지 도구 ask_user — 도구 결과 텍스트로 reason 문장을 그대로 돌려준다.
 *   ③ Codex 기본 질문 요청 item/tool/requestUserInput — 빈 답 `{ answers: {} }`을 돌려준다(reason은 실리지 않는다).
 *   ④ Grok은 기존 시험이 덮는다 — test/grok_ask_question.ts:41-43 (`skip_interview`), test/grok_runtime.ts ⑦b.
 *
 * 실행: server 폴더에서 `npx tsx test/brief_questionnaire_adapters.ts`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-briefq-data-"));
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

const { ClaudeRuntime } = await import("../sessions/runtimes/claude");
const { CodexRuntime } = await import("../sessions/runtimes/codex");
const { codexThreadConfig } = await import("../providers/codex/knowledgeThreadConfig");
type RuntimeStartOptions = import("../providers/types").RuntimeStartOptions;
type RawProviderEventBody = import("../types").RawProviderEventBody;
type OnQuestion = RuntimeStartOptions["onQuestion"];

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e?: unknown) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c || e === undefined ? "" : " — " + JSON.stringify(e)}`);
  c ? pass++ : fail++;
};

/** 공통 세션이 질문을 못 받았을 때 돌려주는 안내 문장. 어댑터가 이 문장을 그대로 실어 보내는지 본다. */
const REASON_CLAUDE = "사용자가 질문에 답하지 않았다. 추측하지 말고 다른 방법을 찾아라.";
const REASON_CODEX_TOOL = "사용자가 응답 시간 안에 답하지 않았다. 이 질문은 다시 묻지 마라.";
const REASON_CODEX_REQUEST = "세션이 종료되어 질문을 취소했다.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ── ① Claude: AskUserQuestion 거절은 deny 메시지로 reason 문장 그대로 간다 ──
async function claudeDenyCarriesReason() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-briefq-claude-"));
  const rt = new ClaudeRuntime({
    sessionId: "brief-q-claude",
    cwd,
    model: "haiku",
    permissionMode: "manual",
    onPermission: async () => ({ allow: false, message: "테스트" }),
    onQuestion: async () => ({ answered: false, reason: REASON_CLAUDE }),
    onResumeKey: () => {},
  }) as any;
  // requestPermission은 private이라 기존 시험(phase5_lifecycle, bx_verify_askquestion)과 같은 방식으로 직접 부른다.
  const g = await rt.requestPermission(
    "AskUserQuestion",
    { questions: [{ question: "색?", options: [] }] },
    { signal: new AbortController().signal, toolUseID: "q-claude-1" },
  );
  check(g.behavior === "deny", "① Claude 질문 거절은 deny로 돌아간다", g);
  check(g.message === REASON_CLAUDE, "① deny 메시지가 reason 문장과 글자 하나 다르지 않다", g.message);
  void rt.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ── Codex 공통: 가짜 app-server를 진짜 codex인 척 띄운 런타임을 만든다 ──
function startCodex(onQuestion: OnQuestion) {
  const events: RawProviderEventBody[] = [];
  const rt = new CodexRuntime({
    sessionId: `brief-q-codex-${Math.random().toString(36).slice(2, 8)}`,
    cwd: process.env.AETHER_DATA_DIR!,
    permissionMode: "manual",
    onPermission: async () => ({ allow: false, message: "테스트" }),
    onQuestion,
    onResumeKey: () => {},
  });
  // 이벤트 스트림은 한 곳만 순회한다(런타임 계약).
  void (async () => {
    try {
      for await (const ev of rt.events()) events.push(ev);
    } catch {
      /* 시험 종료 시 스트림이 끊기는 것은 정상이다 */
    }
  })();
  const turnsDone = () => events.filter((e) => (e.msg as { method?: string }).method === "turn/completed").length;
  const calls = async () => {
    const server = (rt as unknown as { server: { request: (m: string) => Promise<unknown> } }).server;
    return ((await server.request("test/calls")) as { calls: { method: string; params: Record<string, unknown> }[] }).calls;
  };
  return { rt, turnsDone, calls };
}

// ── ② Codex 브릿지 도구 ask_user: 거절이면 도구 결과 텍스트가 reason 문장이다 ──
async function codexAskUserToolCarriesReason() {
  let asked = 0;
  const h = startCodex(async () => {
    asked++;
    return { answered: false, reason: REASON_CODEX_TOOL };
  });
  // 브릿지는 준비 단계(boot)에서 열린다. 열린 창구의 주소와 인증 헤더를 스레드 설정에서 꺼낸다.
  await h.rt.handshake();
  const bridge = (h.rt as unknown as { bridge: { httpAttach: { url: string; authorization: string } } | null }).bridge;
  if (!bridge) throw new Error("Codex 지식툴 창구가 열리지 않았다");
  const server = (codexThreadConfig(bridge.httpAttach).mcp_servers as Record<string, any>).aether;
  const url = String(server.url);
  const token = String(server.http_headers?.Authorization ?? "").replace(/^Bearer /, "");

  // ask_user 도구는 턴이 진행 중일 때만 카드를 띄운다(없으면 다른 안내 문장을 돌려준다).
  // 실제 턴을 만들지 않고, 같은 조건을 맞추려고 진행 중 턴 표식만 세운다. 시험이 끝나면 되돌린다.
  (h.rt as unknown as { activeTurnId: string | null }).activeTurnId = "brief-q-fake-turn";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "어디에 배포할까?", header: "배포", options: "운영\n테스트" } },
    }),
  });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  const json = line ? JSON.parse(line.slice(6)) : null;
  (h.rt as unknown as { activeTurnId: string | null }).activeTurnId = null;

  check(asked === 1, "② 도구 호출이 공통 질문 요청까지 도달한다", asked);
  check(json?.result?.content?.[0]?.text === REASON_CODEX_TOOL, "② ask_user 결과 텍스트가 reason 문장 그대로다", json?.result);
  await h.rt.dispose();
}

// ── ③ Codex 기본 질문 요청 item/tool/requestUserInput: 거절이면 빈 답 { answers: {} } ──
async function codexRequestUserInputReturnsEmptyAnswers() {
  let asked = 0;
  const h = startCodex(async () => {
    asked++;
    return { answered: false, reason: REASON_CODEX_REQUEST };
  });
  h.rt.push({ text: "@@question@@ 배포해줘" });
  await until(() => h.turnsDone() === 1);
  check(asked === 1, "③ 질문 요청이 공통 질문 처리까지 온다", asked);
  const answered = (await h.calls()).find((c) => c.method === "questionAnswer");
  check(answered !== undefined, "③ 질문 요청에 응답이 나간다", answered);
  check(
    JSON.stringify(answered?.params) === JSON.stringify({ answers: {} }),
    "③ 거절 응답은 정확히 { answers: {} }이다(reason은 실리지 않는다)",
    answered?.params,
  );
  await h.rt.dispose();
}

async function main() {
  await claudeDenyCarriesReason();
  await codexAskUserToolCarriesReason();
  await codexRequestUserInputReturnsEmptyAnswers();

  console.log("────────────────────────────────────────────────────────");
  console.log(`${fail === 0 ? "✅" : "❌"} brief_questionnaire_adapters: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("❌ brief_questionnaire_adapters 실행 중 오류:", e);
  process.exit(1);
});
