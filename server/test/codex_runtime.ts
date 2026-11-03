/**
 * CodexRuntime 계약 검증 (Phase 8e 단위 3) — 모델 호출 0, 사용량 0.
 *
 * 가짜 app-server를 진짜 codex인 척 띄워 **세션 하나를 굴리는 규칙**을 반증한다.
 *   ① 턴은 한 번에 하나만 나간다 — 진행 중에 보낸 메시지는 현재 턴이 끝난 뒤에 전송된다(D5.5).
 *   ② 작업 폴더 밖 쓰기 반경이 Claude와 같다 — 임시 폴더 예외를 끈다.
 *   ③ 첨부 임시 파일은 쓰이는 동안 살아 있고 끝나면 사라진다(D3의 수명 계약).
 *   ④ 모델·추론 강도는 이 계정이 실제로 받는 값만 통과한다(D12).
 *   ⑤ 이어가기는 스레드 재개로 이뤄지고, 식별자는 가장 이른 시점에 알려진다.
 *   ⑥ 프로세스가 죽으면 세션이 조용히 멈추지 않고 오류로 드러난다.
 *   ⑦ 사용 한도 갱신만 세션에 남고, 다른 계정 알림은 여전히 섞이지 않는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexrt-"));
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";

const { makeFakeCodexBin, FAKE_THREAD_ID } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

const { CodexRuntime } = await import("../sessions/runtimes/codex");
const { normalizeCodex } = await import("../sessions/normalize/codex");
const { userSkillsDir, projectSkillsDir } = await import("../skill/skillPaths");
const { knowledgeBridgeStatus } = await import("../providers/knowledgeBridge");
const { codexCodec } = await import("../sessions/codec/codex");
type CodexRuntimeT = InstanceType<typeof CodexRuntime>;
type RuntimeStartOptions = import("../providers/types").RuntimeStartOptions;
type PermissionAsk = import("../providers/types").PermissionAsk;
type QuestionAsk = import("../providers/types").QuestionAsk;
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
  rt: CodexRuntimeT;
  /** 이 하니스가 쓴 세션 식별자 — 임시 첨부 폴더를 직접 들여다볼 때 쓴다. */
  sessionId: string;
  /** 이벤트 스트림이 내보낸 것 전부(LiveSession이 받는 것과 같다). */
  events: RawProviderEventBody[];
  /** 스트림이 오류로 끝났으면 그 오류. */
  streamError: Error | null;
  resumeKeys: string[];
  /** 상대가 받은 요청 기록(가짜 서버가 모아둔다). */
  calls(): Promise<{ method: string; params: Record<string, unknown> }[]>;
  methodsOf(events: RawProviderEventBody[]): string[];
};

const open = new Set<CodexRuntimeT>();
let seq = 0;

