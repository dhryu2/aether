/**
 * 사람이 붙는 REST와 SSE 공통 문의 응답 모양 (Phase 9e).
 *
 * 화면과 서버가 이 파일만 본다. 웹은 응답 모양을 손으로 베끼지 않는다. 웹 생산 코드는 server/를 import하지 않는다.
 * 디스크에 남는 모델 원본 봉투(`kind` + `msg`)는 여기 없다.
 * 화면 사건 본문과 계약 버전은 `agentEvent.ts`다. 이 파일은 HTTP 봉투와 REST 응답만 둔다.
 *
 * 런타임 검사: `server/test/door_wire.ts`가 실제 SSE와 `GET /events` 모양을 고정한다.
 */
import type { AgentEvent, BackgroundTask } from "./agentEvent";

/** REST 오류 본문. 라우트가 실패를 JSON으로 줄 때 이 칸만 쓴다. */
export type ApiErrorBody = { error: string };

/** `caught_up` 표지. 계약 버전이 없거나 다른 타입이면 화면이 구버전 서버로 보고 안내를 보류한다. */
export type CaughtUpInfo = { contractVersion?: unknown };

/** `backlog_info` — 초기 replay가 꼬리를 잘랐을 때 무한스크롤 상태. */
export type BacklogInfo = { oldestSeq: number; hasOlder: boolean };

export type DerivedStatus = "active" | "ended" | "crashed" | "interrupted" | "corrupted";

export type ImageAttachment = { media_type: string; data: string };
export type DocAttachment = { name: string; media_type: string; data: string };

/**
 * 권한 모드(중립). 어느 모드가 있는지는 provider가 알려 준다 — 공통 코드는 받은 목록만 본다.
 *   manual: 파일 수정·명령 실행 전에 묻는다 · edits: 파일 편집은 바로 하고 명령은 묻는다
 *   auto: 안전한 작업은 AI 서비스가 판단해 실행한다 · full: 묻지 않고 모두 실행한다
 */
export type PermissionMode = "manual" | "edits" | "auto" | "full";
export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "edits", "auto", "full"];
/** 권한이 넓은 순서(낮을수록 좁다). 모드가 좁아졌는지 가를 때 쓴다. */
export const PERMISSION_RANK: Record<PermissionMode, number> = { manual: 0, edits: 1, auto: 2, full: 3 };
/** 세션 하나의 권한 모드 목록 응답. */
export type PermissionModesResponse = { modes: PermissionMode[]; current: PermissionMode };

/** provider마다 어휘가 다르다. 실제 목록은 라이브 세션의 모델 목록이 정본이다. */
export type SessionEffort = string;

export type ProviderInfo = {
  id: string;
  displayName: string;
  authSupported: boolean;
  /** 계획문을 승인·수정요청·취소로 검토한다. 없으면 그 컨트롤을 그리지 않는다. */
  planReview?: boolean;
};
export type ProviderList = ProviderInfo[];
/**
 * provider를 지금 쓸 수 있는가. 못 쓰면 이유를 중립 낱말로 준다. 문구는 화면이 언어에 맞춰 고른다.
 *   not_installed: 실행 프로그램이 없다 · logged_out: 로그인이 안 됐다 · unreachable: 모델 서버가 응답하지 않는다
 *   no_models: 모델 서버에 모델이 없다 · check_failed: 확인하다 실패했다
 *   sdk_unavailable: 이 서비스를 쓰는 데 필요한 구성 요소를 불러오지 못했다
 */
export type ProviderUnavailableReason = "not_installed" | "logged_out" | "unreachable" | "no_models" | "check_failed" | "sdk_unavailable";
export type ProviderAvailability =
  | { available: true }
  | {
      available: false;
      reason: ProviderUnavailableReason;
      /** 이 서비스를 쓰려면 함께 있어야 하는 다른 프로그램의 표시 이름. 어댑터가 채운다. */
      requires?: string;
    };
