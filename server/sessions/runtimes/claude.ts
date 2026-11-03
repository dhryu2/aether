import { classifyServiceError } from '../../providers/claude/errorOrigin';
import { createClaudeTurnFailureTracker } from "../../providers/claude/turnFailure";
import { reportError } from "../../observability/report";
/**
 * ClaudeRuntime — Claude Code 세션 1개의 실행부(Phase 8d · D3).
 *
 * 8d 이전엔 이 코드가 LiveSession 생성자에 있었다. 옮긴 것뿐이며 동작은 동일하다:
 *   - `query()` 옵션 조립(cwd·모델·effort·권한모드·설정소스·MCP·시스템 프롬프트·resume)
 *   - 입력 큐(실행 중 새 메시지는 다음 턴에서 소비 — 끼어들기 없음)
 *   - 권한 왕복(canUseTool) + AskUserQuestion을 질문 카드로 우회
 *   - 프롬프트 제출 훅(UserPromptSubmit)으로 매 턴 컨텍스트 주입
 *
 * provider 전용 지식이 이 파일 밖으로 새지 않게 하는 것이 목적이다. 특히:
 *   - AskUserQuestion을 "거부 + 답변 메시지"로 되돌리는 우회는 Claude 고유 수법이라 여기 있다.
 */
import { randomUUID } from "node:crypto";
import type { PermissionMode as SdkPermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeSdk } from "../../providers/claude/sdk";
import { config } from "../../config";
import type { PermissionMode } from "../../../shared/http";
import { st } from "../../i18n";
import type { Entry } from "../../i18n/types";
import { claudeModelTraits } from "../../providers/claude/modelTraits";
import { resolveClaudeBin } from "../../auth/claudeLogin";
import { buildKnowledgeTools } from "../../knowledge/tools";
import { buildAetherMcpServer, claudeToolName } from "../../providers/claude/knowledgeMcp";
import { claudeServices } from "../../providers/claude/services";
import { modelEnv } from "../../providers/modelEnv";
import { claudePermissionPolicy } from "../../providers/claude/permissionPolicy";
import { compactOutcome, endsClaudeTurn } from "../../providers/claude/compactSignal";
import { buildMutationPreview, isSecretToolInput, redactToolInputContent } from "../../providers/claude/mutationPreview";
import { parseAskQuestions } from "../questionParse";
import type { AetherQuestion, DocAttachment, ImageAttachment, RawProviderEventBody, SessionEffort } from "../../types";
import type {
  AgentRuntime,
  ContextUsage,
  LocalizedText,
  NormalizedUserInput,
  PermissionPolicy,
  ProviderUsage,
  QuestionAnswer,
  RuntimeCommand,
  RuntimeCommandInvocation,
  RuntimeCommandOperation,
  RuntimeCommandResult,
  RuntimeCapabilities,
  RuntimeHandshake,
  RuntimeStartOptions,
  UsageWindow,
} from "../../providers/types";

// Claude가 구독 화면에 쓰는 실제 한도 창만 표시한다. SDK의 실험적 usage 응답에는
// 내부 배열·설정 블록도 섞일 수 있으므로, 이름 없는 `limit-1` 같은 항목을 UI까지 보내지 않는다.
const DISPLAYABLE_RATE_LIMIT_KEYS = new Set([
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "extra_usage",
]);

function modelScopedLimitLabel(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof (raw as { display_name?: unknown }).display_name === "string"
    ? (raw as { display_name: string }).display_name.trim()
    : "";
  // 서버가 모델 이름을 주지 않을 때의 내부 배열 번호는 사용자에게 의미가 없다.
  return label && !/^limits?(?:[\s_-]*\d+)?$/i.test(label) ? label : null;
}

/**
 * 강도 값 → 사람이 읽는 설명 (8i).
 *
 * Claude SDK는 강도 **이름만** 준다(`RuntimeModel.supportedEffortLevels: string[]`). Codex처럼 설명을
 * 함께 주지 않으므로, 그 어휘를 쓰는 이 어댑터가 문구를 소유한다. 8i 전엔 이 표가 화면에 있었고
 * (`EffortPicker`의 `EFFORT_DESC_KEY`) 그래서 프론트가 Claude 어휘를 알고 있었다.
 *
 * ★ `st()`·`pick()`으로 **고르지 않는다** — 둘 다 프로세스 전역 로케일 하나를 읽으므로, 폰과 노트북이
 *   다른 언어일 때 REST 응답이 어긋난다. 표 전체를 실어 보내고 언어 선택은 화면이 한다.
 *   타입만 `Entry`를 빌려 써서 ko/en 누락을 컴파일 타임에 막는다.
 *
 * 목록에 없는 값(SDK가 새 강도를 추가한 경우)은 설명 없이 이름만 나간다 — 지어내지 않는다.
 */
