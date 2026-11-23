/**
 * GrokRuntime 계약 검증 (Phase 10c) — 모델 호출 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokrt-"));
process.env.AETHER_GROK_SHUTDOWN_GRACE_MS = "500";
process.env.AETHER_GROK_DISTILL_MODEL = "grok-4.5";
const GROK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokrt-home-"));
fs.writeFileSync(path.join(GROK_HOME, "auth.json"), JSON.stringify({ email: "fake-grok@example.invalid" }), { mode: 0o600 });
process.env.GROK_HOME = GROK_HOME;

const { makeFakeGrokBin, FAKE_GROK_SESSION_ID, FAKE_GROK_CLEARED_SESSION_ID } = await import("./support/fakeGrokStdio");
const fake = makeFakeGrokBin();
process.env.AETHER_GROK_BIN = fake.bin;

const { GrokRuntime } = await import("../sessions/runtimes/grok");
const { grokServices } = await import("../providers/grok/services");
const { grokCodec } = await import("../sessions/codec/grok");
const { normalizeGrok, grokToolKind } = await import("../sessions/normalize/grok");
type GrokRuntimeT = InstanceType<typeof GrokRuntime>;
type RuntimeStartOptions = import("../providers/types").RuntimeStartOptions;
type RawProviderEventBody = import("../types").RawProviderEventBody;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

type Harness = {
  rt: GrokRuntimeT;
  events: RawProviderEventBody[];
  streamError: Error | null;
  resumeKeys: string[];
  asks: import("../providers/types").PermissionAsk[];
  questions: import("../providers/types").QuestionAsk[];
  plans: import("../providers/types").PlanAsk[];
  planOut: import("../providers/types").PlanOutcome;
  perm: "allow" | "deny";
  holdQuestion: boolean;
  holdPlan: boolean;
  calls(): Promise<{ method: string; params: Record<string, unknown>; _rpcError?: boolean }[]>;
  methodsOf(events: RawProviderEventBody[]): string[];
};
const open = new Set<GrokRuntimeT>();
let seq = 0;

function start(over: Partial<RuntimeStartOptions> = {}): Harness {
  const events: RawProviderEventBody[] = [];
  const resumeKeys: string[] = [];
  const asks: import("../providers/types").PermissionAsk[] = [];
  const questions: import("../providers/types").QuestionAsk[] = [];
  const plans: import("../providers/types").PlanAsk[] = [];
  const h = { events, resumeKeys, asks, questions, plans, perm: "allow" as const, planOut: { decision: "approve" } as const, holdQuestion: false, holdPlan: false, streamError: null as Error | null } as Harness;
  const rt = new GrokRuntime({
    sessionId: `sess-${++seq}`,
    cwd: process.env.AETHER_DATA_DIR!,
    permissionMode: "manual",
    onPermission: async (ask) => {
      asks.push(ask);
      return h.perm === "allow" ? { allow: true } : { allow: false, message: "거부" };
    },
    onQuestion: async (ask) => {
      questions.push(ask);
      if (h.holdQuestion) {
        if (ask.signal.aborted) return { answered: false, reason: "aborted" };
        await new Promise<void>((resolve) => {
          ask.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { answered: false, reason: "aborted" };
      }
      return { answered: true, answers: [{ chosen: [ask.questions[0]?.options[0]?.label ?? "운영"] }] };
    },
    onPlan: async (ask) => {
      plans.push(ask);
      if (h.holdPlan) {
        if (ask.signal.aborted) return { decision: "cancel" as const };
        await new Promise<void>((resolve) => {
          ask.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { decision: "cancel" as const };
      }
      return h.planOut;
    },
    onResumeKey: (k) => resumeKeys.push(k),
    ...over,
  });
  open.add(rt);
  h.rt = rt;
  void (async () => {
    try {
      for await (const ev of rt.events()) events.push(ev);
    } catch (e) {
      h.streamError = e as Error;
    }
  })();
  h.calls = async () => {
    const stdio = (rt as unknown as { stdio: { request: (m: string) => Promise<unknown> } }).stdio;
    const res = (await stdio.request("test/calls")) as { calls: { method: string; params: Record<string, unknown>; _rpcError?: boolean }[] };
    return res.calls;
  };
  h.methodsOf = (evs) => evs.map((e) => (e.msg as { method?: string })?.method ?? "");
  return h;
}

const turnsDone = (h: Harness) => h.methodsOf(h.events).filter((m) => m === "session/prompt_result").length;

async function main() {
  {
    const h = start({ model: "grok-4.6" });
    const hs = await h.rt.handshake();
    check(hs.models.find((m) => m.value === "grok-4.6")?.defaultEffort === "high", "① 모델의 기본 강도가 실린다", hs.models);
    check(hs.models.some((m) => m.value === "grok-4.6" && m.isDefault), "① 모델 목록에 기본 grok-4.6이 있다", hs.models);
    check((await h.rt.handshake()) === hs, "① 여러 번 불러도 같은 결과 객체(공통 계층이 같은 관측을 다시 기억하지 않는다)");
    check(h.resumeKeys[0] === FAKE_GROK_SESSION_ID, "① 이어가기 식별자를 가장 이른 시점에 알린다", h.resumeKeys);
    const calls = await h.calls();
    check(calls.some((c) => c.method === "initialize"), "① initialize를 보낸다");
    check(calls.some((c) => c.method === "session/new"), "① session/new를 보낸다");
    check(!calls.some((c) => c.method === "session/load"), "① session/load는 쓰지 않는다");
    const argv = (await (h.rt as unknown as { stdio: { request: (m: string) => Promise<{ argv: string[] }> } }).stdio.request("test/argv")).argv;
    check(argv.includes("--permission-mode") && argv.includes("default"), "① spawn에 --permission-mode default가 있다", argv);
    check(argv.includes("--no-leader") && argv.includes("stdio"), "① spawn이 agent --no-leader stdio다", argv);
    check(h.rt.capabilities.planReview === true, "① 계획 검토 능력이 켜져 있다");
    check(!("workspaceIsolation" in h.rt.capabilities), "① 복사본은 실행기 능력이 아니다");
    await h.rt.dispose();
  }

  // ①c 수동·편집·자동은 --permission-mode와 샌드박스를 못 박고, 자동만 _meta.autoMode를 싣는다. 새 세션(미지정)은 자동이다.
  for (const [mode, cli, auto] of [["manual", "default", false], ["edits", "acceptEdits", false], ["auto", "auto", true], [undefined, "auto", true]] as const) {
    const h = start({ permissionMode: mode });
    await h.rt.handshake();
    const argv = (await (h.rt as unknown as { stdio: { request: (m: string) => Promise<{ argv: string[] }> } }).stdio.request("test/argv")).argv;
    const at = argv.indexOf("--permission-mode");
    check(at >= 0 && argv[at + 1] === cli && argv.includes("--sandbox") && !argv.includes("--always-approve"), `①c ${mode ?? "미지정"}: --permission-mode ${cli}`, argv);
    const created = (await h.calls()).find((c) => c.method === "session/new");
    const meta = created?.params._meta as { autoMode?: boolean; yoloMode?: boolean } | undefined;
    check((meta?.autoMode === true) === auto && meta?.yoloMode !== true, `①c ${mode ?? "미지정"}: autoMode=${auto}`, created?.params);
    const modes = await h.rt.permissionModes();
    check(modes.modes.join() === "manual,edits,auto,full" && modes.current === (mode ?? "auto"), `①c ${mode ?? "미지정"}: 목록은 네 모드, 현재 모드`, modes);
    await h.rt.dispose();
  }

  {
    const h = start({ permissionMode: "full" });
    await h.rt.handshake();
    const argv = (await (h.rt as unknown as { stdio: { request: (m: string) => Promise<{ argv: string[] }> } }).stdio.request("test/argv")).argv;
    check(argv.includes("--always-approve"), "①b full이면 --always-approve", argv);
    check(!argv.includes("--permission-mode"), "①b full이면 --permission-mode를 안 붙인다", argv);
    const calls = await h.calls();
    const created = calls.find((c) => c.method === "session/new");
    check((created?.params._meta as { yoloMode?: boolean } | undefined)?.yoloMode === true, "①b yoloMode를 session/new에 실는다", created?.params);
    check((await h.rt.setPermissionMode("manual")).deferred === false, "①b 모드 변경은 프로세스를 다시 띄워 즉시 적용하므로 deferred가 아니다");
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "안녕" });
    check(await until(() => turnsDone(h) === 1), "② 턴이 끝까지 흐른다");
    const methods = h.methodsOf(h.events);
    check(methods.includes("session/prompt_started"), "② 턴 시작 사건이 온다", methods);
    check(methods.includes("session/update"), "② 스트림 갱신이 온다", methods);
    check(methods.includes("session/prompt_result"), "② 턴 종료 사건이 온다", methods);
    const usage = await h.rt.contextUsage();
    check(usage.totalTokens === 1200 && usage.maxTokens === 500000, "② 문맥 점유량은 session/update _meta.totalTokens에서 온다", usage);
    const reported = await h.rt.usage();
    check(reported.windowsAvailable === true && reported.windows.length === 1, "② 구독 한도 창을 싣는다", reported);
    check(reported.windows[0]?.key !== "five_hour", "② 가짜 5시간 창을 만들지 않는다", reported);
    check(reported.context?.used === 1200 && reported.context?.size === 500000, "② 사용량 응답에 문맥 점유량을 싣는다", reported);
    const usages = h.events.flatMap((e) => normalizeGrok(e as never)).filter((a) => a.type === "usage_update");
    check(usages.some((a) => a.type === "usage_update" && a.totalTokens === 1200 && a.maxTokens === 500000), "② 정규화 사건에 문맥 점유량이 있다", usages);
    const text = h.events.flatMap((e) => normalizeGrok(e as never)).filter((a) => a.type === "text");
    check(text.some((a) => a.type === "text" && a.text.includes("안녕")), "② 최종 본문이 정규화된다", text);
    check(grokCodec.endsTurn({ kind: "grok", msg: { method: "session/prompt_result", params: { stopReason: "end_turn" } } }), "② codec이 prompt_result를 턴 종료로 본다");
    check(grokCodec.isLiveOnly({ kind: "grok", msg: { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } } }), "② 청크는 라이브 전용이다");
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@slow@@ 첫 번째" });
    await until(() => h.methodsOf(h.events).includes("session/prompt_started"));
    h.rt.push({ text: "두 번째" });
    await sleep(80);
    const mid = (await h.calls()).filter((c) => c.method === "session/prompt");
    check(mid.length === 1, "③ 진행 중에는 다음 prompt를 보내지 않는다", mid.length);
    check(await until(() => turnsDone(h) === 2, 8000), "③ 앞 턴이 끝나면 다음 턴이 이어진다", turnsDone(h));
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@slow@@ 세어라" });
    await until(() => h.methodsOf(h.events).includes("session/prompt_started"));
    await h.rt.interrupt();
    check(await until(() => turnsDone(h) === 1, 8000), "④ 중단 후 턴이 끝난다");
    const last = h.events.filter((e) => (e.msg as { method?: string }).method === "session/prompt_result").pop();
    check((last?.msg as { params?: { stopReason?: string } })?.params?.stopReason === "cancelled", "④ stopReason이 cancelled다", last);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@ask@@ 써라" });
    check(await until(() => h.asks.length === 1, 8000), "⑤ 승인 카드가 온다");
    check(h.asks[0]?.toolKind === "file_change", "⑤ 편집 승인 요청은 file_change를 싣는다", h.asks[0]?.toolKind);
    check(typeof h.asks[0]?.input?.file_path === "string" || typeof h.asks[0]?.input?.path === "string", "⑤ 카드에 경로가 실린다", h.asks[0]?.input);
    check(await until(() => turnsDone(h) === 1), "⑤ 승인 뒤 턴이 끝난다");
    const permCalls = (await h.calls()).filter((c) => c.method === "permissionAnswer");
    check(
      JSON.stringify(permCalls[0]?.params ?? {}).includes("allow-once"),
      "⑤ allow_once만 고른다(세션 전체 허용은 안 고른다)",
      permCalls,
    );
    await h.rt.dispose();
  }

  check(grokToolKind({ kind: "execute", title: "Run" }) === "bash", "⑤ 명령 실행 승인 요청은 bash로 가른다");
  check(grokToolKind({ kind: "edit", title: "Write" }) === "file_change", "⑤ content가 없는 편집 승인 요청도 file_change로 가른다");

  {
    const h = start();
    h.rt.push({ text: "@@ask-secret@@ 써라" });
    check(await until(() => h.asks.length === 1, 8000), "⑤c 비밀 경로 승인 카드가 온다");
    const input = h.asks[0]?.input as Record<string, unknown> | undefined;
    check(JSON.stringify(input ?? {}).includes("example-outside/.env"), "⑤c 경로는 카드에 실린다", input);
    check(!JSON.stringify(h.asks[0] ?? {}).includes("DUMMY-SECRET"), "⑤c 비밀 내용은 카드 입력에 없다", h.asks[0]);
    await until(() => turnsDone(h) === 1);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@ask-session@@ 써라" });
    check(await until(() => h.asks.length === 1 && turnsDone(h) === 1), "⑤b 세션 허용만 있어도 턴이 끝난다");
    const permCalls = (await h.calls()).filter((c) => c.method === "permissionAnswer");
    check(
      JSON.stringify(permCalls[0]?.params ?? {}).includes("allow-edits-session"),
      "⑤b 한 번 허용이 없으면 세션 허용을 고른다",
      permCalls,
    );
    await h.rt.dispose();
  }

  {
    const h = start();
    h.perm = "deny";
    h.rt.push({ text: "@@ask@@ 쓰지 마" });
    check(await until(() => h.asks.length === 1 && turnsDone(h) === 1, 8000), "⑥ 거부해도 턴은 끝난다");
    const permCalls = (await h.calls()).filter((c) => c.method === "permissionAnswer");
    check(JSON.stringify(permCalls[0]?.params ?? {}).includes("reject-once"), "⑥ reject_once를 고른다", permCalls);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@question@@ 물어봐" });
    check(await until(() => h.questions.length === 1 && turnsDone(h) === 1, 8000), "⑦ 질문 카드가 공통 질문으로 온다");
    check(h.questions[0]?.questions[0]?.question.includes("배포"), "⑦ 질문 본문이 실린다", h.questions[0]);
    const qCalls = (await h.calls()).filter((c) => c.method === "questionAnswer");
    check(!qCalls.some((c) => c._rpcError), "⑦ 질문 응답은 JSON-RPC 오류가 아니다", qCalls);
    check(qCalls[0]?.params.outcome === "accepted", "⑦ 질문 응답에 outcome accepted가 있다", qCalls[0]?.params);
    const qAnswers = qCalls[0]?.params.answers;
    check(!!qAnswers && !Array.isArray(qAnswers) && typeof qAnswers === "object", "⑦ answers는 배열이 아니라 맵이다", qAnswers);
    check(JSON.stringify((qAnswers as Record<string, string[]>)["어디에 배포할까요?"]) === JSON.stringify(["운영"]), "⑦ 질문 본문이 열쇠다", qAnswers);
    const askChips = h.events.flatMap((e) => normalizeGrok(e as never)).filter((a) => a.type === "tool_call" || a.type === "tool_result");
    check(
      !askChips.some((a) => ("name" in a && /ask_user_question/i.test(String(a.name))) || ("output" in a && /AskUserQuestion/i.test(String(a.output)))),
      "⑦ 질문 도구는 명령 줄로 안 나온다",
      askChips,
    );
    check(h.questions[0]?.lead === "받음:", "⑦ 질문 앞에 쌓인 설명을 카드에 실는다", h.questions[0]?.lead);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@nolead@@ 물어봐" });
    check(await until(() => turnsDone(h) === 1, 8000), "⑦d 설명 없는 질문도 턴은 끝난다");
    check(h.questions.length === 0, "⑦d 설명 없으면 질문 카드를 열지 않는다", h.questions);
    const qCalls = (await h.calls()).filter((c) => c.method === "questionAnswer");
    check(qCalls[0]?._rpcError === true, "⑦d 모델에게는 JSON-RPC 오류를 돌린다", qCalls[0]);
    check(
      String(qCalls[0]?.params.message ?? "").includes("설명 없는 질문 카드는 열지 않는다"),
      "⑦d 오류에 설명을 먼저 쓰라는 문장이 있다",
      qCalls[0]?.params,
    );
    await h.rt.dispose();
  }

  {
    const h = start();
    h.holdQuestion = true;
    h.rt.push({ text: "@@question-timeout@@ 물어봐" });
    check(await until(() => h.questions.length === 1 && turnsDone(h) === 1, 8000), "⑦b Grok이 질문을 포기하면 턴이 끝난다");
    check(h.questions[0]?.signal.aborted === true, "⑦b 화면 카드 대기가 취소된다");
    const qCalls = (await h.calls()).filter((c) => c.method === "questionAnswer");
    check(qCalls[0]?.params.outcome === "skip_interview", "⑦b 포기에 skip_interview를 돌려준다", qCalls[0]?.params);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.holdQuestion = true;
    h.rt.push({ text: "@@question@@ 물어봐" });
    check(await until(() => h.questions.length === 1, 8000), "⑦c 질문 대기 중에 중지할 수 있다");
    await h.rt.interrupt();
    check(await until(() => h.questions[0]?.signal.aborted === true && turnsDone(h) === 1, 8000), "⑦c 중지가 질문 카드 대기를 끊고 턴을 끝낸다");
    await h.rt.dispose();
  }

  {
    const h = start({ resumeKey: FAKE_GROK_SESSION_ID });
    await h.rt.handshake();
    const calls = await h.calls();
    check(calls.some((c) => c.method === "session/resume"), "⑧ 재개는 session/resume이다", calls.map((c) => c.method));
    check(!calls.some((c) => c.method === "session/load"), "⑧ session/load는 쓰지 않는다");
    await h.rt.dispose();
  }

  {
    const h = start();
    await h.rt.handshake();
    const cmds = await h.rt.listCommands();
    const names = cmds.map((c) => c.name);
    check(names.includes("compact"), "⑨ handshake가 준 compact를 올린다", names);
    check(names.includes("clear") && cmds.find((c) => c.name === "clear")?.uiAction === undefined, "⑨ handshake에 없어도 내장 clear를 올린다", names);
    check(!cmds.some((c) => c.name === "memory"), "⑨ /memory는 Grok 자체 기억 도구라 광고하지 않는다", cmds);
    check(!names.includes("dashboard") && !names.includes("rewind") && !names.includes("fork") && !names.includes("remember"), "⑨ 터미널 전용·미구현·Grok 기억 도구는 광고하지 않는다", names);
    check(names.length > 1, "⑨ compact만 하드코딩한 목록이 아니다", names);
    const unknown = await h.rt.executeCommand({ name: "does-not-exist", arguments: "" });
    check(!unknown.accepted, "⑨ 모르는 명령은 거절한다", unknown);
    check(!(await h.calls()).some((c) => c.method === "session/prompt"), "⑨ 모르는 명령을 일반 대화로 보내지 않는다");
    const memory = await h.rt.executeCommand({ name: "memory", arguments: "" });
    check(!memory.accepted, "⑨ /memory는 Grok 자체 기억 도구라 실행기가 거절한다", memory);
    check(!(await h.calls()).some((c) => c.method === "session/prompt"), "⑨ /memory를 Grok 기억 폴더로 보내지 않는다");
    const compact = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(compact.accepted && compact.startsTurn, "⑨ compact는 실행기 쪽으로 간다", compact);
    check(await until(() => turnsDone(h) === 1), "⑨ compact 턴이 흐른다");
    const clear = await h.rt.executeCommand({ name: "clear", arguments: "" });
    check(clear.accepted && !clear.startsTurn, "⑨ clear는 실행기 턴을 시작하지 않는다", clear);
    const afterClear = await h.calls();
    const news = afterClear.filter((c) => c.method === "session/new");
    check(news.length === 2, "⑨ clear는 session/new로 CLI 문맥을 새로 연다", news.map((c) => c.method));
    const clearPrompt = afterClear.some((c) => {
      if (c.method !== "session/prompt") return false;
      const prompt = c.params.prompt;
      if (!Array.isArray(prompt)) return false;
      return prompt.some((block) => block && typeof block === "object" && "text" in block && String((block as { text?: unknown }).text ?? "").includes("/clear"));
    });
    check(!clearPrompt, "⑨ clear를 일반 대화로 보내지 않는다");
    check(h.resumeKeys.at(-1) === FAKE_GROK_CLEARED_SESSION_ID, "⑨ 새 이어가기 식별자를 알린다", h.resumeKeys);
    await h.rt.dispose();
  }

  {
    const h = start();
    await h.rt.handshake();
    const stdio = (h.rt as unknown as {
      stdio: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
    }).stdio;
    const same = [{ name: "compact", description: "Compact conversation history" }];
    await stdio.request("test/emit_commands", { availableCommands: same, repeat: 5 });
    await until(() => h.events.some((e) => normalizeGrok(e as never).some((a) => a.type === "commands_available")));
    const commandUpdates = () => h.events.filter((e) => normalizeGrok(e as never).some((a) => a.type === "commands_available"));
    check(commandUpdates().length === 1, "⑨b 동일 available_commands_update 5회는 사건 1건만 전달", commandUpdates().length);

    await stdio.request("test/emit_commands", { availableCommands: [...same, { name: "verify" }], repeat: 3 });
    await until(() => commandUpdates().length === 2);
    check(commandUpdates().length === 2, "⑨b 실제 명령 목록 변경은 새 사건 1건을 전달", commandUpdates().length);
    const names = (await h.rt.listCommands()).map((c) => c.name);
    check(names.includes("verify"), "⑨b 중복 억제 뒤에도 최신 command 상태를 사용", names);

    await stdio.request("test/emit_commands", { availableCommands: [], repeat: 3 });
    await until(() => commandUpdates().length === 3);
    check(commandUpdates().length === 3, "⑨b 빈 목록도 실제 상태 변경으로 한 번만 전달", commandUpdates().length);
    const clearedNames = (await h.rt.listCommands()).map((c) => c.name);
    check(!clearedNames.includes("verify"), "⑨b 빈 목록이면 철회된 provider 명령을 최신 상태에서 제거", clearedNames);
    await h.rt.dispose();
  }

  {
    const h = start();
    await h.rt.handshake();
    let threw = false;
    try {
      await h.rt.setModel("not-a-model");
    } catch {
      threw = true;
    }
    check(threw, "⑩ 카탈로그에 없는 모델은 거부한다");
    await h.rt.setModel("grok-4.6");
    check(!(await h.calls()).some((c) => c.method === "session/resume"), "⑩ 같은 모델은 프로세스를 다시 안 띄운다");
    await h.rt.setModel("grok-4.5");
    check(true, "⑩ 카탈로그에 있는 모델은 받는다");
    const argv = (await (h.rt as unknown as { stdio: { request: (m: string) => Promise<{ argv: string[] }> } }).stdio.request("test/argv")).argv;
    check(argv.includes("-m") && argv.includes("grok-4.5"), "⑩ 모델 변경은 spawn -m 을 바꾼다", argv);
    check((await h.calls()).some((c) => c.method === "session/resume"), "⑩ 모델 변경은 session/resume 으로 이어간다");
    const usage = await h.rt.usage();
    const billed = (await h.calls()).some((c) => c.method === "_x.ai/billing");
    check(billed, "⑩ 사용량은 과금 조회를 부른다");
    check(usage.windowsAvailable === true && usage.windows.length === 1, "⑩ 구독 한도 창을 싣는다", usage);
    check(usage.windows[0]?.key !== "five_hour" && usage.subscriptionType === "SuperGrok", "⑩ 가짜 5시간 창을 만들지 않는다", usage);
    const distilled = await grokServices.distill("x", process.env.AETHER_DATA_DIR!);
    check(distilled === "받음: x", "⑩ 배경 작업이 Grok 경로로 돈다", distilled);
    check(!!grokServices.auth, "⑩ 원격 로그인이 붙어 있다");
    check(grokServices.auth?.submitCode === undefined, "⑩ 기기코드라 코드 제출 함수가 없다");
    await h.rt.dispose();
  }

  {
    const h = start();
    await h.rt.handshake();
    const calls = await h.calls();
    const created = calls.find((c) => c.method === "session/new");
    const servers = (created?.params.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
    check(servers[0]?.type === "http" && servers[0]?.name === "aether", "⑪ 지식 창구를 session/new에 HTTP로 붙인다", servers);
    const headers = Array.isArray(servers[0]?.headers) ? (servers[0].headers as Array<{ name?: string; value?: string }>) : [];
    const auth = headers.find((hdr) => hdr.name === "Authorization")?.value ?? "";
    check(/^Bearer \S+/.test(auth), "⑪ 자격증명은 Authorization 헤더뿐이다", auth);
    const token = auth.replace(/^Bearer /, "");
    const spawn = calls.find((c) => c.method === "__spawn");
    const argv = JSON.stringify((spawn?.params as { argv?: string[] })?.argv ?? []);
    check(!argv.includes(token), "⑪ 실행 인자에 토큰이 없다");
    check((spawn?.params as { envHasMcpToken?: boolean })?.envHasMcpToken !== true, "⑪ 환경에 AETHER_MCP_TOKEN이 없다", spawn?.params);
    check((spawn?.params as { envValuesContainBearer?: boolean })?.envValuesContainBearer !== true, "⑪ 환경값에 Bearer 토큰이 없다", spawn?.params);
    check((spawn?.params as { askTimeoutEnabled?: string | null })?.askTimeoutEnabled === "false", "⑪ 질문 카드 자체 시간 제한을 끈다", spawn?.params);
    const url = String(servers[0]?.url ?? "");
    const toolsRes = await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const mcp = await toolsRes.text();
    check(mcp.includes("session_search"), "⑪ 지식 창구가 도구 목록을 직접 돌려준다", mcp.slice(0, 200));
    await h.rt.dispose();
    let tokenGone = false;
    try {
      const listed = await fetch(url, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      tokenGone = listed.status === 401;
    } catch {
      tokenGone = true;
    }
    check(tokenGone, "⑪ 세션이 끝나면 그 토큰은 쓸 수 없다");
  }

  {
    const h = start({ turnContext: () => ["[Aether 자동 회상 — 배경 MARKER-RECALL]"] });
    h.rt.push({ text: "안녕" });
    check(await until(() => turnsDone(h) === 1), "⑫ 회상을 얹은 턴이 끝난다");
    const promptCall = (await h.calls()).find((c) => c.method === "session/prompt");
    const prompt = (promptCall?.params.prompt as Array<Record<string, unknown>> | undefined) ?? [];
    const resource = prompt.find((b) => b.type === "resource");
    const resourceText = String((resource?.resource as { text?: string } | undefined)?.text ?? "");
    check(resourceText.includes("<aether-context>") && resourceText.includes("MARKER-RECALL"), "⑫ 회상은 첨부 자원 블록으로 들어간다", resource);
    check(prompt.some((b) => b.type === "text" && b.text === "안녕"), "⑫ 사용자 글 블록은 원문 그대로다", prompt);
    const userish = h.events.flatMap((e) => normalizeGrok(e as never)).filter((a) => a.type === "user_text");
    check(!userish.some((a) => a.type === "user_text" && a.text.includes("aether-context")), "⑫ 되돌아온 회상은 user_text가 아니다", userish);
    const fromUser = normalizeGrok({ kind: "user_msg", text: "사용자가 친 글", seq: 1, ts: 0 });
    check(fromUser.some((a) => a.type === "user_text" && a.text === "사용자가 친 글"), "⑫ 사용자가 친 글만 user_text다");
    await h.rt.dispose();
  }

  {
    let release!: (v: string[]) => void;
    const delayed = new Promise<string[]>((r) => {
      release = r;
    });
    const h = start({ turnContext: () => delayed });
    await h.rt.handshake();
    h.rt.push({ text: "배포해줘" });
    await new Promise((r) => setTimeout(r, 120));
    const mid = await h.calls();
    check(!mid.some((c) => c.method === "session/prompt"), "⑫b 회상 Promise 완료 전 session/prompt 0", mid.map((c) => c.method));
    release(["[Aether 자동 회상 — 배경 DELAYED-GROK]"]);
    check(await until(() => turnsDone(h) === 1), "⑫b 회상 완료 후 턴이 끝난다");
    const promptCall = (await h.calls()).find((c) => c.method === "session/prompt");
    const prompt = (promptCall?.params.prompt as Array<Record<string, unknown>> | undefined) ?? [];
    const resourceText = String(
      (prompt.find((b) => b.type === "resource")?.resource as { text?: string } | undefined)?.text ?? "",
    );
    check(resourceText.includes("DELAYED-GROK"), "⑫b 완료 후 회상이 프롬프트에 실렸다", resourceText.slice(0, 120));
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@plan@@" });
    check(await until(() => h.plans.length === 1 && turnsDone(h) === 1), "⑬ 계획 종료가 권한 카드가 아니라 계획 카드로 온다");
    check(h.asks.length === 0, "⑬ 계획 검토는 권한 카드에 안 들어간다", h.asks);
    check(h.plans[0]?.text.includes("인증 방식"), "⑬ 계획문이 세션 plan.md에서 실린다", h.plans[0]?.text);
    const planCalls = (await h.calls()).filter((c) => c.method === "planAnswer");
    check(planCalls.length === 1, "⑬ 가짜 Grok이 _x.ai/exit_plan_mode를 보낸다", planCalls);
    check(!planCalls.some((c) => c._rpcError), "⑬ 계획 종료에 JSON-RPC 오류로 답하지 않는다", planCalls);
    check(planCalls[0]?.params.outcome === "approved", "⑬ 승인은 outcome approved다", planCalls[0]?.params);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.planOut = { decision: "revise", message: "접근을 바꿔라" };
    h.rt.push({ text: "@@plan@@" });
    check(await until(() => h.plans.length === 1 && turnsDone(h) === 1), "⑬b 수정 요청에도 턴이 끝난다");
    const planCalls = (await h.calls()).filter((c) => c.method === "planAnswer");
    check(!planCalls.some((c) => c._rpcError), "⑬b 수정 요청도 오류로 답하지 않는다", planCalls);
    check(planCalls[0]?.params.outcome === "cancelled", "⑬b 수정 요청은 outcome cancelled다(계획 모드 유지)", planCalls[0]?.params);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.planOut = { decision: "cancel" };
    h.rt.push({ text: "@@plan@@" });
    check(await until(() => h.plans.length === 1 && turnsDone(h) === 1), "⑬c 취소에도 턴이 끝난다");
    const planCalls = (await h.calls()).filter((c) => c.method === "planAnswer");
    check(!planCalls.some((c) => c._rpcError), "⑬c 취소도 오류로 답하지 않는다", planCalls);
    check(planCalls[0]?.params.outcome === "abandoned", "⑬c 취소는 outcome abandoned다", planCalls[0]?.params);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@plan-perm@@" });
    check(await until(() => h.plans.length === 1 && turnsDone(h) === 1), "⑬d 예전 request_permission 경로도 계획 카드로 온다");
    check(h.asks.length === 0, "⑬d 폴백도 권한 카드에 안 들어간다", h.asks);
    const permCalls = (await h.calls()).filter((c) => c.method === "permissionAnswer");
    check(!permCalls.some((c) => c._rpcError), "⑬d 폴백도 오류로 답하지 않는다", permCalls);
    check(JSON.stringify(permCalls[0]?.params ?? {}).includes("allow-once"), "⑬d 폴백 승인은 allow_once다", permCalls);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.holdPlan = true;
    h.rt.push({ text: "@@plan-timeout@@" });
    check(await until(() => h.plans.length === 1 && turnsDone(h) === 1, 8000), "⑬e Grok이 계획 도구를 실패하면 턴이 끝난다");
    check(h.plans[0]?.signal.aborted === true, "⑬e 화면 계획 카드 대기가 취소된다");
    const planCalls = (await h.calls()).filter((c) => c.method === "planAnswer");
    check(!planCalls.some((c) => c._rpcError), "⑬e 계획 포기도 JSON-RPC 오류가 아니다", planCalls);
    check(planCalls[0]?.params.outcome === "abandoned" || planCalls[0]?.params.outcome === "cancelled", "⑬e 포기 응답은 성공 모양이다", planCalls[0]?.params);
    await h.rt.dispose();
  }

  {
    const h = start();
    await h.rt.handshake();
    h.rt.push({ text: "그림", images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }] });
    check(await until(() => turnsDone(h) === 1), "⑮ 이미지 턴이 끝난다");
    const prompt = (((await h.calls()).find((c) => c.method === "session/prompt")?.params.prompt as Array<Record<string, unknown>> | undefined) ?? []);
    check(
      prompt.some((b) => b.type === "resource" && String((b.resource as { mimeType?: string } | undefined)?.mimeType ?? "").startsWith("image/")),
      "⑮ 이미지는 첨부 자원으로 간다",
      prompt,
    );
    check(!prompt.some((b) => b.type === "image"), "⑮ image 블록을 안 쓴다", prompt);
    await h.rt.dispose();
  }

  {
    const h = start();
    h.rt.push({ text: "@@unknown@@" });
    check(await until(() => turnsDone(h) === 1), "⑭ 모르는 역방향 요청에도 턴이 끝난다");
    const unknown = (await h.calls()).filter((c) => c.method === "unknownAnswer");
    check(unknown[0]?._rpcError === true, "⑭ 모르는 메서드는 JSON-RPC 오류다", unknown);
    check((unknown[0]?.params as { code?: number } | undefined)?.code === -32601, "⑭ 오류 코드는 Method not found(-32601)다", unknown[0]?.params);
    await h.rt.dispose();
  }

  {
    const seen: string[] = [];
    const h = start({
      turnContext: (prompt) => {
        seen.push(prompt);
        return [];
      },
    });
    h.rt.push({ text: "배포해줘" });
    h.rt.push({ text: "안녕" });
    check(await until(() => turnsDone(h) === 2), "⑰ 입력 둘이 차례로 끝난다", turnsDone(h));
    check(seen[0] === "배포해줘" && seen[1] === "안녕", "⑰ turnContext는 입력마다 그 글을 받는다", seen);
    await h.rt.dispose();
  }
}

try {
  await main();
} catch (e) {
  check(false, "예상 못 한 오류", String((e as Error)?.stack ?? e));
}
for (const rt of open) await rt.dispose().catch(() => {});
fs.rmSync(fake.dir, { recursive: true, force: true });
fs.rmSync(GROK_HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} grok_runtime: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
