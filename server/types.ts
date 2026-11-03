/**
 * 디스크에 남는 세션 이벤트 봉투.
 * 사람이 붙는 REST·SSE 모양은 `shared/http.ts`다. 여기 `AetherEvent`는 원본 `msg`를 포함한 영속 형식이다.
 */
import type { Provider, TodoItem } from "../shared/agentEvent";
import type { AutoResumePlan, HandoffJob, HandoffSource, PermissionMode, PermissionPolicy, SlashCommandInfo } from "../shared/http";
import type {
  AetherQuestion,
  DerivedStatus,
  DocAttachment,
  ImageAttachment,
  PermissionRequest,
  PlanRequest,
  QuestionRequest,
  QuestionnaireAnswerValue,
  QuestionnaireQuestion,
  SessionAttentionKind,
  SessionEffort,
} from "../shared/http";

export type {
  AetherQuestion,
  DerivedStatus,
  DocAttachment,
  ImageAttachment,
  MutationPreview,
  PermissionRequest,
  PlanRequest,
  QuestionRequest,
  QuestionnaireAnswerValue,
  QuestionnaireQuestion,
  SessionEffort,
  SessionListItem,
} from "../shared/http";

export type ProviderId = Provider;

// "interrupted" = 종료 이벤트 없이 끊긴 턴(백엔드 재시작/크래시로 고아가 됨)을 부팅 시 합성 영속하는 값.
export type SessionStatus = "completed" | "crashed" | "interrupted";

/**
 * provider 원본 이벤트 봉투 — 모델 프로세스가 뱉은 것을 구조 그대로 담는다(D2.1).
 * runtime이 방출하는 유일한 이벤트 종류다.
 *
 * `kind`는 디스크에 그대로 적힌다(events.jsonl). 코어는 이름을 둘로 닫지 않는다. 세 번째 실행기를
 * 끼울 때마다 이 파일을 다시 열지 않기 위해서다. `"sdk"`·`"codex"`는 각 adapter 안에서만 좁힌다.
 * `msg`의 모양도 adapter만 안다.
 */
export type RawProviderEventBody = { kind: string; msg: unknown };

/** seq/ts가 아직 안 매겨진 이벤트 본문 (ingest 시점에 부여) */
export type AetherEventBody =
  | RawProviderEventBody
  | { kind: "user_msg"; text: string; images?: ImageAttachment[]; documents?: DocAttachment[]; clientMessageId?: string; sentBy?: "aether"; handoffFrom?: string; briefId?: string; questionnaireAnswer?: { id: string; answers: Record<string, QuestionnaireAnswerValue> } } // 사용자 입력(영속+replay). text는 사람이 쓴 글. briefId는 옛 브리프 진행 글에만 있다. 새 글에는 붙지 않는다. questionnaireAnswer는 카드로 답한 질문지다. images·documents: base64(디스크엔 stub·라이브만 full)
  | { kind: "permission_request"; req: PermissionRequest }
  | { kind: "permission_resolved"; id: string; decision: "allow" | "deny" }
  | { kind: "question_request"; req: QuestionRequest }
  | { kind: "question_resolved"; id: string; answered: boolean; answers?: string[][] }
  | { kind: "plan_request"; req: PlanRequest }
  | { kind: "plan_resolved"; id: string; decision: "approve" | "revise" | "cancel" }
  | { kind: "status"; status: SessionStatus; error?: string }
  /** provider-native 명령의 시작·완료. 명령의 의미는 runtime이, 표시·영속은 공통 계층이 맡는다. */
  | { kind: "command_operation"; operationId: string; state: "started" | "completed" | "failed"; detail: string; blocksInput: boolean }
  // distill_model = 배경 작업이 쓸 경량 모델을 새로 골랐다는 안내.
  | { kind: "notice"; notice: "resumed" | "no_context" | "auth_expired" | "distill_model" | "permission_lowered"; detail?: string }
  /** 할 일 도구가 남긴 목록 전체. 마지막 사건이 유효하다. 밖으로는 codec이 `plan_update`로 바꿔 내보낸다. */
  | { kind: "todo_list"; items: TodoItem[] }
  | { kind: "ctx"; totalTokens: number; maxTokens: number } // 매 턴 후 getContextUsage로 갱신하는 현재 컨텍스트 점유량
  /** 브리프 턴 끝의 질문지. 실패면 questions 없이 invalid와 error만 있다. */
  | { kind: "questionnaire"; id: string; sourceSeq: number; sourcePart: number; questions: QuestionnaireQuestion[] }
  | { kind: "questionnaire"; id: string; sourceSeq: number; sourcePart: number; invalid: true; error: string };