const EFFORT_DESCRIPTIONS = {
  low: { ko: "빠른 응답", en: "Fast response" },
  medium: { ko: "균형", en: "Balanced" },
  high: { ko: "깊은 추론", en: "Deep reasoning" },
  xhigh: { ko: "더 깊은 추론", en: "Deeper reasoning" },
  max: { ko: "최대 추론", en: "Max reasoning" },
} satisfies Record<string, Entry>;

/** SDK가 준 강도 이름들 중 우리가 문구를 아는 것만 골라 설명 표를 만든다. 아는 게 없으면 아예 안 싣는다. */
export function effortDescriptionsFor(levels: readonly string[] | undefined): Record<string, LocalizedText> | undefined {
  if (!levels?.length) return undefined;
  const out: Record<string, LocalizedText> = {};
  for (const level of levels) {
    const byLocale = EFFORT_DESCRIPTIONS[level as keyof typeof EFFORT_DESCRIPTIONS];
    if (byLocale) out[level] = { byLocale };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * effort → 런타임 flag settings(applyFlagSettings용).
 *   값이 실제로 이 모델에서 되는지는 SDK가 판정한다 — 서버는 목록을 들고 있지 않는다.
 *   max: Settings.effortLevel 타입이 'xhigh'까지만(SDK 0.3.177 보수적 타입). as any로 런타임 전달(실제 처리 됨).
 */
export function effortToFlagSettings(effort: SessionEffort) {
  return { effortLevel: effort as any };
}

/**
 * 사용자가 고른 선택지를 모델이 읽을 한 문장으로 포맷(canUseTool deny message로 전달 — spike_f 검증).
 *
 * 8d-3 ⑥ⓒ: 제시한 선택지에서 고른 것과 사용자가 직접 적은 문장을 **구분해서** 적는다. 둘을 섞어 보내면
 * 모델은 자기가 내놓지 않은 문장도 자기 선택지 중 하나였다고 읽는다.
 */
function formatQuestionAnswer(questions: AetherQuestion[], answers: QuestionAnswer[]): string {
  const parts = questions.map((q, i) => {
    const a = answers[i];
    const bits = [...(a?.chosen ?? []).filter(Boolean)];
    if (a?.custom) bits.push(st("notice.proto.customAnswer", { text: a.custom }));
    const header = q?.header ? `[${q.header}] ` : "";
    return `${header}${q?.question ?? st("notice.proto.questionFallback", { n: i + 1 })} → ${bits.join(", ") || st("notice.proto.noAnswer")}`;
  });
  return st("notice.proto.userResponse", { parts: parts.join(" / ") });
}

export function makeInputQueue() {
  const q: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (text: string, images?: ImageAttachment[], documents?: DocAttachment[]) => {
    // 첨부(이미지/문서) 있으면 content를 블록 배열로(이미지·문서 먼저 → 텍스트). 없으면 기존처럼 문자열(호환).
    const hasAttach = (images && images.length) || (documents && documents.length);
    const content = hasAttach
      ? [
          ...(images ?? []).map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
          ...(documents ?? []).map((d) => ({ type: "document", source: { type: "base64", media_type: d.media_type, data: d.data }, title: d.name })),
          ...(text ? [{ type: "text", text }] : []),
        ]
      : text;
    q.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    wake?.();
    wake = null;
  };
  const close = () => {
    done = true;
    wake?.();
    wake = null;
  };
  async function* stream(): AsyncIterable<SDKUserMessage> {
    while (true) {
      if (q.length === 0) {
        if (done) return;
        await new Promise<void>((r) => (wake = r));
        if (done && q.length === 0) return;
      }
      yield q.shift()!;
    }
  }
  return { push, close, stream };
}

/** Aether 중립 권한 모드 → SDK 권한 모드. SDK 어휘는 이 어댑터 안에만 둔다. */
const CLAUDE_MODE: Record<PermissionMode, SdkPermissionMode> = {
  manual: "default",
  edits: "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
};

/** Claude Code가 모델 턴을 시작하지 않고 클라이언트 안에서 처리하는 내장 명령. */
const CLAUDE_LOCAL_COMMANDS = new Set(["clear", "compact", "context", "cost", "effort", "help", "model", "usage"]);
/** SDK 동적 목록과 별개로 Claude Code 파서가 제공하는 내장 명령. 이 어휘는 Claude adapter 안에만 둔다. */
const CLAUDE_BUILTIN_COMMANDS = ["clear", "compact", "context", "cost", "effort", "help", "init", "model", "review", "usage"] as const;
const CLAUDE_COMMAND_LABELS: Record<(typeof CLAUDE_BUILTIN_COMMANDS)[number], { ko: string; en: string; argKo?: string; argEn?: string }> = {
  clear: { ko: "대화 컨텍스트 초기화", en: "Clear conversation context" },
  compact: { ko: "대화 기록 압축", en: "Compact conversation history" },
  context: { ko: "컨텍스트 사용량 보기", en: "View context usage" },
  cost: { ko: "사용량·비용 보기", en: "View usage and cost" },
  effort: { ko: "생각 강도", en: "Thinking effort", argKo: "[생각 강도]", argEn: "[thinking effort]" },
  help: { ko: "도움말", en: "Help" },
  init: { ko: "CLAUDE.md 생성", en: "Generate CLAUDE.md" },
  model: { ko: "모델 변경", en: "Change model", argKo: "[모델 이름]", argEn: "[model name]" },
  review: { ko: "코드 리뷰", en: "Code review", argKo: "[대상]", argEn: "[target]" },
  usage: { ko: "사용량 보기", en: "View usage" },
};

function claudeBuiltinCommand(name: (typeof CLAUDE_BUILTIN_COMMANDS)[number]): RuntimeCommand {
  const label = CLAUDE_COMMAND_LABELS[name];
  return {
    name,
    description: { byLocale: { ko: label.ko, en: label.en } },
    argumentHint: label.argKo && label.argEn ? { byLocale: { ko: label.argKo, en: label.argEn } } : {},
    startsTurn: !CLAUDE_LOCAL_COMMANDS.has(name),
  };
}

export class ClaudeRuntime implements AgentRuntime {
  readonly provider = "claude" as const;
  /** Claude는 SDK 컨트롤로 모델·사용량 조회를 지원한다. 명령은 모든 runtime의 핵심 계약이다. */
  readonly capabilities: RuntimeCapabilities = { supportedModels: true, usage: true, planReview: false };

  private readonly opts: RuntimeStartOptions;
  private readonly input = makeInputQueue();
  /** SDK query 핸들. SDK를 쓰는 순간에야 불러오므로 promise다. 시험은 promise가 아닌 객체를 직접 넣기도 하므로 항상 `await`로 읽는다. */
  private readonly qh: Promise<Query>;
  /** 카드 없이 자동 허용할 지식툴의 *Claude 기준* 이름. 접두사(mcp__aether__)가 Claude MCP 규약이라 여기서 판정한다. */
  private readonly autoApproveTools: ReadonlySet<string>;
  /** `/compact`처럼 모델 턴이 아닌 단독 명령 작업. SDK 압축 결과 신호와 짝짓는다. */
  private commandOperation: RuntimeCommandOperation | null = null;
  /**
   * 넣은 입력의 `result`를 다 받았는가. `/compact`를 진행 중인 턴 뒤에 줄 세우면 그 턴의 `result`가 압축
   * 작업을 닫아 버리므로, Codex처럼 쉬고 있을 때만 받는다. 입력 여러 개가 한 턴으로 합쳐져도 `result`에서
   * 참으로 돌아오므로, 틀리더라도 영원히 막히는 쪽이 아니라 받아 주는 쪽으로 틀린다.
   */
  private idle = true;
  /** 지금 적용 중인 권한 모드. 시작값은 opts에서 오고 `setPermissionMode`로 바뀐다. */
  private permissionMode: PermissionMode;
  /** 지금 모델(미지정 = 계정 기본). 자동 모드 지원 여부를 이 모델 기준으로 판정한다. */
  private model: string | undefined;
  /** 시작 때 자동 모드로 올리는 시도가 끝났다는 신호. 목록·현재 모드는 이걸 기다린 뒤 답한다. */
  private readonly autoStart: Promise<void>;
  /** 새 세션의 첫 턴 전이고 사용자가 모드를 정하지 않았다. 이 동안은 모델이 바뀔 때마다 자동 여부를 다시 정한다. */
  private autoDefault: boolean;

  constructor(opts: RuntimeStartOptions) {
    this.opts = opts;
    this.model = opts.model;
    // SDK는 자동 모드 지원 여부를 모델 목록으로 알려 준다. 목록은 띄운 뒤에야 알 수 있어 일단 수동으로 띄우고 올린다.
    //   넓은 권한(편집 자동 수락·권한 무시)은 사용자가 명시한 시작값만 바로 적용한다.
    const wanted = opts.permissionMode;
    this.permissionMode = wanted === "edits" || wanted === "full" ? wanted : "manual";
    // 지식툴은 provider 중립 서술자로 정의돼 있고(D8.1), 여기서 Claude in-process MCP로 옮긴다.
    //   cwd·services는 서술자 스키마에 없는 세션 컨텍스트로 넘어간다(모델이 인자로 못 줌 — D8 보안 경계).
    //   보조 모델은 이 세션 provider의 것이다(Claude 세션이므로 claudeServices — D6).
    const knowledgeTools = buildKnowledgeTools();
    this.autoApproveTools = new Set(knowledgeTools.filter((t) => t.autoApprove).map(claudeToolName));
    const promptAppend = this.buildSystemPromptAppend();
    // 매 턴 훅 — 회상이나 스킬 힌트가 있을 때만 건다.
    const wantsTurnHook = !!opts.turnContext;

    this.qh = this.open(opts, knowledgeTools, promptAppend, wantsTurnHook);
    // 불러오기 실패는 handshake·events 등 qh를 기다리는 호출이 받는다. 아무도 기다리기 전에 거부가 처리되지
    //   않은 채 남으면 index.ts의 unhandledRejection 처리기가 서버를 내리므로, 여기서 한 번 받아 둔다.
    this.qh.catch(() => {});
    // 새 세션(미지정)과 저장된 자동 모드는 모델이 지원할 때 자동으로 올린다. 실패하면 수동을 유지한다.
    this.autoDefault = wanted === undefined;
    this.autoStart = wanted === undefined || wanted === "auto" ? this.tryAutoMode() : Promise.resolve();
  }

  /** 현재 모델이 자동 모드를 지원하는가. 목록에서 모델을 못 찾으면 지원하지 않는 것으로 본다. */
  private async autoSupported(): Promise<boolean> {
    const models = await (await this.qh).supportedModels();
    const row = this.model
      ? models.find((m) => m.value === this.model || m.resolvedModel === this.model)
      : models.find((m) => m.value === "default");
    return row?.supportsAutoMode === true;
  }

  private async tryAutoMode(): Promise<void> {
    try {
      if (!(await this.autoSupported())) return;
      await (await this.qh).setPermissionMode(CLAUDE_MODE.auto);
      this.permissionMode = "auto";
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "provider.claude.auto_mode", session_id: this.opts.sessionId }); console.error("[aether] Claude 자동 모드 전환 실패(수동 유지):", e);
    }
  }

  /** SDK를 불러와 query를 연다. 동기 준비는 생성자에서 끝났고, SDK 값이 필요한 부분만 여기서 한다. */
  private async open(
    opts: RuntimeStartOptions,
    knowledgeTools: ReturnType<typeof buildKnowledgeTools>,
    promptAppend: string,
    wantsTurnHook: boolean,
  ): Promise<Query> {
    const { query, createSdkMcpServer, tool } = await loadClaudeSdk();
    const aetherMcp = await buildAetherMcpServer({ createSdkMcpServer, tool }, knowledgeTools, {
      cwd: opts.cwd,
      services: claudeServices,
      sessionId: opts.sessionId,
      engine: this.provider,
      onTodoList: opts.onTodoList,
    });
    return query({
      prompt: this.input.stream(),
      options: {
        cwd: opts.cwd,
        // 모델에게 넘길 환경에서 이 허브의 비밀 변수를 걷어낸다(R21). 이 옵션은 환경을 **대체**하므로
        //   `modelEnv()`가 process.env 전부를 복사해 오고 비밀만 뺀다 — 사용자의 도구가 쓰던 값은 그대로다.
        env: modelEnv(),
        // 설치된 CLI를 스폰(SDK 자체 번들은 구버전 → 모델 별칭이 낡음). 최신 CLI를 써야 sonnet=Sonnet 5 등 최신 매핑 반영.
        pathToClaudeCodeExecutable: resolveClaudeBin(),
        // model 미지정이면 생략 → plain `claude`(계정 기본 모델). /model(setModel)로 세션 중 변경.
        ...(opts.model ? { model: opts.model } : {}),
        // effort 복원: max는 Options.effort로(Settings.effortLevel이 max 미포함), 나머지는 Settings.effortLevel.
        ...(opts.effort === "max" ? { effort: "max" as const }
          // 공통 effort는 provider별 문자열이고 SDK 타입은 그 부분집합만 표현한다 →
          // adapter 경계에 국소 캐스팅한다. 값의 유효성은 SDK가 판정한다.
          : opts.effort ? { settings: { effortLevel: opts.effort as any } }
          : {}),
        // full → `claude --dangerously-skip-permissions` 등가(SDK-native): 모든 권한 카드 우회.
        //   bypassPermissions는 SDK 안전장치상 allowDangerouslySkipPermissions:true 동반 필수.
        //   허용 플래그는 늘 켠다 — 세션 중에 우회로 바꾸려면 시작 때 켜져 있어야 한다. 이 플래그만으로는
        //   아무것도 우회되지 않는다. 실제 모드는 permissionMode가 정한다(spike_permission_mode로 확인).
        permissionMode: CLAUDE_MODE[this.permissionMode],
        allowDangerouslySkipPermissions: true,
        // 터미널 claude와 동일하게 user/project/local 설정을 전부 로드 → 유저 스코프 스킬(~/.claude/skills)·MCP(~/.claude.json의 codex 등)·
        //   서브에이전트(~/.claude/agents)·슬래시명령(~/.claude/commands)·~/.claude/CLAUDE.md가 복사 없이 그대로 뜬다(spike_user_scope로 검증).
        //   유저 permissions.allow(자동승인 목록)도 존중 → 등록한 안전 패턴은 폰 카드 없이 실행(터미널 동일). 미등록 변이는 여전히 canUseTool(폰 카드)로 게이팅됨.
        //   플러그인도 이 경로로 enabledPlugins 토글 따라 로드된다(터미널과 동일 — 별도 강제 주입 없음).
        settingSources: ["user", "project", "local"],
        includePartialMessages: config.includePartialMessages, // 토큰 스트리밍(기본 off) — partial은 디스크 영속 제외(ingest)
        // aether MCP 툴(session_search 회상 + remember 영구기억) per-session 주입(cwd 바인딩). requestPermission에서 자동 허용.
        ...(aetherMcp ? { mcpServers: { aether: aetherMcp } } : {}),
        // 회상·메모리·스킬 안내를 기본 claude_code 프롬프트에 append. 생성 시 1회 고정.
        ...(promptAppend ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: promptAppend } } : {}),
        resume: opts.resumeKey,
        canUseTool: (toolName, toolInput, ctx): Promise<PermissionResult> => this.requestPermission(toolName, toolInput, ctx),
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        // UserPromptSubmit 훅 — 프롬프트 제출 직전, 이번 턴의 회상·스킬 힌트만 넣는다.
        //   세션 시작 안내와 달리 매 턴 발동한다. 사용자 글 원본은 바꾸지 않는다.
        ...(wantsTurnHook
          ? { hooks: { UserPromptSubmit: [{ hooks: [(input: unknown) => this.onUserPromptSubmit(input as { prompt?: string })] }] } }
          : {}),
      },
    });
  }

  /** 세션 시작 시 1회 고정되는 공통 안내. 없으면 빈 문자열. */
  private buildSystemPromptAppend(): string {
    return this.opts.systemAppend ?? "";
  }

  /**
   * UserPromptSubmit 훅 — 프롬프트 제출 직전, 공통 계층이 정한 이번 턴 배경만 넣는다.
   * 모델 입력에만 붙는다. 사용자 글, 저장본, 화면은 원본 그대로다.
   */
  private async onUserPromptSubmit(
    input: { prompt?: string },
  ): Promise<{ continue: true; hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string } }> {
    const prompt = (input.prompt ?? "").trim();
    if (!prompt) return { continue: true };
    const parts = this.opts.turnContext ? await Promise.resolve(this.opts.turnContext(prompt)) : [];
    if (!parts.length) return { continue: true };
    return { continue: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n\n") } };
  }

  /** canUseTool → 세션의 권한/질문 핸들러로 중계. 결정을 SDK 형식으로 되돌리는 것은 이쪽 책임. */
  private async requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: {
      signal: AbortSignal;
      displayName?: string;
      title?: string;
      toolUseID: string;
      description?: string;
      decisionReason?: string;
      blockedPath?: string;
    },
  ): Promise<PermissionResult> {
    // aether 지식툴(과거검색·영구기억·스킬생성)은 카드 없이 자동 허용 — 읽기/자체 파일 쓰기로 바운디드·안전하고,
    //   카드를 띄우면 흐름만 끊는다. 판정을 여기서 하는 이유: 이름의 mcp__aether__ 접두사가 Claude MCP 규약이라
    //   세션(중립 계층)이 알아야 할 지식이 아니다. Codex는 자기 브릿지 이름으로 같은 판정을 한다(8g).
    if (this.autoApproveTools.has(toolName)) return { behavior: "allow", updatedInput: toolInput };
    // AskUserQuestion(구조화 객관식)은 권한 카드가 아니라 질문 카드로 분기(allow/deny가 아닌 선택지 답).
    if (toolName === "AskUserQuestion") {
      const questions = parseAskQuestions((toolInput as { questions?: unknown }).questions);
      const out = await this.opts.onQuestion({ toolUseID: ctx.toolUseID, questions, signal: ctx.signal });
      // 헤드리스 SDK는 allow 시 'did not answer'로 자동응답하므로 사용자 선택을 deny+message로 모델에 전달(spike_f 검증).
      return { behavior: "deny", message: out.answered ? formatQuestionAnswer(questions, out.answers) : out.reason };
    }
    // 화면·기록에 나갈 인자와 변경 미리보기는 여기서 만든다(8e). 도구 이름과 인자 이름을 아는 곳이 여기라서다 —
    //   공통 계층이 이 판정을 하면 다른 provider의 도구에서는 아무 일도 일어나지 않고 조용히 지나간다.
    const secret = isSecretToolInput(toolInput as { file_path?: unknown; notebook_path?: unknown });
    const out = await this.opts.onPermission({
      toolName,
      input: secret ? redactToolInputContent(toolInput) : toolInput,
      mutation: buildMutationPreview(toolName, toolInput, this.opts.cwd),
      displayName: ctx.displayName,
      title: ctx.title,
      toolUseID: ctx.toolUseID,
      description: ctx.description,
      decisionReason: ctx.decisionReason,
      blockedPath: ctx.blockedPath,
      signal: ctx.signal,
    });
    // ★ H1: allow는 항상 SDK가 준 원본 toolInput을 실행 인자로 되돌린다. 세션·클라이언트는 인자를 수정할 통로가 없다
    //   (승인한 카드 = 실제 실행 input 보장; 경로없는 툴 undefined===undefined fail-open + redact echo-back 차단).
    return out.allow ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: out.message };
  }

  /**
   * 프로세스가 떠서 대화를 받을 준비가 됐다는 최초 신호(계약: 턴 미소비 + 이벤트 스트림 무접촉).
   *
   * `supportedModels()`는 생성자가 이미 보낸 초기화 응답을 기다릴 뿐이라 턴이 필요 없다(실측 833~923ms).
   * 대화 이벤트를 기다리는 방법은 쓸 수 없다 — 첫 턴을 보내기 전엔 이벤트가 한 건도 안 오고,
   * `events()`를 여기서 순회하면 그 이벤트가 세션 본류에서 사라진다.
   */
  handshake(): Promise<RuntimeHandshake> {
    // SDK는 처음 연결 때 받은 목록을 그대로 돌려준다(`supportedModels`가 초기화 결과를 읽는다). 결과 객체를 하나로
    //   재사용해 Codex·Grok과 같게 둔다 — 공통 계층이 "같은 준비 신호"를 알아보고 옛 관측을 다시 기억하지 않는다.
    return (this.handshakeResult ??= this.readHandshake());
  }
  private handshakeResult: Promise<RuntimeHandshake> | undefined;

  private async readHandshake(): Promise<RuntimeHandshake> {
    // 실행 파일이 없으면 여기서 SDK의 영어 오류가 나온다. events()와 같게 안내 문구로 바꿔 던진다.
    let models;
    try {
      models = await (await this.qh).supportedModels();
    } catch (e) {
      throw e instanceof Error ? classifyServiceError(e) : e;
    }
    // resolvedModel을 반드시 옮겨 담는다 — 스트림이 싣는 모델 이름은 별칭이 아니라 이 정식 id라서,
    //   빠뜨리면 화면이 "지금 이 모델"을 목록에서 찾지 못한다.
    return {
      models: models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
        // Claude SDK에서만 `default` 별칭이 계정 기본 모델을 뜻한다. 그 어휘를 중립 계약 밖으로 내보내지 않는다.
        isDefault: m.value === "default",
        resolvedModel: m.resolvedModel,
        supportsEffort: m.supportsEffort,
        supportedEffortLevels: m.supportedEffortLevels,
        // SDK가 강도 설명을 안 주므로 이 어댑터가 채운다(8i — EFFORT_DESCRIPTIONS 주석 참고).
        supportedEffortDescriptions: effortDescriptionsFor(m.supportedEffortLevels),
        ...claudeModelTraits(m),
      })),
    };
  }

  /** provider 원본 이벤트 스트림. resume 키(session_id)는 가장 이른 메시지에서 캡처해 세션에 알린다. */
  async *events(): AsyncIterable<RawProviderEventBody> {
    const turnFailure = createClaudeTurnFailureTracker();
    try {
      const qh = await this.qh;
      for await (const msg of qh) {
        // 모든 SDK 메시지가 session_id 보유 → init 등 가장 이른 시점에 resume 키 캡처(긴 첫 턴 중 죽어도 복원).
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) this.opts.onResumeKey(sid);
        const failure = turnFailure(msg);
        if (failure) {
          void reportError(failure, { component: "session", operation: "session.turn", session_id: this.opts.sessionId, model: this.opts.model, provider: "claude" });
        }
        if (endsClaudeTurn(msg)) this.idle = true;
        const outcome = this.commandOperation ? compactOutcome(msg) : null;
        if (outcome) this.finishCommandOperation(outcome);
        const raw: { kind: "sdk"; msg: SDKMessage } = { kind: "sdk", msg };
        yield raw;
      }
    } catch (e) {
      throw e instanceof Error ? classifyServiceError(e) : e;
    } finally {
      // 프로세스가 죽거나 세션이 끝나면 압축 중 표시가 영원히 남지 않게 닫는다.
      this.finishCommandOperation("failed");
    }
  }

  push(input: NormalizedUserInput): void {
    this.idle = false;
    this.autoDefault = false;
    this.input.push(input.text, input.images, input.documents);
  }

  async interrupt(): Promise<void> {
    await (await this.qh).interrupt();
  }

  /** SDK stopTask — 뒤 작업 하나만 끝낸다(메인 턴은 건드리지 않는다). */
  async stopBackgroundTask(taskId: string): Promise<void> {
    try {
      await (await this.qh).stopTask(taskId);
    } catch (e) {
      throw e instanceof Error ? classifyServiceError(e) : e;
    }
  }

  /**
   * 입력 스트림 종료(→query 제너레이터 return→이벤트 루프 종료) + 진행 턴 중단. 멱등.
   * Claude는 첨부를 메시지에 실어 보내므로 지울 임시 파일이 없다(D3의 첨부 수명 계약 참조).
   */
  async dispose(): Promise<void> {
    this.input.close();
    // 이미 끝난 세션이면 reject하고, SDK를 못 불러온 세션이면 qh 자체가 reject한다 — 정리 실패가 삭제를 막지 않는다.
    try { await (await this.qh).interrupt(); } catch { /* 자원 정리 중 중단 거절은 허용한다. */ }
  }

  /** SDK 컨트롤 setModel — 다음 턴부터 적용(현재 진행 턴엔 영향 없음). */
  async setModel(model: string): Promise<void> {
    await (await this.qh).setModel(model);
    this.model = model;
    // 첫 턴 전의 새 세션이면 새 모델 기준으로 자동 여부를 다시 정한다. 이때는 낮춰도 경고하지 않는다(사용자가 고른 적 없는 기본값이다).
    if (this.autoDefault) await this.settleDefaultMode();
  }

  private async settleDefaultMode(): Promise<void> {
    try {
      const supported = await this.autoSupported();
      if (supported && this.permissionMode === "manual") {
        await (await this.qh).setPermissionMode(CLAUDE_MODE.auto);
        this.permissionMode = "auto";
      } else if (!supported && this.permissionMode === "auto") {
        await (await this.qh).setPermissionMode(CLAUDE_MODE.manual);
        this.permissionMode = "manual";
      }
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "provider.claude.auto_mode", session_id: this.opts.sessionId }); console.error("[aether] Claude 기본 권한 모드 재설정 실패:", e);
    }
  }

  /** SDK 컨트롤 applyFlagSettings(flag 레이어 병합) — 다음 턴부터 적용. */
  async setEffort(effort: SessionEffort): Promise<void> {
    await (await this.qh).applyFlagSettings(effortToFlagSettings(effort));
  }

  /** SDK 컨트롤 setPermissionMode — 다음 도구 호출부터 적용. 자동 모드는 현재 모델이 지원할 때만 받는다. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.autoStart;
    this.autoDefault = false; // 사용자가 정했다. 기본값 재설정은 더 하지 않는다.
    if (mode === "auto" && !(await this.autoSupported())) throw new Error(st("notice.permission.unavailable"));
    await (await this.qh).setPermissionMode(CLAUDE_MODE[mode]);
    this.permissionMode = mode;
  }

  /** 수동·편집 자동 수락·권한 무시는 늘 되고, 자동은 현재 모델이 지원할 때만 더한다. */
  async permissionModes(): Promise<{ modes: readonly PermissionMode[]; current: PermissionMode }> {
    await this.autoStart;
    const auto = await this.autoSupported();
    return { modes: auto ? ["manual", "edits", "auto", "full"] : ["manual", "edits", "full"], current: this.permissionMode };
  }

  /**
   * 현재 컨텍스트 창 점유량. result.usage는 한 턴의 모든 API 콜 토큰을 합산(멀티스텝 캐시리드 누적)이라
   * ctx 창을 초과해 100%로 고착된다. getContextUsage만이 "지금 컨텍스트에 실제 들어있는" 토큰을 준다.
   */
  async contextUsage(): Promise<ContextUsage> {
    const u = await (await this.qh).getContextUsage();
    return { totalTokens: u.totalTokens, maxTokens: u.maxTokens };
  }

  /**
   * 이 세션에 실제로 적용 중인 승인 정책 요약(8d-3 ⑥ⓕ).
   * Claude는 스폰 시 넘긴 `settingSources` 범위의 `permissions.allow`가 카드 앞단에서 도구를 통과시킨다 —
   * 그래서 여기 계산 근거도 같은 세 설정 파일이다. 동작은 안 바꾸고 요약만 돌려준다.
   */
  async effectivePermissionPolicy(): Promise<PermissionPolicy> {
    return claudePermissionPolicy(this.opts.cwd, this.permissionMode === "full");
  }

  /**
   * 세션 비용·구독 한도 사용률 — SDK usage(실험적)를 **중립 스키마로 옮겨** 돌려준다(8d-3 ④).
   *
   * SDK 응답은 창 종류마다 필드가 따로 있는 객체(`rate_limits.five_hour`·`seven_day_opus`…)인데,
   * 그대로 흘려보내면 프론트가 Claude 필드 이름을 알아야 한다. 여기서 목록으로 펴고 창 이름만 넘긴다.
   * 다만 SDK의 내부·이름 없는 항목은 사용자에게 의미가 없으므로 서버에서 제외한다.
   *
   * 실험적 API라 필드 부재를 방어한다(옵셔널 체이닝 + 기본값).
   */
  async usage(): Promise<ProviderUsage> {
    const u = await (await this.qh).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const limits = (u?.rate_limits ?? {}) as Record<string, unknown>;
    const windows: UsageWindow[] = [];
    const modelScoped = limits.model_scoped;
    if (Array.isArray(modelScoped)) {
      for (const raw of modelScoped) {
        const label = modelScopedLimitLabel(raw);
        if (!label) continue;
        const w = raw as { utilization?: number | null; resets_at?: string | null };
        windows.push({ key: label, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null });
      }
    }
    for (const [key, raw] of Object.entries(limits)) {
      if (!DISPLAYABLE_RATE_LIMIT_KEYS.has(key) || !raw || typeof raw !== "object") continue;
      // 나머지는 `{utilization, resets_at}` 모양의 창 하나. 그 형태가 아닌 항목(설정 블록 등)은 창이 아니다.
      const w = raw as { utilization?: number | null; resets_at?: string | null };
      if (!("utilization" in w)) continue;
      windows.push({ key, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null });
    }
    // 계약상 못 세는 provider는 이 필드를 비운다. 값이 실제로 온 경우에만 싣는다(0을 지어내지 않는다).
    const cost = u?.session?.total_cost_usd;
    return {
      ...(typeof cost === "number" ? { costUsd: cost } : {}),
      ...(u?.subscription_type ? { subscriptionType: u.subscription_type } : {}),
      windowsAvailable: !!u?.rate_limits_available && windows.length > 0,
      windows,
    };
  }

  /** SDK가 알려준 동적 명령 + Claude Code 내장 명령을 합친다. 원본 이벤트 모양은 codec만 읽는다. */
  async listCommands(): Promise<RuntimeCommand[]> {
    let rich: Awaited<ReturnType<Query["supportedCommands"]>> = [];
    try {
      rich = await (await this.qh).supportedCommands();
    } catch (error) {
      // SDK 조회가 잠깐 실패해도 검증된 내장 명령까지 메뉴에서 사라지지는 않게 한다. 동적 명령 누락은 로그로 남긴다.
      void reportError(error, { component: "session", severity: "warning", operation: "provider.claude.commands_list", session_id: this.opts.sessionId }); console.error("[aether] Claude 동적 명령 목록 조회 실패(내장 명령만 표시):", error);
    }
    const byName = new Map<string, RuntimeCommand>();
    for (const command of rich) {
      byName.set(command.name, {
        name: command.name,
        description: command.description ? { text: command.description } : {},
        argumentHint: command.argumentHint ? { text: command.argumentHint } : {},
        aliases: command.aliases,
        startsTurn: !CLAUDE_LOCAL_COMMANDS.has(command.name.toLowerCase()),
      });
    }
    for (const name of CLAUDE_BUILTIN_COMMANDS) {
      if (!byName.has(name)) byName.set(name, claudeBuiltinCommand(name));
    }
    return [...byName.values()];
  }

  /** Claude Code의 명령 파서는 입력 스트림 앞단에 있으므로, 검증된 명령만 그 통로에 넣는다. */
  async executeCommand(command: RuntimeCommandInvocation): Promise<RuntimeCommandResult> {
    const available = await this.listCommands();
    const wanted = command.name.toLowerCase();
    const found = available.find((c) => c.name.toLowerCase() === wanted || c.aliases?.some((a) => a.toLowerCase() === wanted));
    if (!found) return { accepted: false, error: st("notice.command.unsupported", { command: command.name }) };
    const args = command.arguments.trim();
    if (found.name === "compact") {
      if (this.commandOperation || !this.idle) return { accepted: false, error: st("notice.command.busy") };
      this.startCompactOperation();
    }
    this.push({ text: `/${found.name}${args ? ` ${args}` : ""}` });
    return { accepted: true, startsTurn: found.startsTurn };
  }

  async compactContext(): Promise<void> {
    this.startCompactOperation();
    this.push({ text: `/compact` });
  }

  /** Codex와 같은 공통 operation 사건으로 압축 시작을 알린다. 화면은 명령 이름을 몰라도 진행 카드를 그린다. */
  private startCompactOperation() {
    this.finishCommandOperation("failed");
    const operation: RuntimeCommandOperation = {
      operationId: randomUUID(),
      state: "started",
      detail: st("notice.command.compact.started"),
      blocksInput: true,
    };
    this.commandOperation = operation;
    this.opts.onCommandOperation?.(operation);
  }

  /** SDK 신호·스트림 종료를 한 곳에서 operation 완료 사건으로 바꾼다(멱등). */
  private finishCommandOperation(state: "completed" | "failed") {
    const operation = this.commandOperation;
    if (!operation) return;
    this.commandOperation = null;
    this.opts.onCommandOperation?.({ ...operation, state, detail: st(`notice.command.compact.${state}`) });
  }
}
