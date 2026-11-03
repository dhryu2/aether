import { codexTurnError } from './errorOrigin';
import { classifyError, isExpectedError } from '../../observability/event';
import { reportError } from "../../observability/report";
/**
 * Codex 배경 작업 — 도구를 못 쓰는 격리 실행기 (Phase 8f · D6).
 *
 * 배경 작업이란 대화 중 쉬는 틈에 도는 네 가지다: 기억 자동 저장(reflect)·기억 압축·검색 결과 요약·
 * 스킬 자동 생성. 넷 다 "긴 글을 주고 짧은 글을 받는" 단순한 일이라 도구가 전혀 필요 없고, 오히려
 * 도구가 붙어 있으면 위험하다 — 이 실행은 사용자에게 승인 카드를 띄우지 않기 때문이다.
 *
 * ## 격리 구성(8a에서 적대적으로 실증한 것을 그대로 구현한다 — 재설계 금지)
 *
 * 1. **임시 설정 폴더**를 새로 만들고 거기에 **인증 파일 하나만** 권한 0600으로 복사한다.
 *    사용자의 `~/.codex/config.toml`·MCP 서버·플러그인 설정은 하나도 물려받지 않는다.
 *    이게 없으면 사용자가 등록해 둔 MCP 서버(예: 코드를 실행해 주는 도구)를 통해 격리가 뚫린다 —
 *    8a 재검증에서 실제로 외부 파일의 비밀 문자열이 새어 나왔다.
 * 2. **공식 설정으로 도구를 제거한다**: 웹 검색·셸·앱·원격 플러그인·브라우저·컴퓨터 사용.
 *    (`tools.web_search=false`는 정식 키가 아니다 — `web_search="disabled"`가 정본이다.)
 * 3. **스레드는 일회용·읽기 전용·승인 안 물음·빈 작업 폴더·MCP 목록 비움**으로 시작한다.
 *    일회용이라 대화 기록이 디스크에 남지 않는다(사용자의 실제 대화 목록을 오염시키지 않는다).
 *
 * 이 셋을 함께 걸었을 때 8a 실측 결과는 MCP 서버 0개·도구 시도 0회·외부 비밀 비유출·기록 파일 증가 0이었다.
 * 하나만 빠져도 뚫린다 — 특히 "읽기 전용"만으로는 읽기 격리가 되지 않는다(§2 함정 3).
 *
 * ## 모델
 *
 * 운영자가 `AETHER_CODEX_DISTILL_MODEL`로 못 박으면 그 이름, 아니면 저장해 둔 이름, 그것도 없으면
 * 계정 기본 모델에게 "제일 싼 것"을 한 번 물어 정한다. 규칙은 Claude와 같은 모듈에 있다
 * (`providers/distillModel.ts`) — 다른 점은 이름 검증 방법뿐이다. Codex는 `model/list`가 정확한 목록을
 * 주므로 목록과 대조하면 되고, Claude처럼 "띄워 보고 알아내는" 우회가 필요 없다.
 *
 * 옵션 세 형태(배경 작업 모델 측정 계획 8절): 옵션이 없으면 위 규칙과 가장 낮은 추론 강도. 계정 기본이면 모델을
 * 지정하지 않는다. 명시면 목록과 대조해 없으면 `UnknownModelNameError`를 던지고, 추론 강도는 옵션 값(없으면 모델 기본값)이다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config";
import { st } from "../../i18n";
import { CLIENT_INFO, CodexAppServer } from "../../codex/appServer";
import { UnknownModelNameError, resolveAndApply, type DistillModelChoice } from "../distillModel";
import { modelEnv } from "../modelEnv";
import type { DistillOptions, RuntimeModel } from "../types";
import type { ModelListResponse } from "../../codex/protocol/v2/ModelListResponse";
import type { ThreadStartResponse } from "../../codex/protocol/v2/ThreadStartResponse";
import type { TurnStartResponse } from "../../codex/protocol/v2/TurnStartResponse";

/**
 * 프로세스 설정으로 끄는 도구들 — 공식 config reference의 실제 키다(8a 확정).
 * 이 배열이 곧 보안 계약이라 테스트가 글자 단위로 대조한다.
 */