export type ProviderAvailabilityResponse = { availability: Record<string, ProviderAvailability> };
/** 세션이 뜰 때 받아 저장해 둔 provider별 모델 목록. 프로그램을 띄우지 않고 저장본만 읽는다. */
export type RememberedModelsResponse = { models: Record<string, ModelInfo[]> };
export type ProvidersResponse = { providers: ProviderList; reloginEnabled: boolean };

export type UsageWindow = {
  key: string;
  utilization: number | null;
  resetsAt?: string | null;
  windowMinutes?: number;
};
export type UsageResponse = {
  costUsd?: number;
  subscriptionType?: string;
  windowsAvailable: boolean;
  windows: UsageWindow[];
  /** 지금 문맥 창에 들어 있는 토큰. 구독 한도 창과 별개다. 아직 모르면 칸 자체를 안 싣는다. */
  context?: { used: number; size: number };
};

export type LocalizedText = {
  text?: string;
  byLocale?: Readonly<Record<string, string>>;
};

export type SlashCommandInfo = {
  name: string;
  description: LocalizedText;
  argumentHint: LocalizedText;
  aliases?: string[];
  startsTurn: boolean;
  /**
   * 서버가 아니라 화면이 처리할 동작. 값이 없으면 POST /commands 로 보낸다.
   * 화면은 명령 이름을 해석하지 않고 이 표시만 본다.
   */
  uiAction?: "newSession" | "rename" | "delete" | "settings" | "help" | "find" | "login" | "status";
};

/** `POST /api/sessions/:id/commands`가 수락했을 때. 거부는 `{ error }` 본문이다. */
export type CommandExecutionResult = {
  ok: true;
  accepted: true;
  startsTurn: boolean;
  sessionUpdate?: { model?: string; effort?: SessionEffort };
};

export type ModelInfo = {
  value: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
  supportedEffortDescriptions?: Readonly<Record<string, LocalizedText>>;
  /**
   * 이 줄은 계정 기본 모델을 따라가는 "기본값" 선택지다. 어댑터만 채운다.
   * `isDefault`(고르지 않은 세션이 쓰는 모델 표시)와 뜻이 다르다 — 실제 모델 줄에 `isDefault`를 붙이는 provider가 있다.
   */
  followsAccountDefault?: boolean;
  /** 이 줄의 value는 버전이 오르면 다른 정식 id를 가리키게 되는 별칭이다. 어댑터만 채운다. */
  movingAlias?: boolean;
  /**
   * 지금 provider가 준 목록에는 없고, 허브가 최근에 받은 더 긴 목록에서 기억한 줄이다(공통 계층이 채운다).
   * 고를 수는 있다. provider가 거부하면 지금의 오류 표시가 나온다.
   */
  remembered?: boolean;
};

export type PermissionPolicyScope = "user" | "project" | "local";
export type PermissionPolicy = {
  bypassAll: boolean;
  autoApproveRules: number;
  autoApproveMode?: string;
  sources: PermissionPolicyScope[];
};

/** 다음에 사람이 할 일. 수명 `status`와 섞지 않는다. */
export type SessionAttention = "idle" | "running" | "background" | "waiting" | "done" | "failed";
/** 주의의 이유. `waiting`/`done`/`failed`일 때만 온다. */
export type SessionAttentionKind =
  | "permission"
  | "question"
  | "plan"
  | "done"
  | "failed"
  | "rate_limit"
  | "crashed"
  | "auth"
  | "interrupted_request";