/** 영속/SSE 이벤트 = 본문 + ingest 시점에 부여되는 seq/ts. (AetherEventBody 유니온에 자동 분배됨) */
export type AetherEvent = AetherEventBody & { seq: number; ts: number };

export type AetherControlKind =
  | "user_msg"
  | "permission_request"
  | "permission_resolved"
  | "question_request"
  | "question_resolved"
  | "plan_request"
  | "plan_resolved"
  | "status"
  | "command_operation"
  | "notice"
  | "ctx"
  | "todo_list"
  | "questionnaire";

/**
 * 제어 사건으로 좁힌다. 원본 봉투의 `kind`는 열린 문자열이라 `===`만으로는 제어 필드를 못 본다.
 */
export function isControlEvent<E extends { kind: string }, K extends AetherControlKind>(
  ev: E,
  kind: K,
): ev is E & Extract<AetherEventBody, { kind: K }> {
  return ev.kind === kind;
}

/**
 * 영속 전 permission_request의 mutation 내용(before/after/hunks) 제거 — 시크릿 평문 로그 차단.
 * 메타(kind/path/플래그/additions/deletions)만 남긴 얕은 복사본 반환. 비대상 이벤트는 원본 그대로.
 * (메모리 buffer/SSE에는 full payload, 디스크 events.jsonl에는 strip본 — partial 영속 제외와 동형.)
 *
 * **8e 분리**: 예전에는 여기서 `req.input`의 콘텐츠 필드(`content`·`old_string`…)까지 지웠다. 그 이름들은
 * Claude 도구의 인자 이름이라, 다른 provider의 도구 인자는 **마스킹 없이 그대로 디스크에 남았다.**
 * 인자 이름을 아는 것은 provider의 지식이므로 그 부분은 각 provider의 영속 축소기로 옮겼다.
 * 여기 남은 것은 어느 provider에서나 같은 판정뿐이다 — 변경 미리보기의 본문은 디스크에 안 남긴다.
 */
export function stripMutationForPersist(ev: AetherEvent): AetherEvent {
  if (!isControlEvent(ev, "permission_request") || !ev.req.mutation) return ev;
  const req = ev.req;
  const { before: _b, after: _a, hunks: _h, ...metaOnly } = req.mutation!;
  return { ...ev, req: { ...req, mutation: metaOnly } };
}

