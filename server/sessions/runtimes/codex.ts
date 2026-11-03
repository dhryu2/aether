import { codexTurnError } from '../../providers/codex/errorOrigin';
import { reportError } from "../../observability/report";
/**
 * CodexRuntime — Codex 세션 1개의 실행부(Phase 8e · D3/D4/D5).
 *
 * `ClaudeRuntime`과 같은 계약을 채운다. 다른 점은 상대가 SDK 함수가 아니라 **별도 프로세스**라는 것뿐이고,
 * 그 프로세스와의 통신은 전부 `codex/appServer.ts`가 맡는다. 여기는 "세션 하나를 어떻게 굴리는가"만 안다.
 *
 * ── 지키는 규칙 ──
 * ① **턴은 한 번에 하나만 보낸다(D5.5).** 진행 중인 턴이 끝났다는 알림을 받기 전에는 다음 요청을 아예 보내지
 *    않는다. 8a 실측에서, 진행 중에 두 번째 턴을 시작하면 응답은 받지만 그 입력이 진행 중인 턴에 섞여
 *    들어가는 일이 있었다. 그래서 "실행 중 새 메시지는 다음 턴"이라는 Aether의 약속은 보내는 쪽에서 줄을
 *    세워야만 성립한다.
 * ② **임시 첨부 파일의 수명은 이 클래스가 책임진다(D3).** Codex는 이미지를 내용이 아니라 **경로**로 받기
 *    때문에 파일이 실제로 있어야 한다. 큐에서 기다리는 동안 살아 있어야 하고, 그 턴이 끝나면 지워야 하며,
 *    중단·크래시·세션 삭제 어디서도 남으면 안 된다.
 * ③ **작업 폴더 밖 쓰기 반경은 Claude와 같게 맞춘다.** Codex 기본 설정은 `/tmp`와 임시 폴더에 승인 없이
 *    쓸 수 있는데(8a 실측), Claude는 어느 경로든 파일을 쓰면 카드가 뜬다. 그대로 두면 같은 화면에서 고른
 *    provider에 따라 조용히 권한 반경이 달라지므로, 임시 폴더 예외를 끈다(유저 결정 2026-08-18).
 *
 * ── 여기서 하지 않는 것(다음 Phase) ──
 *   - 매 턴 자동 회상 주입(8g): 어느 통로로 넣을지가 아직 미확정이다(R4). 세션 시작 시 1회 고정되는
 *     안내문(`developerInstructions`)은 8a에서 정본으로 확정됐으므로 여기서 연결한다.
 *   - 크래시 후 재기동: 이 클래스가 스스로 다시 띄우지 않는다. 프로세스가 죽으면 이벤트 스트림을 오류로
 *     끝내고, 세션은 기존 공통 경로(끝난 세션 + 이어가기 식별자 → 다음 메시지에서 재생성)로 되살아난다.
 *     그 경로가 이미 `thread/resume`을 태우므로 같은 일을 두 벌로 만들지 않는다.
 */
import { randomUUID } from "node:crypto";
import { st } from "../../i18n";
import { CLIENT_INFO, CodexAppServer, type CodexNotification, type CodexServerRequest } from "../../codex/appServer";
import { AttachmentStore, type MaterializedAttachment } from "../attachments";
import { buildKnowledgeTools } from "../../knowledge/tools";
import { projectSkillsDir, userSkillsDir } from "../../skill/skillPaths";
import { openKnowledgeBridge, type KnowledgeBridge } from "../../providers/knowledgeBridge";
import { codexThreadConfig } from "../../providers/codex/knowledgeThreadConfig";
import { changesInsideFolder, codexModePolicy, codexPermissionPolicy, type ConfigOrigins } from "../../providers/codex/permissionPolicy";
import type { PermissionMode } from "../../../shared/http";
import { codexServices } from "../../providers/codex/services";
import { modelEnv } from "../../providers/modelEnv";
import { previewFromUnifiedDiff } from "../mutationPreview";
import { mapQuestionOption } from "../questionParse";
import type { DocAttachment, ImageAttachment, RawProviderEventBody, SessionEffort } from "../../types";
import type {
  AgentRuntime,
  ProviderId,
  ProviderServices,
  ContextUsage,
  NormalizedUserInput,
  PermissionPolicy,
  ProviderUsage,
  RuntimeCommand,
  RuntimeCommandInvocation,
  RuntimeCommandOperation,
  RuntimeCommandResult,
  RuntimeCapabilities,
  RuntimeHandshake,
  RuntimeModel,
  RuntimeStartOptions,
  UsageWindow,
} from "../../providers/types";
import type { ServerNotification } from "../../codex/protocol/ServerNotification";
import type { CommandExecutionRequestApprovalParams } from "../../codex/protocol/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "../../codex/protocol/v2/FileChangeRequestApprovalParams";
import type { ToolRequestUserInputParams } from "../../codex/protocol/v2/ToolRequestUserInputParams";
import type { ConfigReadResponse } from "../../codex/protocol/v2/ConfigReadResponse";
import type { GetAccountRateLimitsResponse } from "../../codex/protocol/v2/GetAccountRateLimitsResponse";
import type { ModelListResponse } from "../../codex/protocol/v2/ModelListResponse";
import type { ReviewStartResponse } from "../../codex/protocol/v2/ReviewStartResponse";
import type { ReviewTarget } from "../../codex/protocol/v2/ReviewTarget";
import type { SkillsListResponse } from "../../codex/protocol/v2/SkillsListResponse";
import type { SandboxPolicy } from "../../codex/protocol/v2/SandboxPolicy";
import type { ThreadStartResponse } from "../../codex/protocol/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "../../codex/protocol/v2/ThreadResumeResponse";
import type { TurnStartResponse } from "../../codex/protocol/v2/TurnStartResponse";
import type { UserInput } from "../../codex/protocol/v2/UserInput";

/**
 * 세션 대화가 아닌 알림 — 아예 세션 이벤트로 만들지 않는다.
 * 계정 변경·MCP 연결 상태 같은 것들이다. 대화 기록에 섞이면 디스크에 영구 보관되고 검색에도 걸린다.
 * 단, 사용 한도 갱신은 대화 도중의 차단 이유를 보여 주고 새로 고친 뒤에도 복원해야 하므로 예외다.
 */
const IRRELEVANT_PREFIXES = ["account/", "mcpServer/", "remoteControl/", "app/", "fuzzyFileSearch/", "thread/realtime/", "externalAgentConfig/", "windows", "skills/"];
const IRRELEVANT_EXACT = new Set(["fs/changed", "rawResponse/completed", "rawResponseItem/completed"]);
function isSessionIrrelevant(method: string, hasUsage: boolean): boolean {
  // `account/*` 중 유일한 예외다. 이 알림만 현재 대화의 한도 차단 배너와 그 복원에 필요하다.
  //   단 한도가 없는 공급처(로컬 Ollama)에서도 Codex는 이 알림을 보낸다(실측). 그때는 의미 없는 값이라 버린다.
  if (method === "account/rateLimits/updated") return !hasUsage;
  return IRRELEVANT_EXACT.has(method) || IRRELEVANT_PREFIXES.some((p) => method.startsWith(p));
}

/** app-server의 현재 정본인 압축 항목 완료 알림인가. 고유 payload 판정은 이 adapter 밖으로 내보내지 않는다. */
function isContextCompactionCompleted(n: CodexNotification): boolean {
  if (n.method !== "item/completed" || typeof n.params !== "object" || n.params === null) return false;
  const item = (n.params as { item?: { type?: unknown } }).item;
  return item?.type === "contextCompaction";
}

