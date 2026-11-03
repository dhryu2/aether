import { failuresFor } from "../providers/failureTracking";
import { reportError } from "../observability/report";
/**
 * LiveSession — 살아있는 세션 1개(모델 제공자 무관).
 *
 * 실행부(모델 프로세스 스폰·턴 진행·권한 왕복·프롬프트 주입)는 `AgentRuntime`이 맡고(Phase 8d · D3),
 * 이 클래스는 그 위에 얹힌 Aether 공통 자산을 소유한다.
 *
 * 보유:
 *  - AgentRuntime 핸들(provider별 구현 — 세션 생성 시 확정, lifecycle 동안 고정)
 *  - 이벤트 버퍼(seq 단조증가, 상한·롤링) + 디스크 영속
 *  - 구독자(SSE) 팬아웃, replaySince(재접속 복원)
 *  - 보류 권한요청·질문 맵(runtime 콜백 ↔ POST /permission·/question)
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import * as store from "./persistence";
import type { Published, SessionEventLog } from "./eventLog";
import { HOLD_EVENT_KINDS, orphanHoldResolves } from "./orphanHolds";
import { applyIsolatedWorkspace as applyIsolatedCopy, discardIsolatedWorkspace as discardIsolatedCopy } from "./isolatedWorkspace";
import { lastWorkPreview as previewFromEvents } from "./workPreview";
import type { AttentionHold, AttentionSticky } from "./attention";
import { waitingFromPending } from "../notify/worthNotifying";
import { isBlankAssistantText } from "../../shared/blankAssistantText";
import { st } from "../i18n";
import { isAuthError } from "../auth/loginParse";
import { isControlEvent, stripMutationForPersist, type AetherEvent, type AetherEventBody, type ImageAttachment, type DocAttachment, type PermissionRequest, type PlanRequest, type QuestionRequest, type SessionMeta, type SessionEffort } from "../types";
import {
  appendCheckpoint,
  applyRestore,
  buildReseed,
  checkpointsForApproval,
  isHiddenSeq,
  linesForReseed,
  loadCheckpoints,
  parseHiddenRanges,
  planRewind,
  RewindError,
  rewindTarget,
  type HiddenRange,
  type RewindOutcome,
} from "./rewind";
import { providerEntry } from "../providers/registry";
import { currentDistillModel, pickGeneration } from "../providers/distillModel";
import type {
  AgentRuntime,
  PermissionAsk,
  PermissionOutcome,
  PlanAsk,
  PermissionPolicy,
  PlanOutcome,
  ProviderId,
  ProviderServices,
  QuestionAnswer,
  QuestionAsk,
  QuestionOutcome,
  RuntimeCommand,
  RuntimeCommandInvocation,
  RuntimeCommandOperation,
  RuntimeHandshake,
  RuntimeModel,
} from "../providers/types";
import type { ProviderEventCodec, ProviderPersistFilter } from "./codec/types";
import { mergeModelList, rememberModelList } from "../providers/modelCatalogMemory";
import { buildCommonSystemAppend } from "./injections";
import { filterUserMsgForPersist } from "./persistFilter";
import { deriveWorkTitle, resolveWorkTitle, stripLeadingCommand } from "../../shared/workTitle";
import { summarizeSessionTitle } from "./sessionTitle";
import { readTitleSummarize } from "./titleSummarySetting";
import { extractIndexable } from "../search/extract";
import { createLetterRefiner } from "../search/refineLetter";
import { projectLiveLetter, touchLetterSession } from "../db/sessionLetter";
import { affectsLastActivity } from "./eventSemantics";
import { questionnaireFollowupHint, questionToolRedirect } from "../agent-brief/rules";
import { buildQuestionnaireAnswerText, findQuestionnaireBlock, parseQuestionnaire, questionnaireRetryVerdict, validateQuestionnaireAnswers } from "../agent-brief/questionnaire";
import { PERMISSION_RANK } from "../../shared/http";
import type { AutoResumePlan, HandoffJob, HandoffSource, PermissionMode, QuestionnaireAnswerValue, QuestionnaireQuestion } from "../../shared/http";
import type { BackgroundTask } from "../../shared/agentEvent";
import { resolveModelDisplayName } from "./modelLabel";
import { assistantTextFromBuffer } from "./assistantText";

type Subscriber = (ev: AetherEvent) => void;
// req.input은 SSE/메모리용 표시본(시크릿 경로면 redact). 실행 인자 원본은 runtime이 들고 있다.
// H1: "인자 수정"(updatedInput) 통로 폐쇄 — 세션은 allow/deny만 답하고, allow 시 원본을 실행에 되돌리는 일은 runtime이 한다.
type Pending = { req: PermissionRequest; resolve: (r: PermissionOutcome) => void };
// 구조화 질문 보류 — 권한과 달리 선택지 답을 돌려준다(모델에 전달하는 통로는 provider별 수법 = runtime 책임).
type PendingQuestion = { req: QuestionRequest; resolve: (r: QuestionOutcome) => void };
type PendingPlan = { req: PlanRequest; resolve: (r: PlanOutcome) => void };

/** Aether 자체 명령. provider 명령과 같은 목록·실행 API를 타지만 의미는 공통 세션 계층이 소유한다. */
const AETHER_COMMANDS: readonly RuntimeCommand[] = [
  {
    name: "model",
    description: { byLocale: { ko: "모델 변경", en: "Change model" } },
    argumentHint: { byLocale: { ko: "[모델 이름]", en: "[model name]" } },
    startsTurn: false,
  },
  {
    name: "effort",
    description: { byLocale: { ko: "생각 강도", en: "Thinking effort" } },
    argumentHint: { byLocale: { ko: "[생각 강도]", en: "[thinking effort]" } },
    startsTurn: false,
  },
  {
    name: "new",
    description: { byLocale: { ko: "새 작업 만들기", en: "Start a new work item" } },
    argumentHint: {},
    startsTurn: false,
    uiAction: "newSession",
  },
  {
    name: "rename",
    description: { byLocale: { ko: "작업 이름 바꾸기", en: "Rename this work item" } },
    argumentHint: { byLocale: { ko: "[새 이름]", en: "[new name]" } },
    aliases: ["title"],
    startsTurn: false,
    uiAction: "rename",
  },
  {
    name: "delete",
    description: { byLocale: { ko: "이 작업 삭제", en: "Delete this work item" } },
    argumentHint: {},
    startsTurn: false,
    uiAction: "delete",
  },
  {
    name: "settings",
    description: { byLocale: { ko: "설정 열기", en: "Open settings" } },
    argumentHint: {},
    startsTurn: false,
    uiAction: "settings",
  },
  {
    name: "help",
    description: { byLocale: { ko: "단축키 도움말", en: "Keyboard shortcuts" } },
    argumentHint: {},
    startsTurn: false,
    uiAction: "help",
  },
  {
    name: "find",
    description: { byLocale: { ko: "이 세션에서 찾기", en: "Find in this session" } },
    argumentHint: {},
    startsTurn: false,
    uiAction: "find",
  },
  {
    name: "login",
    description: { byLocale: { ko: "다시 로그인", en: "Sign in again" } },
    argumentHint: {},
    startsTurn: false,
    uiAction: "login",
  },
  {
    name: "status",
    description: { byLocale: { ko: "사용량·세션 상태", en: "Usage and session status" } },
    argumentHint: {},
    aliases: ["info", "session-info", "context", "usage", "cost"],
    startsTurn: false,
    uiAction: "status",
  },
];

function aetherOwnedCommand(name: string): RuntimeCommand | undefined {
  const n = name.toLowerCase();
  return AETHER_COMMANDS.find((c) => c.name === n || (c.aliases ?? []).some((a) => a.toLowerCase() === n));
}

/** 공통 명령 뒤에 provider 명령을 붙인다. 이름이 겹치면 공통 명령이 이긴다. */
export function mergeCommands(providerCommands: readonly RuntimeCommand[]): RuntimeCommand[] {
  const commonNames = new Set(AETHER_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).map((n) => n.toLowerCase()));
  return [
    ...AETHER_COMMANDS.map((command) => ({ ...command })),
    ...providerCommands
      .filter((command) => !commonNames.has(command.name.toLowerCase()))
      .map((command) => ({
        ...command,
        aliases: command.aliases?.filter((alias) => !commonNames.has(alias.toLowerCase())),
      })),
  ];
}

/** model·effort는 provider 판정 전에 기존 REST와 같은 최소 형식 가드를 거친다. */
function isWellFormedCommandValue(value: string): boolean {
  if (value.length < 1 || value.length > 64 || value.startsWith("-")) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

type QuestionnaireAnswerRecord = { id: string; answers: Record<string, QuestionnaireAnswerValue> };

/** 카드 답 처리 결과. duplicate는 같은 식별자로 이미 기록돼 있고 runtime에 다시 보내지 않았다는 뜻이다. */
export type QuestionnaireAnswerResult =
  | { ok: true }
  | { ok: true; duplicate: true }
  | { ok: false; status: 400 | 409; error: string };

/** 열린 질문지를 찾으려고 기록에서 한 번에 읽는 사건 수. */
// 배경 작업 모델을 새로 고른 사건을 provider별로 어디까지 알렸는지. 서버 전체에서 한 번만 알린다 —
//   세션마다 두면 새 세션이 열릴 때마다 같은 알림이 다시 뜬다. 선택은 턴 도중(과거검색 요약)에도 일어나므로
//   턴이 끝날 때 비교한다.
const notifiedPickGens = new Map<ProviderId, number>();
const OPEN_QUESTIONNAIRE_PAGE = 200;
/** 뒤 작업이 모두 끝난 뒤 provider가 스스로 새 턴을 열기까지 기다려 주는 시간(ms). 이 안에 턴이 열리면 완료를 늦춘다. */
export const BACKGROUND_HOLD_MS = 2000;

export type SessionCommandResult =
  | { accepted: true; startsTurn: boolean; sessionUpdate?: { model?: string; effort?: SessionEffort } }
  | { accepted: false; error: string };

/** 목록에 없는 모드를 요청했다(400). */
export class PermissionModeUnavailableError extends Error {}
/** 조회하는 사이 다른 변경이 끼어들어 적용하지 않았다(409). */
export class PermissionModeConflictError extends Error {}

/**
 * 세션이 정해진 시간 안에 "준비됐다"고 답하지 못했다 (`waitHandshake`).
 *
 * 별도 클래스인 이유: 호출부가 이걸 "모델 이름이 틀렸다"와 갈라야 한다. 앞은 사용자가 오타를 고치면
 * 되는 일(400)이고, 뒤는 사용자가 할 수 있는 게 없는 일(504)이라 안내도 상태 코드도 달라야 한다.
 */
export class SessionReadyTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReadyTimeoutError";
  }
}

export class LiveSession {
  readonly id: string;
  readonly cwd: string;
  readonly provider: ProviderId; // 세션 생성 시 확정, lifecycle 동안 고정(§0.1-2)
  name?: string; // 사람이 직접 붙인 작업 이름(rename). 미지정 = generatedName 또는 화면의 '새 세션'.
  generatedName?: string; // 첫 사용자 말에서 뽑은 임시 제목, 곧이어 모델이 요약한 제목. name이 있으면 목록에 안 쓴다.
  model?: string; // 미지정 = 계정 기본 모델(runtime이 옵션에서 생략). setModel로 런타임 변경 가능.
  accountDefaultModel?: string; // 마지막으로 확인한 계정 기본 모델의 정식 id. 목록 카드 표시 전용(runtime에 안 넘긴다).
  /** 스트림에서 마지막으로 본 실제 모델. 목록 카드는 고른 모델보다 이 값을 우선한다. */
  observedModel?: string;
  /** provider가 마지막 턴에 실제로 적용했다고 알린 강도. */
  observedEffort?: string;
  /** 목록 카드용 표시 이름. 이 세션 모델 목록에서 찾았고, 없으면 비운다. */
  modelLabel?: string;
  effort?: SessionEffort; // /effort로 설정한 reasoning effort. 미지정 = 계정 기본. setEffort로 런타임 변경 가능.
  /** 권한 모드. 'full'만 카드 없이 전부 허용한다. 시작값은 생성 옵션(새 세션은 수동에서 시작해 어댑터가 정한 값으로 맞춘다), setPermissionMode로 변경. */
  permissionMode: PermissionMode;
  /** 마지막으로 provider에게 받은 고를 수 있는 모드. 잠든 세션도 이 목록으로 답한다. */
  permissionModes?: PermissionMode[];
  private permissionEpoch = 0; // 사용자가 모드를 바꿀 때마다 올린다. 늦게 도착한 어댑터 값이 사용자의 선택을 덮지 않게 한다.
  private permissionChanging = 0; // 모드 변경이 진행 중인 횟수. 그동안의 목록 조회는 목록만 갱신하고 현재 모드를 덮지 않는다.
  private freshPermission: boolean; // 새 세션이고 사용자가 모드를 정하지 않았으며 첫 턴 전이다. 이때 어댑터가 정한 기본값 확정은 알리지 않는다.
  readonly workspaceSource?: string; // 작업 폴더를 분리했을 때 원래 고른 폴더. 없으면 격리 없음.
  readonly createdAt: number; // 생성시각(1회 고정) — result마다 덮어쓰지 않는다
  lastActivityAt: number; // 마지막 이벤트(턴 입력·응답·도구 등) 시각 — 사이드바 '마지막 사용' 표기용
  lastInputAt: number; // 사람이 마지막으로 글을 보낸 시각. 사이드바 순서가 응답마다 뒤바뀌지 않도록 정렬은 이 값을 쓴다
  lastViewedAt?: number; // 대화 통로가 따라잡은 시각. 폰·컴퓨터가 같은 "안 봄"을 본다.
  archivedAt?: number; // 보관한 시각(ms). 없으면 보관 아님.
  attentionSticky?: AttentionSticky; // 마지막 완료·실패 사건. 잠든 세션 복원용.
  attentionHold?: AttentionHold; // 한도 막힘·끊긴 요청. 다음 턴이 열리면 지운다.
  autoResume?: AutoResumePlan; // 한도가 풀리면 이어 가기 예약. 메타에 저장돼 재시작 뒤에도 남는다.
  handoffFrom?: string; // 넘기기로 이어 받은 이전 세션
  handoffTo?: string; // 이 세션이 넘겨 준 다음 세션(마지막 하나)
  handoffDraft?: { text: string; source: HandoffSource }; // 새 세션 쪽 입력창 초안. 첫 말을 보내면 지운다.
  handoffJob?: HandoffJob; // 이전 세션 쪽 넘기기 작업
  resumeKey?: string; // 이어가기 식별자 — 코어는 의미를 모르고 provider adapter만 해석한다(D12).
  hiddenRanges: HiddenRange[] = [];
  reseedText?: string;
  rewound = false;
  /** provider가 마지막으로 알려 준 명령 목록(공통 명령 제외). 잠든 세션이 이 목록으로 답한다. */
  commandCatalog?: RuntimeCommand[];
  /** 잠들기 직전에 기억한 승인 정책. 깨어난 세션은 새로 묻는다. */
  private sleepPolicy?: PermissionPolicy;
  /** 이 인스턴스가 만들어진 시각. 쉬는 시간은 마지막 활동과 이 시각 중 늦은 쪽부터 잰다. */
  private readonly awakeSince = Date.now();