export type SessionListItem = {
  id: string;
  cwd: string;
  /** 목록에 올릴 제목. 사람 이름 또는 첫 말에서 뽑은 제목. 둘 다 없으면 빈 문자열 — 화면이 '새 작업'으로 채운다. */
  displayName: string;
  /** 사람이 직접 붙인 이름이면 true. 자동 제목·빈 이름은 false. */
  named?: boolean;
  provider: string;
  model: string;
  /** 마지막으로 확인한 계정 기본 모델의 정식 id. 고른 모델과 스트림에서 본 모델이 둘 다 없을 때 목록 카드가 쓴다(표시 전용). */
  accountDefaultModel?: string;
  /** 스트림에서 마지막으로 본 실제 모델. 있으면 목록 카드가 이 값을 우선한다. */
  observedModel?: string;
  /** 목록 카드용 표시 이름. 서버가 모델 목록에서 찾았고, 비어 있으면 화면이 직접 번역한다. */
  modelLabel?: string;
  effort?: SessionEffort;
  permissionMode: PermissionMode;
  status: DerivedStatus;
  createdAt: number;
  lastActivityAt?: number;
  /** 작업 폴더가 원 폴더와 분리돼 있으면 true. */
  isolated?: boolean;
  /** 분리했을 때 원래 고른 폴더. 코어는 이 경로의 생성 수단을 모른다. */
  workspaceSource?: string;
  /** 복사본에 원 폴더로 아직 반영하지 않은 변경이 있다. */
  needsApply?: boolean;
  /** 원 폴더에 다른 변경이 있어 지금은 반영할 수 없다. */
  applyBlocked?: boolean;
  /** 마지막 사용자·모델 말의 짧은 미리보기. 없으면 빈 문자열. */
  preview?: string;
  /** 다음에 사람이 할 일. 없으면 옛 화면은 수명 점만 그린다. */
  attention?: SessionAttention;
  attentionKind?: SessionAttentionKind;
  /** 알림 본문과 같은 한 줄. */
  attentionPreview?: string;
  /** 사람을 기다리기 시작한 시각(ms). `waiting`일 때만 온다. */
  attentionSince?: number;
  /** 메인 턴이 끝난 뒤에도 뒤에서 도는 작업. 살아 있는 세션만 채운다. */
  backgroundTasks?: BackgroundTask[];
  /** provider가 뒤 작업 중지를 지원하고 중지할 작업이 있으면 true. */
  backgroundCanStop?: boolean;
  /** 이 세션 대화 통로가 마지막으로 따라잡은 시각. */
  lastViewedAt?: number;
  /** 보관한 시각(ms). 있으면 보관된 세션이다 — 대화·폴더는 그대로이고 새 대화만 막힌다. */
  archivedAt?: number;
  /** 한도 풀림을 기다리는 자동 재개 예약. `at`이나 `gaveUp`이 있을 때만 온다. */
  autoResume?: AutoResumePlan;
} & HandoffFields;

/** 인계서가 만들어진 방식. skeleton은 모델이 쓰지 못해 Aether가 기록에서 모은 것이다. */
export type HandoffSource = "model" | "skeleton";
export type HandoffState = "writing" | "waiting_limit" | "copy_ready";

/** 넘기기 작업(이전 세션 쪽). 저장 파일에도 이 모양으로 남는다. */
export type HandoffJob = {
  purpose: "continue" | "rediscuss" | "next";
  focus?: string;
  includeMethod: boolean;
  provider?: string;
  cwd?: string;
  copyOnly?: boolean;
  state: HandoffState;
  requestedAt: number;
  /** 다른 컴퓨터(복사만) 결과이거나, 새 세션을 만들지 못했을 때 남긴 글. */
  result?: { text: string; source: HandoffSource; error?: string };
};

/** POST /api/sessions/:id/handoff 본문. includeMethod는 생략하면 켜짐이다. */
export type HandoffRequestBody = {
  purpose: HandoffJob["purpose"];
  focus?: string;
  includeMethod?: boolean;
  provider?: string;
  cwd?: string;
  copyOnly?: boolean;
};

/** GET /api/sessions/:id/handoff 응답. 새 세션의 입력창 초안(incoming)과 복사 결과(result). */
export type HandoffInfo = {
  incoming?: { fromSessionId: string; fromName: string; text: string; source: HandoffSource };
  result?: NonNullable<HandoffJob["result"]>;
};

/** 목록·방·실시간 갱신에 실리는 넘기기 연결 정보. 모두 선택 필드다. */
export type HandoffFields = {
  /** 이 세션이 이어 받은 이전 세션. */
  handoffFrom?: string;
  /** 이 세션이 넘겨 준 다음 세션. 마지막 하나만 둔다. */
  handoffTo?: string;
  handoffState?: HandoffState;
  /** 입력창에 넣을 인계서가 아직 보내지지 않았다. */
  handoffDraftPending?: true;
};