/**
 * 이 세션 프로세스에 못 박는 실행별 설정 (Phase 8g · D5.4).
 *
 * **질문 카드를 켜는 스위치 둘이다.** 8e는 질문이 오면 카드로 바꿔 답을 되돌리는 배선까지 했지만
 * 실행별 설정을 하나도 지정하지 않았다. 그래서 이 두 값이 사용자 전역 설정에 없는 환경에서는 모델이
 * 질문 요청 자체를 못 보내고 **카드가 아예 안 뜬다**(8e 외부 검토 지적). 사용자 설정에 기대지 않고
 * 우리가 매번 켠다 — 같은 화면에서 고른 provider에 따라 되는 기능이 달라지면 안 된다.
 *
 * ⚠️ 이 기능은 개발 중 표시가 붙어 있다(위험 R1·R14). codex 0.145.0에서 실동작을 확인했고,
 * 버전이 바뀌면 이름이나 동작이 달라질 수 있다. `test:boundary`가 설치된 CLI 버전이 핀과 같은지
 * 확인하고, 이 문자열이 통째로 바뀌면 같은 검사가 실패한다.
 */
export const SESSION_CONFIG_OVERRIDES: readonly string[] = [
  "tools.experimental_request_user_input.enabled=true",
  "features.default_mode_request_user_input=true",
];

/** 첨부의 MIME 형식 → 파일 확장자. 모르는 형식은 확장자 없이 둔다(경로만 넘기므로 동작에 지장 없음). */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};
function extOf(mediaType: string): string {
  return EXT_BY_MIME[mediaType] ?? ".bin";
}

/**
 * 큐에 들어간 한 턴 — 입력과 그 입력이 쓰는 임시 파일들. 파일은 이 턴이 끝난 뒤에 지운다.
 * `prompt`는 사용자가 실제로 친 글이다(첨부 안내가 붙기 전). 매 턴 회상이 무엇을 찾을지 정하는 근거라
 * 따로 들고 있는다 — 우리가 덧붙인 문구까지 검색어로 쓰면 회상이 자기 꼬리를 문다.
 */
type QueuedTurn = { input: UserInput[]; files: MaterializedAttachment[]; prompt: string };

/**
 * Aether가 app-server RPC로 의미를 정확히 보존해 실행하는 Codex 명령.
 * 공식 명령표를 복사한 목록이 아니다. 새 RPC 매핑을 구현하면 이 adapter의 표에만 추가한다.
 */
const CODEX_COMMANDS: readonly RuntimeCommand[] = [
  {
    name: "compact",
    description: { byLocale: { ko: "대화 기록 압축", en: "Compact conversation history" } },
    argumentHint: {},
    startsTurn: false,
  },
  {
    name: "review",
    description: { byLocale: { ko: "코드 리뷰", en: "Code review" } },
    argumentHint: { byLocale: { ko: "[base <브랜치> | commit <SHA> | 지시문]", en: "[base <branch> | commit <sha> | instructions]" } },
    aliases: ["code-review"],
    startsTurn: true,
  },
];

/**
 * 이 실행기를 어느 모델 공급처로 띄우는가.
 *
 * Codex 실행기는 모델 공급처를 바꿔 끼울 수 있다. Ollama provider는 이 실행기를 그대로 쓰고 모델만
 * 로컬 Ollama로 돌린다. 공급처마다 다른 것은 아래 값뿐이고, 턴·승인·이어가기 처리는 같다.
 * 공급처 지식은 각 provider 어댑터가 이 값으로 넘긴다 — 여기는 값의 의미를 모른다.
 */
export type CodexBackend = {
  provider: ProviderId;
  /** 지식툴 검색 요약 같은 배경 작업이 쓸 서비스. 세션 provider를 따라야 한다(D6). */
  services: ProviderServices;
  capabilities: RuntimeCapabilities;
  /** 세션 프로세스에 더 얹는 실행별 설정. */
  configOverrides: readonly string[];
  /** 모델 프로세스 환경에 더 얹는 값(예: 설정 폴더). 비밀 걸러내기 뒤에 얹힌다. */
  env: Record<string, string>;
  /**
   * 있으면 Codex의 `model/list` 대신 이 목록을 쓴다. 공급처를 바꾸면 Codex 목록은 그 공급처 모델이 아니다.
   * 목록에 `isDefault`가 있고 세션이 모델을 안 골랐으면 그 모델로 시작한다.
   */
  listModels?: () => Promise<RuntimeModel[]>;
  /**
   * 있으면 이 모델의 실제 대화 길이(토큰)다. 대화를 열 때 Codex에 알려 준다.
   *
   * Codex는 공급처 모델의 길이를 모른다. 모르면 넘치기 전에 압축하지 못하고, 공급처가 앞부분을 조용히
   * 잘라낸다. 이 값은 대화를 열 때만 반영된다(실측: 대화 도중 모델만 바꾸거나 같은 프로세스에서 다시 열어도
   * 그대로다). 그래서 길이가 다른 모델로는 세션 도중에 바꾸지 않는다.
   */
  contextWindow?: (model: string) => Promise<number>;
  /** 공급처의 자동 검토(AI가 안전한 요청을 대신 승인)를 쓸 수 있는가. 있으면 권한 모드에 자동이 생기고 새 세션이 자동으로 시작한다. */
  autoReview: boolean;
  /** 이 공급처의 모델이 파일 변경마다 승인 요청을 보내는가. 안 보내면 편집 자동 수락이 의미가 없어 목록에서 뺀다. */
  fileChangeApproval: boolean;
};

/** 기본 공급처 — Codex 계정. */
export const CODEX_BACKEND: CodexBackend = {
  provider: "codex",
  services: codexServices,
  /** Codex는 모델·사용량 조회를 지원한다. 명령은 모든 runtime의 핵심 계약이다. */
  capabilities: { supportedModels: true, usage: true, planReview: false },
  configOverrides: [],
  env: {},
  autoReview: true,
  fileChangeApproval: true,
};

/** 이름 바꾸기의 도착 경로. 폴더 안 판정에 원래 경로와 함께 넣는다. */
function movePathOf(kind: { type: string; move_path?: string | null }): { movePath?: string } {
  return kind.type === "update" && kind.move_path ? { movePath: kind.move_path } : {};
}

export class CodexRuntime implements AgentRuntime {
  readonly provider: ProviderId;
  readonly capabilities: RuntimeCapabilities;

  private readonly backend: CodexBackend;
  private readonly opts: RuntimeStartOptions;
  private readonly attachments: AttachmentStore;
  private readonly server: CodexAppServer;
  /**
   * 이 세션의 지식툴 창구(과거검색·기억·스킬). 켜진 도구가 없으면 null이다.
   * 자격증명은 스레드 시작 설정으로만 넘어간다 — 환경변수·실행 인자에 두지 않는다(8g 실측 근거는
   * `providers/knowledgeBridge.ts` 머리 주석).
   */
  private bridge: KnowledgeBridge | null = null;

  private booted: Promise<RuntimeHandshake> | null = null;
  private threadId: string | null = null;
  private models: RuntimeModel[] = [];
  private model?: string;
  /** 이 대화를 열 때 Codex에 알린 대화 길이. 공급처가 길이를 알려 주지 않으면 없다. */
  private window?: number;
  private effort?: SessionEffort;
  /** 지금 적용 중인 권한 모드. 시작값은 opts에서 오고 `setPermissionMode`로 바뀐다. */
  private permissionMode: PermissionMode;

  private readonly queue: QueuedTurn[] = [];
  private activeTurnId: string | null = null;
  private activeFiles: MaterializedAttachment[] = [];
  private pumping = false;
  /** 턴 시작 요청을 보내 놓고 응답을 기다리는 중인가 — 아래 `completedBeforeAck`와 짝이다. */
  private startingTurn = false;
  /** 큐에서 꺼내 회상까지 얹었지만 아직 `turn/start`를 안 보낸 구간인가(중단 처리에 쓴다). */
  private preparingTurn = false;
  /** 그 구간에서 중단을 눌렀다 — 준비가 끝나는 자리에서 그 턴을 안 보낸다. */
  private cancelPending = false;
  /** `/compact`처럼 모델 턴이 아닌 단독 명령 작업. app-server 완료 알림과 짝짓는다. */
  private commandOperation: RuntimeCommandOperation | null = null;
  /**
   * 턴 시작 응답보다 **먼저** 도착한 완료 알림의 턴 식별자.
   *
   * 왜 필요한가: 응답 줄과 완료 알림 줄이 한 덩어리로 도착하면, 알림 처리가 응답을 기다리던 코드의
   * 뒷부분보다 먼저 실행된다. 그때 "지금 진행 중인 턴"은 아직 비어 있어서 완료를 놓치고, 곧이어 이미
   * 끝난 턴의 식별자가 "진행 중"으로 박힌다. 그러면 다음 메시지가 영원히 전송되지 않는다
   * (외부 검토 지적, 2026-08-18). 먼저 온 완료를 여기 적어 두었다가 응답을 받은 자리에서 맞춰본다.
   */
  private readonly completedBeforeAck = new Set<string>();