  private readonly eventLog: SessionEventLog;
  private releaseLog: (() => void) | null = null;
  private buffer: AetherEvent[] = [];
  /** buffer와 같은 순서의 사건별 바이트 크기와 그 합. 개수 상한과 별개로 메모리를 묶는다. */
  private bufferSizes: number[] = [];
  private bufferBytes = 0;
  private subs = new Set<Subscriber>();
  private pending = new Map<string, Pending>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private pendingPlans = new Map<string, PendingPlan>();
  private readonly runtime: AgentRuntime;
  private readonly onTitleChange?: (session: LiveSession) => void;
  private readonly services: ProviderServices; // 이 세션의 백그라운드 지능(distill) — provider를 따른다(D6)
  readonly codec: ProviderEventCodec; // 이 세션 이벤트의 수명주기 판정 일체(D2.6)
  private readonly persistFilter: ProviderPersistFilter; // 세션 1개의 영속 축소기(시크릿 추적 상태 보유)
  private readonly letterRefiner = createLetterRefiner(); // 검색용 표 정제기 — 다시 만들기와 같은 규칙, 세션 하나의 상태
  private ended = false;
  private rewinding = false;
  private endedResolve: () => void = () => {};
  private readonly endedPromise: Promise<void> = new Promise((resolve) => {
    this.endedResolve = resolve;
  });
  private disposed = false; // 영구삭제(dispose)됨 — 이후 디스크 쓰기 금지(사라진 dir append ENOENT·좀비 부활 차단)
  private authNotified = false; // 인증만료 notice 1회만(스팸 방지). 성공 턴이면 재무장.
  /** 완료 전 새 입력을 막아야 하는 provider-native 명령 작업. */
  private readonly blockingCommandOperations = new Set<string>();
  // 깨어난 뒤 사용자가 실제로 말을 걸기 전까지는 '마지막 사용'을 갱신하지 않는다. 세션을 열기만 해도
  //   이어가기 안내와 provider 시작 훅이 쌓이는데, 그것까지 활동으로 세면 구경만 한 세션이 목록 맨 위로 온다.
  private awaitingFirstInput = true;
  private turnOpen = false;
  /** 메인 턴이 끝난 뒤에도 백그라운드 작업(provider가 알려 준 전체 목록). 프로세스 시작·종료 때 비운다. */
  private bgTasks: BackgroundTask[] = [];
  /** 뒤 작업이 모두 끝난 직후 깨움 턴이 열리기까지 화면에 '백그라운드 작업 중'을 붙잡아 두는 직전 목록과 마감 시각. */
  private bgHold: { tasks: BackgroundTask[]; until: number } | null = null;
  /**
   * 브리프 대화가 진행 중이다. 질문 도구를 막고 턴 끝에서 질문지를 읽는다.
   * 브리프 입력에서 켜고, 마지막 글에 질문지 상자 없이 끝난 턴에서 끈다.
   */
  private briefOpen = false;
  /** 마지막 사람 입력(user_msg)의 순번. 이보다 앞선 모델 글은 질문지 후보가 아니다. */
  private lastUserMsgSeq = 0;
  /** runtime에 넘겼지만 아직 턴 끝을 못 본 턴 입력 수. 질문지 판정 전용이고 turnOpen과 따로다. */
  private openTurns = 0;
  /** 이번 턴에서 본 마지막 모델 글. 턴 끝에서 질문지 상자를 찾는 후보다. */
  private textCandidate: { seq: number; part: number; text: string } | null = null;
  /** 세션별 입력 문. 앞 구간이 아직 안 끝났을 때만 약속이 있다. */
  private inputGate: Promise<void> | null = null;
  /** endsTurn 이후 ctx ingest(또는 실패) 대기. waitCtx가 소비한다. */
  private ctxWait: Promise<void> = Promise.resolve();
  private ctxEpoch = 0;
  private ctxWaitedEpoch = 0;
  /** 마지막 준비 신호가 준 모델 목록. 재개 직후 아직 신호가 없으면 null이다. */
  private modelCatalog: readonly RuntimeModel[] | null = null;
  /** 마지막으로 기억한 준비 신호 결과. 같은 결과를 두 번 기억하지 않으려고 둔다. */
  private lastHandshake: RuntimeHandshake | null = null;
  /**
   * 지금 표시 이름이 어느 원문에 대한 것인지. 디스크에는 안 남긴다.
   * 표시 이름과 유효 모델은 항상 같은 저장에 나가므로, 재개 직후에는 저장된 이름이 그 원문의 것이라고 본다.
   * 목록을 아직 모르는데 유효 모델이 바뀌면 표시 이름을 비운다.
   */
  private modelLabelFor = "";

  constructor(opts: {
    id?: string;
    cwd: string;
    name?: string;
    generatedName?: string;
    onTitleChange?: (session: LiveSession) => void;
    provider: ProviderId;
    model?: string;
    accountDefaultModel?: string;
    observedModel?: string;
    observedEffort?: string;
    modelLabel?: string;
    resume?: string;
    createdAt?: number;
    permissionMode?: PermissionMode;
    permissionModes?: PermissionMode[];
    effort?: SessionEffort;
    lastActivityAt?: number;
    lastInputAt?: number;
    workspaceSource?: string;
    lastViewedAt?: number;
    archivedAt?: number;
    attentionSticky?: AttentionSticky;
    hiddenRanges?: HiddenRange[];
    reseedText?: string;
    rewound?: boolean;
    commandCatalog?: RuntimeCommand[];
    eventLog: SessionEventLog;
  }) {
    this.id = opts.id ?? randomUUID();
    this.cwd = opts.cwd;
    this.name = opts.name;
    this.generatedName = opts.generatedName;
    this.onTitleChange = opts.onTitleChange;
    this.model = opts.model;
    this.accountDefaultModel = opts.accountDefaultModel;
    this.observedModel = opts.observedModel?.trim() || undefined;
    this.observedEffort = opts.observedEffort;
    this.modelLabel = opts.modelLabel?.trim() || undefined;
    // 목록을 다시 받기 전에는 저장된 표시 이름을 유지한다. 유효 모델이 그 사이 바뀌면 비운다.
    this.modelLabelFor = this.effectiveModel();
    this.effort = opts.effort;
    // 미지정(새 세션)은 수동으로 시작한다. 어댑터가 정한 기본값은 준비 신호 뒤에 받아 맞춘다(넓어지는 순간이 없게 좁은 쪽에서 시작).
    this.permissionMode = opts.permissionMode ?? "manual";
    this.permissionModes = opts.permissionModes;
    this.freshPermission = opts.permissionMode === undefined;
    this.workspaceSource = opts.workspaceSource;
    this.createdAt = opts.createdAt ?? Date.now(); // resume 시 원본 생성시각 보존(덮어쓰기 방지)
    this.resumeKey = opts.resume?.trim() || undefined;
    this.hiddenRanges = parseHiddenRanges(opts.hiddenRanges);
    this.reseedText = opts.reseedText?.trim() || undefined;
    this.commandCatalog = opts.commandCatalog;
    this.rewound = opts.rewound === true || this.hiddenRanges.length > 0 || !!this.reseedText;
    if (opts.eventLog.sessionId !== this.id) throw new Error("세션 사건 기록기가 다른 세션이다");
    this.eventLog = opts.eventLog;

    // provider 확정 — 미등록 값이면 여기서 throw(조용한 fallback 금지 §0.1-4).
    //   metaSnapshot·tailInfo가 codec을 참조하므로 디스크 접근 전에 먼저 확정한다.
    const entry = providerEntry(opts.provider);
    this.provider = entry.id;
    this.services = entry.services;
    this.codec = entry.codec;
    this.persistFilter = entry.codec.persistFilter();

    this.lastActivityAt = opts.lastActivityAt ?? store.tailInfo(this.id, this.codec).lastTs ?? this.createdAt; // resume 시 영속 활동시각 우선 복원
    this.lastInputAt = opts.lastInputAt ?? store.lastUserInputTs(this.id) ?? this.createdAt;
    const prevMeta = store.loadMeta(this.id);
    this.lastViewedAt = opts.lastViewedAt ?? prevMeta?.lastViewedAt;
    this.archivedAt = opts.archivedAt ?? prevMeta?.archivedAt;
    this.attentionSticky = opts.attentionSticky ?? prevMeta?.attentionSticky;
    this.attentionHold = prevMeta?.attentionHold;
    this.autoResume = prevMeta?.autoResume;
    this.handoffFrom = prevMeta?.handoffFrom;
    this.handoffTo = prevMeta?.handoffTo;
    this.handoffDraft = prevMeta?.handoffDraft;
    // 인계서를 쓰던 턴은 재시작으로 끊겼다. 한도 대기와 복사 결과만 남긴다.
    this.handoffJob = prevMeta?.handoffJob?.state === "writing" ? undefined : prevMeta?.handoffJob;
    this.briefOpen = prevMeta?.briefOpen === true;

    // 영속 축소기는 이벤트 간 상태를 들 수 있다(Claude: 시크릿 파일 Read의 tool_use id). 재시작 뒤 그 상태를
    // 되살리지 않으면 Read 직후 서버가 죽었을 때 다음 tool_result가 평문으로 저장될 수 있다. 최근 꼬리만
    // 다시 읽어 전체 대화 로그를 매 resume마다 스캔하지 않으며, 기존 이벤트는 재기록하지 않고 관측만 한다.
    // 읽기 실패는 resume 자체를 막지 않되, 이후 이벤트는 보수적으로 새 상태에서 처리한다.
    try {
      for (const ev of store.readRecentEvents(this.id)) this.persistFilter.restore(ev);
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.persist_reducer.restore", session_id: this.id, provider: this.provider }); console.error("[aether] 영속 축소기 상태 복원 실패(새 이벤트만 보호):", e);
    }

    if (!this.name?.trim() && !this.generatedName?.trim()) {
      const text = store.firstUserMessageText(this.id);
      const gen = text ? deriveWorkTitle(text) : null;
      if (gen) this.generatedName = gen;
    }
    store.ensureSessionDir(this.id);
    store.saveMeta(this.metaSnapshot());
    this.releaseLog = this.eventLog.bindLive((published) => this.onPublished(published));
    // 재시작 뒤엔 실행기가 예전에 들고 있던 카드를 받을 수 없다. 화면이 계속 기다리게 두지 않는다.
    this.closeOrphanHolds();

    this.runtime = entry.createRuntime({
      sessionId: this.id,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      permissionMode: opts.permissionMode,
      resumeKey: this.resumeKey,
      // 세션 시작 때 한 번 붙는 공통 안내(회상·메모리 스냅샷·스킬 안내). runtime은 이 문자열만 붙인다.
      systemAppend: buildCommonSystemAppend(this.cwd) || undefined,
      // 되돌린 세션의 첫 턴에만 다시 심을 대화를 얹는다. 되돌린 세션은 새로 만들어지므로 생성 때 값이 있는지만 보면 된다.
      turnContext: this.reseedText
        ? async () => {
            const reseed = this.takeReseed();
            return reseed ? [reseed] : [];
          }
        : undefined,
      onPermission: (ask) => this.requestPermission(ask),
      onQuestion: (ask) => this.requestQuestion(ask),
      onPlan: (ask) => this.requestPlan(ask),
      workspaceSource: this.workspaceSource,
      onResumeKey: (key) => this.persistResumeKey(key),
      onEffortObserved: (effort) => this.noteObservedEffort(effort),
      onCommandOperation: (operation) => this.recordCommandOperation(operation),
      onTodoList: (items) => this.ingest({ kind: "todo_list", items }),
    });

    void this.run();
    // 어댑터가 실제로 적용한 모드와 목록을 바로 받아 맞춘다(준비 신호에 기대지 않는다). 복원된 세션도 같다.
    void this.syncPermissionModes();
  }