/** 한도로 멈춘 세션을 풀릴 때 자동으로 이어 가는 예약. 세션마다 하나다. */
export type AutoResumePlan = {
  /** 실행할 동작. 문장 보내기, 또는 한도 때문에 미룬 인계서 쓰기. */
  action: { type: "send"; text: string } | { type: "handoff" };
  /** 다음 시도 시각(ms). 없으면 이미 보냈고 결과를 기다리는 중이거나 포기했다. */
  at?: number;
  /** 자동으로 보낸 횟수(0..3). */
  attempts: number;
  /** 사람 확인 필요(3번을 다 썼거나 보내지 못함). */
  gaveUp?: true;
};

/** 자동 재개 전역 설정. text는 비워 두면 기본 문장이 채워져 온다. */
export type AutoResumeSettings = { enabled: boolean; text: string; defaultText: string };

export type WorkspaceRoomKind = "dm";

export type WorkspaceRoom = {
  id: string; // dm:<세션 id>
  kind: WorkspaceRoomKind;
  title: string;
  sourceSessionId?: string;
  cwd?: string;
  provider?: string; // 표시 태그. 화면이 이 문자열로 분기하지 않음
  status: DerivedStatus;
  attention?: SessionAttention;
  attentionKind?: SessionAttentionKind;
  attentionPreview?: string;
  attentionSince?: number;
  /** 메인 턴이 끝난 뒤에도 뒤에서 도는 작업. 살아 있는 세션만 채운다. */
  backgroundTasks?: BackgroundTask[];
  /** provider가 뒤 작업 중지를 지원하고 중지할 작업이 있으면 true. */
  backgroundCanStop?: boolean;
  lastViewedAt?: number;
  /** 보관한 시각(ms). 있으면 보관된 방이다. */
  archivedAt?: number;
  /** 한도 풀림을 기다리는 자동 재개 예약. `at`이나 `gaveUp`이 있을 때만 온다. */
  autoResume?: AutoResumePlan;
  lastActivityAt?: number;
  preview?: string;
  asleep?: boolean;
} & HandoffFields;

export type WorkspaceListResponse = {
  contractVersion: number;
  rooms: WorkspaceRoom[];
  /** 옛 화면 호환. dm만. id = sourceSessionId. 새 화면은 이 배열을 방 목록으로 쓰지 않는다. */
  sessions: SessionListItem[];
};

/** `GET /api/presence/stream`이 처음 보내는 전 세션 스냅샷. */
export type PresenceSnapshot = {
  contractVersion: number;
  channels: PresenceSession[]; // id = dm:<세션 id>
  sessions: PresenceSession[]; // 옛 화면. dm만, id = sourceSessionId
};
/** 주의 통로가 실어 보내는 짧은 세션 칸. 대화 글자·도구 인자·카드 원문은 없다. */
export type PresenceSession = {
  id: string;
  /** 목록 제목. 첫 턴 중에 요약 제목이 도착하면 이 칸으로 바뀐다. 비어 있으면 화면이 기본 문구를 쓴다. */
  displayName?: string;
  attention: SessionAttention;
  attentionKind?: SessionAttentionKind;
  attentionPreview?: string;
  attentionSince?: number;
  /** 메인 턴이 끝난 뒤에도 뒤에서 도는 작업. 살아 있는 세션만 채운다. */
  backgroundTasks?: BackgroundTask[];
  /** provider가 뒤 작업 중지를 지원하고 중지할 작업이 있으면 true. */
  backgroundCanStop?: boolean;
  lastActivityAt?: number;
  preview?: string;
  status: DerivedStatus;
  lastViewedAt?: number;
  /** 보관한 시각(ms). 보관·해제 때 이 칸이 바뀐 갱신이 흘러간다. */
  archivedAt?: number;
  /** 자동 재개 예약. 예약 문장(사람이 정한 짧은 문장)은 싣는다. `at`이나 `gaveUp`이 있을 때만 온다. */
  autoResume?: AutoResumePlan;
} & HandoffFields;

export type MutationHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};
/** 한 승인 안에 들어 있는 파일 하나. 이전 본문은 승인 순간에 디스크에서 읽는다. */
export type MutationFile = {
  path: string;
  isCreate?: boolean;
};