export const DISTILL_CONFIG_OVERRIDES: readonly string[] = [
  'web_search="disabled"',
  "features.shell_tool=false",
  "features.apps=false",
  "features.remote_plugin=false",
  "features.browser_use=false",
  "features.computer_use=false",
  // 하위 에이전트 띄우기 — 글만 뽑는 일에 필요 없고, 붙어 있으면 우리가 안 보는 사이에 또 다른 모델
  //   실행이 생긴다. `multi_agent`가 공식 기능 이름이다. 예전에 쓴 `collab`은 존재하지 않아 CLI가
  //   오류 없이 무시했고, 따라서 실제로는 아무것도 끄지 못했다. 기본값이 현재 꺼진 v2도 이 계약이
  //   기본값에 기대지 않도록 함께 명시적으로 끈다.
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
];

/** 추론 강도는 낮은 쪽부터 고른다 — 짧은 글을 정해진 형식으로 뽑는 일에 깊은 추론이 필요 없다. */
const CHEAP_EFFORTS = ["minimal", "low"] as const;

/** 사용자의 진짜 설정 폴더(인증 파일을 여기서 복사해 온다). */
function sourceCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * 인증 파일 하나만 든 임시 설정 폴더를 만든다.
 *
 * 인증 파일이 없으면 여기서 멈춘다 — 없는 채로 띄우면 모델 호출이 인증 오류로 실패하는데, 그 실패는
 * "로그인이 안 돼 있다"가 아니라 알 수 없는 오류로 보인다. 이유를 분명히 말하고 끝내는 편이 낫다.
 */