  // ── 입력/제어 ──
  /** 사건에는 사람이 쓴 글을 담는다. 새 글에는 briefId를 붙이지 않는다. */
  private userTurnBody(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    clientMessageId?: string,
    questionnaireAnswer?: QuestionnaireAnswerRecord,
    sentBy?: "aether",
  ): AetherEventBody {
    return {
      kind: "user_msg",
      text,
      images,
      documents,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(sentBy ? { sentBy } : {}),
      // 넘기기 초안이 남아 있는 동안의 첫 말은 이어 받은 말이다(사람이 고쳐 보냈어도).
      ...(this.handoffDraft && this.handoffFrom ? { handoffFrom: this.handoffFrom } : {}),
      ...(questionnaireAnswer ? { questionnaireAnswer } : {}),
    };
  }

  /** 사용자가 새 턴을 시작했다는 공통 기록. 일반 메시지와 턴 시작 슬래시 명령이 같은 영속·SSE 경로를 쓴다. */
  private commitUserTurn(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    clientMessageId?: string,
    questionnaireAnswer?: QuestionnaireAnswerRecord,
    sentBy?: "aether",
  ): Promise<void> {
    return this.commitUserTurnDurable(text, images, documents, clientMessageId, questionnaireAnswer, sentBy);
  }

  /** 데이터베이스 기록이 끝나고 공개된 뒤에만 턴을 연다. 실패하면 그 순번은 빈 번호로 남고 예외를 던진다. */
  private async commitUserTurnDurable(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    clientMessageId?: string,
    questionnaireAnswer?: QuestionnaireAnswerRecord,
    sentBy?: "aether",
  ): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    const body = this.userTurnBody(text, images, documents, clientMessageId, questionnaireAnswer, sentBy);
    const written = await this.eventLog.writeDurable(body, (ev) => {
      const stripped = stripMutationForPersist(ev);
      const toPersist = filterUserMsgForPersist(stripped);
      if (!toPersist) throw new Error("user_msg persist filtered");
      return toPersist;
    });
    this.lastUserMsgSeq = written.seq;
    this.handoffDraft = undefined;
    this.awaitingFirstInput = false;
    this.freshPermission = false;
    this.interruptRequested = false;
    this.turnOpen = true;
    this.attentionHold = undefined; // 새 턴이 열리면 막힘 표시를 푼다(아래 저장이 함께 반영)
    this.maybeAdoptGeneratedName(text);
    this.persistMeta("turn 시작");
  }

  /** 사람이 이름을 안 붙였고 자동 제목도 없으면 첫 말에서 뽑는다. 이후 말은 덮지 않는다. */
  private maybeAdoptGeneratedName(text: string) {
    if (this.name?.trim() || this.generatedName?.trim()) return;
    const gen = deriveWorkTitle(text);
    if (!gen) return;
    this.generatedName = gen;
    this.upsertSearchSession(gen);
    if (readTitleSummarize()) void this.adoptSummarizedName(stripLeadingCommand(text), gen);
  }

  /** 임시 제목을 요약 제목으로 바꾼다. 턴을 기다리게 하지 않고, 실패하면 임시 제목이 남는다. */
  private async adoptSummarizedName(text: string, draft: string) {
    const title = await summarizeSessionTitle(this.services, text, this.cwd, this.id);
    // 끝난 인스턴스가 저장하면 그 뒤에 만든 인스턴스의 meta를 옛 값으로 덮는다.
    if (!title || this.ended || this.generatedName !== draft) return;
    this.generatedName = title;
    this.persistMeta("요약 제목");
    this.upsertSearchSession(resolveWorkTitle(this.name, title));
    this.onTitleChange?.(this);
  }

  push(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    clientMessageId?: string,
    opts?: { modelText?: string; brief?: boolean; sentBy?: "aether" },
  ): void | Promise<void> {
    return this.serialInput(() => this.pushInGate(text, images, documents, clientMessageId, opts));
  }

  /**
   * 세션별 입력 문. 입력(push, 턴 시작 명령, 카드 답)은 기록하고 runtime에 넘기는 데까지를 한 번에 하나씩 처리한다.
   * 앞 구간이 없으면 그 자리에서 바로 돌린다. 앞 구간이 실패해도 다음 구간은 이어서 처리한다.
   * 턴이 끝나기를 기다리지는 않는다.
   */
  private serialInput<T>(fn: () => T | Promise<T>): T | Promise<T> {
    if (!this.inputGate) {
      const first = fn();
      if (!(first instanceof Promise)) return first;
      return this.holdInputGate(first);
    }
    return this.holdInputGate(this.inputGate.then(fn));
  }

  private holdInputGate<T>(work: Promise<T>): Promise<T> {
    const tail: Promise<void> = work
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (this.inputGate === tail) this.inputGate = null;
      });
    this.inputGate = tail;
    return work;
  }

  /** runtime에 턴 입력을 넘기고 열린 턴 수를 1 올린다. 넘기지 못하면 올린 것을 되돌린다. */
  private sendToRuntime(input: Parameters<AgentRuntime["push"]>[0]) {
    this.openTurns += 1;
    try {
      this.runtime.push(input);
    } catch (e) {
      this.openTurns = Math.max(0, this.openTurns - 1);
      throw e;
    }
  }

  /** 입력 문 안에서 도는 push 본체. */
  private pushInGate(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    clientMessageId?: string,
    opts?: { modelText?: string; brief?: boolean; sentBy?: "aether" },
  ): void | Promise<void> {
    // 되돌리는 중이면 꺼지는 중인 실행기로 들어가면 안 된다. 거절 문구는 되돌리기 거절과 같다.
    if (this.rewinding) throw new RewindError("busy");
    if (!store.diaryAcceptsInput(this.id)) throw new Error(st("routes.sessions.diaryBusy"));
    if (this.blockingCommandOperations.size) throw new Error(st("notice.command.busy"));
    // 사건에는 사람이 쓴 글을 남긴다. 모델 입력은 따로 있을 때만 runtime으로 간다.
    const modelText = opts?.modelText ?? text;
    if (opts?.brief === true && !this.briefOpen) {
      this.briefOpen = true;
      this.persistMeta("브리프 세션");
    }
    const runtimeInput = {
      text: modelText,
      images,
      documents,
    };
    const id = clientMessageId?.trim();
    if (id && this.hasUserMsgClientId(id)) {
      // 이미 있으면 user_msg는 skip, runtime.push는 다시(delivered=false 재전송 창).
      this.sendToRuntime(runtimeInput);
      return;
    }
    const committed = this.commitUserTurn(text, images, documents, id || undefined, undefined, opts?.sentBy);
    if (committed) {
      return committed.then(() => {
        this.sendToRuntime(runtimeInput);
      });
    }
    this.sendToRuntime(runtimeInput);
  }

  /**
   * 카드로 질문지에 답한다. push와 같은 입력 문 안에서 중복 조회, 답 검사, 열린 질문지 확인, 기록, runtime 전달 순으로 처리한다.
   * 검사와 상태 충돌은 결과로 돌려주고, push와 같은 거절(되돌리는 중, 일기 점검 중)과 저장 실패는 예외로 던진다.
   */
  submitQuestionnaireAnswer(opts: {
    questionnaireId: string;
    answers: unknown;
    clientMessageId: string;
    /** 같은 식별자가 이미 있을 때 runtime에 다시 보낼지. 승격 길은 거짓이다. */
    resendOnDuplicate: boolean;
  }): Promise<QuestionnaireAnswerResult> {
    return Promise.resolve(this.serialInput(() => this.submitQuestionnaireInGate(opts)));
  }

  private async submitQuestionnaireInGate(opts: {
    questionnaireId: string;
    answers: unknown;
    clientMessageId: string;
    resendOnDuplicate: boolean;
  }): Promise<QuestionnaireAnswerResult> {
    if (this.rewinding) throw new RewindError("busy");
    if (!store.diaryAcceptsInput(this.id)) throw new Error(st("routes.sessions.diaryBusy"));
    if (this.blockingCommandOperations.size) throw new Error(st("notice.command.busy"));
    const clientMessageId = opts.clientMessageId.trim();
    const answers = opts.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return { ok: false, status: 400, error: st("routes.sessions.questionnaire.answersInvalid") };
    }
    const existing = this.findUserMsgByClientId(clientMessageId);
    if (existing) {
      const verdict = questionnaireRetryVerdict(existing.questionnaireAnswer, {
        id: opts.questionnaireId,
        answers: answers as Record<string, QuestionnaireAnswerValue>,
      });
      if (verdict === "different") return { ok: false, status: 409, error: st("routes.sessions.questionnaire.retryDiffers") };
      if (!opts.resendOnDuplicate) return { ok: true, duplicate: true };
      this.sendToRuntime({ text: `${existing.text}\n${questionnaireFollowupHint()}` });
      return { ok: true };
    }
    const open = await this.openQuestionnaire();
    if (!open || open.id !== opts.questionnaireId) {
      return { ok: false, status: 409, error: st("routes.sessions.questionnaire.notOpen") };
    }
    const checked = validateQuestionnaireAnswers(open.questions, answers);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    const text = buildQuestionnaireAnswerText(open.questions, checked.answers);
    const committed = this.commitUserTurn(text, undefined, undefined, clientMessageId, { id: open.id, answers: checked.answers });
    if (committed) await committed;
    this.sendToRuntime({ text: `${text}\n${questionnaireFollowupHint()}` });
    return { ok: true };
  }

  /**
   * 열린 질문지. 보이는 사건(되돌리기로 숨긴 것 제외)을 최신부터 거꾸로 읽어
   * user_msg를 먼저 만나면 없고, questionnaire를 먼저 만나면 그것이다(실패 질문지는 없음).
   * 버퍼에 답이 없으면 기록에서 이전 쪽을 더 읽는다.
   */
  async openQuestionnaire(): Promise<{ id: string; questions: QuestionnaireQuestion[] } | null> {
    const judge = (ev: AetherEvent): { id: string; questions: QuestionnaireQuestion[] } | null | undefined => {
      if (isHiddenSeq(ev.seq, this.hiddenRanges)) return undefined;
      if (ev.kind === "user_msg") return null;
      if (ev.kind !== "questionnaire") return undefined;
      const body = ev as { id: string; questions?: QuestionnaireQuestion[]; invalid?: true };
      return body.invalid || !body.questions ? null : { id: body.id, questions: body.questions };
    };
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const found = judge(this.buffer[i]);
      if (found !== undefined) return found;
    }
    let before = this.buffer.length ? this.buffer[0].seq : Number.MAX_SAFE_INTEGER;
    for (;;) {
      const page = store.readEventsPage(this.id, before, OPEN_QUESTIONNAIRE_PAGE);
      for (let i = page.events.length - 1; i >= 0; i--) {
        const found = judge(page.events[i]);
        if (found !== undefined) return found;
      }
      if (!page.hasOlder || page.events.length === 0) return null;
      before = page.events[0].seq;
    }
  }

  /** 버퍼·디스크에서 같은 clientMessageId의 user_msg를 찾는다. */
  private findUserMsgByClientId(clientMessageId: string): { text: string; questionnaireAnswer?: QuestionnaireAnswerRecord } | undefined {
    const same = (ev: AetherEvent) => ev.kind === "user_msg" && (ev as { clientMessageId?: string }).clientMessageId === clientMessageId;
    const fromBuffer = this.buffer.find(same);
    if (fromBuffer) return fromBuffer as unknown as { text: string; questionnaireAnswer?: QuestionnaireAnswerRecord };
    try {
      const fromDisk = store.readRecentEvents(this.id).find(same);
      failuresFor(this).clear("session.client_message.read");
      if (fromDisk) return fromDisk as unknown as { text: string; questionnaireAnswer?: QuestionnaireAnswerRecord };
    } catch (error) {
      failuresFor(this).report(error, { component: "session", operation: "session.client_message.read", severity: "error", session_id: this.id });
      /* 디스크 읽기 실패 시 없다고 본다 */
    }
    return undefined;
  }

  /** 버퍼·디스크에 같은 clientMessageId의 user_msg가 있는지. */
  private hasUserMsgClientId(clientMessageId: string): boolean {
    return !!this.findUserMsgByClientId(clientMessageId);
  }

  /** 실행 중인 비턴 명령의 상태를 영속·SSE로 흘린다. 화면은 이 이벤트만 보고 작업 카드를 그린다. */
  private recordCommandOperation(operation: RuntimeCommandOperation) {
    if (operation.state === "started" && operation.blocksInput) this.blockingCommandOperations.add(operation.operationId);
    else this.blockingCommandOperations.delete(operation.operationId);
    this.ingest({ kind: "command_operation", ...operation });
  }

  /** 이번 턴에 사람이 멈춤을 요청했다. provider가 멈춘 턴을 어떻게 끝내든(성공·실패) 같은 신호다. 새 턴이 열리면 지운다. */
  interruptRequested = false;

  async interrupt() {
    this.interruptRequested = true;
    await this.runtime.interrupt();
  }

  /** 이 세션의 provider가 뒤 작업을 따로 멈출 수 있는가. */
  get canStopBackground(): boolean {
    return typeof this.runtime.stopBackgroundTask === "function";
  }

  /** 뒤 작업 하나를 멈춘다. 현재 목록에 없는 id이거나 멈출 수 없는 provider면 false(아무것도 하지 않는다). */
  async stopBackgroundTask(taskId: string): Promise<boolean> {
    if (!this.runtime.stopBackgroundTask) return false;
    if (!this.bgTasks.some((x) => x.id === taskId)) return false;
    await this.runtime.stopBackgroundTask(taskId);
    return true;
  }

  /**
   * 배경 작업이 쓰는 경량 모델은 이름을 손으로 적어 두지 않고 자동으로 정한다(providers/distillModel).
   *   새로 정해진 게 있으면 알린다. 설정값을 비교하지 않는 이유가 있다 — 환경변수에 못 박힌 이름이
   *   고장 나서 다른 모델로 돌고 있어도 설정값 자체는 안 바뀌므로, 값 비교로는 그 경우를 영영 못 잡는다.
   *   검색 요약이 턴 도중에 모델을 고르므로 턴이 끝날 때 한 번 확인한다.
   */
  private noteDistillModelPicked() {
    const gen = pickGeneration(this.provider);
    const model = currentDistillModel(this.provider);
    if (model && gen > (notifiedPickGens.get(this.provider) ?? 0) && !this.disposed) {
      notifiedPickGens.set(this.provider, gen);
      this.ingest({ kind: "notice", notice: "distill_model", detail: st("notice.distill.modelPicked", { model }) });
    }
  }

  /** 현재 세션 상태의 meta 스냅샷(saveMeta용 단일 chokepoint — 필드 추가 시 누락으로 영속값이 지워지는 drift 방지). */
  private metaSnapshot(): SessionMeta {
    return {
      id: this.id,
      cwd: this.cwd,
      name: this.name,
      generatedName: this.generatedName,
      provider: this.provider,
      model: this.model,
      accountDefaultModel: this.accountDefaultModel,
      observedModel: this.observedModel,
      observedEffort: this.observedEffort,
      modelLabel: this.modelLabel,
      resumeKey: this.resumeKey,
      createdAt: this.createdAt,
      permissionMode: this.permissionMode,
      ...(this.permissionModes ? { permissionModes: this.permissionModes } : {}),
      effort: this.effort,
      lastActivityAt: this.lastActivityAt,
      lastInputAt: this.lastInputAt,
      workspaceSource: this.workspaceSource,
      lastViewedAt: this.lastViewedAt,
      archivedAt: this.archivedAt,
      attentionSticky: this.attentionSticky,
      attentionHold: this.attentionHold,
      autoResume: this.autoResume,
      handoffFrom: this.handoffFrom,
      handoffTo: this.handoffTo,
      handoffDraft: this.handoffDraft,
      handoffJob: this.handoffJob,
      hiddenRanges: this.hiddenRanges.length ? this.hiddenRanges : undefined,
      reseedText: this.reseedText,
      rewound: this.rewound || undefined,
      briefOpen: this.briefOpen || undefined,
      ...(this.commandCatalog ? { commandCatalog: this.commandCatalog } : {}),
    };
  }

  /** 입력이 처리 중인가(입력 문이 열렸거나 턴 끝을 못 본 입력이 있음). 보관 판정이 attention 표시보다 이 값을 믿는다. */
  get hasPendingInput(): boolean {
    return this.inputGate !== null || this.openTurns > 0;
  }

  /** 보관·해제 — 모델 무관 메타 전용. 해제하면 칸을 지운다. meta.json 영속. */
  setArchived(archivedAt?: number) {
    this.archivedAt = archivedAt;
    try {
      store.saveMeta(this.metaSnapshot());
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.archive.save", session_id: this.id, provider: this.provider }); console.error("[aether] saveMeta(setArchived) 실패:", e);
    }
  }

  /** 세션 표시 이름 변경(rename) — 모델 무관 메타 전용. 빈값/공백이면 undefined로 저장(자동 제목 폴백). meta.json 영속. */
  setName(name?: string) {
    const trimmed = name?.trim();
    this.name = trimmed || undefined;
    try {
      store.saveMeta(this.metaSnapshot());
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.name.save", session_id: this.id, provider: this.provider }); console.error("[aether] saveMeta(setName) 실패:", e);
    }
    this.upsertSearchSession(resolveWorkTitle(this.name, this.generatedName) || undefined);
  }

  private upsertSearchSession(displayName?: string) {
    if (!config.search) return;
    void touchLetterSession({
      sessionId: this.id,
      displayName: displayName ?? null,
      cwd: this.cwd,
      model: this.model ?? null,
      createdAt: this.createdAt,
      lineageId: this.resumeKey || this.id,
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : "unknown";
      void reportError(e, { component: "session", operation: "session.letter.rename", session_id: this.id });
      console.error("[aether] 세션 글자 색인 이름 갱신 실패:", msg.includes("://") || msg.includes("@") ? "연결 실패" : msg);
    });
  }

  /**
   * 세션 모델 변경(/model). 다음 턴부터 적용(현재 진행 턴엔 영향 없음). meta.json 영속.
   *
   * 순서는 영속 → runtime이다. 그 다음은 세션이 살아 있는지에 따라 갈린다.
   *
   * ① 이미 끝난 세션(크래시·종료)이면 물어볼 상대가 없으므로 값만 남기고 끝낸다(`deferred`).
   *    잠든 디스크 세션과 같은 처리다. 이게 중요한 이유: 사용량 한도로 죽은 세션에 "더 가벼운 모델로
   *    바꾸세요"라는 안내가 뜨는데, 그대로 따랐을 때 변경이 사라지면 안내가 거짓말이 된다.
   * ② 살아 있는데 거부당했으면 되돌린다. 이름이 실제로 있는지를 이제 provider가 판정하므로, 거부된
   *    이름을 그대로 저장해두면 다음에 깨어날 때 그 잘못된 이름으로 세션이 뜬다.
   */
  async setModel(model: string): Promise<{ deferred: boolean }> {
    const previous = this.model;
    const previousObserved = this.observedModel;
    const previousEffort = this.observedEffort;
    const previousLabel = this.modelLabel;
    const previousLabelFor = this.modelLabelFor;
    this.model = model;
    // 다음 응답 전까지는 방금 고른 모델이 목록에 보여야 한다. 스트림에서 본 값은 그 응답이 오기 전에 치운다.
    this.observedModel = undefined;
    this.observedEffort = undefined;
    this.refreshModelLabel();
    this.persistMeta("setModel");
    if (this.ended) return { deferred: true };
    try {
      await this.runtime.setModel(model);
    } catch (e) {
      this.model = previous;
      this.observedModel = previousObserved;
      this.observedEffort = previousEffort;
      this.modelLabel = previousLabel;
      this.modelLabelFor = previousLabelFor;
      this.persistMeta("setModel 되돌리기");
      throw e;
    }
    // 모델에 따라 고를 수 있는 권한 모드가 달라질 수 있다. 목록 갱신 실패가 모델 변경을 되돌리지는 않는다.
    await this.syncPermissionModes();
    return { deferred: false };
  }

  /** meta.json 저장 — 실패해도 호출 흐름을 끊지 않는다(디스크 오류가 세션 조작을 막지 않게). */
  private persistMeta(what: string) {
    if (this.disposed) return; // 잠들거나 지워진 뒤 늦게 도는 작업이 새 인스턴스의 메타를 옛 값으로 덮지 않게 한다
    try {
      store.saveMeta(this.metaSnapshot());
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.metadata.save", session_id: this.id, provider: this.provider }); console.error(`[aether] saveMeta(${what}) 실패:`, e);
    }
  }

  /** 대화 통로가 따라잡았다. 완료·실패를 본 것으로 친다. */
  markViewed(at = Date.now()) {
    if (this.lastViewedAt != null && this.lastViewedAt >= at) return;
    this.lastViewedAt = at;
    this.persistMeta("본 시각");
  }

  setAttentionSticky(sticky: AttentionSticky) {
    const prev = this.attentionSticky;
    if (prev && prev.kind === sticky.kind && prev.preview === sticky.preview && prev.at === sticky.at) return;
    this.attentionSticky = sticky;
    this.persistMeta("주의 스냅샷");
  }

  /** 막힘 표시를 건다. 한도 막힘은 알림 구독이, 끊긴 요청은 drainPending이 부른다. */
  setAttentionHold(hold: AttentionHold) {
    const prev = this.attentionHold;
    if (prev && prev.kind === hold.kind && prev.preview === hold.preview && prev.since === hold.since && prev.until === hold.until) return;
    this.attentionHold = hold;
    this.persistMeta("주의 막힘");
  }

  /** 자동 재개 예약을 바꾼다(없애려면 undefined). */
  setAutoResume(plan: AutoResumePlan | undefined) {
    this.autoResume = plan;
    this.persistMeta("자동 재개");
  }

  /** 넘기기 연결·초안·작업을 바꾼다. 패치에 키가 있으면 그 값으로 덮고, undefined면 지운다. */
  setHandoff(patch: { handoffFrom?: string; handoffTo?: string; handoffDraft?: { text: string; source: HandoffSource }; handoffJob?: HandoffJob }) {
    if ("handoffFrom" in patch) this.handoffFrom = patch.handoffFrom;
    if ("handoffTo" in patch) this.handoffTo = patch.handoffTo;
    if ("handoffDraft" in patch) this.handoffDraft = patch.handoffDraft;
    if ("handoffJob" in patch) this.handoffJob = patch.handoffJob;
    this.persistMeta("넘기기");
  }

  /** 되돌리는 중인가(읽기 전용). 자동 재개가 일하는 중으로 본다. */
  get isRewinding() {
    return this.rewinding;
  }

  /** 입력을 막는 명령이 실행 중인가(읽기 전용). */
  get hasBlockingCommand() {
    return this.blockingCommandOperations.size > 0;
  }

  get isTurnOpen() {
    return this.turnOpen && !this.ended;
  }

  /** 지금 백그라운드 작업. 목록이 막 빈 뒤 보류 시간 안이면 직전 목록을 돌려준다. */
  get backgroundTasks(): BackgroundTask[] {
    if (this.ended) return []; // 끝난 세션에는 뒤 작업이 없다(끝난 뒤 새 사건이 없어 묵은 목록이 남는 것을 막는다)
    if (this.bgTasks.length > 0) return this.bgTasks;
    if (this.bgHold && Date.now() < this.bgHold.until) return this.bgHold.tasks;
    return [];
  }

  /** 보류가 걸려 있으면 그 마감 시각(ms). 없으면 undefined. */
  get backgroundHoldUntil(): number | undefined {
    return this.ended ? undefined : this.bgHold?.until;
  }

  /** 지금 멈출 수 있는 뒤 작업이 실제로 있는가(보류 중인 직전 목록은 이미 끝난 작업이라 제외). */
  get canStopBackgroundNow(): boolean {
    return !this.ended && this.canStopBackground && this.bgTasks.length > 0;
  }

  get isCommandBusy() {
    return this.blockingCommandOperations.size > 0;
  }

  lastAssistantText(afterUserText?: string): string | null {
    return assistantTextFromBuffer(this.buffer, this.codec, afterUserText, this.id);
  }

  lastCtx(): { totalTokens: number; maxTokens: number } | null {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const ev = this.buffer[i];
      if (ev && isControlEvent(ev, "ctx")) {
        return { totalTokens: ev.totalTokens, maxTokens: ev.maxTokens };
      }
    }
    return null;
  }

  async waitCtx(): Promise<void> {
    if (this.ctxWaitedEpoch >= this.ctxEpoch) return;
    await this.ctxWait;
    this.ctxWaitedEpoch = this.ctxEpoch;
  }

  async compactNotebook(): Promise<void> {
    while (this.isCommandBusy) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await this.runtime.compactContext();
  }

  /**
   * 이 세션 runtime이 지원하는 provider-native 조회 표면(§0.1-5). 라우트가 호출 전에 확인한다 —
   * 미지원 provider에서 조회가 예외로 터져 500이 되는 대신 명시적으로 "지원 안 함"을 답하기 위해서다.
   */
  get capabilities() {
    return this.runtime.capabilities;
  }

  /**
   * runtime 응답에 상한을 건다.
   *
   * 상한이 필요한 이유: runtime 호출은 별도 프로세스에 달려 있어서, 그쪽이 답을 안 주면 이 promise가
   * 영원히 매달리고 그 응답을 기다리는 HTTP 요청도 같이 매달린다.
   * 타이머는 `unref()`해서 이 대기가 서버 종료를 붙잡지 못하게 하고, 어느 쪽이 이기든 `finally`에서 끈다.
   */
  private async within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SessionReadyTimeoutError(st("notice.session.readyTimeout", { ms: timeoutMs }))), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 모델 칩에 줄 목록. 준비 신호의 목록에 허브가 기억한 긴 목록을 합친다(계획 7.2절).
   * 이미 열린 세션도 부를 때마다 그 시점의 기억으로 다시 합친다.
   */
  async listModels(timeoutMs: number): Promise<RuntimeModel[]> {
    const { models } = await this.waitHandshake(timeoutMs);
    return mergeModelList(this.provider, models);
  }

  /** 이 세션이 대화를 받을 준비가 될 때까지 기다린다(상한 있음). */
  async waitHandshake(timeoutMs: number): Promise<RuntimeHandshake> {
    const handshake = await this.within(this.runtime.handshake(), timeoutMs);
    this.rememberHandshake(handshake);
    return handshake;
  }

  /**
   * 준비 신호의 모델 목록을 기억하고, 계정 기본 모델과 목록 카드 표시 이름을 다시 계산한다.
   * 둘 중 하나라도 바뀔 때만 meta를 쓴다.
   */
  private rememberHandshake(handshake: RuntimeHandshake) {
    if (this.disposed) return;
    // 준비 신호를 처음 받은 결과를 다시 돌려주는 runtime이 있다. 같은 결과를 다시 기억·관측하면 옛 세션의 옛 목록이
    //   다른 세션이 본 새 목록을 "최신"으로 덮는다. 새 결과일 때만 기억하고, 같은 결과면 지금 기억으로 다시 합치기만 한다.
    const fresh = handshake !== this.lastHandshake;
    this.lastHandshake = handshake;
    if (!fresh) {
      this.modelCatalog = mergeModelList(this.provider, handshake.models);
      if (this.refreshModelLabel()) this.persistMeta("모델 표시 이름");
      return;
    }
    // 짧은 목록이 와도 화면에는 최근에 받은 긴 목록을 합쳐 보인다(계획 7절). 표시 이름 계산도 합친 목록으로 한다.
    rememberModelList(this.provider, handshake.models);
    this.modelCatalog = mergeModelList(this.provider, handshake.models);
    const defaultChanged = this.rememberAccountDefaultModel(handshake);
    const labelChanged = this.refreshModelLabel();
    if (defaultChanged || labelChanged) this.persistMeta(defaultChanged ? "계정 기본 모델" : "모델 표시 이름");
  }

  /**
   * 모델을 고르지 않은 세션도 목록 카드에 모델 이름이 보이게, provider가 준 목록에서 기본 표시가 붙은 줄의
   * 정식 id를 적어 둔다. 모델 이름을 코어가 지어내지 않는다. 저장은 호출부가 모아서 한다.
   */
  private rememberAccountDefaultModel(handshake: RuntimeHandshake): boolean {
    const row = handshake.models.find((m) => m.isDefault);
    const name = (row?.resolvedModel || row?.value || "").trim();
    if (this.disposed || !name || name === this.accountDefaultModel) return false;
    this.accountDefaultModel = name;
    return true;
  }

  /** 목록 카드가 쓸 모델 원문. 스트림에서 본 값, 고른 값, 계정 기본 순이다. */
  private effectiveModel(): string {
    return (this.observedModel || this.model || this.accountDefaultModel || "").trim();
  }

  /**
   * 표시 이름을 다시 계산한다. 바뀌었으면 true.
   * 목록이 없으면, 기준 원문이 같을 때만 기존 이름을 유지한다. 원문이 바뀌면 이름을 비운다.
   */
  private refreshModelLabel(): boolean {
    const effective = this.effectiveModel();
    const prev = this.modelLabel ?? "";
    if (!this.modelCatalog) {
      if (effective === this.modelLabelFor) return false;
      this.modelLabel = undefined;
      this.modelLabelFor = effective;
      return prev !== "";
    }
    const next = resolveModelDisplayName(effective, this.modelCatalog) || undefined;
    const changed = (next ?? "") !== prev;
    this.modelLabel = next;
    this.modelLabelFor = effective;
    return changed;
  }

  /** 정규화된 이벤트에 실제 모델이 실려 있으면 기억한다. 값이 바뀔 때만 meta를 쓴다. */
  private noteObservedModel(ev: AetherEvent) {
    if (this.disposed) return;
    let model = "";
    for (const item of this.codec.normalize(ev)) {
      if (item.type !== "model_info") continue;
      const next = item.model.trim();
      if (next) model = next;
    }
    if (!model || model === this.observedModel) return;
    this.observedModel = model;
    this.refreshModelLabel();
    this.persistMeta("관측 모델");
  }

  /** provider가 알린 실제 강도를 기억한다. 값이 바뀔 때만 meta를 쓰고 화면에 알린다. */
  private noteObservedEffort(effort: string) {
    if (this.disposed || effort === this.observedEffort) return;
    this.observedEffort = effort;
    this.persistMeta("관측 강도");
    this.onTitleChange?.(this);
  }

  /** 세션 생성 중의 모델 확인용 — `setModel`에 상한을 건다(생성 요청이 무한정 매달리지 않게). */
  async setModelWithin(model: string, timeoutMs: number): Promise<{ deferred: boolean }> {
    return this.within(this.setModel(model), timeoutMs);
  }

  /** 세션 비용·구독 rate-limit(5h/7d) 사용률. live 세션만. */
  async getUsage() {
    return this.runtime.usage();
  }

  /** Aether 공통 명령과 provider가 실제 실행할 수 있다고 선언한 목록을 합친다. */
  async listCommands(): Promise<RuntimeCommand[]> {
    let providerCommands: RuntimeCommand[] = [];
    try {
      providerCommands = await this.runtime.listCommands();
      this.commandCatalog = providerCommands;
    } catch (error) {
      // 공통 명령까지 함께 사라지게 하지 않되, provider 목록 실패를 조용히 숨기지는 않는다.
      void reportError(error, { component: "session", severity: "warning", operation: "session.commands.list", session_id: this.id, provider: this.provider }); console.error(`[aether] ${this.provider} 명령 목록 조회 실패(Aether 공통 명령만 표시):`, error);
    }
    return mergeCommands(providerCommands);
  }

  /** 잠들기 직전에 목록을 한 번 받아 둔다. 상한 안에 못 받으면 마지막으로 기억한 목록을 그대로 쓴다. */
  async refreshCommandCatalog(timeoutMs: number): Promise<void> {
    try {
      this.commandCatalog = await this.within(this.runtime.listCommands(), timeoutMs);
    } catch {
      /* 못 받아도 잠들기는 이어간다. 기억해 둔 목록(없으면 공통 명령만)으로 답한다 */
    }
  }

  /** 잠들기 직전에 승인 정책 요약을 받아 둔다. 못 받으면 적지 않는다(잠든 세션은 배지 없음으로 답한다). */
  async refreshPolicyForSleep(timeoutMs: number): Promise<void> {
    try {
      this.sleepPolicy = await this.within(this.runtime.effectivePermissionPolicy(), timeoutMs);
    } catch {
      this.sleepPolicy = undefined;
    }
  }

  /** 쉬는 시간의 기준 시각. 마지막 입력·출력 활동과 인스턴스 생성 시각 중 늦은 쪽이다. 상태 조회나 하트비트로는 늘지 않는다. */
  get idleSince(): number {
    return Math.max(this.lastActivityAt, this.awakeSince);
  }

  /** 잠들기 직전 마지막 메타를 쓰고 그 사본을 돌려준다. 저장이 실패하면 던진다(그러면 잠재우지 않는다). */
  metaForSleep(): SessionMeta {
    const meta: SessionMeta = { ...this.metaSnapshot(), slept: true, ...(this.sleepPolicy ? { permissionPolicy: this.sleepPolicy } : {}) };
    store.saveMeta(meta);
    return meta;
  }

  /**
   * 명령 실행의 단일 진입점. 공통 명령은 이 계층이 소유하고, 나머지 의미·지원 판정은 runtime에 위임한다.
   * 모르는 명령을 `push()`로 되돌리는 폴백은 두지 않는다.
   */
  async executeCommand(command: RuntimeCommandInvocation): Promise<SessionCommandResult> {
    if (!store.diaryAcceptsInput(this.id)) return { accepted: false, error: st("routes.sessions.diaryBusy") };
    if (this.blockingCommandOperations.size) return { accepted: false, error: st("notice.command.busy") };
    const name = command.name.toLowerCase();
    const rawArgs = command.arguments.trim();
    if (name === "model") {
      if (!isWellFormedCommandValue(rawArgs)) return { accepted: false, error: st(rawArgs ? "routes.sessions.modelMalformed" : "routes.sessions.modelRequired") };
      await this.setModel(rawArgs);
      return { accepted: true, startsTurn: false, sessionUpdate: { model: rawArgs } };
    }
    if (name === "effort") {
      const args = rawArgs.toLowerCase();
      if (!isWellFormedCommandValue(args)) return { accepted: false, error: st("routes.sessions.effortInvalid") };
      await this.setEffort(args as SessionEffort);
      return { accepted: true, startsTurn: false, sessionUpdate: { effort: args as SessionEffort } };
    }
    const owned = aetherOwnedCommand(name);
    if (owned?.uiAction) {
      // 화면이 카탈로그의 uiAction으로 처리한다. 여기선 실행기에 넘기지 않는다.
      return { accepted: true, startsTurn: false };
    }
    return this.serialInput(async () => {
      // 턴이 시작됐는지는 실행 뒤에야 안다. 시작된 턴의 끝이 먼저 올 수 있어 미리 올리고, 시작이 아니면 되돌린다.
      this.openTurns += 1;
      let result: SessionCommandResult;
      try {
        result = await this.runtime.executeCommand({ name, arguments: command.arguments });
      } catch (e) {
        this.openTurns = Math.max(0, this.openTurns - 1);
        throw e;
      }
      if (result.accepted && result.startsTurn) {
        const commandText = `/${command.name}${rawArgs ? ` ${rawArgs}` : ""}`;
        const committed = this.commitUserTurn(commandText);
        if (committed) await committed;
      } else {
        this.openTurns = Math.max(0, this.openTurns - 1);
      }
      return result;
    });
  }

  /** 세션 effort 변경(/effort). 다음 턴부터 적용. meta.json 영속. 끝난 세션·거부 처리는 setModel과 동일. */
  async setEffort(effort: SessionEffort): Promise<{ deferred: boolean }> {
    const previous = this.effort;
    const previousObserved = this.observedEffort;
    this.effort = effort;
    this.observedEffort = undefined;
    this.persistMeta("setEffort");
    if (this.ended) return { deferred: true };
    try {
      await this.runtime.setEffort(effort);
      return { deferred: false };
    } catch (e) {
      this.effort = previous;
      this.observedEffort = previousObserved;
      this.persistMeta("setEffort 되돌리기");
      throw e;
    }
  }

  /**
   * 권한 모드를 바꾼다. meta.json 영속. 끝난 세션·거부 처리는 setModel과 같다.
   * 값을 runtime보다 먼저 바꾸므로, 'full'로 올리는 쪽은 이 턴에 새로 오는 권한 요청부터 카드 없이 허용된다.
   * 이미 떠 있는 카드는 건드리지 않는다 — 사람이 보고 있는 결정을 몰래 대신 내리지 않는다.
   */
  async setPermissionMode(mode: PermissionMode): Promise<{ deferred: boolean }> {
    const previous = this.permissionMode;
    const epoch = ++this.permissionEpoch;
    this.freshPermission = false;
    this.permissionChanging += 1;
    try {
      this.permissionMode = mode;
      this.persistMeta("setPermissionMode");
      if (this.ended) return { deferred: true };
      // 어댑터가 응답하지 않아도 finally가 돌도록 시간 상한을 둔다. 늦게 끝나면 그때 어댑터 값을 다시 맞춘다.
      const call = this.runtime.setPermissionMode(mode);
      try {
        await this.within(call, config.sessionReadyTimeoutMs);
        return { deferred: false };
      } catch (e) {
        if (e instanceof SessionReadyTimeoutError) void call.then(() => this.reconcileAdapterMode(), () => this.reconcileAdapterMode());
        // 그 사이 다른 변경이 있었다면 이 실패가 새 선택을 되돌리지 않는다.
        if (epoch === this.permissionEpoch && !this.disposed) {
          // 표시를 어댑터가 실제로 적용 중인 값과 맞춘다. 물어볼 수 없으면 바꾸기 전 값으로 되돌린다.
          const actual = await this.within(this.runtime.permissionModes(), config.sessionReadyTimeoutMs).then((r) => r.current, () => previous);
          if (epoch === this.permissionEpoch && !this.disposed) {
            this.permissionMode = actual;
            this.persistMeta("setPermissionMode 되돌리기");
          }
        }
        throw e;
      }
    } finally {
      this.permissionChanging -= 1;
    }
  }

  /**
   * 조회와 적용을 한 번에 한다. 조회 전에 epoch를 잡아, 조회 뒤 다른 변경이 끼어들었으면 적용하지 않고 충돌로 알린다.
   * manual은 가장 좁아서 목록 확인 없이 바로 적용한다 — 조회가 실패해도 넓은 모드에서 내려올 수 있어야 한다.
   */
  async changePermissionMode(mode: PermissionMode, timeoutMs: number): Promise<{ deferred: boolean }> {
    const epoch = this.permissionEpoch;
    if (mode !== "manual") {
      const { modes } = await this.listPermissionModes(timeoutMs);
      if (!modes.includes(mode)) throw new PermissionModeUnavailableError(st("routes.sessions.permissionModeUnavailable"));
      if (epoch !== this.permissionEpoch) throw new PermissionModeConflictError(st("routes.sessions.permissionModeConflict"));
    }
    return this.setPermissionMode(mode);
  }

  /** 시간 초과 뒤 늦게 끝난 변경이 표시보다 넓게 남지 않게, 어댑터 값을 다시 받아 세션 값보다 넓으면 세션 값으로 내린다. */
  private async reconcileAdapterMode() {
    if (this.disposed || this.ended || this.permissionChanging > 0) return;
    try {
      const { current } = await this.within(this.runtime.permissionModes(), config.sessionReadyTimeoutMs);
      if (this.disposed || this.permissionChanging > 0 || PERMISSION_RANK[current] <= PERMISSION_RANK[this.permissionMode]) return;
      await this.within(this.runtime.setPermissionMode(this.permissionMode), config.sessionReadyTimeoutMs);
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.permission_modes.reconcile", session_id: this.id, provider: this.provider });
      console.error("[aether] 늦게 끝난 권한 모드 변경을 세션 값에 맞추지 못했다:", e);
    }
  }

  /**
   * 최신 권한 모드 목록과 현재 모드를 답한다. 끝난 세션은 물어볼 상대가 없으니 저장된 목록(없으면 잠든 세션과 같은
   * 기본 목록)을 쓴다. 살아 있으면 어댑터에 직접 묻는다 — 준비 신호는 기다리지 않는다.
   */
  async listPermissionModes(timeoutMs: number): Promise<{ modes: PermissionMode[]; current: PermissionMode }> {
    if (!this.ended) await this.refreshPermissionModes(timeoutMs);
    return { modes: this.permissionModes ?? ["manual", "full"], current: this.permissionMode };
  }

  /** 시작·복원 때 어댑터 값을 받아 맞춘다. 실패하면 어댑터를 수동으로 내려 표시보다 실제가 넓은 상태가 남지 않게 한다. */
  private async syncPermissionModes() {
    try {
      await this.refreshPermissionModes();
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "session.permission_modes.sync", session_id: this.id, provider: this.provider });
      console.error("[aether] 권한 모드 확인 실패 — 수동으로 내린다:", e);
      await this.forceManual();
    }
  }

  private async forceManual() {
    if (this.disposed || this.ended) return;
    const epoch = this.permissionEpoch;
    const before = this.permissionMode;
    try {
      await this.within(this.runtime.setPermissionMode("manual"), config.sessionReadyTimeoutMs);
      if (this.disposed || epoch !== this.permissionEpoch) return;
      this.lowerTo("manual", before);
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.permission_modes.lower", session_id: this.id, provider: this.provider });
      console.error("[aether] 권한 모드를 수동으로 내리지 못했다:", e);
    }
  }

  /** 모드를 낮추고 저장하며 알린다. 새 세션의 첫 기본값 확정처럼 알릴 일이 아니면 알림은 생략한다. */
  private lowerTo(mode: PermissionMode, before: PermissionMode) {
    this.permissionMode = mode;
    if (!this.freshPermission && PERMISSION_RANK[mode] < PERMISSION_RANK[before]) this.ingest({ kind: "notice", notice: "permission_lowered", detail: st("notice.permission.lowered") });
    this.persistMeta("권한 모드 낮춤");
  }

  /**
   * 어댑터에서 목록과 현재 모드를 받아 맞춘다. 현재 모드가 목록에 없으면(모델을 바꿔 자동을 못 쓰는 경우 등)
   * 수동으로 내리고, 저장돼 있던 모드보다 낮아졌으면 사용자에게 알린다.
   * 모드 변경이 진행 중이거나 그 사이 바뀌었으면 목록만 갱신하고 현재 모드는 덮지 않는다.
   */
  private async refreshPermissionModes(timeoutMs = config.sessionReadyTimeoutMs) {
    if (this.disposed || this.ended) return;
    const epoch = this.permissionEpoch;
    const { modes, current } = await this.within(this.runtime.permissionModes(), timeoutMs);
    if (this.disposed) return;
    this.permissionModes = [...modes];
    if (this.permissionChanging > 0 || epoch !== this.permissionEpoch) {
      this.persistMeta("권한 모드 목록");
      return;
    }
    const before = this.permissionMode;
    if (!modes.includes(current)) {
      try {
        await this.within(this.runtime.setPermissionMode("manual"), timeoutMs);
      } catch (e) {
        // 내리지 못하면 표시를 실제 값에 맞추고 보고한다. 실제보다 좁게 보이면 안 된다.
        void reportError(e, { component: "session", operation: "session.permission_modes.lower", session_id: this.id, provider: this.provider });
        console.error("[aether] 권한 모드를 수동으로 내리지 못했다:", e);
        this.permissionMode = current;
        this.persistMeta("권한 모드 목록");
        return;
      }
      if (this.disposed || this.permissionChanging > 0 || epoch !== this.permissionEpoch) return;
      this.lowerTo("manual", before);
      return;
    }
    this.permissionMode = current;
    if (PERMISSION_RANK[current] < PERMISSION_RANK[before]) this.lowerTo(current, before);
    else this.persistMeta(current === before ? "권한 모드 목록" : "권한 모드 확정");
  }

  /**
   * 영구 삭제 시 정리: runtime 자원 해제(프로세스·입력 스트림·임시 첨부) + 보류 승인 거부.
   * ⚠️ 이 메서드는 동기다 — 세션 삭제 경로(SessionManager.delete → REST)가 동기이기 때문이다.
   *   runtime의 정리는 비동기라 결과를 기다리지 않고 던져둔다. 정리 실패가 삭제 자체를 막으면 안 되고,
   *   runtime 계약이 "실패를 스스로 삼키고 로그로 남긴다"이므로 여기서 붙잡을 것도 없다.
   */
  dispose(): Promise<void> {
    this.disposed = true; // 이후 ingest/persistResumeKey의 디스크 쓰기 차단(삭제될 dir에 append→ENOENT·부활 방지)
    this.ended = true;
    // 잠재우기는 이 약속이 끝나야(자식 프로세스가 내려가야) 같은 세션을 다시 띄운다. 삭제 경로는 기다리지 않는다.
    //   runtime 정리가 끝나도 입력만 닫고 돌아오는 runtime이 있어, 사건 흐름이 끝나는 것(run 종료)까지 함께 기다린다.
    const closing = Promise.all([
      this.runtime.dispose().catch((e) => { void reportError(e, { component: "session", operation: "session.runtime.dispose", session_id: this.id }); console.error("[aether] runtime 정리 실패:", e); }),
      this.endedPromise,
    ]).then(() => undefined);
    this.drainPending(st("notice.proto.sessionDeleted"));
    this.releaseLog?.();
    this.releaseLog = null;
    return closing;
  }

  // ── 구독/복원 ──
  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /**
   * seq > since 인 이벤트들(메모리 우선, 상한 밖이면 디스크에서).
   * 경계 `buffer[0].seq <= since+1`: 버퍼가 since 바로 다음(since+1) 이벤트부터 보유 → 메모리만으로 gap 없이
   *   since 이후 전부 커버. 아니면(롤오버) 디스크 fallback.
   * ⚠️ 라이브 전용 이벤트(토큰 미리보기)는 replay에서 제외 — 디스크엔 애초에 없고, 메모리 분기도 제외해 두 경로를 대칭화.
   * ⚠️ mutation diff 비대칭(의도된 보안 trade-off): 메모리 분기는 permission_request의 full diff(before/after/hunks)를
   *   돌려주나, 버퍼 evict 후 디스크 분기는 stripMutationForPersist된 meta-only 카드를 돌려준다(시크릿 평문 비영속 우선).
   *   같은 since라도 버퍼 보유 여부에 따라 카드 diff 유무가 갈린다 — strip 유지가 우선이라 수용.
   */
  replaySince(since: number): AetherEvent[] {
    const raw =
      this.buffer.length && this.buffer[0].seq <= since + 1
        ? this.buffer.filter((e) => e.seq > since && !this.codec.isLiveOnly(e))
        : store.readEventsSince(this.id, since);
    if (!this.hiddenRanges.length) return raw;
    return raw.filter((event) => !isHiddenSeq(event.seq, this.hiddenRanges));
  }

  /**
   * replaySince(0)과 같은 사건을 같은 규칙으로 최신부터 하나씩 낸다. 첫 진입이 꼬리만 읽도록 쓴다.
   * 버퍼가 1번부터 덮으면 버퍼를, 아니면 저장소를 거꾸로 읽는다(전체를 메모리에 올리지 않는다).
   */
  *replayNewestFirst(): Generator<AetherEvent> {
    const visible = (e: AetherEvent) => !isHiddenSeq(e.seq, this.hiddenRanges);
    if (this.buffer.length && this.buffer[0].seq <= 1) {
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        const e = this.buffer[i];
        if (!this.codec.isLiveOnly(e) && visible(e)) yield e;
      }
      return;
    }
    for (const e of store.eventsNewestFirst(this.id)) if (visible(e)) yield e;
  }

  // ── 권한 ──
  /**
   * runtime의 권한 요청 → 카드 발행 후 사용자 결정까지 hold. 반환은 allow/deny만(인자 수정 통로 없음 — H1).
   * 구조화 질문(AskUserQuestion 등)은 runtime이 requestQuestion으로 따로 보낸다.
   */
  private requestPermission(ask: PermissionAsk): Promise<PermissionOutcome> {
    // aether 지식툴의 자동 허용은 runtime이 판정한다(툴 이름이 provider MCP 규약에 달려 있어서 — D8.1).
    //   그래서 그 요청은 애초에 여기까지 오지 않는다.
    // 이미 취소된 요청은 카드도 만들지 않고 즉시 거부한다. AbortSignal은 listener를 나중에 붙여도 재발화하지
    // 않으며, 취소 뒤 allow를 반환하면 중단된 턴의 실행을 되살릴 여지가 생긴다.
    if (ask.signal.aborted) return Promise.resolve({ allow: false, message: st("notice.proto.interrupted") });
    // full 모드 → 권한 카드 없이 즉시 자동 허용(bypass 모드 안전망). 세션 중에 켜도 다음 요청부터 여기서 걸린다.
    if (this.permissionMode === "full") return Promise.resolve({ allow: true });
    // 카드에 담을 내용(표시용 인자·변경 미리보기)은 runtime이 이미 채워서 보낸다(8e). 도구 이름과 인자
    //   이름을 아는 것은 provider의 지식이라, 여기서 판정하면 다른 provider에서 조용히 비어버린다.
    const req: PermissionRequest = {
      id: randomUUID(),
      toolName: ask.toolName,
      input: ask.input,
      displayName: ask.displayName,
      title: ask.title,
      toolUseID: ask.toolUseID,
      createdAt: Date.now(),
      description: ask.description,
      decisionReason: ask.decisionReason,
      blockedPath: ask.blockedPath,
      mutation: ask.mutation,
    };
    return new Promise<PermissionOutcome>((resolve) => {
      // resolve/abort/drainPending 중 무엇이 먼저 와도 한 번만 정리한다. 일반 resolve 뒤에도
      // abort listener를 떼어 내어 긴 세션의 이미 끝난 카드가 signal에 매달리지 않게 한다.
      let onAbort: () => void = () => {};
      const settle = (outcome: PermissionOutcome) => {
        ask.signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.pending.set(req.id, { req, resolve: settle });
      this.ingest({ kind: "permission_request", req });
      // AbortSignal은 이미 abort된 뒤에 listener를 붙여도 이벤트를 재발화하지 않는다. 이 검사가 없으면
      // runtime 종료와 카드 생성이 겹친 순간 보류 promise가 영구 대기한다.
      onAbort = () => {
        if (this.pending.delete(req.id)) {
          this.ingest({ kind: "permission_resolved", id: req.id, decision: "deny" });
          settle({ allow: false, message: st("notice.proto.interrupted") });
        }
      };
      if (ask.signal.aborted) onAbort();
      else ask.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** runtime의 구조화 질문 → 질문 카드. 사용자가 GUI에서 고를 때까지 hold(권한과 동형). */
  private requestQuestion(ask: QuestionAsk): Promise<QuestionOutcome> {
    // 취소된 질문은 화면에 순간 카드도 남기지 않는다(권한과 같은 abort 의미론).
    if (ask.signal.aborted) return Promise.resolve({ answered: false, reason: st("notice.proto.interrupted") });
    // 브리프 세션은 카드 대신 질문지 상자로 묻게 한다. 사람의 답이 아니라는 뜻으로 answered:false를 돌려준다.
    if (this.briefOpen) return Promise.resolve({ answered: false, reason: questionToolRedirect() });
    const lead = ask.lead?.trim() ?? "";
    const req: QuestionRequest = {
      id: randomUUID(),
      toolUseID: ask.toolUseID,
      questions: ask.questions,
      createdAt: Date.now(),
      ...(lead && !isBlankAssistantText(lead) ? { lead } : {}),
    };
    return new Promise<QuestionOutcome>((resolve) => {
      let onAbort: () => void = () => {};
      const settle = (outcome: QuestionOutcome) => {
        ask.signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.pendingQuestions.set(req.id, { req, resolve: settle });
      this.ingest({ kind: "question_request", req });
      onAbort = () => {
        if (this.pendingQuestions.delete(req.id)) {
          this.ingest({ kind: "question_resolved", id: req.id, answered: false });
          settle({ answered: false, reason: st("notice.proto.interrupted") });
        }
      };
      if (ask.signal.aborted) onAbort();
      else ask.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * POST /permission에서 호출. 성공 시 true.
   * ★ 보안(H1): "인자 수정"(updatedInput) 통로 폐쇄 — 클라가 보낸 수정본은 받지도 않고,
   * allow는 runtime이 provider 원본 toolInput을 그대로 실행에 되돌린다
   * (승인한 카드 = 실제 실행 input 보장; 경로없는 툴 undefined===undefined fail-open + redact echo-back 차단).
   * 카드에서 인자를 고쳐 승인하는 기능이 필요해지면, 전필드 무결성 대조를 갖춰 별도로 재도입할 것.
   */
  resolvePermission(permissionId: string, decision: "allow" | "deny"): boolean {
    const p = this.pending.get(permissionId);
    if (!p) return false; // 멱등: 이미 처리됐거나 만료(중복 resolve 차단)
    if (decision === "allow") this.noteCheckpoint(p.req);
    this.pending.delete(permissionId);
    // 디스크 throw가 resolve를 건너뛰지 못하도록 ingest는 내부 try/catch로 격리됨(데드락 방지).
    this.ingest({ kind: "permission_resolved", id: permissionId, decision });
    p.resolve(decision === "allow" ? { allow: true } : { allow: false, message: st("notice.proto.userDenied") });
    return true;
  }

  pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  /**
   * POST /question에서 호출. answers[i] = i번째 질문의 답(고른 선택지 + 직접 입력, 분리 보관 — 8d-3 ⑥ⓒ).
   * 답을 모델에 어떤 통로로 되돌리는지는 runtime이 결정한다(Claude는 canUseTool deny+메시지 우회 — spike_f 검증).
   */
  resolveQuestion(questionId: string, answers: QuestionAnswer[]): boolean {
    const p = this.pendingQuestions.get(questionId);
    if (!p) return false; // 멱등: 이미 처리됐거나 만료
    this.pendingQuestions.delete(questionId);
    // 화면이 새로고침돼도 "무슨 질문에 무엇을 골랐는지"가 남게, 표시용 답을 이벤트에 같이 적는다.
    //   질문별 배열 = 고른 선택지 + (있으면) 직접 입력. 클라 store.answers와 같은 모양이라 그리는 쪽이 한 경로만 탄다.
    const shown = answers.map((a) => (a.custom ? [...a.chosen, a.custom] : [...a.chosen]));
    this.ingest({ kind: "question_resolved", id: questionId, answered: true, answers: shown });
    p.resolve({ answered: true, answers });
    return true;
  }

  /** 보류 중인 질문 1건 — 라우트가 답을 *제시된 선택지*와 대조하려면 원본 질문이 필요하다(8d-3 ⑥ⓒ). */
  pendingQuestion(questionId: string): QuestionRequest | undefined {
    return this.pendingQuestions.get(questionId)?.req;
  }

  pendingQuestionList(): QuestionRequest[] {
    return [...this.pendingQuestions.values()].map((p) => p.req);
  }

  /** runtime의 계획 검토 → 세 갈래 카드. 권한·질문 카드에 넣지 않는다. */
  private requestPlan(ask: PlanAsk): Promise<PlanOutcome> {
    if (ask.signal.aborted) return Promise.resolve({ decision: "cancel" });
    const req: PlanRequest = { id: randomUUID(), planId: ask.planId, text: ask.text, createdAt: Date.now() };
    return new Promise<PlanOutcome>((resolve) => {
      let onAbort: () => void = () => {};
      const settle = (outcome: PlanOutcome) => {
        ask.signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.pendingPlans.set(req.id, { req, resolve: settle });
      this.ingest({ kind: "plan_request", req });
      onAbort = () => {
        if (this.pendingPlans.delete(req.id)) {
          this.ingest({ kind: "plan_resolved", id: req.id, decision: "cancel" });
          settle({ decision: "cancel" });
        }
      };
      if (ask.signal.aborted) onAbort();
      else ask.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  resolvePlan(planId: string, outcome: PlanOutcome): boolean {
    const p = this.pendingPlans.get(planId);
    if (!p) return false;
    this.pendingPlans.delete(planId);
    this.ingest({ kind: "plan_resolved", id: planId, decision: outcome.decision });
    p.resolve(outcome);
    if (outcome.decision === "revise" && outcome.message.trim()) {
      const sent = this.push(outcome.message.trim());
      if (sent) sent.catch((e) => { void reportError(e, { component: "session", operation: "session.plan.send", session_id: this.id }); console.error("[aether] 계획 수정 글 전달 실패:", e); });
    }
    return true;
  }

  pendingPlanList(): PlanRequest[] {
    return [...this.pendingPlans.values()].map((p) => p.req);
  }

  async applyIsolatedWorkspace(): Promise<void> {
    if (!this.workspaceSource) throw new Error(st("notice.workspace.missing"));
    applyIsolatedCopy(this.cwd, this.workspaceSource);
  }

  async discardIsolatedWorkspace(): Promise<void> {
    if (!this.workspaceSource) throw new Error(st("notice.workspace.missing"));
    discardIsolatedCopy(this.cwd, this.workspaceSource);
  }

  /** 이 세션에 실제로 적용 중인 승인 정책 요약(8d-3 ⑥ⓕ) — 화면 배지의 출처. */
  async permissionPolicy() {
    return this.runtime.effectivePermissionPolicy();
  }

  /** 이어가기 식별자를 가장 이른 시점에 원자 영속(runtime의 onResumeKey 콜백). 변화 없으면 no-op(멱등). */
  private persistResumeKey(key?: string) {
    // 되돌리는 중인 객체만 막는다. 꺼지는 실행기가 옛 키를 다시 넣지 못하게 하려는 것이다.
    // 이미 되돌린 뒤 새로 뜬 프로세스가 발급한 키는 저장한다. 여기서 막으면 재시작 때 대화를 잇지 못한다.
    if (this.disposed || this.rewinding) return;
    if (!key || key === this.resumeKey) return;
    this.resumeKey = key;
    // saveMeta 실패를 격리(appendEvent와 대칭) — 이어가기 식별자 영속 실패가 turn을 crashed로 둔갑시키지 않게.
    try {
      store.saveMeta(this.metaSnapshot());
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.resume_key.save", session_id: this.id, provider: this.provider }); console.error("[aether] saveMeta(persistResumeKey) 실패(이어가기 식별자 영속 건너뜀):", e);
    }
  }

  /** resume로 live화됐음을 1회 표기(SSE+영속). 진행 중이던 턴은 복원 불가 — 정직 표기. */
  noticeResumed(detail?: string) {
    this.ingest({ kind: "notice", notice: "resumed", detail });
  }
  noticeNoContext(detail?: string) {
    this.ingest({ kind: "notice", notice: "no_context", detail });
  }

  /**
   * 정상적으로 끝난 턴이면 다음 만료를 다시 알리도록 재무장한다.
   * (만료 감지 자체는 모든 이벤트에서 하고, 여기는 "다시 알릴 준비"만 한다 — 아래 run() 참조.)
   */
  private rearmAuthNotice(ev: AetherEvent) {
    const ended = this.codec.normalize(ev).find((a) => a.type === "turn_completed");
    if (ended?.type === "turn_completed" && ended.status === "ok") this.authNotified = false;
  }

  /** 구독 인증 만료 안내 — UI 배너(재인증 CTA) + 푸시. 세션당 1회(스팸 방지). */
  private emitAuthExpired() {
    if (this.authNotified) return;
    this.authNotified = true;
    this.ingest({ kind: "notice", notice: "auth_expired", detail: st("notice.auth.expired", { provider: this.services.displayName }) });
  }

  /**
   * 보류 권한 전부 거부 정리(세션 종료/크래시/서버 종료 시). 멱등 delete 가드로 abort 경로와 더블-resolve 없음.
   * 안 하면 남은 promise + req.input(큰 페이로드)이 영구 매달림·메모리 누수.
   */
  /** 디스크에만 있고 실행기가 더 이상 안 들고 있는 카드는 넘어간 것으로 닫는다. */
  private closeOrphanHolds() {
    let events: AetherEvent[] = [];
    try {
      events = store.readEventsOfKinds(this.id, HOLD_EVENT_KINDS);
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.pending_cards.load", session_id: this.id, provider: this.provider }); console.error("[aether] 미해결 카드 조회 실패(건너뜀):", e);
      return;
    }
    for (const body of orphanHoldResolves(events)) this.ingest(body);
  }

  drainPending(reason: string) {
    // 닫기 전에 끊기는 카드를 읽어 둔다. 삭제 중인 세션은 메타를 다시 쓰면 폴더가 되살아나므로 건너뛴다.
    const interrupted = this.disposed
      ? undefined
      : waitingFromPending({ permissions: this.pendingPermissions(), questions: this.pendingQuestionList(), plans: this.pendingPlanList() });
    // 표시는 닫기 사건보다 먼저 건다. 닫는 사건이 나가며 presence가 한 번 나가는데, 그때 이미 걸려 있어야 한다.
    if (interrupted) this.setAttentionHold({ kind: "interrupted_request", preview: interrupted.preview, since: interrupted.since });
    for (const [id, p] of [...this.pending.entries()]) {
      if (!this.pending.delete(id)) continue;
      this.ingest({ kind: "permission_resolved", id, decision: "deny" });
      p.resolve({ allow: false, message: reason });
    }
    for (const [id, p] of [...this.pendingQuestions.entries()]) {
      if (!this.pendingQuestions.delete(id)) continue;
      this.ingest({ kind: "question_resolved", id, answered: false });
      p.resolve({ answered: false, reason });
    }
    for (const [id, p] of [...this.pendingPlans.entries()]) {
      if (!this.pendingPlans.delete(id)) continue;
      this.ingest({ kind: "plan_resolved", id, decision: "cancel" });
      p.resolve({ decision: "cancel" });
    }
  }

  // ── 내부 ──
  private async run() {
    this.bgTasks = [];
    this.bgHold = null;
    try {
      for await (const ev of this.runtime.events()) {
        const endsTurn = this.codec.endsTurn(ev);
        if (endsTurn) {
          // 질문지는 턴 끝 사건보다 앞 순번이어야 한다. 첫 await 전에 판정과 계수기 감소를 끝낸다.
          this.settleTurnQuestionnaire();
          this.turnOpen = false;
        }
        const ingested = this.ingest(ev);
        if (ingested && !endsTurn && this.briefOpen) this.noteTextCandidate(ingested);
        // 스트림이 알려 준 실제 모델은 계정 기본값과 다를 수 있다. 목록 카드는 이 값을 우선한다.
        if (ingested) this.noteObservedModel(ingested);
        // 인증 만료는 **모든 이벤트에서** 확인한다. 턴이 끝날 때만 보면, 만료를 별도 오류 알림으로 먼저
        //   알리는 provider에서는 배너가 영영 안 뜬다(외부 검토 지적, 2026-08-18 — Codex가 그 경우다).
        //   무엇이 만료를 뜻하는지는 provider마다 다르므로 판정은 codec이 한다(D2.6).
        if (ingested && this.codec.isAuthExpired(ingested)) this.emitAuthExpired();
        // 턴 종료 직후 현재 컨텍스트 점유량 갱신 — 턴 누적 usage가 아닌 정확값을 별도 ctx 이벤트로.
        // 판정 주체는 세션 provider의 codec이다(D2.6) — 여기서 원본 필드를 직접 보지 않는다.
        if (endsTurn) {
          this.ctxEpoch += 1;
          this.ctxWait = this.emitContextUsage();
          if (ingested) this.rearmAuthNotice(ingested); // 정상 턴이면 다음 만료를 다시 알릴 준비
          this.noteDistillModelPicked();
          this.persistMeta("turn 종료");
        }
      }
      this.ended = true;
      // 잠재우거나 지워서 끝난 흐름은 사건을 남기지 않는다(기록기는 열려 있어 순번만 소모된다).
      if (!this.rewinding && !this.disposed) this.ingest({ kind: "status", status: "completed" });
    } catch (err) {
      if (!this.rewinding) void reportError(err, { component: "session", operation: "session.run", session_id: this.id, provider: this.provider });
      const errText = String(err);
      this.ended = true;
      if (!this.rewinding && !this.disposed) {
        this.ingest({ kind: "status", status: "crashed", error: errText });
        if (isAuthError(errText)) this.emitAuthExpired(); // 크래시 사유가 401/인증만료면 재인증 안내
      }
    } finally {
      this.turnOpen = false;
      this.bgTasks = [];
      this.bgHold = null;
      this.openTurns = 0;
      this.textCandidate = null;
      if (!this.rewinding) this.drainPending(st("notice.proto.sessionEnded")); // 정상완료/크래시 양쪽에서 보류 권한 정리(좀비 promise 방지)
      this.endedResolve();
    }
  }

  /** 방금 기록한 사건 안의 마지막 모델 글을 질문지 후보로 기억한다. */
  private noteTextCandidate(ingested: AetherEvent) {
    const texts = this.codec.normalize(ingested).filter((a) => a.type === "text");
    const last = texts[texts.length - 1];
    if (last && last.type === "text") this.textCandidate = { seq: last.seq, part: last.part, text: last.text };
  }

  /**
   * 턴 끝에서 질문지를 읽어 사건으로 남긴다. 브리프 대화 중이고, 후보가 마지막 사람 입력 뒤의 글이고,
   * 이 턴 말고 기다리는 입력이 없을 때(openTurns가 1)만 만든다. 후보 지우기와 계수기 감소도 여기서 한다.
   * 같은 조건에서 마지막 글에 질문지 상자가 없으면 브리프 대화를 끝낸다. 형식이 틀린 상자도 물은 것으로 본다.
   */
  private settleTurnQuestionnaire() {
    const candidate = this.textCandidate;
    const open = this.openTurns;
    this.textCandidate = null;
    this.openTurns = Math.max(0, open - 1);
    if (!this.briefOpen || open !== 1) return;
    const block = candidate && candidate.seq > this.lastUserMsgSeq ? findQuestionnaireBlock(candidate.text) : null;
    if (!candidate || block === null) {
      this.briefOpen = false; // 메타 저장은 같은 턴 끝의 persistMeta가 한다
      return;
    }
    const parsed = parseQuestionnaire(block);
    const base = { kind: "questionnaire" as const, id: randomUUID(), sourceSeq: candidate.seq, sourcePart: candidate.part };
    const saved = this.ingest(parsed.ok ? { ...base, questions: parsed.questions } : { ...base, invalid: true, error: parsed.error });
    if (!saved) console.error("[aether] 질문지 사건 저장 실패(원문만 보인다)");
  }

  /** 승인한 파일 변경의 이전 내용을 남긴다. 본문이 없거나 잘렸으면 이유만 적는다. */
  private noteCheckpoint(req: PermissionRequest) {
    let seq = 0;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const ev = this.buffer[i];
      if (isControlEvent(ev, "permission_request") && ev.req.id === req.id) {
        seq = ev.seq;
        break;
      }
    }
    // 큰 사건이 많으면 카드가 버퍼에서 밀려날 수 있다. 되돌리기 기록을 잃지 않게 DB에서 찾는다.
    if (!seq) {
      for (const ev of store.eventsNewestFirst(this.id)) {
        if (isControlEvent(ev, "permission_request") && ev.req.id === req.id) {
          seq = ev.seq;
          break;
        }
      }
    }
    if (!seq) return;
    const notes = checkpointsForApproval(seq, req.mutation, this.cwd);
    for (const note of notes) {
      try {
        appendCheckpoint(this.id, note);
      } catch (e) {
        void reportError(e, { component: "session", operation: "session.file_history.save", session_id: this.id, provider: this.provider }); console.error("[aether] 파일 이전 내용 저장 실패:", e);
      }
    }
  }

  private takeReseed(): string | undefined {
    const text = this.reseedText?.trim();
    if (!text) return undefined;
    this.reseedText = undefined;
    this.persistMeta("되돌린 대화 전달");
    return text;
  }

  /**
   * 고른 사용자 말 뒤의 대화와, 그때 승인해 저장해 둔 파일을 되돌린다.
   * 실행기는 끝내고, 다음 말은 새 프로세스가 남겨 둔 글을 한 번 읽고 잇는다.
   */
  async rewind(seq: number): Promise<RewindOutcome> {
    if (this.disposed) throw new RewindError("missing");
    if (this.rewinding) throw new RewindError("busy");
    if (
      this.turnOpen ||
      this.pending.size ||
      this.pendingQuestions.size ||
      this.pendingPlans.size ||
      this.blockingCommandOperations.size
    ) {
      throw new RewindError("busy");
    }
    // 끄기 시작 전에 막아야, 같은 객체를 받은 새 입력이 꺼지는 실행기로 들어가지 않는다.
    this.rewinding = true;
    // 이번 시도에서 실행기 종료가 끝났는지. 예전 되돌리기로 rewound 가 이미 참이어도, 종료 실패면 입력을 다시 연다.
    let disposeFinished = this.ended;
    try {
      const before = store.readEventsSince(this.id, 0);
      const target = rewindTarget(before, seq, this.hiddenRanges);
      if (!this.ended) {
        await this.runtime.dispose();
        await this.endedPromise;
        disposeFinished = true;
      }
      const events = store.readEventsSince(this.id, 0);
      let until = target.until;
      for (const event of events) if (event.seq > until) until = event.seq;
      const plan = planRewind(loadCheckpoints(this.id), target.after, until);
      const applied = applyRestore(this.cwd, plan.restore);
      this.hiddenRanges = [...this.hiddenRanges, { after: target.after, until }];
      this.reseedText = buildReseed(linesForReseed(events, this.hiddenRanges, (event) => this.codec.normalize(event)));
      this.rewound = true;
      this.resumeKey = undefined;
      // 고른 말 뒤의 완료 사건은 숨김 범위에 들어간다. 그 사건을 다시 보이면 중단 배너가 될 수 있다.
      // 범위 밖에 조용한 완료를 남겨, 화면과 새로고침이 모두 이 자리를 쉰 상태로 보게 한다.
      const idle = this.ingest({ kind: "status", status: "completed" });
      let idleSeq = idle && idle.seq > until ? idle.seq : undefined;
      if (!idleSeq) {
        idleSeq = until + 1;
        try {
          store.appendEvent(this.id, { seq: idleSeq, ts: Date.now(), kind: "status", status: "completed" });
        } catch (error) {
          void reportError(error, { component: "session", operation: "session.rewind.complete", session_id: this.id, provider: this.provider }); console.error("[aether] 되돌린 뒤 완료 표시 저장 실패:", error);
          idleSeq = undefined;
        }
      }
      this.persistMeta("되돌리기");
      return {
        restored: applied.restored,
        skipped: [...plan.skipped, ...applied.failed],
        after: target.after,
        until,
        ...(idleSeq ? { idleSeq } : {}),
      };
    } catch (error) {
      if (!disposeFinished) this.rewinding = false;
      throw error;
    }
  }

  /**
   * 현재 컨텍스트 창 점유량을 runtime에서 조회 → ctx 이벤트(영속+SSE).
   * 턴 누적 usage가 아니라 "지금 컨텍스트에 실제 들어있는" 토큰이다. fire-and-forget(턴 종료 후라 루프 비차단).
   */
  private async emitContextUsage() {
    try {
      const u = await this.runtime.contextUsage();
      this.ingest({ kind: "ctx", totalTokens: u.totalTokens, maxTokens: u.maxTokens });
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.context_usage.load", session_id: this.id, provider: this.provider }); console.error("[aether] 컨텍스트 사용량 조회 실패(ctx 갱신 건너뜀):", e);
    }
  }

  /**
   * 글자 색인에 라이브 적재. 입력은 *toPersist*(redact/clamp본) — 시크릿 tool_result는 이미 마커,
   * Bash 인라인 시크릿 마스킹·16KB clamp 적용본이라 일기와 누출이 같다.
   * 한 이벤트가 여러 행(병렬 tool_result=결과당 1행, part 0,1,2…). 색인이 닫혀 있으면 조용히 skip.
   */
  private indexLive(persisted: AetherEvent) {
    let items: { part: number; role: "user" | "assistant" | "assistant_interim" | "tool"; content: string }[] = [];
    let turnEnded = false;
    try {
      const plan = extractIndexable(persisted, this.codec);
      items = this.letterRefiner.refine(persisted.seq, plan.items);
      turnEnded = plan.turnEnded;
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.search.index", session_id: this.id, provider: this.provider }); console.error("[aether] 검색 인덱싱 실패(건너뜀):", e);
      return;
    }
    if (!items.length && !turnEnded) return;
    const displayName = resolveWorkTitle(this.name, this.generatedName);
    void projectLiveLetter({
      sessionId: this.id,
      seq: persisted.seq,
      ts: persisted.ts,
      turnEnded,
      items,
      displayName: displayName || null,
      cwd: this.cwd,
      model: this.model ?? null,
      createdAt: this.createdAt,
      lineageId: this.resumeKey || this.id,
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : "unknown";
      void reportError(e, { component: "session", operation: "session.letter.project", session_id: this.id });
      console.error("[aether] 세션 글자 색인 반영 실패(건너뜀):", msg.includes("://") || msg.includes("@") ? "연결 실패" : msg);
    });
  }

  /** 공개된 마지막 순번. 저장 중인 사건은 포함하지 않는다. */
  private get seq(): number {
    return this.eventLog.lastPublished();
  }

  /** 디스크에 남길 모양. 라이브 전용과 삭제 이후에는 저장하지 않는다. */
  private toPersist(ev: AetherEvent): AetherEvent | null {
    if (this.disposed || this.codec.isLiveOnly(ev)) return null;
    if (ev.kind === "user_msg") return filterUserMsgForPersist(stripMutationForPersist(ev));
    return this.persistFilter.apply(stripMutationForPersist(ev));
  }

  /**
   * 뒤 작업 목록과 '스스로 시작한 턴'을 따라간다. provider는 뒤 작업이 끝나거나 예약 시각이 되면 사용자 입력 없이 새 턴을 여는데,
   * 그 시작은 턴 시작 사건으로만 온다. 목록이 비는 순간과 그 턴이 열리는 순간 사이에는 보류로 '백그라운드 작업 중'을 유지한다.
   */
  private trackBackground(ev: AetherEvent): void {
    for (const a of this.codec.normalize(ev)) {
      if (a.type === "background_tasks") {
        const prev = this.bgTasks;
        this.bgHold = a.tasks.length === 0 && prev.length > 0 && !this.turnOpen ? { tasks: prev, until: Date.now() + BACKGROUND_HOLD_MS } : null;
        this.bgTasks = a.tasks;
      } else if (a.type === "turn_started" && !this.turnOpen && !this.ended) {
        // 턴 시작 사건은 메인 대화의 턴만 뜻한다. 하위 thread의 시작은 어댑터가 걸러서 여기까지 오지 않는다.
        this.bgHold = null;
        this.turnOpen = true;
        if (this.attentionHold) {
          this.attentionHold = undefined;
          this.persistMeta("주의 막힘 해제");
        }
      }
    }
  }

  /** 기록기가 순번 순서대로 공개할 때 버퍼·구독·색인에 반영한다. */
  private onPublished(published: Published): void {
    const ev = published.event;
    this.trackBackground(ev); // 구독자(알림 판정·주의 상태)가 갱신된 목록을 보도록 알리기 전에 먼저 반영한다
    // 명령 목록·사용량·모델 관측·status 같은 비대화 사건은 세션을 최근 사용한 것처럼 올리지 않는다.
    // 사용자 글은 첫 입력이어도 활동으로 센다.
    if (ev.kind === "user_msg" || (!this.awaitingFirstInput && affectsLastActivity(ev, this.codec))) this.lastActivityAt = ev.ts;
    if (ev.kind === "user_msg" && !(ev as { sentBy?: string }).sentBy) this.lastInputAt = ev.ts;
    this.buffer.push(ev);
    const size = JSON.stringify(ev).length;
    this.bufferSizes.push(size);
    this.bufferBytes += size;
    // 개수 또는 바이트 상한을 넘으면 앞에서 밀어낸다. 방금 넣은 사건 하나는 남긴다. 밀려난 사건은 DB에서 읽는다.
    while (this.buffer.length > 1 && (this.buffer.length > config.bufferCap || this.bufferBytes > config.bufferMaxBytes)) {
      this.buffer.shift();
      this.bufferBytes -= this.bufferSizes.shift()!;
    }
    if (published.persisted) {
      this.indexLive(published.persisted);
    }
    for (const fn of this.subs) {
      try {
        fn(ev);
        failuresFor(fn).clear("session.subscriber.notify");
      } catch (error) {
        failuresFor(fn).report(error, { component: "session", operation: "session.subscriber.notify", severity: "warning", session_id: this.id });
        /* 구독자 오류 격리 */
      }
    }
  }

  /** seq·시각을 붙여 기록기에 맡긴다. 거절되면 null이다. 순번을 쓰는 호출부는 null을 건너뛴다. */
  private ingest(body: AetherEventBody): AetherEvent | null {
    // 디스크 throw가 호출부(resolvePermission/drainPending/onAbort)의 resolve를 건너뛰지 못하게 격리한다.
    // notice는 영속한다. 라이브 전용과 삭제 이후만 저장하지 않는다.
    try {
      return this.eventLog.write(body, (ev) => this.toPersist(ev));
    } catch (e) {
      if (body.kind === "user_msg") throw e;
      void reportError(e, { component: "session", operation: "session.event.append", session_id: this.id, provider: this.provider }); console.error("[aether] appendEvent 실패(이벤트 영속 건너뜀):", e);
      return null;
    }
  }

  /** 목록 카드용 마지막 말. 버퍼 꼬리만 본다. */
  lastWorkPreview(): string {
    return previewFromEvents(this.buffer, this.codec, this.id);
  }

  get isEnded() {
    return this.ended;
  }

  get isDisposed() {
    return this.disposed;
  }
}