function start(over: Partial<RuntimeStartOptions> = {}): Harness {
  const events: RawProviderEventBody[] = [];
  const resumeKeys: string[] = [];
  const sessionId = `sess-${++seq}`;
  const h = { events, resumeKeys, sessionId, streamError: null as Error | null } as Harness;
  const rt = new CodexRuntime({
    sessionId,
    cwd: process.env.AETHER_DATA_DIR!,
    permissionMode: "manual",
    onPermission: async () => ({ allow: false, message: "테스트" }),
    onQuestion: async () => ({ answered: false, reason: "테스트" }),
    onResumeKey: (k) => resumeKeys.push(k),
    ...over,
  });
  open.add(rt);
  h.rt = rt;
  // 이벤트 스트림은 한 곳만 순회한다(계약) — 여기서 그 한 곳을 맡는다.
  void (async () => {
    try {
      for await (const ev of rt.events()) events.push(ev);
    } catch (e) {
      h.streamError = e as Error;
    }
  })();
  h.calls = async () => {
    const server = (rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    const res = (await server.request("test/calls")) as { calls: { method: string; params: Record<string, unknown> }[] };
    return res.calls;
  };
  h.methodsOf = (evs) => evs.map((e) => (e.msg as { method: string }).method);
  return h;
}

/** 이 이벤트 목록에 턴 종료가 몇 번 들어 있나. */
const turnsDone = (h: Harness) => h.methodsOf(h.events).filter((m) => m === "turn/completed").length;

async function main() {
  // ── ① 준비와 스레드 시작 ──
  {
    const h = start({ systemAppend: "기억 스냅샷: 사용자는 한국어를 쓴다." });
    const hs = await h.rt.handshake();
    check(hs.models.length === 3, "① 준비 신호가 모델 목록을 준다", hs.models.map((m) => m.value));
    check(
      hs.models.filter((m) => m.isDefault).length === 1 && hs.models.find((m) => m.isDefault)?.value === "gpt-5.6-terra",
      "① 계정 기본 모델 표시가 목록에 정확히 하나 실린다",
      hs.models.map((m) => ({ value: m.value, isDefault: m.isDefault })),
    );
    check(
      hs.models[0].supportedEffortLevels?.includes("medium") === true,
      "① 모델별 추론 강도 목록이 실린다",
      hs.models[0].supportedEffortLevels,
    );
    check(hs.models[0].defaultEffort === "medium", "① 모델의 기본 강도가 실린다", hs.models[0].defaultEffort);
    // 8i: Codex는 강도마다 설명을 직접 준다. 그걸 버리면 화면이 자기 표를 들어야 하므로 그대로 실어야 한다.
    check(
      hs.models[0].supportedEffortDescriptions?.medium?.text === "보통",
      "① 강도 설명이 provider 원문 그대로 실린다",
      hs.models[0].supportedEffortDescriptions,
    );
    const again = await h.rt.handshake();
    check(again.models.length === hs.models.length, "① 여러 번 불러도 같은 결과(준비는 한 번만 돈다)");
    check(again === hs, "① 여러 번 불러도 같은 결과 객체(공통 계층이 같은 관측을 다시 기억하지 않는다)");
    const calls = await h.calls();
    const startCall = calls.find((c) => c.method === "thread/start");
    check(!!startCall, "① 스레드를 시작한다");
    check(startCall?.params.cwd === process.env.AETHER_DATA_DIR, "① 작업 폴더가 전달된다", startCall?.params.cwd);
    check(startCall?.params.approvalPolicy === "untrusted", "① 수동의 승인 정책은 믿지 않는 명령을 물어보기", startCall?.params.approvalPolicy);
    // 승인을 사람이 판단한다고 못 박는지 — 사용자의 전역 Codex 설정이 이걸 AI 하위 에이전트에게 넘길 수 있고,
    //   실제로 그 설정이 켜진 환경에서 승인 카드가 통째로 우회됐다(2026-08-18 실측).
    check(startCall?.params.approvalsReviewer === "user", "① 승인 판단은 사람이라고 못 박는다(전역 설정 미상속)", startCall?.params.approvalsReviewer);
    check(
      String(startCall?.params.developerInstructions ?? "").includes("기억 스냅샷"),
      "① 세션 시작 시 1회 고정되는 안내문이 전달된다(D10 정본)",
      startCall?.params.developerInstructions,
    );
    check(h.resumeKeys[0] === FAKE_THREAD_ID, "① 이어가기 식별자를 가장 이른 시점에 알린다", h.resumeKeys);
    // 지식툴 창구(8g): 서버 정의와 자격증명이 **스레드 시작 설정**으로 간다.
    //   환경변수로 넘기면 같은 계정의 아무 프로세스나 `ps eww`로 읽는다(8g 실측) — 그래서 통로를 바꿨다.
    const mcpCfg = (startCall?.params.config as { mcp_servers?: Record<string, any> } | undefined)?.mcp_servers?.aether;
    check(String(mcpCfg?.url ?? "").startsWith("http://127.0.0.1:"), "① 지식툴 창구 주소가 이 기계 안으로 묶여 있다", mcpCfg?.url);
    check(String(mcpCfg?.http_headers?.Authorization ?? "").startsWith("Bearer "), "① 자격증명이 스레드 설정으로 전달된다(환경변수·실행 인자 아님)");
    check(mcpCfg?.default_tools_approval_mode === "approve", "① 도구별 승인 판정은 창구가 한다(Codex 쪽 서버 단위 승인에 맡기지 않는다)");
    // 질문 카드를 켜는 스위치(8g · D5.4) — 이게 없으면 사용자 전역 설정에 값이 없는 환경에서 카드가 아예 안 뜬다.
    const spawnCfg = (await (h.rt as unknown as { server: { request: (m: string) => Promise<unknown> } }).server.request("test/configOverrides")) as { overrides: string[] };
    check(
      spawnCfg.overrides.includes("tools.experimental_request_user_input.enabled=true") &&
        spawnCfg.overrides.includes("features.default_mode_request_user_input=true"),
      "① 질문 카드를 켜는 설정 두 개가 실제 프로세스 인자로 들어간다",
      spawnCfg.overrides,
    );
    await h.rt.dispose();
  }

  // ── ①b provider 중립 명령 계약: 목록과 실행이 app-server RPC로 이어진다 ──
  {
    const operations: import("../providers/types").RuntimeCommandOperation[] = [];
    const h = start({ onCommandOperation: (operation) => operations.push(operation) });
    const commands = await h.rt.listCommands();
    check(commands.some((c) => c.name === "compact" && c.startsTurn === false), "①b /compact가 비턴 명령으로 노출된다", commands);
    check(commands.some((c) => c.name === "review" && c.startsTurn === true), "①b /review가 턴 명령으로 노출된다", commands);
    check(!commands.some((c) => c.name === "fork"), "①b Aether 세션으로 추적하지 못하는 명령은 실행 가능하다고 거짓말하지 않는다", commands);

    const unknown = await h.rt.executeCommand({ name: "does-not-exist", arguments: "" });
    check(!unknown.accepted, "①b 모르는 명령은 일반 프롬프트로 폴백하지 않고 거부한다", unknown);
    check(!(await h.calls()).some((c) => c.method === "turn/start"), "①b 모르는 명령이 turn/start로 새지 않는다");

    const compact = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(compact.accepted && !compact.startsTurn, "①b /compact 실행을 비턴 결과로 답한다", compact);
    const compactCall = (await h.calls()).find((c) => c.method === "thread/compact/start");
    check(compactCall?.params.threadId === FAKE_THREAD_ID, "①b /compact가 정확한 thread/compact/start RPC를 부른다", compactCall);
    check(operations.length === 1 && operations[0]?.state === "started" && operations[0]?.blocksInput, "①b 완료 알림 전 /compact 시작 operation을 먼저 알린다", operations);
    const overlapping = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(!overlapping.accepted, "①b 진행 중 operation을 새 명령이 덮어쓰지 못한다", overlapping);
    check(await until(() => operations.length === 2), "①b 압축 완료 알림이 공통 operation 완료로 흐른다", operations);
    check(operations[1]?.state === "completed" && operations[1]?.operationId === operations[0]?.operationId, "①b 완료 알림이 같은 operation을 완료 상태로 닫는다", operations);
    check(!h.methodsOf(h.events).includes("thread/compacted"), "①b deprecated thread/compacted 없이 현재 contextCompaction 완료 신호로 닫는다", h.methodsOf(h.events));

    const review = await h.rt.executeCommand({ name: "review", arguments: "base main" });
    check(review.accepted && review.startsTurn, "①b /review는 실제 턴을 시작한다", review);
    check(await until(() => turnsDone(h) === 1), "①b 리뷰 턴이 끝까지 흐른다", h.methodsOf(h.events));
    const reviewCall = (await h.calls()).find((c) => c.method === "review/start");
    check(
      (reviewCall?.params.target as { type?: string; branch?: string } | undefined)?.type === "baseBranch" &&
        (reviewCall?.params.target as { branch?: string } | undefined)?.branch === "main",
      "①b /review 인자 해석은 Codex adapter 안에서 구조화 target으로 바뀐다",
      reviewCall,
    );
    await h.rt.dispose();
  }

  // ── ② 턴 한 번: 이벤트가 순서대로 흐른다 ──
  {
    const h = start();
    h.rt.push({ text: "@@subthread@@" });
    check(await until(() => turnsDone(h) === 1), "하위 thread 시험: 턴이 끝까지 흐른다");
    const starts = h.events.filter((e) => (e.msg as { method?: string }).method === "turn/started");
    check(starts.length === 1, "하위 thread의 턴 시작은 내보내지 않고 메인 턴 시작만 남는다", starts.length);
    await h.rt.dispose();
  }
  {
    const h = start();
    h.rt.push({ text: "안녕" });
    check(await until(() => turnsDone(h) === 1), "② 턴이 끝까지 흐른다");
    const methods = h.methodsOf(h.events);
    check(methods[0] === "turn/started", "② 첫 이벤트는 턴 시작", methods);
    check(methods.includes("item/completed"), "② 답변 항목이 온다");
    check(methods.includes("thread/tokenUsage/updated"), "② 사용량 갱신이 온다");
    check(methods[methods.length - 1] === "turn/completed", "② 마지막 이벤트는 턴 종료", methods);
    // ⑦ 실제 계정에서 관측한 사용 한도 갱신은 대화 중 경고·차단 배너 경로에만 들어간다.
    // 이 검사가 `account/*` 예외를 빼는 회귀를 막는다. 관측값은 사용률만 있으므로 정보성(배너 없음)이다.
    const rateUpdate = h.events.find((e) => (e.msg as { method?: string }).method === "account/rateLimits/updated");
    const rateNotice = (rateUpdate && normalizeCodex(rateUpdate as never).find((a) => a.type === "provider_notice" && a.kind === "rate_limit")) as
      | { utilization?: number; severity?: "warn" | "blocked" }
      | undefined;
    check(!!rateUpdate && rateNotice?.utilization === 0.16 && rateNotice?.severity === undefined, "⑦ 사용 한도 갱신이 세션·정규화 경로에 도달한다", rateNotice);
    check(methods.filter((m) => m.startsWith("account/")).every((m) => m === "account/rateLimits/updated"), "⑦ 다른 계정 알림은 세션 이벤트로 나오지 않는다", methods);
    const usage = await h.rt.contextUsage();
    check(usage.totalTokens === 1200 && usage.maxTokens === 258400, "② 문맥 점유량은 마지막 요청분을 쓴다(누계 아님)", usage);
    await h.rt.dispose();
  }

  // ── ③ 실행 중 새 메시지는 다음 턴으로(D5.5) ──
  {
    const h = start();
    h.rt.push({ text: "@@slow@@ 첫 번째" });
    await until(() => h.methodsOf(h.events).includes("turn/started"));
    h.rt.push({ text: "두 번째" });
    // 진행 중인 턴이 끝나기 전에는 두 번째 요청이 나가면 안 된다.
    await sleep(120);
    const mid = (await h.calls()).filter((c) => c.method === "turn/start");
    check(mid.length === 1, "③ 진행 중에는 다음 턴을 보내지 않는다", mid.length);
    check(await until(() => turnsDone(h) === 2, 8000), "③ 앞 턴이 끝나면 다음 턴이 이어진다", turnsDone(h));
    const done = (await h.calls()).filter((c) => c.method === "turn/start");
    check(done.length === 2, "③ 결국 두 턴 모두 전송된다", done.length);
    const texts = done.map((c) => (c.params.input as { type: string; text?: string }[]).find((i) => i.type === "text")?.text);
    check(texts[0]?.includes("첫 번째") === true && texts[1]?.includes("두 번째") === true, "③ 순서가 보존된다", texts);
    await h.rt.dispose();
  }

  // ── ④ 권한 반경: 임시 폴더 예외를 끈다 ──
  {
    const h = start();
    h.rt.push({ text: "안녕" });
    await until(() => turnsDone(h) === 1);
    const turn = (await h.calls()).find((c) => c.method === "turn/start")!;
    const sandbox = turn.params.sandboxPolicy as Record<string, unknown>;
    check(sandbox?.type === "workspaceWrite", "④ 기본 샌드박스는 작업 폴더 쓰기", sandbox);
    check(sandbox?.excludeSlashTmp === true && sandbox?.excludeTmpdirEnvVar === true, "④ /tmp·임시 폴더 예외를 끈다(Claude와 같은 반경)", sandbox);
    check(sandbox?.networkAccess === false, "④ 네트워크는 기본 차단", sandbox);
    check(turn.params.approvalsReviewer === "user", "④ 턴마다도 사람이 판단한다고 못 박는다", turn.params.approvalsReviewer);
    const policy = await h.rt.effectivePermissionPolicy();
    check(policy.bypassAll === false && policy.autoApproveRules === 0, "④ 승인 정책 요약이 '전부 물어봄'이다", policy);
    // ★ R22: 사용자 전역 설정에 카드를 건너뛰는 축이 켜져 있으면 **그대로 보고해야 한다.**
    //   8e까지 여기는 무조건 0을 답했고, 그래서 화면 배지가 "자동승인 0건"이라고 거짓말할 수 있었다.
    //   ★ 2026-08-19 검토: 아래 설정 모양은 전부 **실측한 것**이다(spike configshape). 예전 시험대는
    //   구현이 기대하는 가짜 모양(`execpolicy.allow`)을 그대로 만들어 줘서, 실제로는 아무것도 못 세는
    //   구현이 통과하고 있었다. 실제 응답 최상위엔 execpolicy도 rules도 없다.
    const server = (h.rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    const REAL_BASE = { model: null, approval_policy: null }; // 실제 응답은 값이 null이어도 키는 있다
    await server.request("test/setConfig", {
      config: {
        ...REAL_BASE,
        mcp_servers: {
          risky: { command: "x", enabled: true, default_tools_approval_mode: "approve" },
          reads: { command: "z", enabled: true, default_tools_approval_mode: "writes" }, // 읽기는 카드 없이 = 부분 우회
          polite: { command: "y", enabled: true, default_tools_approval_mode: "prompt" },
          off: { command: "w", enabled: false, default_tools_approval_mode: "approve" }, // 꺼진 서버 — 실행될 수 없다
          aether: { url: "http://127.0.0.1:1/mcp", default_tools_approval_mode: "approve" }, // 우리 창구 — 세면 안 된다
        },
        apps: { _default: {}, connectorA: { enabled: true, default_tools_approval_mode: "approve" }, connectorB: { enabled: true, default_tools_approval_mode: "prompt", tools: { read_rows: { enabled: true, approval_mode: "auto" } } } },
        projects: { [process.env.AETHER_DATA_DIR!]: { trust_level: "trusted" } },
      },
      origins: {
        "mcp_servers.risky.default_tools_approval_mode": { name: { type: "user", file: "/x/config.toml", profile: null } },
        "mcp_servers.reads.default_tools_approval_mode": { name: { type: "project", dotCodexFolder: "/x/.codex" } },
        [`projects.${process.env.AETHER_DATA_DIR!}.trust_level`]: { name: { type: "user", file: "/x/config.toml", profile: null } },
      },
    });
    const dirty = await h.rt.effectivePermissionPolicy();
    check(dirty.autoApproveRules === 4, "④ MCP 2개(approve·writes) + 앱 2개를 센다 — 꺼진 서버와 우리 창구는 뺀다", dirty);
    check(dirty.autoApproveMode === "trusted", "④ 이 폴더가 신뢰로 잡혀 있으면 그것도 밝힌다", dirty);
    // 범위는 지어내지 않고 출처 메타에서 읽는다 — 예전엔 "규칙이 있으면 user"라고 찍어 넣었다.
    check(dirty.sources.includes("user") && dirty.sources.includes("project"), "④ 범위를 출처 메타에서 읽는다", dirty.sources);

    // ★ 훅이 걸려 있으면 개수를 셀 수 없다 — permissionRequest 훅은 카드를 대신 승인할 수 있는데
    //   그 판단은 실행해 봐야 안다. "0"이라고 말할 근거가 없으므로 모른다고 답해야 한다.
    await server.request("test/setConfig", { config: { ...REAL_BASE, hooks: { permissionRequest: [{ command: "x" }] } } });
    const hooked = await h.rt.effectivePermissionPolicy();
    check(hooked.autoApproveMode === "unknown", "④ 훅이 걸려 있으면 '모름'으로 답한다(0이라고 하지 않는다)", hooked);

    // ★ 아는 모양이 아닌 응답(빈 객체)은 "설정 없음"이 아니다 — 그걸 0으로 받으면 배지가 다시 거짓말한다.
    await server.request("test/setConfig", { config: {} });
    const bogus = await h.rt.effectivePermissionPolicy();
    check(bogus.autoApproveMode === "unknown", "④ 아는 모양이 아닌 설정 응답은 '모름'이다", bogus);

    await server.request("test/setConfig", { config: REAL_BASE });
    await h.rt.dispose();
  }

  // ── ④e 규칙 파일의 자동 허용을 센다(2026-08-19 검토) ──
  //   실제 허용 규칙은 config/read에 안 실려 온다 — `$CODEX_HOME/rules/*.rules` 파일에 산다(실측).
  //   초판은 설정 최상위에서 찾느라 **언제나 0**을 보고했다. 이 맥에서만도 실제로는 27건이 있었다.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexhome-"));
    fs.mkdirSync(path.join(home, "rules"));
    fs.writeFileSync(
      path.join(home, "rules", "default.rules"),
      'prefix_rule(pattern=["git", "status"], decision="allow")\n' +
        'prefix_rule(pattern=["ls"], decision="allow")\n' +
        'prefix_rule(pattern=["rm"], decision="deny")\n',
    );
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const h = start();
    await h.rt.handshake();
    const withRules = await h.rt.effectivePermissionPolicy();
    check(withRules.autoApproveRules === 2, "④e 규칙 파일의 allow만 센다(deny는 우회가 아니다)", withRules);
    check(withRules.sources.includes("user"), "④e 규칙 파일은 이 계정 전역이다", withRules.sources);
    await h.rt.dispose();

    // 규칙 폴더를 못 읽으면 0이 아니라 모른다 — 읽기 권한을 막아 확인한다.
    fs.chmodSync(path.join(home, "rules"), 0o000);
    const h2 = start();
    await h2.rt.handshake();
    const unreadable = await h2.rt.effectivePermissionPolicy();
    check(unreadable.autoApproveMode === "unknown", "④e 규칙 폴더를 못 읽으면 '모름'이다", unreadable);
    fs.chmodSync(path.join(home, "rules"), 0o700);
    await h2.rt.dispose();

    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── ④c 설정을 못 읽으면 "0건"이라고 답하지 않는다(R22) ──
  //   못 읽은 것을 0으로 답하면 배지가 다시 거짓말을 한다 — 모른다는 사실을 드러내야 한다.
  {
    const h = start();
    await h.rt.handshake();
    const server = (h.rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    await server.request("test/exitAfterReply", { code: 0 }).catch(() => {});
    await sleep(300);
    const policy = await h.rt.effectivePermissionPolicy();
    check(policy.autoApproveMode === "unknown", "④c 설정을 못 읽으면 '모름'으로 답한다", policy);
    await h.rt.dispose();
  }

  // ── ④d 구독 한도 조회(8h) — Codex 응답을 중립 스키마로 옮긴다 ──
  //   Codex는 창에 이름을 안 주고 길이(분)만 준다. 이름 자리에 내부 키를 넣고 끝내면 화면에
  //   `codex_primary` 같은 글자가 나가므로, 길이를 함께 실어 화면이 스스로 라벨을 만들게 한다.
  {
    const h = start();
    await h.rt.handshake();
    const server = (h.rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    const usage = await h.rt.usage();
    check(usage.windowsAvailable && usage.windows.length === 1, "④d 한도 창을 하나 싣는다", usage);
    check(usage.windows[0].utilization === 16 && usage.windows[0].windowMinutes === 10080, "④d 사용률과 창 길이를 그대로 옮긴다", usage.windows[0]);
    check(usage.windows[0].resetsAt === new Date(1787617478 * 1000).toISOString(), "④d 초 단위 리셋 시각을 ISO로 옮긴다", usage.windows[0].resetsAt);
    check(usage.subscriptionType === "plus", "④d 요금제 이름을 옮긴다", usage.subscriptionType);
    check(usage.costUsd === undefined, "④d 세지 않는 비용은 0으로 지어내지 않는다", usage);
    // 한도 종류별 묶음이 오면 그쪽만 쓴다 — 둘 다 세면 같은 창이 두 번 그려진다.
    await server.request("test/setRateLimits", {
      value: {
        rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: "pro" },
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null }, planType: "pro" },
        },
        rateLimitResetCredits: null,
      },
    });
    const multi = await h.rt.usage();
    check(multi.windows.length === 2, "④d 종류별 묶음이 오면 그쪽만 센다(중복 없음)", multi.windows.map((w) => w.key));
    check(multi.windows.map((w) => w.utilization).join(",") === "9,40", "④d 두 창의 사용률이 각각 실린다", multi.windows);
    check(new Set(multi.windows.map((w) => w.key)).size === 2, "④d 창 키가 서로 겹치지 않는다", multi.windows.map((w) => w.key));
    // 한도를 알 수 없는 계정이면 창이 없다고 정직하게 답한다(가짜 0% 막대를 그리지 않는다).
    await server.request("test/setRateLimits", { value: { rateLimits: null, rateLimitsByLimitId: null, rateLimitResetCredits: null } });
    const none = await h.rt.usage();
    check(none.windowsAvailable === false && none.windows.length === 0, "④d 창을 못 받으면 '알 수 없음'으로 답한다", none);
    await h.rt.dispose();
  }

  // ── ④b 우회 세션은 명시적으로 전부 허용 ──
  {
    const h = start({ permissionMode: "full" });
    h.rt.push({ text: "안녕" });
    await until(() => turnsDone(h) === 1);
    const calls = await h.calls();
    check((calls.find((c) => c.method === "thread/start")!.params as { approvalPolicy?: string }).approvalPolicy === "never", "④b 우회 세션은 승인을 묻지 않는다");
    const sandbox = calls.find((c) => c.method === "turn/start")!.params.sandboxPolicy as Record<string, unknown>;
    check(sandbox?.type === "dangerFullAccess", "④b 우회 세션은 전체 접근", sandbox);
    check((await h.rt.effectivePermissionPolicy()).bypassAll === true, "④b 요약도 '전부 우회'로 나온다");
    await h.rt.dispose();
  }

  // ── ④c 세션 중 권한 우회 전환은 다음 턴의 승인 정책과 샌드박스에 실린다 ──
  {
    const h = start();
    await h.rt.setPermissionMode("full");
    h.rt.push({ text: "켜고 첫 턴" });
    await until(() => turnsDone(h) === 1);
    let turns = (await h.calls()).filter((c) => c.method === "turn/start");
    check(turns[0]?.params.approvalPolicy === "never", "④c 켜면 다음 턴은 승인을 묻지 않는다", turns[0]?.params.approvalPolicy);
    check((turns[0]?.params.sandboxPolicy as { type?: string })?.type === "dangerFullAccess", "④c 켜면 다음 턴은 전체 접근", turns[0]?.params.sandboxPolicy);
    check((await h.rt.effectivePermissionPolicy()).bypassAll === true, "④c 요약도 바뀐 값을 따른다");
    await h.rt.setPermissionMode("manual");
    h.rt.push({ text: "끄고 둘째 턴" });
    await until(() => turnsDone(h) === 2);
    turns = (await h.calls()).filter((c) => c.method === "turn/start");
    check(turns[1]?.params.approvalPolicy === "untrusted", "④c 수동으로 돌리면 다시 승인을 묻는다", turns[1]?.params.approvalPolicy);
    check((turns[1]?.params.sandboxPolicy as { type?: string })?.type === "workspaceWrite", "④c 끄면 작업 폴더 샌드박스로 돌아간다", turns[1]?.params.sandboxPolicy);
    check((await h.rt.effectivePermissionPolicy()).bypassAll === false, "④c 끈 뒤 요약도 우회 아님");
    await h.rt.dispose();
  }

  // ── ④d 자동 모드는 필요할 때 요청하고 판단을 자동 검토에 맡긴다. 수동·편집은 사람이 판단한다 ──
  {
    const h = start({ permissionMode: "auto" });
    h.rt.push({ text: "안녕" });
    await until(() => turnsDone(h) === 1);
    const calls = await h.calls();
    const t = calls.find((c) => c.method === "thread/start")!.params as { approvalPolicy?: string; approvalsReviewer?: string };
    check(t.approvalPolicy === "on-request" && t.approvalsReviewer === "auto_review", "④d 자동: on-request + auto_review", t);
    const turn = calls.find((c) => c.method === "turn/start")!.params;
    check(turn.approvalPolicy === "on-request" && turn.approvalsReviewer === "auto_review", "④d 자동: 턴마다도 같다", turn);
    check((turn.sandboxPolicy as { type?: string })?.type === "workspaceWrite", "④d 자동도 작업 폴더 샌드박스", turn.sandboxPolicy);
    check((await h.rt.effectivePermissionPolicy()).bypassAll === false, "④d 자동은 우회가 아니다");
    const modes = await h.rt.permissionModes();
    check(modes.current === "auto" && modes.modes.join() === "manual,edits,auto,full", "④d Codex 목록은 네 모드", modes);
    await h.rt.dispose();
  }
  {
    const h = start({ permissionMode: "edits" });
    h.rt.push({ text: "안녕" });
    await until(() => turnsDone(h) === 1);
    const turn = (await h.calls()).find((c) => c.method === "turn/start")!.params;
    check(turn.approvalPolicy === "untrusted" && turn.approvalsReviewer === "user", "④d 편집 자동 수락: untrusted + 사람 판단", turn);
    await h.rt.dispose();
  }
  {
    const h = start();
    await h.rt.handshake();
    check((await h.rt.permissionModes()).current === "manual", "④d 명시한 수동 시작값을 그대로 쓴다");
    const h2 = start({ permissionMode: undefined });
    check((await h2.rt.permissionModes()).current === "auto", "④d 시작값이 없으면(새 세션) 자동 검토가 있는 Codex는 자동으로 시작한다");
    await h2.rt.dispose();
    await h.rt.dispose();
  }

  // ── ④e 편집 자동 수락: 작업 폴더 안의 파일 변경은 카드 없이 받고, 폴더 밖이면 카드로 묻는다 ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({ permissionMode: "edits", onPermission: async (a) => { asks.push(a); return { allow: false, message: "거부" }; } });
    h.rt.push({ text: "@@patch@@ 고쳐줘" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks.length === 0, "④e 폴더 안 변경은 카드를 띄우지 않는다", asks);
    const ans = (await h.calls()).find((c) => c.method === "fileChangeAnswer");
    check((ans?.params as { decision?: string } | undefined)?.decision === "accept", "④e 폴더 안 변경은 accept로 답한다", ans?.params);
    await h.rt.dispose();
  }
  {
    const asks: PermissionAsk[] = [];
    const h = start({ permissionMode: "edits", onPermission: async (a) => { asks.push(a); return { allow: false, message: "거부" }; } });
    h.rt.push({ text: "@@outpatch@@ 고쳐줘" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks.length === 1 && asks[0].toolName === "fileChange", "④e 폴더 밖 변경은 카드로 묻는다", asks);
    await h.rt.dispose();
  }
  for (const tag of ["@@movepatch@@", "@@movepatch2@@"]) {
    const asks: PermissionAsk[] = [];
    const h = start({ permissionMode: "edits", onPermission: async (a) => { asks.push(a); return { allow: false, message: "거부" }; } });
    h.rt.push({ text: `${tag} 이름 바꿔줘` });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks.length === 1, `④e ${tag}: 폴더 밖으로 이름을 바꾸는 변경은 카드로 묻는다`, asks);
    await h.rt.dispose();
  }
  {
    const asks: PermissionAsk[] = [];
    const h = start({ permissionMode: "manual", onPermission: async (a) => { asks.push(a); return { allow: false, message: "거부" }; } });
    h.rt.push({ text: "@@patch@@ 고쳐줘" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks.length === 1, "④e 수동이면 폴더 안 변경도 카드로 묻는다", asks);
    await h.rt.dispose();
  }

  // ── ⑤ 첨부: 파일로 만들어 경로로 넘기고, 끝나면 지운다 ──
  {
    const h = start();
    const png = Buffer.from("가짜 이미지").toString("base64");
    const pdf = Buffer.from("가짜 문서").toString("base64");
    h.rt.push({
      text: "이거 봐줘",
      images: [{ media_type: "image/png", data: png }],
      documents: [{ name: "보고서.pdf", media_type: "application/pdf", data: pdf }],
    });
    await until(() => turnsDone(h) === 1);
    const turn = (await h.calls()).find((c) => c.method === "turn/start")!;
    const input = turn.params.input as { type: string; path?: string; text?: string }[];
    const image = input.find((i) => i.type === "localImage");
    check(!!image?.path, "⑤ 이미지는 경로로 넘어간다", image);
    check(image?.path?.endsWith(".png") === true, "⑤ 확장자가 보존된다", image?.path);
    const text = input.find((i) => i.type === "text")?.text ?? "";
    check(text.startsWith("이거 봐줘"), "⑤ 사용자가 친 글이 앞에 그대로 있다", text.slice(0, 40));
    check(text.includes("보고서.pdf") && text.includes(".pdf"), "⑤ 문서는 파일 경로 안내로 붙는다(유저 결정)", text.slice(-160));
    check(!fs.existsSync(image!.path!), "⑤ 턴이 끝나면 임시 파일이 지워진다", image?.path);
    await h.rt.dispose();
  }

  // ── ⑥ 모델·추론 강도 검증(D12) ──
  {
    const h = start();
    await h.rt.handshake();
    let rejected = "";
    try {
      await h.rt.setModel("없는-모델-이름");
    } catch (e) {
      rejected = String((e as Error).message);
    }
    check(rejected.includes("없는-모델-이름"), "⑥ 이 계정에 없는 모델 이름은 거부한다", rejected);

    let defaultRejected = "";
    try {
      await h.rt.setEffort("ultra");
    } catch (e) {
      defaultRejected = String((e as Error).message);
    }
    check(defaultRejected.includes("ultra"), "⑥ 모델 미지정이면 계정 기본 모델이 받지 않는 강도를 거부한다", defaultRejected);
    let defaultAccepted = true;
    try {
      await h.rt.setEffort("high");
    } catch {
      defaultAccepted = false;
    }
    check(defaultAccepted, "⑥ 모델 미지정이면 계정 기본 모델이 받는 강도를 통과시킨다");

    await h.rt.setModel("gpt-5.6-terra");
    let effortRejected = "";
    try {
      await h.rt.setEffort("ultra");
    } catch (e) {
      effortRejected = String((e as Error).message);
    }
    check(effortRejected.includes("ultra"), "⑥ 그 모델이 받지 않는 추론 강도는 거부한다", effortRejected);
    await h.rt.setEffort("high");
    h.rt.push({ text: "안녕" });
    await until(() => turnsDone(h) === 1);
    const turn = (await h.calls()).find((c) => c.method === "turn/start")!;
    check(turn.params.model === "gpt-5.6-terra" && turn.params.effort === "high", "⑥ 바꾼 값이 다음 턴에 실린다", turn.params);
    await h.rt.dispose();
  }

  {
    const h = start();
    await h.rt.setModel("gpt-5.4-nano");
    let effortRejected = "";
    try {
      await h.rt.setEffort("low");
    } catch (e) {
      effortRejected = String((e as Error).message);
    }
    check(effortRejected.includes("Effort를 지원하지 않아요"), "⑥ 강도를 받지 않는 모델은 어떤 강도도 거부한다", effortRejected);
    await h.rt.dispose();
  }

  // ── ⑥b 첫 턴 전에는 문맥 점유량을 지어내지 않는다 ──
  {
    const h = start();
    let msg = "";
    try {
      await h.rt.contextUsage();
    } catch (e) {
      msg = String((e as Error).message);
    }
    check(!!msg, "⑥b 아직 모르는 문맥 점유량은 0으로 지어내지 않는다", msg);
    await h.rt.dispose();
  }

  // ── ⑥c 매 턴 자동 회상(8g · R4) ──
  //   지키려는 문장: **주입은 모델 입력에만 들어가고, 저장본·화면에는 사용자가 친 글만 남는다.**
  {
    const asked: string[] = [];
    const h = start({
      turnContext: (prompt) => {
        asked.push(prompt);
        return [`과거 배경: ${prompt}에 대한 회상`];
      },
    });
    h.rt.push({ text: "배포 어떻게 했더라" });
    check(await until(() => turnsDone(h) === 1), "⑥c 회상이 붙은 턴이 끝까지 흐른다");
    const calls = await h.calls();
    const inject = calls.find((c) => c.method === "thread/inject_items");
    const turn = calls.find((c) => c.method === "turn/start");
    check(!!inject, "⑥c 회상을 스레드에 덧붙인다", calls.map((c) => c.method));
    check(
      calls.indexOf(inject!) < calls.indexOf(turn!),
      "⑥c 덧붙이기가 턴 시작보다 먼저다(늦으면 이번 턴이 그 배경을 못 본다)",
      calls.map((c) => c.method).join(","),
    );
    check(asked[0] === "배포 어떻게 했더라", "⑥c 회상은 사용자가 친 글을 근거로 찾는다", asked);
    const injected = JSON.stringify(inject?.params ?? {});
    check(injected.includes("과거 배경") && injected.includes("<aether-context>"), "⑥c 덧붙인 내용에 회상이 실린다");
    // ★ 불변식: 턴 입력에는 사용자가 친 글만 있다. 여기 섞으면 그 문구가 사용자 메시지로 되돌아와
    //   화면과 디스크에 남는다(8g 실측 — 입력 항목 통로는 되돌아온다).
    const turnInput = JSON.stringify(turn?.params ?? {});
    check(!turnInput.includes("과거 배경"), "⑥c 턴 입력에는 회상이 섞이지 않는다", turnInput.slice(0, 120));
    check(!JSON.stringify(h.events).includes("과거 배경"), "⑥c 세션 이벤트에도 회상이 나타나지 않는다(저장·화면 무오염)");
    await h.rt.dispose();
  }

  // ── ⑥e 스킬 저장소 등록·재발견(8g · D7) ──
  {
    const h = start();
    await h.rt.handshake();
    const calls = await h.calls();
    const roots = calls.find((c) => c.method === "skills/extraRoots/set");
    const listed = calls.filter((c) => c.method === "skills/list");
    const paths = (roots?.params.extraRoots as string[] | undefined) ?? [];
    check(paths.length === 2, "⑥e 스킬 루트를 등록한다(전역 + 이 프로젝트)", paths);
    check(
      paths.some((p) => p === userSkillsDir()) && paths.some((p) => p === projectSkillsDir(process.env.AETHER_DATA_DIR!)),
      "⑥e 등록 경로가 공통 스킬 저장소 규약과 같다(경로를 따로 조립하지 않는다)",
      paths,
    );
    check(listed.length === 1 && listed[0].params.forceReload === true, "⑥e 등록 직후 목록을 강제로 다시 읽는다", listed.map((c) => c.params));
    // 세션 도중 스킬이 생기면(자동 생성 포함) 그 세션이 바로 볼 수 있어야 한다.
    const server = (h.rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    await server.request("test/skillsChanged");
    let relisted = 0;
    for (let i = 0; i < 100 && relisted < 2; i++) {
      relisted = (await h.calls()).filter((c) => c.method === "skills/list").length;
      if (relisted < 2) await sleep(20);
    }
    check(relisted >= 2, "⑥e 스킬이 바뀌었다는 신호에 목록을 다시 읽는다", relisted);
    check(!h.methodsOf(h.events).includes("skills/changed"), "⑥e 그 신호는 대화 이벤트로 나가지 않는다(무효화 신호일 뿐)");
    await h.rt.dispose();
  }

  // ── ⑥i 상대가 얹은 글을 되돌려 보내도 화면에는 안 그린다(외부 검토 지적) ──
  //   실측한 0.145.0은 되돌려 보내지 않지만, 그 성질에 기대는 검사만 두면 상대가 바뀌는 순간 조용히
  //   깨진다. 되돌려 보내는 상대를 흉내 내고, 그래도 사용자 말풍선이 안 생기는지 본다.
  {
    const marker = "@@echoinject@@ 비밀 회상";
    const h = start({ turnContext: () => [marker] });
    h.rt.push({ text: "질문" });
    check(await until(() => turnsDone(h) === 1), "⑥i 되돌려 보내는 상대에서도 턴이 끝난다");
    const echoed = h.events.filter((e) => JSON.stringify(e.msg).includes("비밀 회상"));
    check(echoed.length > 0, "⑥i 시험대가 실제로 되돌려 보냈다(검사가 헛돌지 않는다)", echoed.length);
    const bubbles = echoed.flatMap((e) => codexCodec.normalize(e as never)).filter((ev) => ev.type === "user_text");
    check(bubbles.length === 0, "⑥i 되돌아온 글은 사용자 말풍선으로 바뀌지 않는다", bubbles);
    await h.rt.dispose();
  }

  // ── ⑥h 프로세스가 죽으면 지식툴 토큰도 함께 버린다(외부 검토 지적) ──
  //   크래시 경로는 `dispose()`를 안 지나간다. 이걸 빼면 죽은 세션의 자격증명이 등록표에 영영 남고
  //   마지막 세션이 나가도 창구가 안 닫힌다.
  {
    const before = knowledgeBridgeStatus().registrations;
    const h = start();
    await h.rt.handshake();
    check(knowledgeBridgeStatus().registrations === before + 1, "⑥h 세션이 뜨면 창구에 하나 등록된다", knowledgeBridgeStatus());
    const server = (h.rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    await server.request("test/exitAfterReply", { code: 9 }).catch(() => {});
    let after = -1;
    for (let i = 0; i < 100 && after !== before; i++) {
      after = knowledgeBridgeStatus().registrations;
      if (after !== before) await sleep(20);
    }
    check(after === before, "⑥h 프로세스가 예기치 않게 죽으면 그 토큰이 등록표에서 빠진다", { before, after });
    await h.rt.dispose();
  }

  // ── ⑥f 턴을 보내기 전에 중단하면 그 턴은 안 나간다(외부 검토 지적) ──
  //   회상 주입이 늦어지는 동안 사용자가 중단을 누르면, 예전에는 보낼 턴 식별자가 없어 아무 일도
  //   일어나지 않았고 몇 초 뒤 그 턴이 그대로 시작됐다.
  {
    const h = start({ turnContext: () => ["@@slowinject@@ 느린 주입"] });
    await h.rt.handshake();
    h.rt.push({ text: "이건 보내면 안 된다" });
    // 주입 요청이 나갈 때까지 기다렸다가 중단한다(아직 turn/start 전이다).
    let injected = false;
    for (let i = 0; i < 100 && !injected; i++) {
      injected = (await h.calls()).some((c) => c.method === "thread/inject_items");
      if (!injected) await sleep(20);
    }
    check(injected, "⑥f 회상 주입이 먼저 나간다");
    await h.rt.interrupt();
    await sleep(700); // 느린 주입이 끝나고 pump가 판단할 시간
    const calls = await h.calls();
    check(!calls.some((c) => c.method === "turn/start"), "⑥f 중단한 턴은 끝내 전송되지 않는다", calls.map((c) => c.method));
    check(
      h.events.some((e) => JSON.stringify(e.msg).includes("전달되지 않았다")),
      "⑥f 전달되지 않았다는 사실을 사용자에게 알린다(화면이 '생각 중'에 머물지 않게)",
      h.methodsOf(h.events),
    );
    await h.rt.dispose();
  }

  // ── ⑥g 스킬 목록 읽기가 실패해도 그 사이 들어온 변경 신호를 잃지 않는다(외부 검토 지적) ──
  {
    const h = start();
    await h.rt.handshake();
    const server = (h.rt as unknown as { server: { request: (m: string, p?: unknown) => Promise<unknown> } }).server;
    await server.request("test/skillsListFailSlow", { on: true });
    const before = (await h.calls()).filter((c) => c.method === "skills/list").length;
    await server.request("test/skillsChanged"); // 첫 갱신 시작(느리게 실패한다)
    await sleep(60);
    await server.request("test/skillsChanged"); // 실패가 끝나기 전에 다시 바뀐다
    let after = 0;
    for (let i = 0; i < 100 && after < before + 2; i++) {
      after = (await h.calls()).filter((c) => c.method === "skills/list").length;
      if (after < before + 2) await sleep(30);
    }
    check(after >= before + 2, "⑥g 실패한 갱신 뒤에도 밀린 변경 신호를 한 번 더 처리한다", { before, after });
    await h.rt.dispose();
  }

  // ── ⑥d 회상이 비어 있으면 아무것도 얹지 않는다 ──
  {
    const h = start({ turnContext: () => [] });
    h.rt.push({ text: "안녕" });
    check(await until(() => turnsDone(h) === 1), "⑥d 회상 없는 턴도 정상");
    check(!(await h.calls()).some((c) => c.method === "thread/inject_items"), "⑥d 얹을 게 없으면 요청 자체를 안 보낸다");
    await h.rt.dispose();
  }

  // ── ⑥j 지연 Promise turnContext: 완료 전 모델 입력 0, 완료 후 회상 포함 ──
  {
    let release!: (v: string[]) => void;
    const delayed = new Promise<string[]>((r) => {
      release = r;
    });
    const h = start({ turnContext: () => delayed });
    await h.rt.handshake();
    h.rt.push({ text: "배포해줘" });
    await sleep(120);
    const mid = await h.calls();
    check(!mid.some((c) => c.method === "turn/start"), "⑥j 회상 Promise 완료 전 turn/start 0", mid.map((c) => c.method));
    release(["지연회상-MARKER-CODEX"]);
    check(await until(() => turnsDone(h) === 1), "⑥j 회상 완료 후 턴이 끝난다");
    const calls = await h.calls();
    const inject = calls.find((c) => c.method === "thread/inject_items");
    check(!!inject, "⑥j 회상 주입이 나간다");
    check(JSON.stringify(inject?.params ?? {}).includes("지연회상-MARKER-CODEX"), "⑥j 주입에 회상이 실렸다");
    check(calls.some((c) => c.method === "turn/start"), "⑥j 회상 뒤에 turn/start");
    await h.rt.dispose();
  }

  // ── ⑦ 이어가기 ──
  {
    const h = start({ resumeKey: FAKE_THREAD_ID });
    await h.rt.handshake();
    const calls = await h.calls();
    check(calls.some((c) => c.method === "thread/resume"), "⑦ 이어가기 식별자가 있으면 스레드를 재개한다", calls.map((c) => c.method));
    check(!calls.some((c) => c.method === "thread/start"), "⑦ 새 스레드를 만들지 않는다");
    // 스레드 단위 설정이라 이어갈 때도 다시 넘겨야 한다 — 안 넘기면 재개한 세션만 조용히 지식툴을 잃는다.
    const resumeCfg = (calls.find((c) => c.method === "thread/resume")?.params.config as { mcp_servers?: Record<string, any> } | undefined)?.mcp_servers?.aether;
    check(String(resumeCfg?.http_headers?.Authorization ?? "").startsWith("Bearer "), "⑦ 이어가는 스레드에도 지식툴 창구가 다시 붙는다", resumeCfg?.url);
    await h.rt.dispose();
  }

  // ── ⑧ 중단 ──
  {
    const h = start();
    h.rt.push({ text: "@@slow@@ 오래 걸리는 일" });
    await until(() => h.methodsOf(h.events).includes("turn/started"));
    await h.rt.interrupt();
    check(await until(() => turnsDone(h) === 1, 8000), "⑧ 중단 후 턴이 끝난다");
    const last = h.events[h.events.length - 1].msg as { params: { turn: { status: string } } };
    check(last.params.turn.status === "interrupted", "⑧ 중단된 턴은 중단 상태로 끝난다", last.params.turn.status);
    check((await h.calls()).some((c) => c.method === "turn/interrupt"), "⑧ 중단 요청이 실제로 나간다");
    await h.rt.dispose();
  }

  // ── ⑨ 명령 실행 승인 카드 ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({
      onPermission: async (a) => {
        asks.push(a);
        return { allow: true };
      },
    });
    h.rt.push({ text: "@@ask@@ 지워줘" });
    check(await until(() => turnsDone(h) === 1, 8000), "⑨ 승인 요청이 있어도 턴이 매달리지 않는다");
    check(asks.length === 1, "⑨ 승인 요청이 카드로 올라온다", asks.length);
    check(asks[0]?.input.command === "rm -rf /tmp/demo", "⑨ 카드에 실행될 명령 전문이 실린다", asks[0]?.input);
    check(asks[0]?.input.cwd === "/tmp", "⑨ 어느 폴더에서 도는지도 실린다");
    check(asks[0]?.description === "위험한 명령입니다", "⑨ 왜 물어보는지가 실린다", asks[0]?.description);
    check(!!asks[0]?.displayName, "⑨ 카드 제목이 사람 말로 붙는다", asks[0]?.displayName);
    const answer = (await h.calls()).find((c) => c.method === "approvalAnswer");
    check((answer?.params as { decision?: string })?.decision === "accept", "⑨ 승인하면 accept로 답한다", answer?.params);
    await h.rt.dispose();
  }

  // ── ⑨b 거부하면 실제로 거부가 나간다 ──
  {
    const h = start({ onPermission: async () => ({ allow: false, message: "사용자가 거부" }) });
    h.rt.push({ text: "@@ask@@ 지워줘" });
    await until(() => turnsDone(h) === 1, 8000);
    const answer = (await h.calls()).find((c) => c.method === "approvalAnswer");
    check((answer?.params as { decision?: string })?.decision === "decline", "⑨b 거부하면 decline으로 답한다", answer?.params);
    await h.rt.dispose();
  }

  // ── ⑨c 네트워크 접근 승인 ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({
      onPermission: async (a) => {
        asks.push(a);
        return { allow: true };
      },
    });
    h.rt.push({ text: "@@net@@ 받아와줘" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks[0]?.input.host === "example.com" && asks[0]?.input.protocol === "https", "⑨c 어디로 나가는 연결인지 카드에 실린다", asks[0]?.input);
    await h.rt.dispose();
  }

  // ── ⑩ 파일 변경 승인 카드에 실제 diff가 실린다(8d-2 이월 ⓐ) ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({
      onPermission: async (a) => {
        asks.push(a);
        return { allow: true };
      },
    });
    h.rt.push({ text: "@@patch@@ 고쳐줘" });
    await until(() => turnsDone(h) === 1, 8000);
    const m = asks[0]?.mutation;
    check(!!m, "⑩ 파일 변경 카드에 미리보기가 붙는다", asks[0]);
    check(m?.path === "src/app.ts", "⑩ 어느 파일인지 나온다", m?.path);
    check((m?.hunks?.length ?? 0) === 1, "⑩ 변경 덩어리가 읽힌다", m?.hunks);
    check(m?.additions === 1 && m?.deletions === 1, "⑩ 더한 줄·지운 줄 수가 나온다", { add: m?.additions, del: m?.deletions });
    check(m?.hunks?.[0].lines.includes("+const a = 2") === true, "⑩ 바뀐 줄 내용이 그대로 보인다", m?.hunks?.[0].lines);
    await h.rt.dispose();
  }

  // ── ⑩b 비밀을 담은 파일의 변경 내용은 카드에도 안 보인다 ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({
      onPermission: async (a) => {
        asks.push(a);
        return { allow: false, message: "거부" };
      },
    });
    h.rt.push({ text: "@@secretpatch@@ 고쳐줘" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks[0]?.mutation?.redacted === true, "⑩b 비밀 파일의 변경 내용은 가려진다", asks[0]?.mutation);
    check(!JSON.stringify(asks[0]?.mutation).includes("new-2222"), "⑩b 실제 값이 카드에 새지 않는다");
    await h.rt.dispose();
  }

  // ── ⑩c 권한 확대 요청은 카드로 올리지 않는다(H1) ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({
      onPermission: async (a) => {
        asks.push(a);
        return { allow: true };
      },
    });
    h.rt.push({ text: "@@perm@@ 밖에도 쓸게" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks.length === 0, "⑩c 권한을 넓혀달라는 요청은 카드가 되지 않는다", asks.length);
    const granted = (await h.calls()).find((c) => c.method === "permissionsAnswer");
    check(JSON.stringify((granted?.params as { permissions?: unknown })?.permissions) === "{}", "⑩c 아무 권한도 더 주지 않는다", granted?.params);
    await h.rt.dispose();
  }

  // ── ⑪ 질문 카드 ──
  {
    const asks: QuestionAsk[] = [];
    const h = start({
      onQuestion: async (a) => {
        asks.push(a);
        return { answered: true, answers: [{ chosen: ["테스트"], custom: "임시 서버로" }] };
      },
    });
    h.rt.push({ text: "@@question@@ 배포해줘" });
    await until(() => turnsDone(h) === 1, 8000);
    check(asks.length === 1, "⑪ 질문이 카드로 올라온다", asks.length);
    check(asks[0]?.questions[0].header === "배포 대상", "⑪ 질문 제목이 전달된다", asks[0]?.questions[0]);
    check(asks[0]?.questions[0].options.map((o) => o.label).join(",") === "운영,테스트", "⑪ 선택지가 전달된다", asks[0]?.questions[0].options);
    const answered = (await h.calls()).find((c) => c.method === "questionAnswer");
    const given = (answered?.params as { answers?: Record<string, { answers: string[] }> })?.answers?.q1;
    check(given?.answers.join("|") === "테스트|임시 서버로", "⑪ 고른 선택지와 직접 적은 문장이 함께 돌아간다", given);
    await h.rt.dispose();
  }

  // ── ⑪b 턴이 끝나면 답을 못 받은 카드가 정리된다 ──
  {
    let aborted = false;
    const h = start({
      onPermission: (a) =>
        new Promise((resolve) => {
          a.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ allow: false, message: "중단" });
          });
        }),
    });
    h.rt.push({ text: "@@hang@@ 오래 걸리는 승인" });
    await until(() => turnsDone(h) === 1, 8000);
    check(await until(() => aborted, 3000), "⑪b 턴이 끝나면 보류 중인 카드에 취소 신호가 간다");
    await h.rt.dispose();
  }

  // ── ⑩ 프로세스가 죽으면 조용히 멈추지 않고, 쓰이지 못한 임시 파일도 남기지 않는다 ──
  {
    const h = start();
    await h.rt.handshake();
    const png = Buffer.from("가짜").toString("base64");
    h.rt.push({ text: "@@slow@@ 진행 중", images: [{ media_type: "image/png", data: png }] });
    h.rt.push({ text: "아직 못 보낸 것", images: [{ media_type: "image/png", data: png }] }); // 큐에서 대기
    const dir = path.join(process.env.AETHER_DATA_DIR!, ".attachments", h.sessionId);
    check(await until(() => fs.existsSync(dir) && fs.readdirSync(dir).length === 2, 5000), "⑩ 보내기 전 임시 파일이 만들어져 있다");
    const server = (h.rt as unknown as { server: { pid?: number } }).server;
    process.kill(server.pid!, "SIGKILL");
    check(await until(() => h.streamError !== null), "⑩ 프로세스가 죽으면 이벤트 스트림이 오류로 끝난다", String(h.streamError));
    check(String(h.streamError?.message).includes("예기치 않게 종료"), "⑩ 오류 메시지가 원인을 밝힌다", h.streamError?.message);
    // 프로세스가 죽으면 이 세션은 더 못 쓴다 — 큐에 남은 입력의 파일도 영영 소비되지 않으므로 지워야 한다.
    check(await until(() => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 3000), "⑩ 아직 못 보낸 입력의 임시 파일도 정리된다", fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    await h.rt.dispose();
  }

  // ── ⑪ 정리는 멱등이고 남기는 것이 없다 ──
  {
    const h = start();
    h.rt.push({ text: "안녕", images: [{ media_type: "image/png", data: Buffer.from("x").toString("base64") }] });
    await until(() => turnsDone(h) === 1);
    const dir = path.join(process.env.AETHER_DATA_DIR!, ".attachments");
    await h.rt.dispose();
    await h.rt.dispose();
    check(true, "⑪ 정리를 두 번 불러도 안전하다");
    const server = (h.rt as unknown as { server: { alive: boolean } }).server;
    check(!server.alive, "⑪ 정리 후 프로세스가 살아 있지 않다");
    const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    check(leftovers.length === 0, "⑪ 임시 첨부가 남지 않는다", leftovers);
  }

  // ── ⑫ 완료 알림이 시작 응답보다 먼저 와도 큐가 멈추지 않는다(외부 검토 지적) ──
  {
    const h = start();
    h.rt.push({ text: "@@instant@@ 첫 번째" });
    check(await until(() => turnsDone(h) === 1, 8000), "⑫ 순서가 뒤집혀 도착한 완료도 인식한다");
    // 이 상황을 놓치면 이미 끝난 턴이 '진행 중'으로 박혀 다음 메시지가 영원히 안 나간다.
    h.rt.push({ text: "두 번째" });
    check(await until(() => turnsDone(h) === 2, 8000), "⑫ 그 뒤 메시지도 정상 전송된다(큐 고착 없음)", turnsDone(h));
    const starts = (await h.calls()).filter((c) => c.method === "turn/start");
    check(starts.length === 2, "⑫ 두 턴 모두 전송됐다", starts.length);
    await h.rt.dispose();
  }

  // ── ⑫b 턴 전송이 거절되면 알리고, 뒤에 쌓인 메시지는 이어간다 ──
  {
    const h = start();
    h.rt.push({ text: "@@rejectturn@@ 실패할 메시지" });
    h.rt.push({ text: "그 다음 메시지" });
    check(await until(() => turnsDone(h) === 1, 8000), "⑫b 실패 뒤에도 다음 턴이 이어진다", turnsDone(h));
    const errs = h.events.filter((e) => (e.msg as { method?: string }).method === "error");
    check(errs.length === 1, "⑫b 전송 실패를 오류로 알린다", errs.length);
    const detail = JSON.stringify(errs[0]?.msg ?? {});
    check(detail.includes("전달하지 못했어요"), "⑫b 이 메시지가 상대에게 안 갔다는 사실을 문구로 밝힌다", detail.slice(0, 200));
    const starts = (await h.calls()).filter((c) => c.method === "turn/start");
    check(starts.length === 2, "⑫b 뒤 메시지는 실제로 전송된다", starts.length);
    await h.rt.dispose();
  }

  // ── ⑫c 우리가 처리하지 않는 역방향 요청에는 오류로 답한다 ──
  {
    const h = start();
    h.rt.push({ text: "@@unknown@@ 토큰 갱신 요청" });
    await until(() => turnsDone(h) === 1, 8000);
    const answered = (await h.calls()).find((c) => c.method === "unknownAnswer");
    check(!!(answered?.params as { error?: unknown })?.error, "⑫c 모르는 요청에 빈 성공이 아니라 오류로 답한다", answered?.params);
    await h.rt.dispose();
  }

  // ── ⑬ 승인 카드의 변경 미리보기에 없는 줄이 끼지 않는다 ──
  {
    const asks: PermissionAsk[] = [];
    const h = start({
      onPermission: async (a) => {
        asks.push(a);
        return { allow: true };
      },
    });
    h.rt.push({ text: "@@patch@@ 고쳐줘" });
    await until(() => turnsDone(h) === 1, 8000);
    const lines = asks[0]?.mutation?.hunks?.[0].lines ?? [];
    check(lines.length === 3, "⑬ 실제 diff 줄 수만큼만 나온다(유령 빈 줄 없음)", lines);
    check(!lines.some((l, i) => i === lines.length - 1 && l.trim() === "" && l.length <= 1), "⑬ 마지막이 빈 문맥 줄이 아니다", lines);
    await h.rt.dispose();
  }

  // ── ⑭ turnContext는 입력마다 그 글을 받는다 ──
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
    check(await until(() => turnsDone(h) === 2), "⑭ 입력 둘이 차례로 끝난다", turnsDone(h));
    check(seen[0] === "배포해줘" && seen[1] === "안녕", "⑭ turnContext는 입력마다 그 글을 받는다", seen);
    await h.rt.dispose();
  }
}

try {
  await main();
} catch (e) {
  check(false, "예상 못 한 오류로 중단", String((e as Error)?.stack ?? e));
} finally {
  for (const rt of open) await rt.dispose().catch(() => {});
  try {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  } catch {
    /* 임시 폴더 정리 실패는 무해 */
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} codex_runtime: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