export function makeIsolatedCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codex-distill-home-"));
  fs.chmodSync(dir, 0o700);
  try {
    const source = path.join(sourceCodexHome(), "auth.json");
    // 오류 문구에 절대 경로를 넣지 않는다 — 이 문구는 사용자 화면과 로그로 나간다.
    if (!fs.existsSync(source)) throw classifyError(new Error(st('notice.codex.distillNoAuth')), 'external_environment');
    const target = path.join(dir, "auth.json");
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    return dir;
  } catch (e) {
    // 복사·권한 설정이 실패해도 임시 폴더를 남기지 않는다(자격증명 복제본이 디스크에 남는 것을 막는다).
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 배경 작업 프로세스에 넘길 환경. 설정 폴더만 바꿔 끼운다.
 * 이 허브의 비밀 변수는 여기서도 빠진다(R21) — 도구가 없어 지금은 볼 방법이 없지만, 도구 제거가
 * 언젠가 뚫렸을 때 볼 것이 남아 있으면 안 된다.
 */
export function distillEnv(codexHome: string): NodeJS.ProcessEnv {
  return modelEnv({ CODEX_HOME: codexHome });
}

/** 이 모델이 받는 추론 강도 중 가장 낮은 것. 아무것도 안 받으면 undefined(모델 기본값). */
function cheapestEffort(models: ModelListResponse["data"], id: string): string | undefined {
  const efforts = models.find((m) => m.id === id)?.supportedReasoningEfforts ?? [];
  for (const want of CHEAP_EFFORTS) {
    if (efforts.some((e) => e.reasoningEffort === want)) return want;
  }
  return efforts[0]?.reasoningEffort;
}

/**
 * 이 실행에서 관측한 격리 상태. 격리가 성립하면 셋 다 비어 있다.
 *
 * 관측을 굳이 남기는 이유는 테스트 때문만이 아니다. 격리가 언젠가 깨지면(설정 키 이름이 바뀌거나
 * 새 도구가 기본으로 켜지거나) 아무 증상 없이 조용히 뚫린다 — 배경 작업은 화면에 안 보이기 때문이다.
 * 그래서 매 실행이 스스로를 관측하고, 하나라도 걸리면 로그로 크게 알린다.
 */
export type DistillObservation = {
  text: string;
  /** 모델이 시도한 도구 — 글만 뽑는 이 실행에서 나올 수 없는 종류의 항목 전부. */
  toolAttempts: string[];
  /** 이 실행에 붙어 있던 MCP 서버 이름. */
  mcpServers: string[];
  /** 일회용 스레드가 디스크에 남긴 경로(남기지 않으면 null). */
  threadPath: string | null;
  /** MCP 목록 조회 자체가 실패했으면 그 사유. 값이 있으면 위 `mcpServers`는 "0개"가 아니라 "모름"이다. */
  observeFailed: string | null;
};

/**
 * 글만 뽑는 이 실행에서 **정상적으로 나올 수 있는** 항목 종류 — 바깥 세상에 아무 자국도 남기지 않는 것들.
 *
 * 감시할 도구 목록을 대신 적는 방식은 쓰지 않는다. 그러면 Codex에 새 도구 종류가 생길 때마다 조용히
 * 빠져나가기 때문이다 — 생성 타입에는 `dynamicToolCall`·`collabAgentToolCall`·`imageView`·`imageGeneration`
 * 처럼 처음 목록에 없던 것들이 실제로 있다(2026-08-18 외부 검토 지적). 모르는 종류는 의심하는 쪽이 안전하다.
 *
 * 이름은 생성 타입 `codex/protocol/v2/ThreadItem.ts`의 것과 정확히 같아야 한다. 틀린 이름을 적으면 그
 * 항목이 매번 도구 시도로 잡혀 거짓 경보가 나거나, 반대로 감시가 헐거워진다 — `test:boundary`가 대조한다.
 */
export const HARMLESS_ITEM_TYPES: ReadonlySet<string> = new Set(["agentMessage", "reasoning", "userMessage", "plan"]);

/** 한 턴이 어떻게 끝났는가 — 성공만 성공으로 친다. */
type TurnEnd = { kind: "turn"; status: string; error?: {message: string; codexErrorInfo?: unknown} } | { kind: "processGone" };

/**
 * 프롬프트 1회 실행 → 모델이 낸 텍스트를 이어 붙여 돌려준다.
 *
 * `cwd`를 받지만 쓰지 않는다. 계약이 provider 공통이라 인자는 있고(Claude는 그 폴더에서 띄운다),
 * Codex 쪽은 D6이 **빈 작업 폴더**를 못 박았다 — 프롬프트에 필요한 내용이 이미 다 들어 있고, 폴더를
 * 열어 주면 그만큼 읽을 수 있는 것이 늘어난다.
 */
export async function runCodexDistill(prompt: string, cwd: string, opts?: DistillOptions): Promise<string> {
  const o = await runCodexDistillObserved(prompt, cwd, opts);
  if (o.toolAttempts.length || o.mcpServers.length || o.threadPath || o.observeFailed) {
    void reportError(new Error("배경 작업 도구 격리 실패 또는 확인 불가"), { component: "provider", operation: "provider.distill.isolation", provider: "codex" });
    console.error(
      "[aether] ⚠️ Codex 배경 작업의 도구 격리가 깨졌거나 확인되지 않았다 — 즉시 확인 필요:",
      JSON.stringify({ toolAttempts: o.toolAttempts, mcpServers: o.mcpServers, threadPath: o.threadPath, observeFailed: o.observeFailed }),
    );
  }
  return o.text;
}

/** 위와 같되 관측값까지 돌려준다 — 적대적 회귀(카나리)가 이 자리에서 격리를 반증한다. */
export async function runCodexDistillObserved(prompt: string, _cwd: string, opts?: DistillOptions): Promise<DistillObservation> {
  // ★ 임시 폴더를 하나라도 만든 뒤에는 반드시 정리해야 한다. 아래 `try`가 시작되기 전에 예외가 나면
  //   복제한 인증 파일이 디스크에 남으므로, 생성부터 바깥 try 안에 둔다(2026-08-18 외부 검토 지적).
  let codexHome: string | null = null;
  let emptyCwd: string | null = null;
  let server: CodexAppServer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let text = "";
  const toolAttempts: string[] = [];
  let mcpServers: string[] = [];
  let observeFailed: string | null = null;
  let threadPath: string | null = null;
  /** 이번 실행이 시간 상한에 걸려 우리가 프로세스를 내렸는가. */
  let timedOut = false;
  /** 지금 돌고 있는 턴이 어떻게 끝났는지 알릴 자리. 턴마다 새로 잡는다. */
  let turnEnded: ((how: TurnEnd) => void) | null = null;

  try {
    codexHome = makeIsolatedCodexHome();
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codex-distill-cwd-"));

    server = new CodexAppServer({
      configOverrides: DISTILL_CONFIG_OVERRIDES,
      env: distillEnv(codexHome),
      onNotification: (n) => {
        if (n.method === "item/started") {
          const type = (n.params as { item?: { type?: string } })?.item?.type;
          // ★ 아는 것만 통과시킨다. 감시할 도구 종류를 손으로 적어 두면 새 종류가 생길 때마다 조용히
          //   빠져나간다 — 격리는 "모르는 것은 의심한다"가 기본이어야 한다.
          if (type && !HARMLESS_ITEM_TYPES.has(type)) toolAttempts.push(type);
          return;
        }
        if (n.method === "item/completed") {
          const item = (n.params as { item?: { type?: string; text?: string; status?: string } })?.item;
          if (item?.type === "agentMessage" && typeof item.text === "string") text += item.text;
          // 시도가 어떻게 끝났는지도 남긴다 — "시도했지만 막혔다"와 "시도해서 됐다"는 대응이 다르다.
          //   유형만 적어 두면 나중에 로그를 봐도 어느 쪽이었는지 알 수 없다(8g 카나리에서 실제로 겪었다).
          else if (item?.type && !HARMLESS_ITEM_TYPES.has(item.type)) toolAttempts.push(`${item.type}:${item.status ?? "?"}`);
          return;
        }
        if (n.method === "turn/completed") {
          const status = (n.params as { turn?: { status?: string } })?.turn?.status ?? "unknown";
          const error = (n.params as {turn?: {error?: {message: string; codexErrorInfo?: unknown}}})?.turn?.error;
          turnEnded?.({ kind: "turn", status, error });
        }
      },
      // 도구가 없으니 승인·질문이 올 리 없다. 오면 우리가 모르는 상황이므로 오류로 답한다(빈 성공 금지).
      onServerRequest: async (r) => {
        throw new Error(`배경 작업 실행은 역방향 요청을 받지 않는다(${r.method})`);
      },
      onExit: () => turnEnded?.({ kind: "processGone" }),
    });

    // 행(hang) 방지 — 배경 작업이 무한히 매달리면 그 세션의 자동 캡처 전체가 멈춘다(Claude와 같은 규율).
    const owned = server;
    timer = setTimeout(() => {
      timedOut = true;
      console.error(`[aether] Codex 배경 작업이 ${config.distillTimeoutMs}ms를 넘겨 중단한다`);
      void owned.close();
    }, config.distillTimeoutMs);
    timer.unref?.();
    const sv = server;
    await sv.initialize(CLIENT_INFO);
    const list = await sv.request<ModelListResponse>("model/list", {});
    const models = (list.data ?? []).filter((m) => !m.hidden);
    const choices: DistillModelChoice[] = models.map((m) => ({ value: m.id, resolvedModel: m.model, displayName: m.displayName, description: m.description }));

    /** 일회용 스레드 하나를 열고 한 턴을 돌린다. 모델을 안 주면 계정 기본 모델이 답한다. */
    const runOnce = async (input: string, model?: string, effort?: string): Promise<string> => {
      const started = await sv.request<ThreadStartResponse>("thread/start", {
        cwd: emptyCwd,
        ...(model ? { model } : {}),
        ephemeral: true,
        sandbox: "read-only" as const,
        approvalPolicy: "never" as const,
        // 사용자 config의 MCP 서버를 물려받지 않는다 — 격리의 핵심이다(8a: 이걸 빼면 뚫렸다).
        config: { mcp_servers: {} },
      });
      // 이 스레드에 실제로 붙은 MCP 서버를 세어 둔다 — 모델을 안 부르는 조회라 비용이 없고,
      //   격리가 깨졌을 때 "무엇이 붙어 있었나"를 남기는 유일한 증거다.
      threadPath = (started.thread as { path?: string | null }).path ?? null;
      // ★ 조회가 실패하면 "0개"가 아니라 **모른다**로 남긴다. 실패를 빈 목록으로 바꾸면, 버전이 바뀌어
      //   조회 자체가 안 되는 상황이 "격리가 깨끗하다"는 관측으로 둔갑한다(fail-open 금지).
      mcpServers = await sv
        .request<{ data?: { name?: string }[] }>("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: started.thread.id })
        .then((r) => (r.data ?? []).map((s) => String(s.name ?? "")))
        .catch((e) => {
          observeFailed = String((e as Error)?.message ?? e);
          return [];
        });
      text = "";
      const done = new Promise<TurnEnd>((r) => (turnEnded = r));
      // 추론 강도는 턴에만 실린다(스레드 시작 인자에는 자리가 없다 — 생성 타입 확인).
      await sv.request<TurnStartResponse>("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: input, text_elements: [] }],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      const how = await done;
      // ★ 끝났다고 다 성공이 아니다. 중단·실패한 턴이나 프로세스 사망을 성공으로 돌려주면 호출자(reflect)가
      //   빈 결과를 정상 완료로 받아들이고 **그 대화 구간을 영영 다시 안 본다**(기억 하나가 통째로 유실).
      if (how.kind === "processGone") {
        throw timedOut ? classifyError(new Error(st('notice.codex.distillTimeout', { ms: String(config.distillTimeoutMs) })), 'external_environment') : new Error(st('notice.codex.distillProcessGone'));
      }
      if (how.status !== "completed") {
        const error = new Error(st("notice.codex.distillTurnFailed", { status: how.status }));
        if (how.error && isExpectedError(codexTurnError(how.error))) classifyError(error, 'external_environment');
        throw error;
      }
      return text;
    };

    // 쓸 모델을 정한다. 이름 검증은 목록 대조로 끝난다 — Codex는 `model/list`가 정확한 정본이다.
    const inList = (m: string) => choices.some((c) => c.value === m || c.resolvedModel === m);
    let chosen: string | undefined;
    let effort: string | undefined;
    if (opts?.use === "explicit") {
      // 거부되면 다른 모델로 넘어가지 않는다(측정하려는 칸이 조용히 바뀌면 안 된다).
      if (!inList(opts.model)) throw classifyError(new UnknownModelNameError(opts.model), "external_environment");
      chosen = opts.model;
      effort = opts.effort;
    } else if (opts?.use !== "account_default") {
      chosen = await resolveAndApply(
        "codex",
        choices,
        async (m) => {
          if (!inList(m)) throw classifyError(new UnknownModelNameError(m), "external_environment");
        },
        (p) => runOnce(p),
        (model, p) => runOnce(p, model),
      );
      effort = chosen ? cheapestEffort(models, chosen) : undefined;
    }

    const answer = (await runOnce(prompt, chosen, effort)).trim();
    return { text: answer, toolAttempts, mcpServers, threadPath, observeFailed };
  } finally {
    if (timer) clearTimeout(timer);
    await server?.close().catch(() => { /* 주 작업이 끝난 뒤 이미 닫힌 통신선의 정리 실패는 무해하다. */ });
    if (codexHome) removeTempDir(codexHome);
    if (emptyCwd) removeTempDir(emptyCwd);
  }
}

/** `model/list` 응답을 중립 줄로 옮긴다. 숨김 모델은 고를 수 없으므로 뺀다. */
function toRows(list: ModelListResponse): RuntimeModel[] {
  return (list.data ?? [])
    .filter((m) => !m.hidden)
    .map((m) => ({
      value: m.id,
      displayName: m.displayName,
      description: m.description,
      isDefault: m.isDefault,
      resolvedModel: m.model,
      supportsEffort: m.supportedReasoningEfforts.length > 0,
      supportedEffortLevels: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    }));
}

/**
 * 턴을 쓰지 않는 모델 목록 조회 — 배경 작업 측정용. 배경 작업과 같은 격리 구성으로 띄운다.
 * 숨김 모델은 고를 수 없으므로 뺀다(대화 런타임과 같은 기준). 별칭도 기본값 선택지도 없어서
 * 중립 필드는 채우지 않는다(`id`와 `model`이 다른 줄은 2026-10-15 실측에서 없었다).
 */
export async function listCodexBackgroundModels(): Promise<RuntimeModel[]> {
  let codexHome: string | null = null;
  let server: CodexAppServer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    codexHome = makeIsolatedCodexHome();
    server = new CodexAppServer({
      configOverrides: DISTILL_CONFIG_OVERRIDES,
      env: distillEnv(codexHome),
      onNotification: () => {},
      onServerRequest: async (r) => {
        throw new Error(`배경 작업 목록 조회는 역방향 요청을 받지 않는다(${r.method})`);
      },
      onExit: () => {},
    });
    const owned = server;
    timer = setTimeout(() => void owned.close(), config.distillTimeoutMs);
    timer.unref?.();
    await server.initialize(CLIENT_INFO);
    return toRows(await server.request<ModelListResponse>("model/list", {}));
  } finally {
    if (timer) clearTimeout(timer);
    await server?.close().catch(() => { /* 목록 조회가 끝난 뒤 이미 닫힌 통신선의 정리 실패는 무해하다. */ });
    if (codexHome) removeTempDir(codexHome);
  }
}

/**
 * 배경 작업이 쓰던 임시 폴더를 지운다 — **절대 예외를 밖으로 내보내지 않는다.**
 *
 * 왜 이렇게까지 하나(2026-08-19 실측): 이 정리가 `ENOTEMPTY`로 실패하는 일이 실제로 있었다. 우리가
 * 프로세스 종료를 기다린 뒤 지우는데도, 죽는 중인 codex가 그 폴더에 마지막 쓰기를 하면 재귀 삭제가
 * 걷는 도중에 파일이 다시 생긴다. 카나리에서 여섯 번에 한 번꼴로 재현됐다.
 *
 * 그때 예외가 `finally`를 뚫고 나가면 **이미 성공한 배경 작업의 결과가 통째로 버려졌다** — 그 턴에
 * 기억할 것을 찾아 놨어도 저장되지 않는다. 정리 실패는 결과를 버릴 이유가 못 된다.
 *
 * 그래도 폴더에는 **인증 파일 복제본**이 들어 있으므로 그냥 포기하지도 않는다. 잠깐 뒤 한 번 더
 * 시도하고(그 사이 상대가 완전히 죽는다), 그마저 실패하면 다음 부팅의 고아 정리가 치운다.
 */
export function removeTempDirForTest(dir: string): void {
  removeTempDir(dir);
}

function removeTempDir(dir: string): void {
  // maxRetries는 EBUSY·ENOTEMPTY 같은 경합 오류에 한해 물러났다 다시 시도한다(Node 문서).
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    return;
  } catch (e) {
    void reportError(e, { component: "providers", operation: "provider.codex.temp_remove" }); console.error("[aether] 배경 작업 임시 폴더 정리 실패(잠시 뒤 재시도):", e);
  }
  const later = setTimeout(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      // 여기까지 실패하면 인증 복제본이 남는다 — 다음 부팅의 고아 정리가 치운다(그 사실을 로그로 남긴다).
      void reportError(e, { component: "providers", operation: "provider.codex.temp_retry" }); console.error("[aether] 배경 작업 임시 폴더가 남았다(다음 부팅에 정리된다):", dir, e);
    }
  }, 2000);
  later.unref?.(); // 이 타이머가 서버 종료를 붙잡지 않게
}

/**
 * 부팅 시 고아 정리 — 프로세스가 강제 종료돼 위 `finally`가 못 돌았을 때 남은 임시 폴더를 치운다.
 * 그대로 두면 **복제된 인증 파일이 디스크에 영영 남는다**. 첨부 임시 파일과 같은 규율이다.
 */
export function purgeOrphanDistillHomes(): void {
  const tmp = os.tmpdir();
  for (const prefix of ["aether-codex-distill-home-", "aether-codex-distill-cwd-"]) {
    try {
      for (const name of fs.readdirSync(tmp)) {
        if (!name.startsWith(prefix)) continue;
        try {
          fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
        } catch {
          /* 다른 프로세스가 쓰는 중이면 건너뛴다 */
        }
      }
    } catch (e) {
      void reportError(e, { component: "providers", operation: "provider.codex.temp_cleanup" }); console.error("[aether] Codex 배경 작업 임시 폴더 청소 실패:", e);
    }
  }
}