  private lastUsage: ContextUsage | null = null;
  private disposed = false;
  /** 이번 턴의 취소 신호 — 턴이 끝나거나 프로세스가 죽으면 보류 중인 카드를 정리한다. */
  private turnAbort: AbortController | null = null;
  /**
   * 파일 변경 항목의 diff를 항목 식별자로 기억해 둔다.
   * 승인 요청 payload에는 diff가 없고(8a 실측) 같은 항목의 알림에만 실려 오기 때문에, 카드에 변경 내용을
   * 보여주려면 먼저 온 알림을 붙잡아 둬야 한다. 턴이 끝나면 비운다.
   */
  private readonly fileChanges = new Map<string, { path: string; diff: string; isCreate?: boolean; movePath?: string }[]>();

  // ── 이벤트 스트림(단독 소비 계약 — LiveSession.run 하나만 순회한다) ──
  private readonly pending: RawProviderEventBody[] = [];
  private wake: (() => void) | null = null;
  private streamEnded = false;
  private streamError: Error | null = null;

  constructor(opts: RuntimeStartOptions, backend: CodexBackend = CODEX_BACKEND) {
    this.backend = backend;
    this.provider = backend.provider;
    this.capabilities = backend.capabilities;
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
    // 미지정 = 새 세션. 자동 검토가 있으면 자동, 없으면 수동으로 시작한다. 이 공급처에 없는 모드가 오면 수동으로 시작한다.
    const wanted = opts.permissionMode ?? (backend.autoReview ? "auto" : "manual");
    this.permissionMode = this.offeredModes().includes(wanted) ? wanted : "manual";
    this.attachments = new AttachmentStore(opts.sessionId);
    this.server = new CodexAppServer({
      // 질문 카드를 켜는 스위치(위 상수 주석) — 사용자 전역 설정에 기대지 않는다.
      configOverrides: [...SESSION_CONFIG_OVERRIDES, ...backend.configOverrides],
      // 모델에게 넘길 환경에서 이 허브의 비밀 변수를 걷어낸다(R21) — 모델 셸이 `env` 한 번으로 볼 수 있고,
      //   그 출력은 경로 기반 가리기에 안 걸린다.
      env: modelEnv(backend.env),
      onNotification: (n) => this.onNotification(n),
      onServerRequest: (r) => this.onServerRequest(r),
      onExit: (info) => this.onExit(info),
    });
  }

  // ── 준비 ──

  /**
   * 프로세스가 떠서 대화를 받을 준비가 됐다는 최초 신호(계약: 턴 미소비 + 이벤트 스트림 무접촉).
   * 여러 번 불러도 같은 결과를 준다 — 준비 작업은 한 번만 돈다.
   */
  handshake(): Promise<RuntimeHandshake> {
    return this.ready();
  }

  private ready(): Promise<RuntimeHandshake> {
    return (this.booted ??= this.boot());
  }

  private async boot(): Promise<RuntimeHandshake> {
    await this.server.initialize(CLIENT_INFO);
    this.models = this.backend.listModels ? await this.backend.listModels() : await this.codexModels();
    // 공급처가 기본 모델을 알려 주면 모델을 안 고른 세션은 그 모델로 시작한다.
    //   Codex 계정 기본 모델은 다른 공급처에 없는 이름이라, 비워 두면 첫 턴이 거부된다.
    if (!this.model && this.backend.listModels) this.model = this.models.find((m) => m.isDefault)?.value;
    if (this.backend.contextWindow && this.model) this.window = await this.backend.contextWindow(this.model);

    // 지식툴 창구를 먼저 연다 — 스레드 시작 설정에 서버 정의를 실어 보내야 하기 때문이다.
    //   이어가기(`thread/resume`)에도 같은 설정을 넘긴다. 스레드 단위 설정이라 안 넘기면 재개한 세션만
    //   조용히 지식툴을 잃는다.
    await this.openBridge();

    const common = {
      cwd: this.opts.cwd,
      ...(this.bridge || this.window ? { config: { ...(this.bridge ? codexThreadConfig(this.bridge.httpAttach) : {}), ...this.windowConfig() } } : {}),
      ...(this.model ? { model: this.model } : {}),
      // 승인 정책: 기본은 물어보기, 명시적으로 켠 세션만 안 물어보기(D5.1).
      approvalPolicy: codexModePolicy(this.permissionMode).approvalPolicy,
      // ★ 승인을 누가 판단하는가 — 기본은 반드시 사람이다. 자동 모드만 Codex의 자동 검토에 맡기고, 그것도 사용자가 고른 모드일 때뿐이다.
      //   Codex는 승인 요청을 사람 대신 **AI 하위 에이전트**에게 보내 자동으로 판단하게 하는 설정을 지원하고,
      //   그 설정은 사용자의 전역 설정 파일(`~/.codex/config.toml`의 `approvals_reviewer`)에서 온다.
      //   실측(2026-08-18): 그 설정이 켜져 있던 환경에서 Aether가 이 값을 지정하지 않자, 위험한 명령이
      //   **승인 카드 없이 AI 판단으로 실행됐다.** 폰에서 승인하는 것이 이 제품의 안전 장치인데 그게 통째로
      //   우회된 것이다. 그래서 사용자 설정을 물려받지 않고 매번 못 박는다.
      approvalsReviewer: codexModePolicy(this.permissionMode).approvalsReviewer,
      // 세션 시작 시 1회 고정되는 안내문 — 8a에서 정본으로 확정된 통로다(D10).
      ...(this.opts.systemAppend ? { developerInstructions: this.opts.systemAppend } : {}),
    };
    const res = this.opts.resumeKey
      ? await this.server.request<ThreadResumeResponse>("thread/resume", { threadId: this.opts.resumeKey, ...common })
      : await this.server.request<ThreadStartResponse>("thread/start", common);
    this.threadId = res.thread.id;
    // 이어가기 식별자를 가장 이른 시점에 알린다 — 첫 턴 도중 죽어도 다음에 이어갈 수 있게.
    this.opts.onResumeKey(this.threadId);
    await this.registerSkillRoots();
    return { models: this.models };
  }

  /** 대화를 열 때 넘길 대화 길이 설정. 자동 압축 기준은 길이의 80%다 — 넘치기 전에 압축해야 앞부분이 안 잘린다. */
  private windowConfig(): Record<string, number> {
    if (!this.window) return {};
    return { model_context_window: this.window, model_auto_compact_token_limit: Math.floor(this.window * 0.8) };
  }

