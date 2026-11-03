// HTTP 응답 모양은 shared/http.ts 한 벌이다. 화면 사건 본문은 shared/agentEvent.ts다.
// 이 파일은 그 계약을 재수출하고, 턴 상태·연결 상태처럼 화면만 쓰는 값만 둔다.
// 웹 생산 코드는 server/를 import하지 않는다.
import type { AgentEvent, BackgroundTask } from '@shared/agentEvent'

export type { AgentEvent, BackgroundTask }
export type {
  ApiErrorBody,
  CaughtUpInfo,
  BacklogInfo,
  DerivedStatus,
  ImageAttachment,
  DocAttachment,
  SessionEffort,
  ProviderInfo,
  ProviderList,
  ProvidersResponse,
  ProviderAvailability,
  AccountUsageEntry,
  AccountUsageResponse,
  ProviderAvailabilityResponse,
  RememberedModelsResponse,
  UsageWindow,
  UsageResponse,
  LocalizedText,
  SlashCommandInfo,
  CommandExecutionResult,
  ModelInfo,
  PermissionPolicyScope,
  PermissionPolicy,
  SessionListItem,
  AutoResumePlan,
  HandoffFields,
  HandoffInfo,
  HandoffRequestBody,
  HandoffJob,
  HandoffSource,
  HandoffState,
  SessionAttention,
  SessionAttentionKind,
  WorkspaceRoomKind,
  WorkspaceRoom,
  WorkspaceListResponse,
  PresenceSession,
  PresenceSnapshot,
  MutationHunk,
  MutationPreview,
  PermissionRequest,
  PermissionMode,
  PermissionModesResponse,
  PlanRequest,
  AetherQuestion,
  QuestionRequest,
  QuestionnaireQuestion,
  QuestionnaireAnswerValue,
  AetherEvent,
} from '@shared/http'

/** 턴이 끝났다는 정규화 이벤트 — 결과 푸터가 소비한다. */
export type TurnCompleted = Extract<AgentEvent, { type: 'turn_completed' }>

export type TurnState = 'idle' | 'running' | 'operation' | 'requires_action'
export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'offline'

/**
 * 참딩 마스코트가 지금 어떤 국면을 보여줘야 하는가 — `stream/Indicators.tsx`가 `ChamdingMascot`의
 * `state`로 옮긴다. `waiting`은 렌즈를 올린 채 더 느리게 자세를 고치는 대기 자세다.
 * `success`·`error`·`confused`·`surprise`는 한 번 재생하고 끝나는 몸짓이다.
 * 턴이 끝난 뒤의 값은 "그 턴이 왜 끝났는가"이고, 새로고침만으로 참딩을 다시 띄우지는 않는다.
 * `waiting`은 권한·질문·계획 카드가 떠서 답을 기다리는 동안(`turn === 'requires_action'`)이다.
 * 자세한 사건→국면 규칙은 streamSegments.ts 참고.
 */
export type ChamdingPhase = 'idle' | 'thinking' | 'working' | 'success' | 'error' | 'confused' | 'surprise' | 'waiting'

// ── 폴더 고르기(GET /api/fs/places, /api/fs/list) ──
/** 위치 한 줄. kind는 그림을 고르는 데만 쓴다. */
export type FsPlace<K extends string = string> = { kind: K; name: string; path: string }
export type FsPlaces = {
  home: string
  favorites: FsPlace<'home' | 'desktop' | 'documents' | 'downloads'>[]
  devices: FsPlace<'drive' | 'root' | 'volume'>[]
}
export type FsEntry = { name: string; path: string; hidden: boolean }
export type FsListing = {
  /** 심볼릭 링크를 푼 실제 경로. */
  path: string
  name: string
  parent: string | null
  /** 루트부터 지금 폴더까지. 서버가 쪼갠다. */
  crumbs: { name: string; path: string }[]
  /** 지금 폴더 하나만. */
  canCopy: boolean
  entries: FsEntry[]
  truncated: boolean
}