export type SessionMeta = {
  id: string;
  cwd: string;
  name?: string; // 사람이 직접 붙인 작업 이름(rename). 빈값/미지정 = generatedName 또는 화면의 '새 작업'.
  /** 보관한 시각(ms). 있으면 목록에서 「보관됨」으로 가고 알림·주의 표시를 내지 않는다. 해제하면 지운다. 삭제가 아니다. */
  archivedAt?: number;
  /** 첫 사용자 말에서 뽑은 제목. name이 있으면 목록에 안 쓴다. name을 비워도 이건 남긴다. */
  generatedName?: string;
  provider?: ProviderId; // 이 세션을 실행하는 모델 제공자. 부재 = 옛 세션. 해석은 registry의 storedProviderId 한 곳(D12)
  model?: string; // 미지정 = 계정 기본 모델(query에 model 안 넘김)
  /**
   * 마지막으로 확인한 계정 기본 모델의 정식 id. **표시 전용**이다 — runtime에 넘기지 않으므로 계정 기본
   * 모델이 바뀌면 세션도 따라간다. 고른 모델과 스트림에서 본 모델이 둘 다 없을 때 목록 카드가 이 값을 쓴다.
   */
  accountDefaultModel?: string;
  /**
   * 스트림에서 마지막으로 본 실제 모델. 고른 모델과 계정 기본 모델보다 목록 카드가 우선한다.
   * 모델을 새로 고르면 다음 응답이 오기 전까지 비운다.
   */
  observedModel?: string;
  /** provider가 마지막 턴에 실제로 적용했다고 알린 강도. 강도나 모델을 바꾸면 다음 턴까지 비운다. */
  observedEffort?: string;
  /**
   * 목록 카드에 쓸 사람이 읽는 모델 이름. 이 세션의 모델 목록에서 찾는다.
   * 맞는 줄이 없으면 빈 값이다. 이름을 지어내지 않는다.
   */
  modelLabel?: string;
  /**
   * 이어갈 세션 식별자 — 코어는 이 문자열의 *의미를 모른다*(D12). Claude adapter가 SDK session_id로,
   * Codex adapter가 threadId로 해석한다. 프로토콜 식별자를 provider마다 나란히 두면 provider 용어가
   * 코어로 새고 세 번째 provider에서 필드가 또 늘어나므로 하나로 통일했다.
   */
  resumeKey?: string;
  /**
   * 8d-1 이전 이름(Claude SDK session_id). **읽기 전용 호환 필드** — 새로 쓰지 않는다.
   * 승격 규칙(`resumeKey ??= sdkSessionId`)은 `persistence.loadMeta` 한 곳에만 있고, 거기서 이 필드를
   * 걷어내므로 코어 로직은 이 이름을 보지 않는다.
   */
  sdkSessionId?: string;
  createdAt: number;
  /** 권한 모드. resume 후에도 유지하려 영속. 없으면 옛 `skipPermissions`로 읽는다(`promoteMeta`). */
  permissionMode?: PermissionMode;
  /** 마지막으로 provider에게 받은 고를 수 있는 모드 목록. 잠든 세션도 이 목록으로 답한다. */
  permissionModes?: PermissionMode[];
  /** 읽기 전용 호환 필드 — 새로 쓰지 않는다. true는 full, 그 밖은 manual로 읽는다. */
  skipPermissions?: boolean;
  effort?: SessionEffort; // /effort로 설정한 reasoning effort. resume 후에도 유지하려 영속(settings flag로 재적용).
  /**
   * 마지막 활동 시각 — 사용자가 실제로 말을 건 뒤의 이벤트만 반영한다(사이드바 '마지막 사용' 정렬의 출처).
   * 디스크 꼬리의 마지막 이벤트 시각을 쓰지 않는 이유: 세션을 깨우기만 해도 이어가기 안내와 provider의
   * 시작 훅 이벤트가 꼬리에 쌓여서, 구경만 한 세션이 맨 위로 올라온다. 부재면 예전처럼 꼬리에서 유추한다.
   */
  lastActivityAt?: number;
  /** 사람이 마지막으로 글을 보낸 시각(사이드바 정렬 기준). 에이전트 응답이나 Aether가 대신 보낸 글로는 움직이지 않는다. */
  lastInputAt?: number;
  /**
   * 작업 폴더를 분리했을 때 원래 고른 폴더. 없으면 격리가 없다.
   * cwd는 실제 작업 경로(분리됐으면 그 경로)다. 코어는 분리 수단을 모른다.
   */
  workspaceSource?: string;
  /** 이 세션 대화 통로가 마지막으로 따라잡은 시각. 기기 저장소가 아니라 서버가 가진다. */
  lastViewedAt?: number;
  /**
   * 마지막으로 사람을 부를 사건(완료·실패·한도·크래시·인증). 잠든 세션은 이 칸만 보고 주의를 복원한다.
   * 목록이 events.jsonl을 다시 전수 읽지 않게 한다.
   */
  attentionSticky?: { kind: SessionAttentionKind; preview: string; at: number };
  /**
   * 사람이 풀어야 막힌 것(한도 막힘·재시작으로 끊긴 요청). 다음 턴이 열리면 지운다.
   * until이 있으면 그 시각이 지난 뒤에는 무시한다.
   */
  attentionHold?: { kind: "rate_limit" | "interrupted_request"; preview: string; since: number; until?: number };
  /** 한도 풀림을 기다리는 자동 재개 예약. 재시작 뒤에도 남는다. */
  autoResume?: AutoResumePlan;
  /** 넘기기로 이어 받은 이전 세션. */
  handoffFrom?: string;
  /** 이 세션이 넘겨 준 다음 세션(마지막 하나). */
  handoffTo?: string;
  /** 새 세션 쪽: 입력창에 넣을 인계서. 첫 말을 보내면 지운다. */
  handoffDraft?: { text: string; source: HandoffSource };
  /** 이전 세션 쪽: 진행 중이거나 결과가 남은 넘기기 작업. */
  handoffJob?: HandoffJob;
  /** 되돌린 구간. seq가 after보다 크고 until 이하이면 다시 보여 주지 않는다. */
  hiddenRanges?: { after: number; until: number }[];
  /** 다음 첫 말에 한 번만 붙이는, 남겨 둔 대화. 전달 뒤 지운다. */
  reseedText?: string;
  /** 이어가기 식별자를 비운 세션. 없어도 깨울 수 있다. */
  rewound?: boolean;
  /** 쉬는 시간이 지나 실행기만 내린 세션이다. 깨어나면 지운다. 재시작으로 끊긴 것과 구분해 깨울 때 안내를 남기지 않는다. */
  slept?: true;
  /** 잠들 때 기억한 승인 정책 요약. 잠든 세션이 이 값으로 답한다. */
  permissionPolicy?: PermissionPolicy;
  /** provider가 마지막으로 알려 준 명령 목록(공통 명령 제외). 잠든 세션이 이 목록으로 답한다. 옛 파일에는 없다. */
  commandCatalog?: SlashCommandInfo[];
  /** 브리프 대화가 진행 중인 세션. 질문지 없이 끝난 턴에서 지운다. */
  briefOpen?: true;
};