  /** Codex 계정의 모델 목록. */
  private async codexModels(): Promise<RuntimeModel[]> {
    const list = await this.server.request<ModelListResponse>("model/list", {});
    // 숨김 모델은 고를 수 없는 것이라 목록에서 뺀다 — 화면에 띄우면 고르는 순간 거부당한다.
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
        // 강도 설명은 Codex가 강도마다 직접 준다(`ReasoningEffortOption.description` — 필수 필드).
        //   8i 전엔 이걸 버리고 이름만 남겼고, 화면이 자기 표로 설명을 붙였다(Claude 어휘 하드코딩).
        //   provider 원문이므로 `text`에 담는다 — 번역이 아니라서 특정 로케일의 값인 척하면 안 된다.
        supportedEffortDescriptions: Object.fromEntries(
          m.supportedReasoningEfforts.map((e) => [e.reasoningEffort, { text: e.description }]),
        ),
      }));
  }

  /**
   * 이 세션이 읽을 스킬 저장소를 알려준다 (8g · D7).
   *
   * 스킬 저장소는 provider 공통 자산이다. 위치가 Claude Code 관례(`.claude/skills`)인 것은 역사적
   * 이유이고 옮기지 않는 것이 결정이라(`skill/skillPaths.ts`), Codex 세션은 그 폴더를 **추가 스킬 루트**로
   * 등록해 같은 파일을 읽는다. 8a 실측에서 우리 SKILL.md가 Codex 검증을 그대로 통과했으므로 별도 사본은
   * 만들지 않는다.
   *
   * 등록은 프로세스가 다시 뜨면 사라진다(8a 실측) — 그래서 스레드를 열 때마다 다시 한다. 목록을 한 번
   * 강제로 다시 읽는 이유는 방금 등록한 루트를 즉시 반영시키기 위해서다.
   */
  private async registerSkillRoots(): Promise<void> {
    const roots = [userSkillsDir(), projectSkillsDir(this.opts.cwd)];
    try {
      await this.server.request("skills/extraRoots/set", { extraRoots: roots });
      await this.refreshSkills();
    } catch (e) {
      // 스킬을 못 읽는 것은 대화를 막을 일이 아니다 — 크게 알리고 세션은 계속 간다.
      void reportError(e, { component: "session", severity: "warning", operation: "provider.codex.skill_roots", session_id: this.opts.sessionId }); console.error("[aether] Codex 스킬 루트 등록 실패(스킬 없이 진행):", e);
    }
  }

  /**
   * 스킬 목록을 디스크에서 다시 읽는다. 파싱 에러는 그대로 로그로 드러낸다 —
   * 조용히 빠지면 "왜 내 스킬이 안 뜨지"를 아무도 추적할 수 없다.
   */
  private async refreshSkills(): Promise<void> {
    const res = await this.server.request<SkillsListResponse>("skills/list", { cwds: [this.opts.cwd], forceReload: true });
    const entries = res.data ?? [];
    const count = entries.reduce((n, e) => n + (e.skills?.length ?? 0), 0);
    const errors = entries.flatMap((e) => e.errors ?? []);
    // 설치본 SkillErrorInfo에는 path·message만 있다. 파일 소유자나 실패 원인을 경로·문구로 추정하지 않는다.
    for (const error of errors) void reportError(new Error(error.message), {
      component: "session", operation: "provider.skills.read", session_id: this.opts.sessionId, severity: "warning",
      context: { path: error.path },
    });
    if (errors.length) console.error(`[aether] Codex 스킬 읽기 오류 ${errors.length}건:`, JSON.stringify(errors).slice(0, 500));
    if (process.env.AETHER_SKILLS_DEBUG) console.error(`[skills:debug] Codex 세션이 스킬 ${count}개를 읽었다(루트 ${entries.length}곳)`);
  }

  /**
   * 스킬 파일이 바뀌었다는 신호에 목록을 다시 읽는다.
   * 이게 없으면 세션 도중 만들어진 스킬(자동 생성 포함)을 그 세션이 영영 못 본다.
   * 여러 번 몰려와도 한 번에 하나만 돌리고, 도는 동안 또 오면 끝난 뒤 한 번 더 돈다(마지막 상태 보장).
   */
  private refreshingSkills = false;
  private skillsChangedAgain = false;
  private onSkillsChanged(): void {
    if (this.refreshingSkills) {
      this.skillsChangedAgain = true;
      return;
    }
    this.refreshingSkills = true;
    void (async () => {
      try {
        do {
          this.skillsChangedAgain = false;
          // ★ 한 번 실패했다고 멈추면 그 사이 들어온 변경 신호가 통째로 사라진다 — 목록이 낡은 채로
          //   굳고 세션은 새 스킬을 영영 못 본다(외부 검토 지적, 2026-08-18). 실패도 한 바퀴로 친다.
          await this.refreshSkills().catch((e) => { void reportError(e, { component: "session", operation: "provider.skills.refresh", session_id: this.opts.sessionId, severity: "warning" }); console.error("[aether] Codex 스킬 목록 갱신 실패:", e); });
        } while (this.skillsChangedAgain && !this.disposed);
      } finally {
        this.refreshingSkills = false;
      }
    })();
  }

  /**
   * 이 세션의 지식툴 창구를 연다. 켜진 도구가 없으면 아무것도 열지 않는다.
   *
   * 승인 규칙은 서술자가 들고 있다 — 카드가 필요한 도구는 여기서 세션에 물어보고, 답이 올 때까지
   * 창구가 응답을 붙잡는다. Claude 쪽도 같은 값으로 같은 판정을 한다(`runtimes/claude.ts`의 자동 허용 집합).
   */
  private async openBridge(): Promise<void> {
    // 지식툴이 전부 꺼져 있어도 창구는 연다 — 되물음 폴백이 이 통로를 타기 때문이다.
    const tools = buildKnowledgeTools();
    const bridge = await openKnowledgeBridge({
      sessionId: this.opts.sessionId,
      cwd: this.opts.cwd,
      // 보조 모델은 이 세션 provider의 것이다 — 검색결과 요약이 Claude로 새면 안 된다(D6).
      services: this.backend.services,
      engine: this.provider,
      tools,
      onTodoList: this.opts.onTodoList,
      approve: async (def, args) => {
        const out = await this.opts.onPermission({
          toolName: def.name,
          displayName: st("notice.codex.tool.knowledge", { name: def.name }),
          input: args,
          toolUseID: `knowledge-${randomUUID()}`,
          signal: this.turnSignal(),
        });
        return out.allow ? { allow: true } : { allow: false, message: out.message };
      },
      // 되물음 폴백(D5.4) — 정본은 Codex가 직접 보내는 질문 요청이고, 그 기능이 개발 중 표시를 달고
      //   있어(R14) 사라졌을 때도 사용자에게 물어볼 길이 남게 도구로도 하나 연다. 도착점은 같은 질문 카드다.
      askUser: async (question, header, options) => {
        // 진행 중인 턴이 없으면 띄우지 않는다. 그런 카드는 취소 신호에 걸리지 않아 화면에 남고,
        //   중단 버튼으로도 못 없앤다(외부 검토 지적 — 정상 흐름에서는 생기지 않는 경로다).
        if (!this.activeTurnId && !this.startingTurn && !this.preparingTurn) {
          return { answered: false, text: st("notice.codex.askUserNoTurn") };
        }
        const out = await this.opts.onQuestion({
          toolUseID: `ask-user-${randomUUID()}`,
          questions: [{ question, header, options: options.map((label) => ({ label })) }],
          signal: this.turnSignal(),
        });
        if (!out.answered) return { answered: false, text: out.reason };
        const a = out.answers[0];
        const picked = [...(a?.chosen ?? []), ...(a?.custom ? [a.custom] : [])];
        return { answered: true, text: picked.join(", ") };
      },
    });
    // 여는 사이에 세션이 정리됐으면 방금 연 것을 그대로 되돌린다(창구가 주인 없이 남지 않게).
    if (this.disposed) {
      bridge?.dispose();
      return;
    }
    this.bridge = bridge;
  }

  // ── 턴 진행 ──

  /**
   * 턴 입력. 진행 중이면 큐에 쌓았다가 **현재 턴이 끝난 뒤에** 보낸다(D5.5).
   * 첨부는 이 시점에 임시 파일로 만든다 — 큐에서 기다리는 동안에도 파일이 살아 있어야 하기 때문이다.
   */
  push(input: NormalizedUserInput): void {
    if (this.disposed) return;
    this.queue.push(this.prepare(input));
    void this.pump();
  }

  private prepare(input: NormalizedUserInput): QueuedTurn {
    const files: MaterializedAttachment[] = [];
    const items: UserInput[] = [];
    for (const im of input.images ?? []) {
      const f = this.materialize(im);
      if (!f) continue;
      files.push(f);
      items.push({ type: "localImage", path: f.path });
    }
    // 문서(PDF 등)는 Codex 입력 형식에 자리가 없다. 파일로 만들어 경로를 알려주고 모델이 직접 열게 한다.
    //   이 안내는 **모델 입력에만** 붙는다 — 대화 기록·화면에는 사용자가 실제로 친 글만 남는다.
    const docs: string[] = [];
    for (const d of input.documents ?? []) {
      const f = this.materialize(d);
      if (!f) continue;
      files.push(f);
      docs.push(`- ${d.name}: ${f.path}`);
    }
    const text = docs.length ? `${input.text}\n\n${st("notice.codex.attachedDocs", { list: docs.join("\n") })}` : input.text;
    items.push({ type: "text", text, text_elements: [] });
    return { input: items, files, prompt: input.text };
  }

  private materialize(att: ImageAttachment | DocAttachment): MaterializedAttachment | null {
    try {
      return this.attachments.materialize(att.data, extOf(att.media_type));
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "provider.codex.attachments_prepare", session_id: this.opts.sessionId }); console.error("[aether] Codex 첨부 임시 파일 생성 실패(첨부 없이 진행):", e);
      return null;
    }
  }

  /**
   * 큐에서 한 턴씩 꺼내 보낸다. 진행 중인 턴이 있으면 아무것도 하지 않고, 완료 알림이 다시 부른다.
   * 이 함수가 이 클래스의 유일한 `turn/start` 발신 지점이다 — 줄 세우기가 한 곳에서만 성립하게 하기 위해서다.
   */
  private async pump(): Promise<void> {
    if (this.pumping || this.startingTurn || this.disposed || this.activeTurnId || this.queue.length === 0) return;
    this.pumping = true;
    /** 이 호출이 끝난 뒤 곧바로 다음 턴을 이어가야 하는가(이미 끝났거나 실패한 경우). */
    let resume = false;
    try {
      await this.ready();
      if (this.disposed || this.activeTurnId || this.startingTurn || this.queue.length === 0) return;
      const job = this.queue.shift()!;
      this.activeFiles = job.files;
      // 여기서부터 `turn/start`를 보내기 전까지는 "아직 시작 안 한 턴"이다. 이 구간에서 중단을 누르면
      //   보낼 턴 식별자가 없어 예전에는 아무 일도 일어나지 않았고, 회상 주입이 늦어지는 동안 사용자가
      //   멈춘 줄 알았던 턴이 뒤늦게 시작될 수 있었다(외부 검토 지적, 2026-08-18).
      this.preparingTurn = true;
      // 매 턴 회상은 턴을 시작하기 **전에** 스레드에 얹는다(아래 함수 주석 — 통로 선택 근거).
      await this.injectTurnContext(job);
      // 기다리는 사이에 세션이 정리됐거나 사용자가 중단했으면 이 턴은 보내지 않는다.
      if (this.disposed || this.cancelPending) {
        this.cancelPending = false;
        this.finishTurn();
        if (!this.disposed) {
          this.emitError(st("notice.codex.turnCanceled"));
          resume = true; // 뒤에 쌓인 메시지는 계속 처리한다
        }
      } else {
        this.startingTurn = true;
        const ack = await this.server.request<TurnStartResponse>("turn/start", {
          threadId: this.threadId,
          input: job.input,
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          // 권한 우회는 세션 중에 바뀔 수 있어서 턴마다 승인 정책과 샌드박스를 함께 다시 보낸다.
          approvalPolicy: codexModePolicy(this.permissionMode).approvalPolicy,
          sandboxPolicy: this.sandboxPolicy(),
          // 턴마다 다시 못 박는다 — 이 값은 턴 단위로도 바뀔 수 있어서, 한 번만 정해두면 도중에 뒤집힐 여지가 남는다.
          approvalsReviewer: codexModePolicy(this.permissionMode).approvalsReviewer,
        });
        // 응답을 기다리는 사이에 이미 끝나 버린 턴이면(위 `completedBeforeAck` 주석) 여기서 마감한다.
        if (this.completedBeforeAck.delete(ack.turn.id)) {
          this.finishTurn();
          resume = true;
        } else {
          this.activeTurnId = ack.turn.id;
        }
      }
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.turn.start", session_id: this.opts.sessionId, model: this.opts.model, provider: this.backend.services.provider });
      // 턴을 못 보낸 것은 사용자가 알아야 할 사건이다 — 조용히 삼키면 화면이 영원히 "생각 중"에 머문다.
      //   이 메시지는 Codex 쪽 대화에 들어가지 못했으므로 그 사실을 문구로 밝힌다. 같은 입력을 다시 보내
      //   무한히 재시도하지는 않는다(영구적인 실패면 오류만 반복 생산한다).
      this.finishTurn();
      this.emitError(st("notice.codex.turnFailed", { provider: this.backend.services.displayName, error: String((e as Error)?.message ?? e) }));
      resume = true; // 뒤에 쌓인 메시지까지 함께 멈추지 않게 다음 턴은 이어간다
    } finally {
      this.startingTurn = false;
      this.preparingTurn = false;
      this.pumping = false;
    }
    if (resume && !this.disposed) void this.pump();
  }

  /**
   * 이번 턴에 얹을 휘발성 컨텍스트(자동 회상)를 스레드에 덧붙인다 (8g · 위험 R4).
   *
   * ## 왜 이 통로인가 (세 통로를 실측 비교해서 골랐다 — 내부 실측 의 `injectturn`)
   *
   * 판정 기준은 둘이었다. 모델이 그 내용을 실제로 참조하는가(준수), 그리고 그 문구가 세션 알림으로
   * 되돌아오지 않는가(불변식 — 되돌아오면 우리 정규화가 그걸 **사용자가 친 글**로 바꿔 화면과 디스크에
   * 남긴다). 결과는 이랬다.
   *   - 스레드에 항목 덧붙이기: 준수 O, 되돌아옴 X  ← 유일하게 둘 다 만족해서 채택
   *   - 턴 입력 앞에 별도 항목: 준수 X, 되돌아옴 O  (8a가 본 미준수가 재현됐다)
   *   - 사용자 글과 같은 항목 안 블록: 준수 X, 되돌아옴 O
   *
   * ## 불변식
   *
   * 주입은 모델 입력에만 들어간다. 저장본·화면에는 사용자가 친 글만 남는다 — 이 함수는 `turn/start`의
   * `input`을 건드리지 않고, 얹은 내용은 세션 이벤트로 나가지 않는다.
   *
   * 실패는 턴을 막지 않는다. 회상은 있으면 좋은 배경이지 턴의 전제가 아니다(Claude 쪽도 훅이 실패하면
   * 빈 배경으로 그냥 진행한다 — `sessions/injections.ts`).
   *
   * ⚠️ 알려진 한계: 이 통로는 스레드 기록에 **덧붙이는** 것이라 되돌릴 수 없다. 얹은 뒤 `turn/start`가
   * 실패하면 그 회상은 스레드에 남아 다음 턴에서도 보인다(같은 메시지를 다시 보내면 비슷한 회상이 또
   * 얹힐 수 있다). 내용이 배경 정보라 해롭지는 않지만 정확한 표현은 "이번 턴 전용"이 아니라
   * "이 시점부터의 배경"이다. 턴에 묶어 얹는 API는 0.145.0에 없다.
   */
  private async injectTurnContext(job: QueuedTurn): Promise<void> {
    const prompt = job.prompt;
    if (!this.opts.turnContext || !this.threadId) return;
    let parts: string[] = [];
    try {
      parts = await Promise.resolve(this.opts.turnContext(prompt));
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "provider.codex.recall_prepare", session_id: this.opts.sessionId }); console.error("[aether] Codex 자동 회상 준비 실패(회상 없이 진행):", e);
      return;
    }
    if (!parts.length) return;
    const text = `<aether-context>\n${parts.join("\n\n")}\n</aether-context>`;
    // 주입은 화면에 안 보인다 — 켜 두면 "이번 턴에 배경이 붙었나"를 로그로 확인할 수 있게 한다(카나리도 이걸 본다).
    if (process.env.AETHER_RECALL_DEBUG) console.error(`[recall:debug] Codex 턴에 회상 ${parts.length}건 주입(${text.length}자)`);
    await this.server
      .request("thread/inject_items", {
        threadId: this.threadId,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
      })
      .catch((e) => { void reportError(e, { component: "session", operation: "provider.recall.inject", session_id: this.opts.sessionId, severity: "warning" }); console.error("[aether] Codex 자동 회상 주입 실패(회상 없이 진행):", e); });
  }

  /** 진행 중이던 턴을 마감한다 — 보류 카드 정리, 임시 첨부 해제, 기억해 둔 변경 내용 비우기. */
  private finishTurn() {
    this.activeTurnId = null;
    this.fileChanges.clear();
    // 이 턴에 대해 아직 답을 못 받은 카드가 있으면 여기서 정리된다(세션이 거부로 마감한다).
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.releaseActive();
  }

  /**
   * 이 세션의 샌드박스 정책.
   * `/tmp`·임시 폴더 예외를 끄는 이유는 파일 머리 주석 ③ 참조 — Claude와 권한 반경을 맞춘다.
   * 네트워크는 기본 차단이고, 필요하면 승인 카드로 물어본다(D5.3).
   */
  private sandboxPolicy(): SandboxPolicy {
    if (codexModePolicy(this.permissionMode).fullAccess) return { type: "dangerFullAccess" };
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }

  /**
   * 진행 중인 턴을 멈춘다.
   *
   * 아직 `turn/start`를 보내기 전이면 보낼 턴 식별자가 없다. 그때는 **중단 요청을 적어 두고**, 준비가
   * 끝나는 자리에서 그 턴을 아예 안 보낸다 — 안 그러면 사용자가 멈춘 줄 아는 턴이 몇 초 뒤에 시작된다
   * (외부 검토 지적, 2026-08-18).
   */
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      if (this.preparingTurn || this.startingTurn) this.cancelPending = true;
      return;
    }
    await this.server.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
  }

  // ── 설정 변경(다음 턴부터 적용 — §0.2 #8·#9) ──

  /** 이 계정에 없는 이름은 거부한다(D12) — 조용히 무시하면 사용자는 바뀐 줄 안다. */
  async setModel(model: string): Promise<void> {
    await this.ready();
    const found = this.models.find((m) => m.value === model || m.resolvedModel === model);
    if (!found) throw new Error(st("notice.codex.modelUnknown", { provider: this.backend.services.displayName, model }));
    // 대화 길이가 다른 모델은 이 대화에서 못 바꾼다(위 `contextWindow` 주석). 바꾸게 두면 Codex는 옛 길이로
    //   압축 시점을 정하고, 짧아진 쪽이면 공급처가 앞부분을 조용히 잘라낸다.
    if (this.backend.contextWindow && this.window !== undefined) {
      const next = await this.backend.contextWindow(found.value);
      if (next !== this.window) {
        throw new Error(st("notice.codex.windowMismatch", { model: found.value, from: String(this.window), to: String(next) }));
      }
    }
    this.model = found.value;
  }

  /** 지금 모델이 받지 않는 강도는 거부한다 — 받는 값은 모델마다 다르다(D12). */
  async setEffort(effort: SessionEffort): Promise<void> {
    await this.ready();
    const current = this.models.find((m) => m.value === this.model) ?? this.models.find((m) => m.isDefault);
    const allowed = current?.supportedEffortLevels ?? [];
    if (!allowed.length) {
      throw new Error(st("notice.codex.effortUnavailable", { model: current?.value ?? "?" }));
    }
    if (!allowed.includes(effort)) {
      throw new Error(st("notice.codex.effortUnsupported", { model: current?.value ?? "?", effort, allowed: allowed.join(", ") }));
    }
    this.effort = effort;
  }

  /** 승인 정책과 샌드박스는 `turn/start`마다 실려 가므로 값만 바꾸면 다음 턴부터 적용된다. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.offeredModes().includes(mode)) throw new Error(st("notice.permission.unavailable"));
    this.permissionMode = mode;
  }

  /** 자동은 공급처에 자동 검토가 있을 때만, 편집 자동 수락은 파일 변경 승인 요청이 올 때만 준다. */
  private offeredModes(): PermissionMode[] {
    return (["manual", "edits", "auto", "full"] as const).filter(
      (m) => (m !== "auto" || this.backend.autoReview) && (m !== "edits" || this.backend.fileChangeApproval),
    );
  }

  async permissionModes(): Promise<{ modes: readonly PermissionMode[]; current: PermissionMode }> {
    return { modes: this.offeredModes(), current: this.permissionMode };
  }

  /**
   * 지금 문맥에 들어 있는 토큰. app-server는 이걸 물어볼 수 없고 턴마다 알려주므로 마지막 값을 기억해 둔다.
   * 아직 한 번도 못 받았으면 0을 지어내지 않고 실패로 답한다 — 가짜 0은 화면에 "문맥 텅 빔"으로 그려진다.
   */
  async contextUsage(): Promise<ContextUsage> {
    if (!this.lastUsage) throw new Error(st("notice.codex.noUsageYet"));
    return this.lastUsage;
  }

  /**
   * 이 세션에 실제로 적용 중인 승인 정책 요약(8d-3 ⑥ⓕ · 위험 R22).
   *
   * 8e까지 여기는 **무조건 "자동승인 0건"**이라고 답했다. 우리가 승인 정책과 승인 판단 주체를 매 턴 못
   * 박으니 카드를 건너뛰는 길이 없다는 근거였는데, 그건 우리가 덮어쓰는 두 축에만 해당한다. 사용자
   * 전역 설정에는 다른 축이 더 있고(MCP 서버별 승인 모드·폴더 신뢰·규칙 기반 허용), 그게 켜져 있으면
   * 카드 없이 실행되는데 화면 배지는 "0건"이라고 잘못 보고했다. 이제 그 축들을 읽어 사실대로 답한다.
   * **동작은 하나도 바꾸지 않는다** — 세는 것뿐이다(유저 결정 2026-08-18).
   */
  async effectivePermissionPolicy(): Promise<PermissionPolicy> {
    return codexPermissionPolicy(this.opts.cwd, this.permissionMode === "full", async () => {
      await this.ready();
      const res = await this.server.request<ConfigReadResponse>("config/read", { cwd: this.opts.cwd });
      return {
        config: (res.config ?? {}) as unknown as Record<string, unknown>,
        // 출처 메타 — 어느 설정 층에서 온 값인지 알려준다. 없으면 요약이 범위를 지어내지 않고 비운다.
        origins: (res.origins ?? {}) as ConfigOrigins,
        // 규칙 파일은 설정 응답에 안 실려 온다. 이 프로세스가 쓰는 설정 폴더에서 직접 읽는다.
        codexHome: this.server.codexHome ?? undefined,
      };
    });
  }

  // ── provider 고유 조회 ──

  /**
   * 구독 한도 사용률 (8h). `account/rateLimits/read`를 중립 스키마로 옮긴다.
   *
   * 응답에 같은 내용이 두 벌 온다 — `rateLimits`는 옛 형식의 단일 묶음이고 `rateLimitsByLimitId`는
   * 한도 종류별 묶음이다(생성 타입 주석). 뒤엣것이 있으면 그쪽만 쓴다. 둘 다 세면 같은 창이 두 번 그려진다.
   *
   * 비용은 담지 않는다 — Codex는 세션 비용을 세지 않으므로 0을 지어내면 "공짜로 썼다"는 거짓말이 된다
   * (선택 필드 규율: 못 채우는 값은 비워 두고 그 표시만 빠진다).
   */
  async usage(): Promise<ProviderUsage> {
    await this.ready();
    const res = await this.server.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined);
    const buckets = Object.keys(res.rateLimitsByLimitId ?? {}).length
      ? Object.entries(res.rateLimitsByLimitId ?? {}).map(([id, snap]) => ({ id, snap }))
      : [{ id: res.rateLimits?.limitId ?? "codex", snap: res.rateLimits }];
    const windows: UsageWindow[] = [];
    let plan: string | undefined;
    for (const { id, snap } of buckets) {
      if (!snap) continue;
      plan ??= snap.planType ?? undefined;
      for (const which of ["primary", "secondary"] as const) {
        const w = snap[which];
        if (!w) continue;
        windows.push({
          // 이름이 없는 창이라 키는 **식별자**로만 쓰고, 사람이 읽는 이름은 아래 길이에서 나온다.
          //   ⚠️ 프로토콜상 길이는 null일 수 있다(실측에서는 항상 왔다). 그런 창이 오면 화면이 만들 이름이
          //   없어 이 키를 그대로 띄운다 — 드물지만 그때는 사용자에게 뜻 없는 글자가 보인다.
          key: `${id}_${which}`,
          utilization: typeof w.usedPercent === "number" ? w.usedPercent : null,
          // 실측값 1787617478은 초 단위다(밀리초면 1970년이 된다).
          resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
          ...(typeof w.windowDurationMins === "number" ? { windowMinutes: w.windowDurationMins } : {}),
        });
      }
    }
    return { ...(plan ? { subscriptionType: plan } : {}), windowsAvailable: windows.length > 0, windows };
  }

  async listCommands(): Promise<RuntimeCommand[]> {
    await this.ready();
    return CODEX_COMMANDS.map((command) => ({ ...command, aliases: command.aliases ? [...command.aliases] : undefined }));
  }

  /** app-server가 처리할 수 있는 명령만 명시 RPC로 옮긴다. 일반 turn/start 텍스트 폴백은 금지한다. */
  async executeCommand(command: RuntimeCommandInvocation): Promise<RuntimeCommandResult> {
    await this.ready();
    const wanted = command.name.toLowerCase();
    const found = CODEX_COMMANDS.find((c) => c.name === wanted || c.aliases?.includes(wanted));
    if (!found) return { accepted: false, error: st("notice.command.unsupported", { command: command.name }) };
    if (!this.threadId) return { accepted: false, error: st("notice.codex.notReady", { provider: this.backend.services.displayName }) };
    if (this.commandOperation || this.activeTurnId || this.startingTurn || this.preparingTurn || this.pumping || this.queue.length > 0) {
      return { accepted: false, error: st("notice.command.busy") };
    }

    if (found.name === "compact") {
      if (command.arguments.trim()) return { accepted: false, error: st("notice.command.noArguments", { command: found.name }) };
      await this.compactContext();
      return { accepted: true, startsTurn: false };
    }

    const target = this.reviewTarget(command.arguments);
    this.startingTurn = true;
    try {
      const ack = await this.server.request<ReviewStartResponse>("review/start", {
        threadId: this.threadId,
        target,
        delivery: "inline",
      });
      if (this.completedBeforeAck.delete(ack.turn.id)) {
        this.finishTurn();
        return { accepted: true, startsTurn: true };
      }
      this.activeTurnId = ack.turn.id;
      return { accepted: true, startsTurn: true };
    } finally {
      this.startingTurn = false;
      if (!this.disposed && !this.activeTurnId && this.queue.length) void this.pump();
    }
  }

  async compactContext(): Promise<void> {
    if (!this.threadId) throw new Error(st("notice.codex.notReady", { provider: this.backend.services.displayName }));
    const operation: RuntimeCommandOperation = {
      operationId: randomUUID(),
      state: "started",
      detail: st("notice.command.compact.started"),
      blocksInput: true,
    };
    this.commandOperation = operation;
    this.opts.onCommandOperation?.(operation);
    try {
      await this.server.request("thread/compact/start", { threadId: this.threadId });
    } catch (error) {
      this.finishCommandOperation("failed");
      throw error;
    }
  }

  /** `/review` 인자를 app-server의 구조화 target으로 바꾸는 지식은 Codex adapter 안에만 둔다. */
  private reviewTarget(raw: string): ReviewTarget {
    const args = raw.trim();
    if (!args) return { type: "uncommittedChanges" };
    const base = /^base\s+(.+)$/i.exec(args);
    if (base) return { type: "baseBranch", branch: base[1].trim() };
    const commit = /^commit\s+(\S+)$/i.exec(args);
    if (commit) return { type: "commit", sha: commit[1], title: null };
    return { type: "custom", instructions: args };
  }

  // ── 이벤트 스트림 ──

  async *events(): AsyncIterable<RawProviderEventBody> {
    for (;;) {
      if (this.pending.length === 0) {
        if (this.streamError) throw this.streamError;
        if (this.streamEnded) return;
        await new Promise<void>((r) => (this.wake = r));
        continue;
      }
      yield this.pending.shift()!;
    }
  }

  private emit(msg: ServerNotification) {
    const raw: { kind: "codex"; msg: ServerNotification } = { kind: "codex", msg };
    this.pending.push(raw);
    this.wake?.();
    this.wake = null;
  }

  /** 우리가 만든 사건을 상대의 어휘로 알린다 — 화면·기록이 한 가지 형식만 다루게 하기 위해서다. */
  private emitError(message: string) {
    this.emit({
      method: "error",
      params: { error: { message, codexErrorInfo: null, additionalDetails: null }, willRetry: false, threadId: this.threadId ?? "", turnId: this.activeTurnId ?? "" },
    } as ServerNotification);
  }

  private endStream(err?: Error) {
    if (err) this.streamError = err;
    this.streamEnded = true;
    this.wake?.();
    this.wake = null;
  }

  private onNotification(n: CodexNotification) {
    if (this.disposed) return;
    // 스킬 변경은 대화가 아니라 무효화 신호다(생성 타입 주석) — 목록만 다시 읽고 이벤트로는 안 내보낸다.
    if (n.method === "skills/changed") this.onSkillsChanged();
    if (this.commandOperation && (isContextCompactionCompleted(n) || n.method === "thread/compacted")) {
      // 현재 정본은 item/completed(contextCompaction), 옛 버전은 thread/compacted다. 이 고유 신호를
      // 공통 operation 완료 사건으로 바꾸고 원본은 삼켜서 완료 카드가 두 번 쌓이지 않게 한다.
      // 자동 압축은 commandOperation이 없으므로 아래 기존 codec 경로를 그대로 탄다.
      this.finishCommandOperation("completed");
      return;
    }
    if (isSessionIrrelevant(n.method, this.capabilities.usage)) return;
    const notification = { method: n.method, params: n.params } as ServerNotification;
    // 공통 계층의 턴 시작은 메인 대화의 턴만 뜻한다. 하위 thread의 시작을 내보내면 쉬는 세션이 작업 중으로 바뀐다.
    if (notification.method === "turn/started" && notification.params.threadId !== this.threadId) return;
    if (notification.method === "thread/tokenUsage/updated") {
      const u = notification.params.tokenUsage;
      this.lastUsage = { totalTokens: u.last.totalTokens, maxTokens: u.modelContextWindow ?? 0 };
    }
    this.rememberFileChanges(notification);
    this.emit(notification);
    // 턴 종료는 이벤트를 내보낸 *뒤에* 처리한다 — 다음 턴이 먼저 시작돼 순서가 뒤엉키지 않게.
    if (notification.method !== "turn/completed") return;
    const turn = notification.params.turn;
    if (turn?.status === "failed" && turn.error) {
      void reportError(codexTurnError(turn.error), { component: "session", operation: "session.turn", session_id: this.opts.sessionId, model: this.opts.model, provider: this.backend.services.provider });
    }
    const id = notification.params.turn?.id;
    if (!id) return;
    if (id === this.activeTurnId) {
      this.finishTurn();
      void this.pump();
    } else if (this.startingTurn) {
      // 시작 응답보다 완료가 먼저 왔다 — 응답을 받는 자리에서 맞춰 마감한다(필드 주석 참조).
      this.completedBeforeAck.add(id);
    }
  }

  /** app-server 알림·시작 RPC 오류를 한 곳에서 operation 완료 사건으로 바꾼다. */
  private finishCommandOperation(state: "completed" | "failed") {
    const operation = this.commandOperation;
    if (!operation) return;
    this.commandOperation = null;
    this.opts.onCommandOperation?.({
      ...operation,
      state,
      detail: st(`notice.command.compact.${state}`),
    });
  }

  /** 파일 변경 알림에서 diff를 붙잡아 둔다 — 뒤에 올 승인 카드가 보여줄 내용이다. */
  private rememberFileChanges(n: ServerNotification) {
    if (n.method === "item/fileChange/patchUpdated") {
      this.fileChanges.set(n.params.itemId, n.params.changes.map((c) => ({ path: c.path, diff: c.diff, ...movePathOf(c.kind) })));
      return;
    }
    if (n.method !== "item/started" && n.method !== "item/completed") return;
    const item = n.params.item;
    if (item.type !== "fileChange") return;
    this.fileChanges.set(
      item.id,
      item.changes.map((c) => ({ path: c.path, diff: c.diff, isCreate: c.kind.type === "add", ...movePathOf(c.kind) })),
    );
  }

  /** 이번 턴이 쓰던 임시 첨부 파일을 지운다(멱등). */
  private releaseActive() {
    for (const f of this.activeFiles) f.release();
    this.activeFiles = [];
  }

  /**
   * 서버가 거꾸로 보낸 요청 — 승인 카드와 질문 카드가 여기서 만들어진다(D5).
   *
   * 세 가지 승인 종류 중 **권한 확대 요청만은 카드로 올리지 않는다.** 그 요청의 응답 형식은 "이만큼 더
   * 허용한다"는 권한 묶음이지 예/아니오가 아니다(생성 타입 확인). Aether는 확대 승인을 화면에 노출하지
   * 않기로 이미 정해 뒀으므로(H1), 아무것도 더 주지 않는 답을 돌려준다. 사용자가 그 작업을 허용하고
   * 싶으면 뒤이어 오는 **명령 실행 승인 카드**에서 허용하면 되고, 그 경로는 그대로 열려 있다.
   */
  private async onServerRequest(r: CodexServerRequest): Promise<unknown> {
    const signal = this.turnSignal();
    switch (r.method) {
      case "item/commandExecution/requestApproval": {
        const p = r.params as CommandExecutionRequestApprovalParams;
        const net = p.networkApprovalContext;
        const out = await this.opts.onPermission({
          toolName: "commandExecution",
          displayName: st("notice.codex.tool.command"),
          // 화면·기록이 읽는 키 이름은 provider와 무관한 약속이다(`command`·`path`…) — 그 약속에 맞춰 담는다.
          input: {
            command: p.command ?? "",
            cwd: p.cwd ?? this.opts.cwd,
            ...(net ? { host: net.host, protocol: net.protocol } : {}),
          },
          toolUseID: p.itemId,
          description: p.reason ?? undefined,
          signal,
        });
        return { decision: out.allow ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const p = r.params as FileChangeRequestApprovalParams;
        // 승인 요청 payload에는 diff가 없다(8a 실측). diff는 같은 itemId의 파일 변경 항목에 실려 먼저 온다.
        const changes = this.fileChanges.get(p.itemId) ?? [];
        // 편집 자동 수락: 변경이 전부 작업 폴더 안이면 카드 없이 받는다. 폴더 밖이거나 경로를 모르면 카드로 묻는다.
        if (this.permissionMode === "edits" && !p.grantRoot && changesInsideFolder(this.opts.cwd, changes.flatMap((c) => (c.movePath ? [c.path, c.movePath] : [c.path])))) {
          return { decision: "accept" };
        }
        const out = await this.opts.onPermission({
          toolName: "fileChange",
          displayName: st("notice.codex.tool.fileChange"),
          input: { path: changes.map((c) => c.path).join(", ") },
          mutation: previewFromUnifiedDiff(changes, this.opts.cwd),
          toolUseID: p.itemId,
          description: p.reason ?? undefined,
          signal,
        });
        return { decision: out.allow ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval":
        // 아무 권한도 더 주지 않는다(위 주석 참조). 이 턴 범위로만 답해 세션에 흔적을 남기지 않는다.
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput": {
        const p = r.params as ToolRequestUserInputParams;
        const out = await this.opts.onQuestion({
          toolUseID: p.itemId,
          questions: p.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: (q.options ?? []).map(mapQuestionOption).filter((o): o is NonNullable<typeof o> => !!o),
          })),
          signal,
        });
        if (!out.answered) return { answers: {} };
        // 고른 선택지와 직접 적은 문장을 함께 돌려준다 — 둘의 구분은 이미 세션이 검증해 뒀다(8d-3 ⑥ⓒ).
        const answers: Record<string, { answers: string[] }> = {};
        p.questions.forEach((q, i) => {
          const a = out.answers[i];
          const picked = [...(a?.chosen ?? []), ...(a?.custom ? [a.custom] : [])];
          if (picked.length) answers[q.id] = { answers: picked };
        });
        return { answers };
      }
      default:
        // 모르는 요청에 빈 성공을 돌려주면 상대는 우리가 처리했다고 믿는다. 예를 들어 인증 토큰 갱신 요청에
        //   그러면 갱신된 척하고 넘어가 세션이 조용히 망가진다(외부 검토 지적, 2026-08-18).
        //   실패로 답하면 상대가 그 사실을 알고, 우리 로그에도 무엇이 왔는지 남는다.
        throw new Error(`Aether가 처리하지 않는 요청이다: ${r.method}`);
    }
  }

  /** 이번 턴의 취소 신호 — 턴이 끝나거나 세션이 정리되면 보류 중인 카드가 자동으로 거부 처리된다. */
  private turnSignal(): AbortSignal {
    return (this.turnAbort ??= new AbortController()).signal;
  }

  private onExit(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) {
    // 승인 대기 중 프로세스가 죽으면 그 카드는 영영 답을 못 받는다 — 취소 신호로 세션이 거부 처리하게 한다
    //   (8a 실측: 이 정리는 클라이언트 몫이다).
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.finishCommandOperation("failed");
    this.releaseActive();
    // 아직 보내지 못한 입력의 임시 파일도 함께 지운다 — 프로세스가 죽으면 이 세션은 더 못 쓰므로
    //   그 파일들은 영영 소비되지 않는다(외부 검토 지적, 2026-08-18).
    for (const job of this.queue.splice(0)) for (const f of job.files) f.release();
    // ★ 지식툴 창구의 토큰도 여기서 버린다. 크래시 경로는 `dispose()`를 안 지나가므로, 이걸 빼면
    //   죽은 세션의 자격증명이 등록표에 영영 남고 창구도 안 닫힌다(외부 검토 지적, 2026-08-18).
    //   세션이 되살아나면 새 runtime이 새 토큰을 발급받는다.
    this.bridge?.dispose();
    this.bridge = null;
    if (this.disposed) {
      this.endStream(); // 우리가 끝낸 것 — 정상 종료
      return;
    }
    // 예기치 않은 종료는 세션 크래시로 정직하게 드러낸다. 되살리기는 공통 경로가 맡는다(파일 머리 주석).
    const detail = info.stderr.trim().slice(-500);
    this.endStream(new Error(`codex app-server가 예기치 않게 종료됐다(code=${info.code ?? "-"} signal=${info.signal ?? "-"})${detail ? `: ${detail}` : ""}`));
  }

  /**
   * 세션 종료·삭제 시 이 runtime이 잡고 있는 자원을 전부 놓는다. 멱등이며 실패를 스스로 삼킨다.
   * 정리 대상: 큐에 남은 입력의 임시 파일, 진행 중 턴의 임시 파일, 세션 전용 임시 폴더, 그리고 프로세스.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.finishCommandOperation("failed");
    this.disposed = true;
    this.turnAbort?.abort(); // 보류 중인 카드 정리
    this.turnAbort = null;
    for (const job of this.queue.splice(0)) for (const f of job.files) f.release();
    this.releaseActive();
    this.attachments.disposeAll();
    // 세션의 토큰을 즉시 버린다 — 이 뒤로 그 토큰을 쓰는 요청은 전부 401이다.
    this.bridge?.dispose();
    this.bridge = null;
    this.endStream();
    await this.server.close().catch((e) => { void reportError(e, { component: "session", operation: "provider.transport.close", session_id: this.opts.sessionId }); console.error("[aether] codex app-server 종료 실패:", e); });
  }
}