export type MutationPreview = {
  kind: "edit" | "write" | "notebook" | "multiedit";
  path: string;
  before?: string | null;
  after?: string;
  hunks?: MutationHunk[];
  replaceAll?: boolean;
  isCreate?: boolean;
  truncated?: boolean;
  totalBytes?: number;
  binary?: boolean;
  redacted?: boolean;
  inexact?: boolean;
  additions?: number;
  deletions?: number;
  /** 파일이 여럿이면 복원은 이 목록을 따른다. 화면용 path 한 줄로 되돌리지 않는다. */
  files?: MutationFile[];
};

export type PermissionRequest = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  displayName?: string;
  title?: string;
  toolUseID: string;
  createdAt: number;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  mutation?: MutationPreview;
};

export type AetherQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
};

/** 브리프 질문지 한 문항. 모델이 상자에 넣은 JSON을 서버가 검사해 남긴 것이다. */
export type QuestionnaireQuestion = {
  id: string;
  text: string;
  kind: "single" | "multi" | "text";
  options?: { label: string; description?: string }[];
  recommended?: string | string[];
};

/** 카드로 고른 답 한 문항. 건너뛴 문항은 skipped만 있다. */
export type QuestionnaireAnswerValue = {
  skipped?: true;
  chosen?: string[];
  custom?: string;
  note?: string;
};

export type QuestionRequest = {
  id: string;
  toolUseID: string;
  questions: AetherQuestion[];
  createdAt: number;
  /** 이 질문 앞에 확정된 사용자용 설명. 없으면 카드만 그린다. */
  lead?: string;
};

/** 계획 검토 카드. 권한 카드·질문 카드와 다른 세 갈래다. */
export type PlanRequest = {
  id: string;
  planId: string;
  text: string;
  createdAt: number;
};

/**
 * SSE와 `GET /events`가 보내는 클라이언트 봉투.
 * 모델이 만든 것은 `events`로만 온다. 원본 `msg`는 타입에 없다.
 */
export type AetherEvent =
  | { seq: number; ts: number; kind: "agent"; events?: AgentEvent[] }
  | {
      seq: number;
      ts: number;
      kind: "user_msg";
      text: string;
      images?: ImageAttachment[];
      documents?: DocAttachment[];
      clientMessageId?: string;
      /** Aether가 대신 보낸 글(자동 재개). 없으면 사람이 쓴 글이다. */
      sentBy?: "aether";
      /** 넘기기로 이어 받은 첫 말이다. 값은 이전 세션 id. 화면은 접힌 카드로 그린다. */
      handoffFrom?: string;
      briefId?: string;
      /** 카드로 답한 질문지. 이 필드가 없으면 그 글은 채팅으로 질문지를 닫은 것이다. */
      questionnaireAnswer?: { id: string; answers: Record<string, QuestionnaireAnswerValue> };
      events?: AgentEvent[];
    }
  | {
      seq: number;
      ts: number;
      kind: "questionnaire";
      id: string;
      sourceSeq: number;
      sourcePart: number;
      questions?: QuestionnaireQuestion[];
      invalid?: true;
      error?: string;
      events?: AgentEvent[];
    }
  | { seq: number; ts: number; kind: "permission_request"; req: PermissionRequest; events?: AgentEvent[] }
  | { seq: number; ts: number; kind: "permission_resolved"; id: string; decision: "allow" | "deny"; events?: AgentEvent[] }
  | { seq: number; ts: number; kind: "question_request"; req: QuestionRequest; events?: AgentEvent[] }
  | { seq: number; ts: number; kind: "question_resolved"; id: string; answered: boolean; answers?: string[][]; events?: AgentEvent[] }
  | { seq: number; ts: number; kind: "plan_request"; req: PlanRequest; events?: AgentEvent[] }
  | {
      seq: number;
      ts: number;
      kind: "plan_resolved";
      id: string;
      decision: "approve" | "revise" | "cancel";
      events?: AgentEvent[];
    }
  | {
      seq: number;
      ts: number;
      kind: "status";
      status: "completed" | "crashed" | "interrupted";
      error?: string;
      events?: AgentEvent[];
    }
  | {
      seq: number;
      ts: number;
      kind: "command_operation";
      operationId: string;
      state: "started" | "completed" | "failed";
      detail: string;
      blocksInput: boolean;
      events?: AgentEvent[];
    }
  | {
      seq: number;
      ts: number;
      kind: "notice";
      notice: "resumed" | "no_context" | "auth_expired" | "distill_model" | "permission_lowered";
      detail?: string;
      events?: AgentEvent[];
    }
  | { seq: number; ts: number; kind: "ctx"; totalTokens: number; maxTokens: number; events?: AgentEvent[] };

/**
 * 이전 페이지 응답.
 * oldestSeq는 덧붙이기 전, 서버가 읽은 페이지의 첫 순번이다.
 * 읽은 페이지가 비면 요청의 before다.
 */
export type EventsPageResponse = {
  events: AetherEvent[];
  hasOlder: boolean;
  oldestSeq: number;
};

/** 서버 정보(읽기 전용). 비밀값은 싣지 않는다. */
export type ServerInfoResponse = {
  version: string;
  dataDir: string;
  port: number;
  authMode: "off" | "tailscale" | "password";
  projectRoot: string;
  /** 사용 조건 주소. 배포 주소 없이 만든 빌드는 빈 문자열이다. */
  termsUrl: string;
};

/** 새 버전 확인 결과(GET /api/system/update). enabled=false면 나머지는 비어 있다. */
export type UpdateStatusResponse = {
  enabled: boolean;
  current: string;
  latest?: string;
  available: boolean;
  /** 내려받기 페이지 주소(설정의 updateUrl). 원격 응답의 값을 쓰지 않는다. */
  pageUrl?: string;
  notes?: string;
  checkedAt?: string;
  /** 앱 안에서 바로 설치할 수 있는 설치본인가. false면 다운로드 페이지로 안내한다. */
  canInstall: boolean;
  install: UpdateInstallState;
  /** 지난 업데이트가 실패해 이전 버전으로 되돌렸으면 실패한 버전. */
  rolledBackVersion?: string;
};

/** 앱 안 업데이트가 실패한 이유. network=받기 실패, signature=서명 또는 내용이 맞지 않음, verify=파일 크기나 지문이 다름, disk=저장 실패, backup=DB 백업 실패, handoff=설치 시작 실패. */
export type UpdateInstallFailure = "network" | "signature" | "verify" | "disk" | "backup" | "handoff";
export type UpdateInstallState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; received: number; total: number }
  | { phase: "installing"; version: string }
  | { phase: "failed"; version?: string; reason: UpdateInstallFailure };

export type ServerLogLevel = "log" | "warn" | "error";
export type ServerLogEntry = { t: string; level: ServerLogLevel; msg: string };
export type ServerLogResponse = { entries: ServerLogEntry[] };

/** DB 백업 한 건. id는 백업 폴더 안의 파일 이름이며 복원 예약의 열쇠로만 쓴다. */
export type BackupItem = { id: string; kind: "manual" | "beforeRestore"; createdAt: string; sizeBytes: number };
/** 복원이 실패한 이유. missing=백업 파일 없음, corrupt=손상됐거나 Aether DB가 아님, inUse=다른 프로그램이 DB를 열고 있음, io=파일 읽기·쓰기 실패. */
export type RestoreFailCode = "missing" | "corrupt" | "inUse" | "io";
/** 지난 복원 시도의 결과. 서버가 시작될 때 한 번 적용하고 남긴다. */
export type RestoreResult = { ok: boolean; id: string; at: string; code?: RestoreFailCode; detail?: string; safetyId?: string };
export type RestoreStatus = { pending: { id: string; requestedAt: string } | null; last: RestoreResult | null };
export type BackupListResponse = RestoreStatus & { items: BackupItem[]; running: boolean; keep: number };

/** 비밀번호 변경 성공 응답. 새 세션 토큰을 함께 준다. */
export type ChangePasswordResponse = { ok: true; token: string };
