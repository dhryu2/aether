import { markErrorReported, reportClientError } from './errorReporting'
import { createClientErrorReporter, createStorageErrorReporter } from './errors'
// 중앙 상태 — useSyncExternalStore 기반 외부 스토어 + 액션 + SSE 배선.
// 단일사용자/이벤트구동이라 전역 1스토어로 단순화. 대화 SSE는 보이는 칸만(첫 칸 + 옆 칸, 최대 4). 주의 통로는 전역으로 하나다.
import { useSyncExternalStore, type ReactNode } from 'react'
import { api, classifyTransportError, reportApiResponseError, RequestTimeoutError } from './api'
import { authHeaders } from './clientAuth'
import { isDesktopShell, showDesktopNotification } from './desktopShell'
import { pickClientMessageId } from './clientMessageId'
import { applyContractReload } from './contractReload'
import { openPresenceStream, openStream, type CaughtUpInfo, type StreamHandle } from './sse'
import { openSse, type SseHandle } from './sseTransport'
import { mergePresenceSnapshot, mergePresenceUpdate, mergeRoomPresenceSnapshot, mergeRoomPresenceUpdate } from './attention'
import { handoffTransition, type HandoffTransition } from './handoff'
import { drafts } from './drafts'
import { blocksFromMessage, encodeDraft } from './composerBlocks'
import { executionId as roomExecutionId, executionIdFor, findRoom, roomIdForExecution } from './workspaceRooms'
import { searchRequestUrl } from './searchFilters'
import { AGENT_EVENT_CONTRACT_VERSION } from '../../../shared/agentEvent'
import { startSameWorkFanout } from './fanoutStart'
import { groupSessions, projectKey } from './sessionGroups'
import {
  PANES_KEY,
  WIDE_QUERY,
  besideVictimIndex,
  decideClosePane,
  decideOpenBeside,
  decideReconnectMask,
  decideSelectSession,
  focusedSessionId,
  noteFocus,
  paneIds,
  movePane,
  parsePanes,
  replacePane,
  serializePanes,
  sessionOwningCard,
  sidebarInset,
  swapPanes,
  toggleZoomed,
  visibleCapacity,
  visibleSessionIds,
  zoomAfterChange,
} from './splitPane'
import { modelRowLabel } from './modelLabel'
import { t } from './i18n'
import { recoverAppViewport } from './appViewport'
import { runUpdateNotice, UPDATE_SEEN_KEY } from './updateNotice'
import { UPDATE_DONE_KEY } from './updateFlow'
import { agentEventsOf, commandsAvailableOf, modelInfoOf, turnCompletedOf } from './agentEvents'
import { createSearchCoordinator } from './searchCoordinator'
import { Archive, type LucideIcon } from 'lucide-react'
import type { AetherEvent, ConnState, HandoffRequestBody, ImageAttachment, DocAttachment, ModelInfo, PermissionMode, PermissionPolicy, PlanRequest, ProviderList, QuestionRequest, PermissionRequest, SessionEffort, SessionListItem, SlashCommandInfo, TurnState, WorkspaceRoom } from './types'
import type { SearchHit, BrainTab } from './brain'
import type { Locale } from './i18n/types'
import { parseTranscriptView, nextTranscriptView, type TranscriptView } from './transcriptView'
import { deriveWorkTitle } from '../../../shared/workTitle'
import { mergeOlderPageEvents, nextOlderBoundary } from '../components/stream/olderHistorySearch'
import { pendingQuestionnaire, type QuestionnaireAnswers } from './questionnaire'
import { opensWorkTurn, optimisticUserIndex } from './brief'
import { eventsToMarkdown, transcriptLabelsKo } from './transcriptMarkdown'
import { stepUserSeq, userSeqsOf } from './userJump'

// ── 언어(i18n) ── 기본 한국어, 설정에서 English 전환. 브라우저별 localStorage에 영속(기기 단위 선호).
const LOCALE_KEY = 'aether.locale'
const VIEW_KEY = 'aether.transcriptView'
const localeReadFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.locale.read' })
const localeWriteFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.locale.write' })
const viewReadFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.transcript_view.read' })
const viewWriteFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.transcript_view.write' })
const paneReadFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.panes.read' })
const paneWriteFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.panes.write' })
const queueReadFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.queued.read' })
const queueWriteFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.queued.write' })
const deepLinkFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.deeplink.read' })
// 아래는 기능을 줄여 계속하는 지점이다. 사용자 표시는 그대로 두고 warning으로만 남기며, 반복되는 지점은 연속 실패의 첫 건만 보낸다.
const commandsLoadFailure = createClientErrorReporter({ component: 'commands', operation: 'web.commands.load', severity: 'warning' })
function loadLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_KEY)
    localeReadFailure.reset()
    if (v === 'ko' || v === 'en') return v
  } catch (error) {
    localeReadFailure.report(error)
    /* localStorage 불가 환경 */
  }
  return 'ko'
}
function loadTranscriptView(): TranscriptView {
  try {
    const view = parseTranscriptView(localStorage.getItem(VIEW_KEY))
    viewReadFailure.reset()
    return view
  } catch (error) {
    viewReadFailure.report(error)
    return 'normal'
  }
}
/** <html lang> 동기화 — 접근성·브라우저 힌트. locale 변경·부팅 시 호출. */
function applyDocLang(locale: Locale) {
  try { document.documentElement.lang = locale } catch { /* SSR/비-DOM */ }
}

const SIDEBAR_COLLAPSED_KEY = 'aether.sidebarCollapsed.v1'
const sidebarReadFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.sidebar_collapsed.read' })
const sidebarWriteFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.sidebar_collapsed.write' })
function loadSidebarCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
    sidebarReadFailure.reset()
    return raw === '1'
  } catch (error) {
    sidebarReadFailure.report(error)
    return false
  }
}

/** 첫 그리기 전 대화 영역 추정치. 목록 기둥(펼침 288 + 여백, 접힘 띠 56 + 여백)을 뺀다. ResizeObserver가 곧 덮어쓴다. */
function initialPaneBox(): { paneW: number; paneH: number } {
  if (typeof window === 'undefined') return { paneW: 0, paneH: 0 }
  const narrow = window.innerWidth < 760
  const side = narrow ? 0 : sidebarInset(loadSidebarCollapsed())
  return { paneW: Math.max(0, window.innerWidth - side), paneH: window.innerHeight }
}

// 범용 확인 다이얼로그 상태 — 브라우저 confirm() 대체(디자인 통일). ConfirmDialog가 렌더.
//   취소 + 위험 버튼(onConfirm 실행). 알리기만 하는 소식은 창 대신 showNotice로 띄운다.
export type DialogState = {
  tone: 'danger' | 'warn' | 'neutral' // 강조색(danger=빨강 · warn=주황 · neutral=브랜드 블루)
  icon?: LucideIcon
  title: string
  message: string // \n 지원(pre-line)
  confirmLabel?: string // 위험/확인 버튼 라벨(기본 '확인')
  onConfirm?: () => void // confirm 확인 시 실행(닫힌 뒤 호출)
}

// 일반 알림 — 알리기만 하고 사용자가 할 일은 없는 소식. 화면 위 가운데에 잠깐 떴다 사라진다(shell/Toasts.tsx).
export type Notice = {
  icon?: LucideIcon
  title: string
  message?: string
  /** 알림 오른쪽의 글자 버튼. 누르면 실행하고 알림을 닫는다. 있으면 8초 동안 뜬다. */
  action?: { label: string; onClick: () => void }
}

// 대기 큐 항목 — qid(안정 id)로 취소/렌더 식별(인덱스 기반이면 flush로 배열이 줄 때 다른 항목 오취소).
type QueuedItem = {
  qid: string
  text: string
  images?: ImageAttachment[]
  documents?: DocAttachment[]
  /** 이번 대기 글만 브리프다. 없으면 일반 전송이다. */
  brief?: boolean
} // 첨부는 sessionStorage 미러 시 제외(용량)
let queueSeq = 0

// catch 블록 에러 메시지 표준화 — Error면 .message, 아니면 값 자체를 문자열화.
const errMsg = (e: unknown) => { reportClientError(e); return String((e as Error).message ?? e) }

// VAPID public 키(base64url) → Uint8Array (pushManager.subscribe applicationServerKey 형식)
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
// serviceWorker.ready는 활성 SW 없으면 영원히 pending → 타임아웃으로 reject(토글 먹통 방지).
const swReady = (): Promise<ServiceWorkerRegistration> =>
  Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error(t('core.sw.notReady')), { errorOrigin: 'external_environment' })), 5000)),
  ])

// SW가 Cache Storage에 남긴 알림 딥링크(pending)를 소비 — iOS PWA는 백그라운드에서 페이지를 폐기해도
//   창은 남겨둬 SW가 postMessage 경로를 타는데, 재생성된 페이지엔 그 메시지가 유실된다(→ 엉뚱한 세션으로 부팅).
//   SW가 마커를 먼저 기록해두므로 부팅(init)·복귀(visibilitychange) 시 여기서 읽어 활성화한다.
//   30초 이내 신선분만 유효(오래된 잔존 마커로 엉뚱한 점프 방지), 읽으면 즉시 삭제(1회성).
async function consumePendingDeepLink(): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  try {
    const c = await caches.open('aether-deeplink')
    const res = await c.match('/pending-session')
    if (!res) { deepLinkFailure.reset(); return null }
    await c.delete('/pending-session')
    const d = (await res.json()) as { sessionId?: string; ts?: number }
    deepLinkFailure.reset()
    if (typeof d.sessionId === 'string' && typeof d.ts === 'number' && Date.now() - d.ts < 30_000) return d.sessionId
  } catch (error) {
    deepLinkFailure.report(error)
    /* Cache 미지원/실패 — 딥링크 없이 정상 부팅 */
  }
  return null
}

// 알림 클릭 딥링크(①): 이미 열린 창에서 알림을 누르면 SW가 'aether:open-session'을 postMessage → 그 세션 활성화.
//   모듈 1회 바인딩(StrictMode 이중 init·중복 등록 방지).
let swMsgBound = false
function bindSwMessages() {
  if (swMsgBound || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  swMsgBound = true
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data as { type?: string; sessionId?: string } | undefined
    if (d?.type === 'aether:open-session' && typeof d.sessionId === 'string') {
      // iOS PWA의 notificationclick → client.focus() 경로는 visibilitychange/pageshow가 생략될 수 있다.
      // 남은 textarea 포커스와 stale visualViewport 높이를 세션 전환 전에 명시적으로 복구한다.
      recoverAppViewport()
      void actions.openSessionFromPush(d.sessionId)
    }
  })
  // 백그라운드 복귀 시 pending 딥링크 소비 — 페이지가 살아있었지만 postMessage가 복귀 타이밍에 유실된 경우 커버.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void consumePendingDeepLink().then((sid) => {
      if (sid) void actions.openSessionFromPush(sid)
    })
  })
}

// 낙관적 로컬 이벤트(전송 즉시 화면 반영). 사람 입력은 백엔드가 user_msg로 영속+SSE로 돌려보내므로,
//   local_user는 그 echo가 도착하면 dedup으로 교체된다(새로고침 후엔 user_msg만 남아 보존). 중단(stop)은
//   백엔드 이벤트가 없어 로컬 notice로만 표시.
export type LocalEvent =
  | {
      seq: number
      ts: number
      kind: 'local_user'
      text: string
      images?: ImageAttachment[]
      documents?: DocAttachment[]
      clientMessageId?: string
      /** 넘기기로 이어 받은 첫 말을 보내는 순간. 접힌 카드가 펼친 글로 잠깐 보이지 않게 미리 싣는다. */
      handoffFrom?: string
    }
  | { seq: number; ts: number; kind: 'local_notice'; variant: 'stop' | 'model' | 'effort' | 'permission'; detail?: string }
export type ConvoItem = AetherEvent | LocalEvent

/** 모델 목록 취득 결과. 화면이 상태마다 다른 것을 보여줘야 해서 실패를 한 덩어리로 뭉치지 않는다. */
export type ModelsStatus = 'loading' | 'ok' | 'asleep' | 'failed'

export type State = {
  /** 방 목록. 새 화면 정본. */
  rooms: WorkspaceRoom[]
  /** 옛 호환·실행 메타. id=sourceSessionId. 방 목록으로 쓰지 않는다. */
  sessions: SessionListItem[]
  locale: Locale // UI/알림 언어 — 기본 'ko', 설정에서 'en' 전환(localStorage 영속)
  transcriptView: TranscriptView // 대화 화면이 진행 보고를 얼마나 남기는지. 기기 단위.
  /** 방 id. 첫 칸(왼쪽 위). */
  activeId: string | null
  /** 첫 칸 다음 칸들(방 id, 최대 3). 창이 좁아 안 보여도 기억하고, 통로만 닫는다. */
  sideIds: string[]
  /** 마지막에 입력·클릭한 칸(방 id). Esc 중단이 이 실행을 본다. */
  focusedId: string | null
  /** 임시로 크게 보는 칸(방 id). 저장하지 않는다 — 새로고침하면 풀린다. 포커스가 다른 칸으로 가면 풀린다. */
  zoomedId: string | null
  /** 칸을 열고 옮긴 일을 낭독기(aria-live)에 알리는 글. seq가 바뀌면 같은 글도 다시 읽는다. */
  paneNote: { text: string; seq: number } | null
  /** 세션 목록을 56px 띠로 접었는가(넓은 화면만 뜻이 있다). 기기 단위로 저장. */
  sidebarCollapsed: boolean
  /** 상단 손길 알림 목록이 열렸는가. 접힌 목록 띠의 「+N」이 같은 목록을 연다. */
  handListOpen: boolean
  /** 포커스 순서. 끝이 가장 최근. 꽉 찬 칸을 바꿀 때 가장 오래된 칸을 고른다. */
  focusOrder: string[]
  /** 대화 칸 영역(창 폭 − 목록 기둥)의 폭·높이. 칸 수 상한. */
  /** 칸별 모델 목록·승인 정책 캐시가 바뀔 때 오른다. 포커스 밖 칸의 칩을 다시 그리는 신호다. */
  facetsRev: number
  paneW: number
  paneH: number
  convos: Record<string, ConvoItem[]>
  lastSeq: Record<string, number>
  pendingSend: Record<string, boolean>
  loadingConvo: Record<string, boolean> // 세션 첫 진입 시 초기 replay(백로그) 로딩 중 여부 — caught_up까지 true(그동안 Stream은 스피너만, 무거운 빌드 스킵).
  older: Record<string, { oldestSeq: number; hasOlder: boolean; loading: boolean }> // 무한스크롤 페이징 — 초기 replay가 꼬리만 온 세션의 미로드 과거 구간 상태(backlog_info로 세팅)
  slashCommands: Record<string, string[]> // 세션 이벤트에서 관측한 명령 이름. REST 카탈로그 갱신 신호·잠든 세션 replay 보조용.
  slashRich: Record<string, SlashCommandInfo[]> // provider adapter가 돌려준 실행 가능 명령 카탈로그. 슬래시 메뉴의 정본.
  queued: Record<string, QueuedItem[]> // 턴 진행 중 입력한 후속 메시지(클라 큐). idle 전환 시 순차 자동 전송.
  answers: Record<string, string[][]> // 제출한 질문 답. 영속은 question_resolved.answers. 이 맵은 SSE보다 먼저 그릴 때 쓴다.
  conn: ConnState
  booting: boolean // 초기 부팅(세션목록 로드 + 첫 세션 활성) 진행 중 — 채팅영역 로드마스크 게이트. init 끝에 false.
  reconnectMask: boolean // 재연결(비연결)이 RECONNECT_MASK_DELAY 이상 지속 — 채팅영역 로드마스크(짧은 blip 제외). setConn이 켜고, 연결되거나 첫 칸이 없어지면 내린다.
  contractMismatch: boolean // 서버가 보낸 계약 버전이 이 빌드와 다름 — 새로고침 전까지 유지하는 안내 상태.
  vapidPublic: string // 서버 VAPID public 키(빈 문자열 = 푸시 미지원/미설정)
  pushEnabled: boolean // 이 기기가 현재 푸시 구독 중인지
  settingsOpen: boolean
  shortcutsOpen: boolean // 단축키 도움말 오버레이(? 키) 열림 여부
  loadingSessions: boolean
  error: string | null
  /** 오류가 들어온 횟수. 글이 같아도 새로 들어온 것을 알림이 알아보게 한다(shell/Toasts.tsx). */
  errorSeq: number
  notice: Notice | null
  /** 일반 알림이 들어온 횟수. errorSeq와 같은 쓰임이다. */
  noticeSeq: number
  drawerOpen: boolean
  modalOpen: boolean
  modalCwd: string | null // 새 작업 창을 열 때 미리 고를 폴더. null이면 루트부터 고른다.
  deleteTarget: SessionListItem | null // 삭제/초기화 확인 다이얼로그 대상(null = 닫힘)
  deleteMode: 'delete' | 'reset' | 'discard' // deleteTarget이 null이 아닐 때만 의미 있음
  handoffSheet: { sessionId: string; mode: 'form' | 'waiting' | 'result' } | null // 다음 작업으로 넘기기 창(null = 닫힘). sessionId는 실행 id.
  dialog: DialogState | null // 범용 확인 다이얼로그(null = 닫힘)
  /**
   * 우클릭 메뉴(null = 닫힘). 한 벌만 shell/ContextMenu.tsx가 그린다. 위젯은 items(메뉴 항목 요소)만 넘긴다.
   * anchor = 우클릭한 위젯. 열려 있는 동안 강조하고, 메뉴 키로 열렸을 때는 이 위치에 띄운다.
   * 전역 Esc가 이 메뉴 위에서 다른 일(세션 중단)을 하지 않도록 shell/useGlobalShortcuts.ts의 overlayOpen에도 든다.
   */
  contextMenu: { x: number; y: number; items: ReactNode; anchor?: HTMLElement; byKeyboard?: boolean } | null
  /** 세션 이름 바꾸기 창(null = 닫힘). id = 실행 id(방 id가 아니다), name = 지금 이름. */
  renameTarget: { id: string; name: string } | null
  /** 앱 안 업데이트 진행 화면(null = 닫힘). 앱 전체를 덮는다. */
  updateProgress: { fromVersion: string; targetVersion?: string; pageUrl?: string } | null
  isNarrow: boolean
  /** 폭 1100 이상. 이때만 칸을 둘 이상 그린다. isNarrow(759)와 별개다. */
  isWide: boolean
  /** 전역 주의 통로가 스냅샷을 한 번이라도 줬는가. 없으면 손길 칩을 그리지 않는다. */
  presenceLive: boolean
  coarsePointer: boolean // 입력수단이 터치(hover 없음)인가 — 넓이(isNarrow)와 분리. 태블릿(아이패드=넓음+터치) 대응.
  scrollBottom: { id: string; nonce: number } | null // 사용자 전송(send/enqueue) 시 그 칸만 최하단으로. 다른 칸은 안 끌어내린다.
  // ── Agent Brain(7e) ──
  brainOpen: boolean
  brainTab: BrainTab
  brainOpenNonce: number // 닫힘 애니메이션 중 재오픈해도 새 Draw를 구분하는 세대
  kSearchNonce: number // 실제 debounce를 통과한 검색 요청 세대 — Recall 180ms 지연 식별
  kSearch: {
    query: string
    sort: 'relevance' | 'recent' | 'oldest'
    results: SearchHit[]
    status: 'idle' | 'loading' | 'empty' | 'ok'
    fromTs?: string
    toTs?: string
  }
  jumpToSeq: { id: string; seq: number; nonce: number } | null // 검색 결과 → 세션 점프(Stream이 best-effort 스크롤)
  findOpen: boolean // 세션 내 찾기 바(Ctrl+K) 열림 여부
  /**
   * Esc를 한 번 눌러 "다음 Esc면 중단" 상태로 들어갔는가.
   *
   * 켜지면 멈춤 버튼이 네모 아이콘 대신 "ESC" 글자를 보여준다 — 지금 Esc를 한 번 더 누르면 무슨 일이
   * 일어나는지 화면이 먼저 말해 주는 것이다. 잠깐 기다리면 저절로 꺼진다(INTERRUPT_ARM_MS).
   * 이렇게 두 번으로 나눈 이유: Esc는 습관적으로 누르는 키라, 한 번에 중단되면 긴 작업이 실수로 날아간다.
   */
  interruptArmed: boolean
  composerFill: { id: string; text: string; nonce: number; images?: ImageAttachment[]; documents?: DocAttachment[]; clientMessageId?: string } | null // 재전송·편집·전송실패 복원. id=대상 세션(오염 방지).
  // 활성 세션이 실제로 고를 수 있는 모델 목록(GET /api/sessions/:id/models). 예비 목록은 없다 — 못 받으면 빈 손이다.
  availableModels: ModelInfo[] | null
  // 그 목록을 받아오는 중에 무슨 일이 있었는지. 화면이 세 가지 다른 안내를 해야 해서 실패를 한 덩어리로 뭉치지 않는다.
  //   loading = 요청 중(재시도 대기 포함) · ok = 받았다 · asleep = 세션이 잠들어 있다(404, 정상) · failed = 재시도까지 다 실패
  modelsStatus: ModelsStatus
  // 활성 세션에 실제 적용 중인 승인 정책 요약(8d-3 ⑥ⓕ). null = 아직 못 받음(잠든 세션·조회 실패) → 배지 없음.
  //   잠들어 있는 동안엔 도구가 실행될 일이 없으므로, 배지가 없는 것이 곧 "지금은 아무것도 안 돈다"와 일치한다.
  permissionPolicy: PermissionPolicy | null
  // 활성 세션이 지금 고를 수 있는 권한 모드(그 세션의 provider가 알려 준 목록). null = 아직 못 받음 → 현재 모드만 보인다.
  permissionModes: PermissionMode[] | null
  // 서버가 알려준 provider 목록(id·표시 이름·재인증 지원 여부). 부팅 시 1회 취득. null = 아직 못 받음.
  providers: ProviderList | null
  // 서버가 원격 재로그인을 허용하는가(킬스위치). false면 설정에서 재인증 항목을 아예 안 그린다.
  reloginEnabled: boolean
  // provider 원격 재인증(중계) 모달 상태. provider = 지금 재인증 중인 대상(8d-3 ④에서 Claude 고정 해제).
  providerAuth: {
    provider: string
    open: boolean
    // awaiting_code = 우리가 코드를 받아야 함(Claude) / awaiting_device = 사용자가 저쪽 화면에서 끝내는 중(Codex)
    phase: 'idle' | 'starting' | 'awaiting_code' | 'awaiting_device' | 'submitting' | 'success' | 'error'
    loginId: string | null
    url: string | null
    // 기기 코드 방식에서 서버가 함께 준 코드. 사용자가 저 주소 화면에 이 코드를 입력하면 끝난다(8f).
    userCode: string | null
    message: string | null // invalid_code 재시도 안내 / 에러 메시지
  }
}

let state: State = {
  locale: loadLocale(),
  transcriptView: loadTranscriptView(),
  rooms: [],
  sessions: [],
  activeId: null,
  sideIds: [],
  focusedId: null,
  zoomedId: null,
  paneNote: null,
  sidebarCollapsed: loadSidebarCollapsed(),
  handListOpen: false,
  focusOrder: [],
  ...initialPaneBox(),
  convos: {},
  lastSeq: {},
  pendingSend: {},
  loadingConvo: {},
  older: {},
  slashCommands: {},
  slashRich: {},
  queued: {},
  answers: {},
  conn: 'connecting',
  booting: true,
  reconnectMask: false,
  contractMismatch: false,
  vapidPublic: '',
  pushEnabled: false,
  settingsOpen: false,
  shortcutsOpen: false,
  loadingSessions: true,
  error: null,
  errorSeq: 0,
  notice: null,
  noticeSeq: 0,
  drawerOpen: false,
  modalOpen: false,
  modalCwd: null,
  deleteTarget: null,
  handoffSheet: null,
  deleteMode: 'delete',
  dialog: null,
  contextMenu: null,
  renameTarget: null,
  updateProgress: null,
  isNarrow: typeof window !== 'undefined' ? window.innerWidth < 760 : false,
  isWide: typeof window !== 'undefined' ? window.innerWidth >= 1100 : false,
  presenceLive: false,
  coarsePointer: typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse)').matches : false,
  scrollBottom: null,
  brainOpen: false,
  brainTab: 'hub',
  brainOpenNonce: 0,
  kSearchNonce: 0,
  kSearch: { query: '', sort: 'relevance', results: [], status: 'idle', fromTs: '', toTs: '' },
  jumpToSeq: null,
  findOpen: false,
  interruptArmed: false,
  composerFill: null,
  availableModels: null,
  modelsStatus: 'loading',
  permissionPolicy: null,
  permissionModes: null,
  facetsRev: 0,
  providers: null,
  reloginEnabled: true,
  providerAuth: { provider: '', open: false, phase: 'idle', loginId: null, url: null, userCode: null, message: null },
}

const listeners = new Set<() => void>()
const seen: Record<string, Set<number>> = {} // 비반응형 dedup(real seq)
let localSeq = -1 // 로컬 이벤트용 음수 seq(실제 seq와 충돌 방지)
let stream: StreamHandle | null = null
/** 옆 칸 SSE. 키는 방 id. 첫 칸 통로(stream)와 섞지 않는다. */
const sideStreams = new Map<string, StreamHandle>()
let controlStream: StreamHandle | null = null
let presence: StreamHandle | null = null
let desktopNotify: SseHandle | null = null
const everCaughtUp = new Set<string>() // 세션별 초기 replay 완료 여부 — 재진입 시 로딩 스킵(convos가 이미 메모리에 있음)
const loadingTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const CAUGHT_UP_FALLBACK_MS = 20000 // caught_up 신호 누락(구버전 백엔드 등) 시 무한 스피너 방지용 강제 해제(순수 방어). 긴 세션의 정상 복원이 6초를 넘길 수 있어 20초로 둔다 — 일찍 풀면 복원 과정이 화면에 그대로 보인다
const RECONNECT_MASK_DELAY = 500 // 비연결이 이 시간 이상 지속돼야 재연결 마스크 노출(짧은 네트워크 blip엔 안 뜸)
let reconnectMaskTimer: ReturnType<typeof setTimeout> | null = null
// 모델 목록 조회 실패 시 쉬었다 다시 묻는 간격(ms). 목록 취득 자체가 1초 가까이 걸리는 것이 실측이라
//   첫 실패로 단정하지 않는다. 마지막 시도까지 실패해야 '실패'로 본다.
const MODEL_RETRY_DELAYS = [500, 1500, 4000]
const modelFetchTokens = new Map<string, number>() // 세션을 빠르게 옮길 때 늦게 도착한 이전 요청이 새 세션 상태를 덮지 않도록 하는 표
const WAKE_RETRY_DELAY = 800 // 세션 깨우기가 실패하면 이만큼 쉬었다 딱 한 번 더 시도한다
let wakingId: string | null = null // 깨우기가 이미 도는 세션 — 보내기와 모델·명령 변경이 겹칠 때 중복 호출을 막는다
let wakingTask: Promise<void> | null = null // 위 깨우기가 끝나는 약속 — 겹친 호출이 끝까지 기다리게 한다
// Esc를 한 번 누른 뒤 "다음 Esc면 중단"이 유효한 시간. 짧으면 두 번째를 누르기 전에 꺼져서 답답하고,
//   길면 한참 전에 누른 Esc가 살아 있다가 엉뚱한 순간의 Esc와 합쳐져 작업을 날린다.
const INTERRUPT_ARM_MS = 2000
let armTimer: ReturnType<typeof setTimeout> | undefined
type BrainSearchRequest = {
  query: string
  sort: 'relevance' | 'recent' | 'oldest'
  fromTs?: string
  toTs?: string
}
const brainSearch = createSearchCoordinator<BrainSearchRequest>()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function emit() {
  for (const l of listeners) l()
}
function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  // 오류는 여러 곳에서 set({ error })로 바로 넣는다. 그래서 세는 일은 여기 한 곳에서 한다.
  if (patch.error) state.errorSeq++
  if ('queued' in patch) saveQueued() // 대기 큐는 클라 전용이라 새로고침 생존을 위해 sessionStorage 미러(탭 한정).
  if ('activeId' in patch || 'sideIds' in patch || 'focusedId' in patch) {
    savePanes()
    // 확대 칸이 아닌 곳으로 포커스가 가거나 칸이 사라지면 확대를 푼다(모든 경로가 이 한 곳을 지난다).
    if (state.zoomedId) state.zoomedId = zoomAfterChange(state.zoomedId, paneIds(state.activeId, state.sideIds), state.focusedId)
  }
  emit()
}
const QUEUED_KEY = 'aether.queued'
function savePanes() {
  try {
    const ids = paneIds(state.activeId, state.sideIds)
    localStorage.setItem(PANES_KEY, serializePanes({
      ids,
      focusedId: state.focusedId && ids.includes(state.focusedId) ? state.focusedId : (ids[0] ?? null),
    }))
    paneWriteFailure.reset()
  } catch (error) {
    paneWriteFailure.report(error)
    /* localStorage 불가 — 이 탭 한정 */
  }
}
function loadPanes() {
  try {
    const panes = parsePanes(localStorage.getItem(PANES_KEY))
    paneReadFailure.reset()
    return panes
  } catch (error) {
    paneReadFailure.report(error)
    return { ids: [] as string[], focusedId: null }
  }
}

const modelCache = new Map<string, { models: ModelInfo[] | null; status: ModelsStatus }>()
const policyCache = new Map<string, PermissionPolicy | null>()
const permissionModesCache = new Map<string, PermissionMode[]>()

/** 캐시를 고치고 포커스 밖 칸의 칩도 다시 그리게 한다. */
function cacheModels(id: string, entry: { models: ModelInfo[] | null; status: ModelsStatus }) {
  modelCache.set(id, entry)
  set({ facetsRev: state.facetsRev + 1 })
}
function cachePolicy(id: string, policy: PermissionPolicy | null) {
  policyCache.set(id, policy)
  set({ facetsRev: state.facetsRev + 1 })
}

function applyChromeFacets(id: string | null) {
  if (!id) {
    set({ availableModels: null, modelsStatus: 'loading', permissionPolicy: null, permissionModes: null })
    return
  }
  const m = modelCache.get(id)
  const hasP = policyCache.has(id)
  set({
    availableModels: m?.models ?? null,
    modelsStatus: m?.status ?? 'loading',
    permissionPolicy: hasP ? (policyCache.get(id) ?? null) : null,
    permissionModes: permissionModesCache.get(id) ?? null,
  })
  if (!permissionModesCache.has(id)) void actions.fetchPermissionModes(id)
  if (!m) void actions.fetchModels(id)
  else if (m.status === 'failed') void actions.fetchModels(id, { quiet: true })
  if (!hasP) void actions.fetchPermissionPolicy(id)
}

/** 저장된 대기열 중 아직 있는 방 id 또는 실행 id만 남긴다. 이미지·문서 항목은 저장 단계에서 이미 빠진다. */
export function restoreQueuedSnapshot<T>(
  saved: Record<string, T[] | undefined>,
  roomIds: readonly string[],
  execIds: readonly string[],
): Record<string, T[]> {
  const allow = new Set<string>([...roomIds, ...execIds.filter((id) => id.length > 0)])
  const restored: Record<string, T[]> = {}
  for (const [sid, items] of Object.entries(saved)) {
    if (allow.has(sid) && Array.isArray(items) && items.length) restored[sid] = items
  }
  return restored
}

/** 되돌린 뒤에 서버가 붙인 조용한 완료를 목록에 넣는다. 이미 있으면 그대로 둔다. */
export function withRewindIdle(items: ConvoItem[], idleSeq: number | undefined, ts = Date.now()): ConvoItem[] {
  if (!idleSeq || items.some((item) => item.seq === idleSeq)) return items
  return [...items, { seq: idleSeq, ts, kind: 'status', status: 'completed' }]
}

function saveQueued() {
  try {
    // 이미지 첨부 대기항목은 sessionStorage 미러에서 통째로 제외 — base64 용량 초과 방지 +
    //   ★ 텍스트만 남겨 복원하면 새로고침 후 '이미지 빠진 텍스트'가 몰래 전송되는 오해 유발 → 아예 제외(이미지 대기항목은 휘발).
    const lean: Record<string, QueuedItem[]> = {}
    for (const [id, q] of Object.entries(state.queued)) {
      const keep = q.filter((it) => !it.images?.length && !it.documents?.length)
      if (keep.length) lean[id] = keep.map(({ qid, text, brief }) => ({ qid, text, ...(brief === true ? { brief: true } : {}) }))
    }
    sessionStorage.setItem(QUEUED_KEY, JSON.stringify(lean))
    queueWriteFailure.reset()
  } catch (error) {
    queueWriteFailure.report(error)
    /* sessionStorage 불가 환경 — 미러 생략(휘발) */
  }
}
export function getState() {
  return state
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function useStore(): State {
  return useSyncExternalStore(subscribe, getState, getState)
}
// 세션 하나의 보관 여부만 구독한다 — 말풍선처럼 자주 그려지는 곳이 전체 상태 변화에 다시 그려지지 않게 한다.
export function useSessionArchived(id: string): boolean {
  return useSyncExternalStore(subscribe, () => !!getState().sessions.find((x) => x.id === id)?.archivedAt)
}
// i18n 엔진 전용 구독 — 매 set()에 통지되지만 useSyncExternalStore가 locale 스냅샷 변화 시에만 리렌더(효율).
export function subscribeLocale(l: () => void) {
  return subscribe(l)
}

// ── 파생(셀렉터) ──
// 대화가 '진행 중 턴'으로 끝나는지 — 꼬리에서 거꾸로 읽어 가장 가까운 턴 신호로 정한다.
//   왜: running/idle이 클라 로컬 pendingSend에만 의존하면, 앱 리로드(창 최소화로 인한 탭 폐기·PWA 축출·
//   새로고침)로 pendingSend가 소실될 때 서버 턴이 살아있어도 idle로 오인된다. 리로드 후엔 대화 꼬리로 복원한다.
//   ★ 턴 시작 사건도 여는 신호다: 뒤 작업이 끝나거나 예약 시각이 되면 provider가 사용자 입력 없이 턴을 연다.
//   ★ 턴 신호가 아닌 잡음(모델 변경 시 SDK가 주입하는 type:'user' local-command-stdout·설정 notice·ctx)은 건너뛴다.
function convoEndsInOpenTurn(items: ConvoItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]
    if (e.kind === 'status') return false // completed/crashed/interrupted(서버 재시작 합성 포함)
    if (e.kind === 'local_notice' && e.variant === 'stop') return false // 사용자 Stop
    if (e.kind !== 'local_user' && e.kind !== 'local_notice' && turnCompletedOf(e)) return false
    if (opensWorkTurn(e)) return true
    if (e.kind !== 'local_user' && e.kind !== 'local_notice' && agentEventsOf(e)?.some((ae) => ae.type === 'turn_started')) return true
  }
  return false // 턴 신호 없음(신규 세션·resume 안내만) → 열린 턴 아님
}
/** 카드가 이미 닫혔으면 404는 중복 제출이다. 아직 열려 있으면 실패를 숨기지 않는다. */
export function ignoreStaleCardResolve(status: number | undefined, alreadyResolved: boolean): boolean {
  return status === 404 && alreadyResolved
}

export function deriveTurn(items: ConvoItem[] | undefined, pendingSend: boolean): TurnState {
  if (!items) return pendingSend ? 'running' : 'idle'
  const resolvedP = new Set<string>()
  const resolvedQ = new Set<string>()
  const resolvedPlan = new Set<string>()
  const blockingOperations = new Set<string>()
  for (const e of items) {
    if (e.kind === 'permission_resolved') resolvedP.add(e.id)
    else if (e.kind === 'question_resolved') resolvedQ.add(e.id)
    else if (e.kind === 'plan_resolved') resolvedPlan.add(e.id)
    else if (e.kind === 'command_operation') {
      if (e.state === 'started' && e.blocksInput) blockingOperations.add(e.operationId)
      else blockingOperations.delete(e.operationId)
    }
  }
  for (const e of items) {
    if (e.kind === 'permission_request' && !resolvedP.has(e.req.id)) return 'requires_action'
    if (e.kind === 'question_request' && !resolvedQ.has(e.req.id)) return 'requires_action'
    if (e.kind === 'plan_request' && !resolvedPlan.has(e.req.id)) return 'requires_action'
  }
  // 브리프 질문지는 턴이 끝난 뒤에 열려서 사람의 답을 기다린다. 턴 끝 사건이 오기 전의 짧은 틈과, 막 답을 보낸 직후는 제외한다.
  if (!pendingSend && !convoEndsInOpenTurn(items) && pendingQuestionnaire(items)) return 'requires_action'
  // operation은 모델 턴이 아니다. 입력만 잠그고, 모델용 구슬·Stop·전송 큐에는 섞지 않는다.
  if (blockingOperations.size) return 'operation'
  // pendingSend 우선(앱 열린 채 전송 직후 즉시 running). 소실 시(리로드) 대화 꼬리로 폴백 복원.
  return pendingSend || convoEndsInOpenTurn(items) ? 'running' : 'idle'
}
/** 실행 id로 그 방의 대기 큐를 본다. 큐는 방 id 기준으로 쌓이고, 대화 화면은 실행 id로 그려진다. */
export function queuedFor(s: State, execId: string): QueuedItem[] {
  return s.queued[roomIdForExecution(s.rooms, execId)] ?? s.queued[execId] ?? []
}
export function sessionTurn(s: State, id: string | null): TurnState {
  if (!id) return 'idle'
  return deriveTurn(s.convos[id], !!s.pendingSend[id])
}
/**
 * 입력창이 보는 턴. 열린 질문지만 기다리는 중이면 모델은 쉬고 있으므로 비어 있는 것으로 본다 —
 * 그때 친 글은 대기열이 아니라 바로 나가고, 그 글이 질문지를 닫는다. (권한·질문·계획 카드는 지금처럼 기다림이다.)
 */
export function composerTurn(s: State, id: string | null): TurnState {
  const turn = sessionTurn(s, id)
  if (turn !== 'requires_action' || !id) return turn
  const items = s.convos[id]
  return pendingQuestionnaire(items) && !pendingPermission(items) && !pendingQuestion(items) && !pendingPlan(items) ? 'idle' : turn
}
export function activeTurn(s: State): TurnState {
  return sessionTurn(s, s.activeId)
}
/** Esc·입력 대상 칸의 턴. 옆 칸에 포커스가 있으면 그쪽을 본다. */
export function focusedTurn(s: State): TurnState {
  return sessionTurn(s, chromeSessionId(s))
}
/** 지금 클릭한(포커스) 세션. 안 보이면 첫 칸. 상단 칩·제목이 이 id를 본다. */
export function chromeRoomId(s: State): string | null {
  return focusedSessionId(s.focusedId, s.activeId, s.sideIds, visibleCapacity(s.isWide, s.paneW, s.paneH))
}
/** 실행 REST·convos 키. 방 id가 아니라 sourceSessionId. */
export function chromeSessionId(s: State): string | null {
  const roomId = chromeRoomId(s)
  if (!roomId) return null
  const room = findRoom(s.rooms, roomId)
  if (room) {
    return roomExecutionId(room) ?? null
  }
  // 단위 시험·옛 상태: rooms 없이 activeId가 실행 id인 경우
  return roomId
}
function chromeId(): string | null {
  return chromeSessionId(state)
}
/** 칸이 둘 이상 보이는가. 이때는 상단 도구 대신 각 칸이 자기 정보를 갖는다. */
export function isSplit(s: State): boolean {
  return visibleSessionIds(s.activeId, s.sideIds, visibleCapacity(s.isWide, s.paneW, s.paneH)).length >= 2
}

/**
 * 칸 하나의 눈으로 본 상태. 칩의 선택자(currentModel 등)는 포커스 칸을 보므로, 이 칸을 포커스 칸으로 놓고
 * 그 세션의 모델 목록·승인 정책을 끼워 넘기면 선택자를 고치지 않고 칸별 값을 얻는다.
 */
export function paneView(s: State, roomId: string): State {
  const view = { ...s, focusedId: roomId }
  const id = chromeSessionId(view)
  if (id === chromeSessionId(s)) return s
  const m = id ? modelCache.get(id) : undefined
  return {
    ...view,
    availableModels: m?.models ?? null,
    modelsStatus: m?.status ?? 'loading',
    permissionPolicy: id ? (policyCache.get(id) ?? null) : null,
    permissionModes: id ? (permissionModesCache.get(id) ?? null) : null,
  }
}

/** 현재 세션이 쓰고 있는 모델 이름 원문 — 모델 피커 활성표시·비교용. 미확정이면 빈 문자열. */
export function currentModelRaw(s: State): string {
  const id = chromeSessionId(s)
  let m: string | undefined
  if (id) {
    for (const e of s.convos[id] ?? []) {
      // 사용자가 방금 /model로 바꾼 것(아직 서버 이벤트가 안 온 상태) → 낙관적 로컬 알림.
      if (e.kind === 'local_notice') { if (e.variant === 'model') m = e.detail }
      else if (e.kind !== 'local_user') m = modelInfoOf(e) ?? m
    }
  }
  if (!m) m = s.sessions.find((x) => x.id === id)?.model || undefined
  return m ?? ''
}

/**
 * 칩에 보여줄 현재 모델 이름.
 *
 * 목록을 받아 놨으면 그 줄의 사람이 읽는 이름(`displayName`)을 쓴다. 목록이 없으면 세션이 흘려보낸 이름을
 * 그대로 보여준다 — 예전처럼 이름을 짧게 줄여 쓰지 않는다. 줄이려면 모델 이름의 생김새를 알아야 하는데,
 * 그 지식이야말로 프론트에서 없애려는 것이다. 모르면 아는 만큼만 정직하게 보여준다.
 */
export function currentModel(s: State): string {
  const info = currentModelInfo(s)
  if (info) return modelRowLabel(info, s.availableModels ?? [])
  return currentModelRaw(s) || '—'
}

/** 활성 세션이 초기 replay(백로그) 로딩 중인지 — 이 동안 convos 파생값(모델·effort·ctx%)은 중간값이라 표시하면 깜빡인다. */
export function convoLoading(s: State): boolean {
  const id = chromeSessionId(s)
  return !!id && !!s.loadingConvo[id]
}

/** 채팅영역 로드마스크 노출 여부 — 부팅(세션목록·첫 세션 활성 진행) 또는 재연결 지속(디바운스 후). 중간 렌더(NoActive 깜빡·재연결 요동)를 가린다. */
export function showLoadMask(s: State): boolean {
  return s.booting || s.reconnectMask
}

/**
 * 지금 고를 수 있는 모델 목록 = 활성 세션이 실제로 알려준 것뿐이다.
 *
 * 예전엔 이 목록이 비면 프론트에 적어 둔 예비 목록을 대신 보여줬다. 그 예비 목록은 손으로 적은 것이라
 * 실제 계정이 쓸 수 있는 모델과 조용히 어긋났고, 어긋나도 화면에는 멀쩡하게 보였다. 그래서 없앴다.
 * 못 받았으면 빈 배열이고, 화면은 그 사실을 사용자에게 그대로 말한다.
 */
export function modelList(s: State): ModelInfo[] {
  return s.availableModels ?? []
}
/** 현재 effort 라벨 — /effort 변경(로컬 알림)을 우선, 없으면 세션 메타(영속본). 미설정이면 빈 문자열(칩 미표시). */
/** 칩에 보여 줄 강도. provider가 알려 준 실제 값, 고른 값, 모델 목록의 기본값 순이다. 모르면 빈 문자열. */
export function effectiveEffort(s: State): string {
  const id = chromeSessionId(s)
  const observed = id ? s.sessions.find((x) => x.id === id)?.observedEffort : undefined
  return observed || currentEffort(s) || currentModelInfo(s)?.defaultEffort || ''
}

export function currentEffort(s: State): string {
  const id = chromeSessionId(s)
  if (!id) return ''
  let e: string | undefined
  for (const ev of s.convos[id] ?? []) {
    if (ev.kind === 'local_notice' && ev.variant === 'effort') e = ev.detail
  }
  if (!e) e = s.sessions.find((x) => x.id === id)?.effort || undefined
  return e ?? ''
}

/**
 * 이름 끝의 대괄호 표시를 뗀다 — `claude-opus-5[1m]` → `claude-opus-5`.
 *
 * 왜 필요한가: Claude가 같은 모델을 두 가지 철자로 말한다(실측 2026-07-30). 고를 수 있는 목록에서는
 * 정식 이름을 `claude-opus-5[1m]`이라고 하는데, 대화 도중 "지금 이 모델로 답하고 있다"고 알릴 때는
 * `claude-opus-5`라고 한다. 대괄호는 같은 모델의 변종(문맥 창 크기) 표시이고, 어느 쪽에 붙는지도 일정하지
 * 않다 — 같은 응답 안에서 Fable 줄은 반대로 *고르는 이름* 쪽에 `[1m]`이 붙어 있었다.
 *
 * 여기가 프론트가 모델 이름의 생김새에 대해 아는 유일한 지식이다. 이름을 만들거나 줄여서 보여주지는
 * 않는다 — 화면에 나가는 글자는 전부 SDK가 준 그대로다.
 */
const stripVariant = (name: string) => name.replace(/\[[^\]]*\]$/, '')

/**
 * 목록에서 지금 쓰고 있는 모델의 줄을 찾는다.
 *
 * `value`만 비교하면 못 찾는다. 목록의 줄은 별칭(`haiku`)인데 대화 스트림이 싣는 이름은 정식 id
 * (`claude-haiku-4-5-20251001`)라서다. 그래서 별칭과 정식 id를 둘 다 대조하고, 그래도 못 찾으면
 * 변종 표시를 뗀 이름끼리 한 번 더 맞춰 본다(대소문자 무시).
 */
export function currentModelInfo(s: State): ModelInfo | null {
  const cur = currentModelRaw(s).toLowerCase()
  if (!s.availableModels) return null
  // 모델을 한 번도 고르지 않은 세션(방금 만든 세션이 그렇다)은 계정 기본 모델로 돈다. 목록에서 그 표시가
  //   붙은 줄을 쓴다. 지어낸 값이 아니라 세션이 준 목록에 실제로 있는 줄이다.
  //   이게 없으면 새 세션은 모델 칩이 '—'가 되고, 강도 목록도 이 줄에서 나오므로 강도 칩이 통째로 사라진다.
  if (!cur) return s.availableModels.find((m) => m.isDefault) ?? null
  // 별칭이 정확히 맞는 줄을 먼저 찾는다 — 확실하기 때문이다.
  const byValue = s.availableModels.find((m) => m.value.toLowerCase() === cur)
  if (byValue) return byValue
  // 정식 id로 찾을 때는 여러 줄이 같은 값을 가리킬 수 있다. 계정 기본 모델 줄과 그 모델을 직접 고른 줄이
  //   같은 정식 id를 갖기 때문이다(실측: 계정 기본 줄과 'opus[1m]'이 둘 다 claude-opus-5[1m]).
  //   그럴 땐 구체적인 이름 쪽을 고른다. 지금 무엇이 도는지 알려주는 것이 "기본(권장)"보다 정확하고,
  //   계정 기본 줄을 골랐다면 사용자가 직접 고른 줄에 체크가 가야 자기 선택이 취소된 것으로 오해하지 않는다.
  const pick = (rows: ModelInfo[]) => rows.find((m) => !m.isDefault) ?? rows[0] ?? null
  const byResolved = pick(s.availableModels.filter((m) => m.resolvedModel?.toLowerCase() === cur))
  if (byResolved) return byResolved
  // 마지막 수단 — 변종 표시(`[1m]`)만 다른 같은 모델인지 본다. 여기까지 와야 잡히는 경우가 실제로 있다:
  //   목록은 `claude-opus-5[1m]`이라 하고 스트림은 `claude-opus-5`라고 한다(stripVariant 주석 참고).
  const bare = stripVariant(cur)
  const same = (name: string | undefined) => !!name && stripVariant(name.toLowerCase()) === bare
  return pick(s.availableModels.filter((m) => same(m.resolvedModel) || same(m.value)))
}
/**
 * 현재 모델이 지원하는 추론 강도 목록 — 모델 목록에 실려 오는 값이 유일한 출처다.
 * 모르면(목록 미취득·모델 미매칭) 빈 배열이고, 그러면 강도 칩은 아예 숨는다. 추측해서 보여주지 않는다.
 */
export function supportedEfforts(s: State): SessionEffort[] {
  const info = currentModelInfo(s)
  if (!info || info.supportsEffort === false) return []
  return [...(info.supportedEffortLevels ?? [])]
}
/**
 * 강도의 순서(낮음 → 높음) — 목록에 있는 모든 모델의 강도를 순서를 지키며 합친 것.
 *
 * 왜 합치나: 아래 clampEffort가 "지금 값과 가장 가까운 지원값"을 찾으려면 지금 값의 위치를 알아야 하는데,
 * 그 값이 지금 모델의 목록에는 없을 수 있다(그 단계를 지원하는 다른 모델에서 옮겨 온 경우). 다른 모델의
 * 목록까지 합쳐야 위치가 잡힌다. 합치는 재료는 전부 SDK가 준 것이라 프론트가 단계 이름을 아는 곳은 없다.
 */
export function effortOrder(s: State): string[] {
  const out: string[] = []
  for (const m of s.availableModels ?? []) {
    for (const e of m.supportedEffortLevels ?? []) if (!out.includes(e)) out.push(e)
  }
  return out
}
// effort를 모델 지원범위로 clamp. 지원값이면 그대로, 아니면 가장 가까운 지원값(동률 시 상위 단계). 지원목록이 비면 null(=미지원).
//   order = 위 effortOrder(낮음 → 높음). "가장 가까운 값"이 이 순서 위의 거리로 정의된다.
export function clampEffort(effort: string, supported: SessionEffort[], order: readonly string[]): SessionEffort | null {
  if (!supported.length) return null
  if (supported.includes(effort as SessionEffort)) return effort as SessionEffort
  const cur = order.indexOf(effort)
  if (cur < 0) return null
  let best: SessionEffort | null = null
  let bestDist = Infinity
  for (const sup of supported) {
    const d = Math.abs(order.indexOf(sup) - cur)
    if (d < bestDist || (d === bestDist && order.indexOf(sup) > order.indexOf(best as string))) {
      best = sup
      bestDist = d
    }
  }
  return best
}
// 모델 변경/모델목록 취득 후 정합 — 현재 effort가 새 모델 지원범위를 벗어나면 clamp(+SDK 재적용). SDK는 현재 effort를 못 알려주므로 Aether가 정합 유지.
//   미설정('기본')·effort 미지원 모델·미취득 폴백이면 건드리지 않음(저장값 유지 → 지원 모델 복귀 시 복원).
function reconcileEffortToModel(id = chromeId()) {
  if (!id) return
  const view = paneView(state, roomOf(id))
  if (chromeSessionId(view) !== id) return // 화면에서 빠진 세션 — paneView가 다른 칸을 보여 준다
  if (convoLoading(view)) return // replay 중엔 모델 파생값이 중간값 — caught_up 후 재실행(markCaughtUp)
  const eff = currentEffort(view)
  if (!eff) return
  const sup = supportedEfforts(view)
  if (!sup.length) return
  const clamped = clampEffort(eff, sup, effortOrder(view))
  // 잠든 세션은 열기만 해서는 깨우지 않는다. 보정은 깨어난 뒤 목록이 다시 올 때 한다.
  if (clamped && clamped !== eff && !isSessionAsleep(state.sessions, id)) void actions.setEffort(clamped, id)
}

/**
 * 이 세션이 잠들어 있나 — 서버가 준 목록의 상태 값만 보고 판정한다.
 * 'active'가 아니면(완료·중단·크래시) 프로세스가 없다는 뜻이라 깨울 수 있고, 'corrupted'는 깨울 수 없다.
 * 목록에 없는 id는 판정할 근거가 없으므로 false(깨우려 들지 않는다).
 */
export function isSessionAsleep(sessions: SessionListItem[], id: string): boolean {
  const s = sessions.find((x) => x.id === id)
  return !!s && s.status !== 'active' && s.status !== 'corrupted'
}

/**
 * 세션 하나를 열 때 함께 받아 오는 것 — 모델 목록, 슬래시 명령, 승인 정책, 권한 모드 목록.
 * 앞의 셋은 살아 있는 세션만 답하므로, 세션을 깨운 뒤에도 같은 묶음을 다시 받아야 한다.
 */
function loadSessionFacets(id: string) {
  void actions.fetchModels(id)
  void actions.fetchCommands(id)
  void actions.fetchPermissionPolicy(id)
  void actions.fetchPermissionModes(id)
}

// 깨우기가 실패하면 목록을 다시 받으므로, 세션마다 한 번만 시도해 되풀이를 막는다.
const wakeForListTried = new Set<string>()

/** 서버가 잠든 세션의 목록을 기억하지 못한다(재시작 직후, 처음 쓰는 provider). 이때만 열면서 깨워 칩을 채운다. */
function wakeForUnknownList(id: string) {
  const session = state.sessions.find((x) => x.id === id)
  if (!session || session.archivedAt || !isSessionAsleep(state.sessions, id) || !visibleExecIds().includes(id)) return
  if (wakeForListTried.has(id)) return
  wakeForListTried.add(id)
  void actions.wakeSession(id)
}

/** wakeSession의 본체. 깨우기가 끝나면(실패 포함) 진행 표시를 지운다. */
async function wakeSessionNow(id: string): Promise<void> {
  // id는 실행 id다. 보이는 칸 목록은 방 id라 그대로 비교하면 늘 "안 보임"으로 판정해 깨운 뒤 할 일을 건너뛴다.
  const visible = () => visibleExecIds().includes(id)
  try {
    for (let i = 0; ; i++) {
      try {
        await api.wakeSession(id)
        if (!visible()) return
        await actions.refreshSessions() // 사이드바 상태('잠듦' → '활성')도 같이 맞춘다
        if (!visible()) return
        loadSessionFacets(id) // 옆 칸의 칩도 이 값을 그린다. 안 받으면 칩이 '잠듦'에 머문다
        return
      } catch (e) {
        if (!visible()) return
        if (i >= 1) {
          set({ error: t('session.wake.failed', { detail: errMsg(e) }) })
          loadSessionFacets(id)
          return
        }
        await sleep(WAKE_RETRY_DELAY)
        if (!visible()) return
      }
    }
  } finally {
    if (wakingId === id) {
      wakingId = null
      wakingTask = null
    }
  }
}

/** 서버 목록이 잠들었다고 알려 준 세션이면 먼저 깨운다. 모델·강도·권한 변경과 명령 실행이 쓴다. */
async function ensureAwake(id: string): Promise<void> {
  if (isSessionAsleep(state.sessions, id)) await actions.wakeSession(id)
}

export function slashCommandsFor(s: State, id: string | null): string[] {
  return (id && s.slashCommands[id]) || []
}
export function slashRichFor(s: State, id: string | null): SlashCommandInfo[] {
  return (id && s.slashRich[id]) || []
}
/** 가장 최근 미해결 권한요청(인라인 카드 1개만 활성). */
export function pendingPermission(items: ConvoItem[] | undefined): PermissionRequest | null {
  if (!items) return null
  const resolved = new Set(items.filter((e) => e.kind === 'permission_resolved').map((e: { id: string }) => e.id))
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]
    if (e.kind === 'permission_request' && !resolved.has(e.req.id)) return e.req
  }
  return null
}
export function pendingQuestion(items: ConvoItem[] | undefined): QuestionRequest | null {
  if (!items) return null
  const resolved = new Set(items.filter((e) => e.kind === 'question_resolved').map((e: { id: string }) => e.id))
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]
    if (e.kind === 'question_request' && !resolved.has(e.req.id)) return e.req
  }
  return null
}
export function pendingPlan(items: ConvoItem[] | undefined): PlanRequest | null {
  if (!items) return null
  const resolved = new Set(items.filter((e) => e.kind === 'plan_resolved').map((e: { id: string }) => e.id))
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]
    if (e.kind === 'plan_request' && !resolved.has(e.req.id)) return e.req
  }
  return null
}
/** 아직 답하지 않은 질문·권한·계획 카드 중 가장 오래된 것의 seq. 없으면 null. */
export function oldestPendingCardSeq(items: ConvoItem[] | undefined): number | null {
  if (!items) return null
  const done = new Set<string>()
  for (const e of items) {
    if (e.kind === 'permission_resolved' || e.kind === 'question_resolved' || e.kind === 'plan_resolved') done.add((e as { id: string }).id)
  }
  for (const e of items) {
    if ((e.kind === 'permission_request' || e.kind === 'question_request' || e.kind === 'plan_request') && !done.has(e.req.id)) return e.seq
  }
  return null
}

// ── 이벤트 수신 ──
// replay/실시간 이벤트를 프레임 단위로 모아 1회 렌더(rAF coalescing). 세션 진입 시 밀린 채팅 수십~수백 건을
//   건당 setState로 그리면 O(n²) 리렌더로 메인스레드가 ~1초 멈추고, 진입 애니메이션(blur 5px→0)이 굳어
//   '특정 채팅이 블러로 멈춰 보이는' 증상이 났다. 각 SSE 메시지는 별개 매크로태스크라 microtask로는 안 묶여,
//   rAF로 한 프레임에 도착한 이벤트를 합쳐 렌더 횟수를 상한(배치 렌더)한다.
const pendingEvents: Record<string, AetherEvent[]> = {}
let flushScheduled = false
const flushAfterStop = new Set<string>()
const hiddenRanges: Record<string, { after: number; until: number }[]> = {}
const userCursor = new Map<string, number | null>()

function hiddenSeq(id: string, seq: number): boolean {
  if (seq < 0) return false
  return (hiddenRanges[id] ?? []).some((range) => seq > range.after && seq <= range.until)
}
function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16)
  raf(flushIngest)
}

function ingest(id: string, ev: AetherEvent) {
  const s = seen[id] ?? (seen[id] = new Set())
  if (s.has(ev.seq)) return // dedup(replay 중복) — 버퍼 적재 전에 차단
  s.add(ev.seq)
  ;(pendingEvents[id] ?? (pendingEvents[id] = [])).push(ev)
  scheduleFlush()
}

function flushIngest() {
  flushScheduled = false
  const ids = Object.keys(pendingEvents)
  if (!ids.length) return
  const convos = { ...state.convos }
  const lastSeq = { ...state.lastSeq }
  const pendingSend = { ...state.pendingSend }
  const slashCommands = { ...state.slashCommands }
  const answers = { ...state.answers }
  let slashChanged = false
  let answersChanged = false
  const flushIds: string[] = []
  const explicitFlush = new Set<string>() // 지금 보내기로 시작한 flush — 열린 질문지가 있어도 막지 않는다
  const endedIds: string[] = [] // 턴이 끝난 세션(정상 종료·중단·크래시 모두) — 모델 목록 조용한 재시도 시점
  for (const id of ids) {
    const evs = pendingEvents[id]
    delete pendingEvents[id]
    const arr = (convos[id] ?? []).slice() // 1회 복사 후 mutate(배치 내 O(n))
    let maxSeq = lastSeq[id] ?? 0
    let released = false // result·status → running(pendingSend) 해제
    let turnDone = false // result만 → 큐 자동 flush(crashed·interrupted·completed는 flush 안 함)
    let stopFlush = false // 지금 보내기를 누른 탭만, 중단 뒤에 대기 하나를 보낸다
    for (const ev of evs) {
      if (hiddenSeq(id, ev.seq)) {
        if (ev.seq > maxSeq) maxSeq = ev.seq
        continue
      }
      // 임시 말풍선은 clientMessageId로 지운다. 그 값이 없는 옛 사건만 같은 글자의 가장 오래된 말을 지운다.
      if (ev.kind === 'user_msg') {
        const idx = optimisticUserIndex(arr, ev)
        if (idx >= 0) arr.splice(idx, 1)
      }
      arr.push(ev)
      if (ev.seq > maxSeq) maxSeq = ev.seq
      // 정상 턴 종료(sdk result)만 큐를 자동 발사. status(completed/crashed/interrupted)는 running만 해제하고
      //   큐는 보류 — replay로 들어온 interrupted나 크래시 직후 대기분이 사용자 동의 없이 자동 전송되는 것 방지.
      if (turnCompletedOf(ev)) { released = true; turnDone = true }
      // 압축 같은 명령 작업이 끝나면 그동안 쌓인 대기분을 보낸다. 실패는 크래시와 겹칠 수 있어 보내지 않는다.
      else if (ev.kind === 'command_operation' && ev.state === 'completed') turnDone = true
      else if (ev.kind === 'status') {
        released = true
        if (ev.status === 'interrupted' && flushAfterStop.has(id)) stopFlush = true
      }
      // 슬래시 명령 목록 갱신 — 마지막 관측이 유효(since=0 replay로 새로고침에도 복원).
      const names = commandsAvailableOf(ev)
      if (names) { slashCommands[id] = names; slashChanged = true }
      if (ev.kind === 'question_resolved' && ev.answers?.length) {
        answers[ev.id] = ev.answers
        answersChanged = true
      }
    }
    convos[id] = arr
    lastSeq[id] = maxSeq
    if (released) { pendingSend[id] = false; endedIds.push(id) }
    if (turnDone || stopFlush) {
      flushAfterStop.delete(id)
      flushIds.push(id)
      if (stopFlush) explicitFlush.add(id)
    }
  }
  set({
    convos,
    lastSeq,
    pendingSend,
    ...(slashChanged ? { slashCommands } : {}),
    ...(answersChanged ? { answers } : {}),
  })
  // 이벤트는 "목록이 바뀌었다"는 신호이고, 설명·별칭·실행 성격의 정본은 runtime interface다.
  if (slashChanged) {
    for (const vid of visibleExecIds()) {
      if (ids.includes(vid)) void actions.fetchCommands(vid)
    }
  }
  // 모델 목록을 끝내 못 받은 세션은 턴이 끝날 때마다 조용히 한 번 더 물어본다. 턴이 끝났다는 건 세션이
  //   분명히 살아 있다는 뜻이라, 여기가 다시 물어보기 가장 좋은 시점이다. 사용자가 눌러야만 회복되는 상태로
  //   두지 않기 위한 것이므로 화면에는 아무 표시도 하지 않는다.
  if (state.modelsStatus === 'failed') {
    const id = chromeId()
    if (id && endedIds.includes(id)) void actions.fetchModels(id, { quiet: true })
  }
  // 정상 턴 종료로 idle이 된 세션만 대기 큐 flush(각 메시지=각 턴 순차 자동 전송).
  for (const id of flushIds) flushQueue(id, explicitFlush.has(id))
}

/**
 * 대기열을 비우지 않고 붙들어 둘 때인가. 미해결 권한·질문·계획 카드가 있으면 붙든다.
 * 열린 질문지도 붙든다 — 단 사람이 「지금 보내기」로 명시한 전송(`explicit`)은 붙들지 않는다.
 */
export function queueFlushHeld(items: ConvoItem[] | undefined, explicit: boolean): boolean {
  return !!(pendingPermission(items) || pendingQuestion(items) || pendingPlan(items) || (!explicit && pendingQuestionnaire(items)))
}

/** 큐 flush — 해당 세션이 진짜 idle(턴 미진행 + 미해결 권한/질문 카드 없음)일 때만 큐의 다음 1건을 전송. 순차(각 메시지=각 턴). */
//   execId = 턴이 끝난 실행 id. 큐·보이는 칸은 방 id 기준이라 방 id로 바꿔 본다 — 섞으면 큐가 영영 안 나간다.
function flushQueue(execId: string, explicit = false) {
  const id = roomOf(execId)
  if (!sessionVisible(id)) return // 보이는 칸만(안 보이는 세션은 SSE 미구독 → 전환 복귀 시 replay로 자연 처리)
  if (state.pendingSend[execId]) return // 아직 턴 진행 중
  const items = state.convos[execId]
  if (queueFlushHeld(items, explicit)) return // requires_action(카드 대기) 중엔 보류
  if (deriveTurn(items, false) === 'operation') return // 명령 작업 중엔 서버가 입력을 거절한다. 끝난 사건이 오면 다시 부른다.
  const q = state.queued[id]
  if (!q || q.length === 0) return
  const next = q[0]
  set({ queued: { ...state.queued, [id]: q.slice(1) } }) // 낙관적 제거
  void actions.sendTo(id, next.text, next.images, next.documents, next.brief).then((ok) => {
    // 전송 실패 시 큐 앞으로 되돌림(유실 방지). 자동 재시도는 안 함(무한루프 방지) — 다음 정상 턴 종료 때 재flush.
    if (!ok) set({ queued: { ...state.queued, [id]: [next, ...(state.queued[id] ?? [])] } })
  })
}

// 전송 중이거나 대기열에 보낼 글이 남았으면 자동 새로고침으로 날리지 않는다(첨부는 reloadGuard가 따로 안다).
function reloadBusy(): boolean {
  return Object.values(state.pendingSend).some(Boolean) || Object.values(state.queued).some((q) => q.length > 0)
}

// 초기 replay 완료(caught_up) 처리 — 받은 백로그를 동기 드레인한 뒤 로딩 해제.
//   loadingConvo 해제 전에 convos를 채워, Stream이 caught_up 직후 '전체를 1회만' 렌더(O(n²) 멈춤 회피) 후 하단 점프하게 한다.
function markCaughtUp(id: string, info?: CaughtUpInfo) {
  // 한 번 확인된 불일치는 이 빌드가 바뀌기 전에는 해소될 수 없다. 재연결의 우연한 값으로 안내를 숨기지 않는다.
  if (!state.contractMismatch && applyContractReload(info?.contractVersion, AGENT_EVENT_CONTRACT_VERSION, reloadBusy())) set({ contractMismatch: true })
  const t = loadingTimers[id]
  if (t) { clearTimeout(t); delete loadingTimers[id] }
  everCaughtUp.add(id)
  if (!state.loadingConvo[id]) return // 이미 해제(재연결/중복 신호/안전타이머 선발) — no-op
  flushIngest() // 버퍼된 replay 이벤트를 즉시 convos에 반영(로딩 해제 전 보장)
  set({ loadingConvo: { ...state.loadingConvo, [id]: false } })
  reconcileEffortToModel(id) // 로딩 중 보류했던 effort 정합을 확정값 기준으로 1회 수행
}

const OLDER_PAGE = 300 // 위로 스크롤 페이징 1회 로드량(서버 초기 꼬리 상한과 동일 스케일)

// backlog_info(초기 replay 꼬리 절단 정보) 수신 — 무한스크롤 페이징 상태 세팅.
function setBacklogInfo(id: string, info: { oldestSeq: number; hasOlder: boolean }) {
  set({ older: { ...state.older, [id]: { oldestSeq: info.oldestSeq, hasOlder: info.hasOlder, loading: false } } })
}

// 이전 페이지 prepend — SSE ingest와 별도 경로(큐 flush·낙관 dedup·lastSeq 갱신 없음). 반환 = 실제로 추가됐는지.
//   삽입 위치: convos 머리의 '양수 seq이고 fresh보다 오래된' 구간(초기 꼬리에 동봉된 init extras) 뒤 —
//   음수 seq(local_*)나 최신 꼬리를 건드리지 않고 seq 순서를 보존한다.
function prependEvents(id: string, events: AetherEvent[], hasOlder: boolean, pageOldestSeq?: number) {
  const o = state.older[id]
  const sn = seen[id] ?? (seen[id] = new Set())
  const fresh = events.filter((ev) => !sn.has(ev.seq) && !hiddenSeq(id, ev.seq))
  // 다음 조회는 거르고 남은 첫 순번이 아니라, 서버가 읽은 페이지의 첫 순번이다.
  const oldestSeq = nextOlderBoundary(pageOldestSeq, fresh[0]?.seq, o?.oldestSeq ?? 0)
  const older = { ...state.older, [id]: { oldestSeq, hasOlder, loading: false } }
  if (!fresh.length) {
    set({ older })
    return false
  }
  for (const ev of fresh) sn.add(ev.seq)
  const arr = state.convos[id] ?? []
  set({
    convos: { ...state.convos, [id]: mergeOlderPageEvents(arr, fresh) },
    older,
  })
  return true
}

// 다음 턴이 새 값을 알릴 때까지 지난 턴의 강도를 보이지 않는다.
function forgetObservedEffort(id: string) {
  set({ sessions: state.sessions.map((x) => (x.id === id ? { ...x, observedEffort: undefined } : x)) })
}

function pushLocal(id: string, item: LocalEvent) {
  const arr = state.convos[id] ?? []
  set({ convos: { ...state.convos, [id]: [...arr, item] } })
}

/** 시험이 사건 수신을 ingest와 flushIngest로 태운다. */
export function __ingestForTest(id: string, ev: AetherEvent): void {
  ingest(id, ev)
  flushIngest()
}

/** 시험이 이전 페이지 경계를 세팅한다. */
export function __setOlderForTest(id: string, info: { oldestSeq: number; hasOlder: boolean }): void {
  setBacklogInfo(id, info)
}

function paneCapNow(): number {
  return visibleCapacity(state.isWide, state.paneW, state.paneH)
}
function visibleIds(): string[] {
  return visibleSessionIds(state.activeId, state.sideIds, paneCapNow())
}
/** 이 탭에서 시작한 넘기기의 실행 id. 저장하지 않는다(새로고침하면 잊고, 목록만 맞춘다). */
const myHandoffs = new Set<string>()

/** 실시간 갱신 앞뒤의 방을 견줘, 이 탭이 시작한 넘기기의 결과에 반응한다. */
function reactToHandoff(before: WorkspaceRoom[], after: WorkspaceRoom[]) {
  if (myHandoffs.size === 0) return
  for (const room of after) {
    const exec = roomExecutionId(room) ?? room.id
    if (!myHandoffs.has(exec)) continue
    const tr = handoffTransition(before.find((r) => r.id === room.id), room)
    if (!tr) continue
    if (tr !== 'waiting') myHandoffs.delete(exec) // 한도 대기는 끝난 것이 아니다. 풀린 뒤의 결과도 이어서 본다
    void onHandoffResult(tr, room, exec)
  }
}

async function onHandoffResult(tr: Exclude<HandoffTransition, null>, room: WorkspaceRoom, exec: string) {
  if (state.handoffSheet?.sessionId === exec && tr !== 'copy') set({ handoffSheet: null })
  if (tr === 'waiting') {
    actions.showNotice({ title: t('handoff.toast.waiting') })
    return
  }
  if (tr === 'stopped') {
    actions.showNotice({ title: t('handoff.toast.stopped') })
    return
  }
  if (tr === 'copy') {
    actions.openHandoffResult(exec)
    return
  }
  const nextExec = room.handoffTo
  if (!nextExec) return
  await actions.refreshSessions()
  const nextRoomId = roomOf(nextExec)
  if (!findRoom(state.rooms, nextRoomId)) return
  // 다른 기기에서도 초안이 보이도록 서버가 들고 있다. 이 탭은 칸을 바꾸기 전에 입력창 초안에 먼저 넣어 둔다.
  try {
    const info = await api.getHandoff(nextExec)
    if (info.incoming?.text) drafts.set(nextRoomId, encodeDraft(blocksFromMessage(info.incoming.text)))
  } catch (e) {
    reportClientError(e, { component: 'session', operation: 'web.handoff.draft', severity: 'warning' })
  }
  const shown = visibleIds()
  if (shown.includes(room.id)) {
    // 칸이 둘 이상이면 그 칸의 자리에, 하나뿐이면 그 세션을 고른다.
    if (shown.length > 1) actions.replacePaneSession(room.id, nextRoomId)
    else actions.selectSession(nextRoomId)
    actions.showNotice({ title: t('handoff.toast.swapped') })
  } else {
    // 사람이 이미 다른 곳을 보고 있다. 칸을 빼앗지 않고 열기만 권한다.
    actions.showNotice({ title: t('handoff.toast.ready'), action: { label: t('handoff.toast.open'), onClick: () => actions.selectSession(nextRoomId) } })
  }
}

/** 방 id → 실행 id. 서버 세션 REST·convos·pendingSend 키는 실행 id다. */
function execOf(id: string | null | undefined): string | null {
  return executionIdFor(state.rooms, id)
}
/** 실행 id → 방 id. 대기 큐·드래프트·보이는 칸 판정은 방 id 기준이다. */
function roomOf(execId: string): string {
  return roomIdForExecution(state.rooms, execId)
}
/** 보이는 칸들의 실행 id — 카드 소유 세션 찾기·명령 목록 갱신처럼 convos를 보는 일에 쓴다. */
function visibleExecIds(): string[] {
  return visibleIds().map(execOf).filter((x): x is string => !!x)
}
function sessionVisible(id: string): boolean {
  return visibleIds().includes(id)
}
function paneTargetId(explicit?: string): string | null {
  if (explicit && sessionVisible(explicit)) return explicit
  if (state.focusedId && sessionVisible(state.focusedId)) return state.focusedId
  return state.activeId
}

/** 목록에 없는 방은 칸 복원에서 버린다. */
function alivePaneIds(): Set<string> {
  return new Set(state.rooms.map((r) => r.id))
}

function closeSideStream(roomId: string) {
  const handle = sideStreams.get(roomId)
  if (!handle) return
  handle.close()
  sideStreams.delete(roomId)
}
function attachSideStream(roomId: string) {
  closeSideStream(roomId)
  // 맵 키는 방 id. SSE·convos는 실행 id(방 id로 붙으면 서버가 404).
  const id = execOf(roomId)
  if (!id) return
  prepareSideView(roomId)
  sideStreams.set(roomId, openStream(
    id,
    () => state.lastSeq[id] ?? 0,
    (ev) => ingest(id, ev),
    () => { /* 옆 칸 통로는 앱 전체 재연결 가림막을 켜지 않는다 */ },
    (info) => markCaughtUp(id, info),
    (info) => setBacklogInfo(id, info),
  ))
}
function syncSideStreams() {
  const want = new Set(visibleIds().filter((id) => id !== state.activeId))
  for (const id of [...sideStreams.keys()]) {
    if (!want.has(id)) closeSideStream(id)
  }
  for (const id of want) {
    if (!sideStreams.has(id)) attachSideStream(id)
  }
}
/** 새로 보이게 된 옆 칸의 명령 목록을 받고, 가려진 칸의 통로는 닫는다. 잠든 세션은 깨우지 않는다. */
function refreshSidePanes() {
  for (const id of visibleIds()) {
    if (id === state.activeId || sideStreams.has(id)) continue
    const exec = execOf(id)
    if (exec) void actions.fetchCommands(exec)
  }
  syncSideStreams()
}
function prepareSideView(roomId: string) {
  const id = execOf(roomId) // 로딩 표시·convos는 실행 id 기준(옆 칸 Stream이 실행 id로 그린다)
  if (!id) return
  const fresh = !everCaughtUp.has(id)
  if (fresh) {
    set({ loadingConvo: { ...state.loadingConvo, [id]: true } })
    if (loadingTimers[id]) clearTimeout(loadingTimers[id])
    loadingTimers[id] = setTimeout(() => markCaughtUp(id), CAUGHT_UP_FALLBACK_MS)
  }
  if (!state.convos[id]) set({ convos: { ...state.convos, [id]: [] } })
}
function ensurePrimaryStream() {
  const id = state.activeId
  if (!id || stream) return
  actions.setActive(id, { focus: false })
}
/** 첫 칸이 없어지면 재연결 타이머를 취소하고 가림막을 내린다. 다른 세션이면 그대로 둔다. */
function applyReconnectMaskDecision(nextActiveId: string | null) {
  const decided = decideReconnectMask(nextActiveId, state.reconnectMask)
  if (decided.cancelTimer && reconnectMaskTimer) {
    clearTimeout(reconnectMaskTimer)
    reconnectMaskTimer = null
  }
  if (decided.reconnectMask !== state.reconnectMask) set({ reconnectMask: decided.reconnectMask })
}

/** 새로고침된 목록에 없는 방을 칸에서 빼고, 그에 붙은 통로도 닫는다. */
function pruneOpenPanes() {
  const alive = alivePaneIds()
  const order = paneIds(state.activeId, state.sideIds).filter((id) => alive.has(id))
  const focused = state.focusedId && order.includes(state.focusedId) ? state.focusedId : (order[0] ?? null)
  const nextActive = order[0] ?? null
  if (
    nextActive === state.activeId &&
    order.slice(1).join('\0') === state.sideIds.join('\0') &&
    focused === state.focusedId
  ) {
    applyReconnectMaskDecision(nextActive)
    return
  }
  if (nextActive !== state.activeId) {
    stream?.close()
    stream = null
  }
  for (const id of [...sideStreams.keys()]) {
    if (!order.includes(id) || id === nextActive) closeSideStream(id)
  }
  set({
    activeId: nextActive,
    sideIds: order.slice(1),
    focusedId: focused,
    focusOrder: noteFocus(state.focusOrder, focused, order),
  })
  applyReconnectMaskDecision(nextActive)
}
/** 낭독기(aria-live)에 칸 소식을 알린다. */
function announcePane(text: string) {
  set({ paneNote: { text, seq: (state.paneNote?.seq ?? 0) + 1 } })
}
/** 칸 순서를 바꿔 반영한다. 순서가 그대로면 아무것도 하지 않는다. focusId에 포커스를 준다. */
function reorderPanes(prev: readonly string[], next: readonly string[], focusId: string, note: () => string) {
  if (next.length === 0 || next.join('\n') === prev.join('\n')) return
  commitPanes({ activeId: next[0], sideIds: next.slice(1), focusedId: focusId })
  announcePane(note())
}
/** 칸 상태를 반영하고 통로를 맞춘다. 첫 칸이 바뀌면 그 통로를 연다. */
function commitPanes(next: { activeId: string | null; sideIds: string[]; focusedId: string | null }) {
  const order = paneIds(next.activeId, next.sideIds)
  const focusedId = next.focusedId && order.includes(next.focusedId) ? next.focusedId : (order[0] ?? null)
  const snap = { activeId: order[0] ?? null, sideIds: order.slice(1), focusedId }
  const prevActive = state.activeId
  if (snap.activeId) closeSideStream(snap.activeId)
  const focusOrder = noteFocus(state.focusOrder, snap.focusedId, order)
  if (snap.activeId !== prevActive) {
    if (!snap.activeId) {
      stream?.close()
      stream = null
      set({ activeId: null, sideIds: [], focusedId: null, focusOrder, availableModels: null, permissionPolicy: null })
    } else {
      actions.setActive(snap.activeId, { focus: false })
      set({ sideIds: snap.sideIds, focusedId: snap.focusedId, focusOrder })
    }
  } else {
    set({ sideIds: snap.sideIds, focusedId: snap.focusedId, focusOrder })
  }
  ensurePrimaryStream()
  refreshSidePanes()
  applyChromeFacets(chromeId())
  applyReconnectMaskDecision(state.activeId)
}

// 사용자가 메시지를 전송할 때 그 칸의 Stream만 최하단으로 끌어내리는 신호(위로 스크롤해 읽던 중이어도).
//   큐 자동 flush(sendTo 직접 호출)는 신호를 올리지 않음 — 스크롤백 읽는 사용자를 강제로 끌어내리지 않기 위함.
function signalScrollBottom(roomOrExecId: string) {
  const id = execOf(roomOrExecId) ?? roomOrExecId // 대화 화면(Stream)은 실행 id로 이 신호를 비교한다
  const prev = state.scrollBottom
  set({ scrollBottom: { id, nonce: (prev?.id === id ? prev.nonce : 0) + 1 } })
}

// 서버에서 세션이 사라진 뒤(삭제/초기화 공통) 로컬 상태 정리 — 스트림 닫기 + 세션별 캐시 제거.
function dropLocalSessionState(id: string) {
  const roomId = state.rooms.find((r) => r.id === id || r.sourceSessionId === id)?.id ?? id
  if (state.activeId === roomId || state.activeId === id) {
    stream?.close()
    stream = null
  }
  closeSideStream(roomId)
  const convos = { ...state.convos }
  const lastSeq = { ...state.lastSeq }
  const pendingSend = { ...state.pendingSend }
  const queued = { ...state.queued }
  const loadingConvo = { ...state.loadingConvo }
  const slashCommands = { ...state.slashCommands }
  const slashRich = { ...state.slashRich }
  const older = { ...state.older }
  delete convos[id]
  delete lastSeq[id]
  delete pendingSend[id]
  delete queued[id]
  delete loadingConvo[id]
  delete slashCommands[id]
  delete slashRich[id]
  delete older[id]
  delete seen[id]
  everCaughtUp.delete(id)
  modelCache.delete(id)
  policyCache.delete(id)
  permissionModesCache.delete(id)
  if (loadingTimers[id]) { clearTimeout(loadingTimers[id]); delete loadingTimers[id] }
  const next = decideClosePane(roomId, state.activeId, state.sideIds, state.focusedId)
  set({
    convos,
    lastSeq,
    pendingSend,
    queued,
    loadingConvo,
    slashCommands,
    slashRich,
    older,
    activeId: next.activeId,
    sideIds: next.sideIds,
    focusedId: next.focusedId,
  })
  applyReconnectMaskDecision(next.activeId)
}

async function executeBrainSearch(request: BrainSearchRequest, token: number) {
  if (!brainSearch.isCurrent(token)) return
  const filters = {
    fromTs: request.fromTs || '',
    toTs: request.toTs || '',
  }
  set({
    kSearchNonce: token,
    kSearch: { query: request.query, sort: request.sort, results: [], status: 'loading', ...filters },
  })
  try {
    // Agent Brain(사람)의 검색은 채팅만 — 도구 호출·결과(actions)는 제외. AI 툴은 별도 경로라 풀검색 유지.
    const fromTsN = request.fromTs ? Number(request.fromTs) : undefined
    const toTsN = request.toTs ? Number(request.toTs) : undefined
    const url = searchRequestUrl({
      q: request.query.trim(),
      sort: request.sort,
      chatOnly: true,
      fromTs: typeof fromTsN === 'number' && Number.isFinite(fromTsN) ? fromTsN : undefined,
      toTs: typeof toTsN === 'number' && Number.isFinite(toTsN) ? toTsN : undefined,
    })
    const res = await fetch(url, { credentials: 'same-origin', headers: { ...authHeaders() } })
    if (!res.ok) {
      const error = new Error(`${res.status} ${res.statusText}`)
      reportApiResponseError(error, res)
      throw error
    }
    const body = (await res.json()) as { results: SearchHit[] }
    const results = body.results ?? []
    if (!brainSearch.isCurrent(token)) return
    set({ kSearch: { query: request.query, sort: request.sort, results, status: results.length ? 'ok' : 'empty', ...filters } })
  } catch (e) {
    if (!brainSearch.isCurrent(token)) return
    const failure = classifyTransportError(e)
    set({ kSearch: { query: request.query, sort: request.sort, results: [], status: 'empty', ...filters }, error: errMsg(failure) })
  }
}

async function loadVapid() {
  try {
    const v = await api.pushVapid()
    set({ vapidPublic: v.vapidPublic ?? '' })
  } catch (error) {
    // 푸시 설정 없이 계속한다. API 실패는 공통 호출기가 이미 처리했고 로컬 처리 결함만 남는다.
    reportClientError(error, { component: 'push', operation: 'web.push.vapid', severity: 'warning' })
    set({ vapidPublic: '' })
  }
}

function applyLocale(locale: Locale) {
  try {
    localStorage.setItem(LOCALE_KEY, locale)
    localeWriteFailure.reset()
  } catch (error) {
    localeWriteFailure.report(error)
  }
  applyDocLang(locale)
  set({ locale })
}

// ── 액션 ──
export const actions = {
  // 언어 전환 — store+localStorage+<html lang> 갱신, 서버에도 통지(LLM 프롬프트·푸시 알림 언어 정렬). 서버 통지는 best-effort.
  setLocale(locale: Locale) {
    if (locale === state.locale) return
    applyLocale(locale)
    void api.setLocale(locale).catch(() => { /* 서버 통지 실패는 UI 언어에 무해 */ })
  },
  setTranscriptView(view: TranscriptView) {
    const next = parseTranscriptView(view)
    if (next === state.transcriptView) return
    try {
      localStorage.setItem(VIEW_KEY, next)
      viewWriteFailure.reset()
    } catch (error) {
      viewWriteFailure.report(error)
    }
    set({ transcriptView: next })
  },
  cycleTranscriptView() {
    actions.setTranscriptView(nextTranscriptView(state.transcriptView))
  },
  // 서비스 목록 — 새 세션 창, 설정 화면의 재인증 항목, 세션의 서비스 표시 이름이 쓴다(모델 목록과 무관).
  // 부팅 때 한 번 받고, 새 세션 창이 목록이 비어 있음을 보면 다시 부른다. 실패해도 던지지 않고 성공 여부를 돌려준다.
  async loadProviders(): Promise<boolean> {
    try {
      const p = await api.listProviders()
      if (p.providers?.length) set({ providers: p.providers })
      set({ reloginEnabled: p.reloginEnabled !== false }) // 서버가 재로그인을 껐으면 설정에서 항목을 숨긴다
      return true
    } catch (error) {
      reportClientError(error, { component: 'init', operation: 'web.init.providers', severity: 'warning' })
      return false
    }
  },

  // 새 버전이 있으면 로그인 뒤 버전별로 한 번만 알린다(본 버전은 이 브라우저에 적어 둔다). 숨은 탭이면 보일 때까지 미룬다.
  async checkUpdateNotice() {
    const r = await runUpdateNotice({
      fetchStatus: () => api.systemUpdate(),
      getSeen: () => localStorage.getItem(UPDATE_SEEN_KEY),
      setSeen: (v) => localStorage.setItem(UPDATE_SEEN_KEY, v),
      isHidden: () => typeof document !== 'undefined' && document.hidden,
      show: (s, url) => actions.showNotice({
        title: t('update.toast.title', { version: s.latest! }),
        // 앱 안에서 설치할 수 있으면 설정을 열어 업데이트 버튼으로 안내하고, 아니면 다운로드 페이지를 연다.
        message: s.canInstall ? t('update.toast.messageInstall') : t('update.toast.message'),
        action: s.canInstall
          ? { label: t('update.row.install'), onClick: () => actions.openSettings() }
          : { label: t('update.row.download'), onClick: () => { window.open(url, '_blank', 'noopener,noreferrer') } },
      }),
    })
    if (r === 'deferred') {
      const onVisible = () => {
        if (document.hidden) return
        document.removeEventListener('visibilitychange', onVisible)
        void actions.checkUpdateNotice()
      }
      document.addEventListener('visibilitychange', onVisible)
    }
  },

  async init() {
    applyDocLang(state.locale) // 부팅 시 <html lang> 동기화(초기 localStorage 로케일).
    // 언어의 정본은 서버다. 다른 기기에서 고른 언어를 따르고, 부팅은 서버 언어를 덮지 않는다.
    void api.getLocale().then(({ locale }) => { if (locale !== state.locale) applyLocale(locale) }).catch(() => { /* 옛 서버·일시 실패는 저장된 화면 언어로 계속 */ })
    // 푸시 알림 딥링크(①): ?s=<id>로 진입하면 그 세션을 활성화. URL은 즉시 정리(새로고침 시 재고정 방지).
    let deepLinkId: string | null = null
    if (typeof window !== 'undefined') {
      try {
        const u = new URL(window.location.href)
        const sid = u.searchParams.get('s')
        if (sid) {
          deepLinkId = sid
          u.searchParams.delete('s')
          window.history.replaceState(null, '', u.pathname + u.search + u.hash)
        }
      } catch (error) {
        reportClientError(error, { component: 'navigation', operation: 'web.deeplink.url', severity: 'warning' })
        /* URL 파싱 실패 — 딥링크 없이 부팅 */
      }
      bindSwMessages() // 이미 열린 창에서 알림 클릭 시 SW→앱 메시지 수신 + 복귀 시 pending 소비(1회 바인딩)
      // ?s가 없으면 SW가 남긴 pending 딥링크 폴백 — 페이지 폐기 후 재생성 부팅(postMessage 유실 케이스)을 커버.
      if (!deepLinkId) deepLinkId = await consumePendingDeepLink()
    }
    await actions.loadProviders()
    // 업데이트 뒤 새로 고친 직후라면 완료 토스트를 한 번 띄운다.
    try {
      const done = sessionStorage.getItem(UPDATE_DONE_KEY)
      if (done) {
        sessionStorage.removeItem(UPDATE_DONE_KEY)
        actions.showNotice({ title: t('update.done', { version: done }) })
      }
    } catch { /* 저장소 불가 — 토스트만 건너뛴다 */ }
    void actions.checkUpdateNotice()
    // 서버는 부팅 1분 뒤에 첫 확인을 하므로, 그 직후 한 번 더 본다(같은 버전은 한 번만 알린다).
    if (typeof window !== 'undefined') window.setTimeout(() => void actions.checkUpdateNotice(), 90_000)
    void actions.refreshPushState()
    await actions.refreshSessions()
    if (!presence && typeof window !== 'undefined') {
      presence = openPresenceStream(
        (snap) => {
          if (applyContractReload(snap.contractVersion, AGENT_EVENT_CONTRACT_VERSION, reloadBusy())) set({ contractMismatch: true })
          const before = state.rooms
          set({
            presenceLive: true,
            rooms: mergeRoomPresenceSnapshot(state.rooms, snap.channels),
            sessions: mergePresenceSnapshot(state.sessions, snap.sessions),
          })
          reactToHandoff(before, state.rooms)
        },
        (row) => {
          // 실시간 갱신의 id는 실행 id다. 사이드바는 방 목록을, 입력창 위 백그라운드 띠는 세션 목록을 본다.
          const before = state.rooms
          set({ rooms: mergeRoomPresenceUpdate(state.rooms, row), sessions: mergePresenceUpdate(state.sessions, row) })
          reactToHandoff(before, state.rooms)
        },
      )
    }
    // 데스크톱 껍데기일 때만 알림 SSE. 웹 브라우저 경로에서는 열지 않는다.
    // 창이 먼저 뜬 뒤 포커스를 잃을 여유를 위해 구독을 한 틱 미룬다(스모크·백그라운드 알림).
    if (!desktopNotify && typeof window !== 'undefined' && isDesktopShell()) {
      window.setTimeout(() => {
        if (desktopNotify) return
        const frameFailure = createClientErrorReporter({ component: 'desktop', operation: 'web.desktop_notify.frame', severity: 'warning' })
        desktopNotify = openSse({
          url: '/api/notify/stream',
          onMessage: (data) => {
            try {
              const intent = JSON.parse(data) as { title?: string; body?: string }
              frameFailure.reset()
              if (!intent?.title) return
              if (typeof document !== 'undefined' && document.hasFocus()) return
              showDesktopNotification({ title: intent.title, body: intent.body ?? '' })
            } catch (error) {
              frameFailure.report(error)
              /* 손상 프레임 무시 */
            }
          },
        })
      }, 400)
    }
    // 새로고침 전 대기 큐 복원(sessionStorage 미러) — 실행 id 기준.
    try {
      const raw = sessionStorage.getItem(QUEUED_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, QueuedItem[]>
        const restored = restoreQueuedSnapshot(
          saved,
          state.rooms.map((room) => room.id),
          state.rooms.map((room) => roomExecutionId(room) ?? ''),
        )
        if (Object.keys(restored).length) set({ queued: restored })
      }
      queueReadFailure.reset()
    } catch (error) {
      queueReadFailure.report(error)
      /* 복원 실패 — 무시(휘발) */
    }
    // 저장된 칸을 복원한다. 목록에 없는 방은 버린다.
    // 저장된 칸이 없으면 아래대로 첫 1대1, 그것도 없으면 빈 화면.
    const alive = alivePaneIds()
    const stored = loadPanes()
    let ids = stored.ids.filter((id) => alive.has(id))
    let focused: string | null = stored.focusedId && ids.includes(stored.focusedId) ? stored.focusedId : (ids[0] ?? null)
    const deepRoom = deepLinkId
      ? (state.rooms.find((r) => r.id === deepLinkId) ?? state.rooms.find((r) => r.sourceSessionId === deepLinkId))
      : undefined
    if (deepRoom && deepRoom.status !== 'corrupted') {
      const decided = decideSelectSession(
        deepRoom.id,
        ids[0] ?? null,
        ids.slice(1),
        focused,
        paneCapNow(),
        false,
        ids,
      )
      ids = paneIds(decided.activeId, decided.sideIds)
      focused = decided.focusedId
    }
    if (!ids.length) {
      const first = state.rooms.find((r) => r.status !== 'corrupted')
      if (first) {
        ids = [first.id]
        focused = first.id
      }
    }
    if (ids[0]) {
      commitPanes({ activeId: ids[0], sideIds: ids.slice(1), focusedId: focused })
    }
    set({ booting: false }) // 세션 선택 완료 → 부팅 마스크 해제(활성세션 있으면 Stream의 ChatSkeleton이 이어받고, 없으면 NoActive 표시)
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(max-width: 759px)')
      const onMq = () => set({ isNarrow: mq.matches })
      mq.addEventListener('change', onMq)
      onMq()
      const wq = window.matchMedia(WIDE_QUERY)
      const onWq = () => {
        const prevChrome = chromeId()
        set({ isWide: wq.matches })
        refreshSidePanes()
        if (chromeId() !== prevChrome) applyChromeFacets(chromeId())
      }
      wq.addEventListener('change', onWq)
      onWq()
      // 입력수단(터치/마우스) — 넓이와 독립. 아이패드(넓음+터치)에서 hover 미노출·작은 히트영역 문제 해결용.
      const pm = window.matchMedia('(pointer: coarse)')
      const onPm = () => set({ coarsePointer: pm.matches })
      pm.addEventListener('change', onPm)
      onPm()
    }
  },

  async refreshSessions() {
    try {
      const body = await api.listSessions()
      if (!Array.isArray(body.rooms) || (typeof body.contractVersion === 'number' && applyContractReload(body.contractVersion, AGENT_EVENT_CONTRACT_VERSION, reloadBusy()))) {
        set({ contractMismatch: true, loadingSessions: false })
        if (!Array.isArray(body.rooms)) {
          set({ error: 'rooms missing — refresh required' })
          return
        }
      }
      // 호환 sessions는 보관만. 방 목록은 rooms.
      set({
        rooms: body.rooms,
        sessions: Array.isArray(body.sessions) ? body.sessions : [],
        loadingSessions: false,
        error: null,
      })
      // 부팅 중에는 저장된 칸을 아직 복원하기 전이다. 여기서 걷으면 빈 칸이 저장본을 덮어 쓴다.
      if (!state.booting) {
        const prevChrome = chromeId()
        pruneOpenPanes()
        ensurePrimaryStream()
        refreshSidePanes()
        if (chromeId() !== prevChrome) applyChromeFacets(chromeId())
      }
    } catch (e) {
      set({ loadingSessions: false, error: errMsg(e) })
    }
  },

  // SSE conn 전이 처리 — conn 반영 + 재연결 마스크 디바운스. 비연결이 RECONNECT_MASK_DELAY 이상 지속돼야 마스크(짧은 blip 무시),
  //   connected 복귀 시 즉시 해제. 부팅 마스크(booting)와 독립 — 둘 중 하나라도 켜지면 showLoadMask가 마스크를 건다.
  setConn(conn: ConnState) {
    // 첫 연결은 'connecting' → 'connected', 재연결은 'reconnecting' → 'connected'로 들어온다(sse.ts).
    //   첫 연결 때는 setActive가 이미 목록·깨우기를 처리했으므로 다시 할 필요가 없다.
    const reconnected = conn === 'connected' && state.conn === 'reconnecting'
    set({ conn })
    if (conn === 'connected') {
      if (reconnectMaskTimer) { clearTimeout(reconnectMaskTimer); reconnectMaskTimer = null }
      if (state.reconnectMask) set({ reconnectMask: false })
      if (reconnected) void actions.reconcileActiveSession()
      return
    }
    if (!reconnectMaskTimer && !state.reconnectMask) {
      reconnectMaskTimer = setTimeout(() => {
        reconnectMaskTimer = null
        // 첫 칸이 없으면 연결 성공이 더 오지 않는다. 가림막을 올리면 빈 화면에 남는다.
        if (state.conn !== 'connected' && state.activeId) set({ reconnectMask: true })
      }, RECONNECT_MASK_DELAY)
    }
  },

  setActive(id: string, opts?: { focus?: boolean }) {
    const room = findRoom(state.rooms, id)
    if (!room) return
    const keepFocus = opts?.focus === false
    closeSideStream(id)
    if (state.activeId === id && stream) {
      if (!keepFocus && state.focusedId !== id) set({ focusedId: id })
      return
    }

    stream?.close()
    stream = null
    // 미해결 카드가 없으면 control SSE도 닫는다.
    const prevExec = state.activeId
      ? roomExecutionId(findRoom(state.rooms, state.activeId))
      : null
    const prevOpen =
      prevExec &&
      (state.convos[prevExec] ?? []).some(
        (e) =>
          e.kind === 'permission_request' ||
          e.kind === 'question_request' ||
          e.kind === 'plan_request',
      )
    if (!prevOpen) {
      controlStream?.close()
      controlStream = null
    }

    const prev = state.activeId
    const execId = roomExecutionId(room)
    const streamKey = execId ?? id
    const fresh = !everCaughtUp.has(streamKey)
    const asleep = room.kind === 'dm' && !!room.sourceSessionId && isSessionAsleep(state.sessions, room.sourceSessionId)

    const patch: Partial<State> = { activeId: id, drawerOpen: false, permissionPolicy: null }
    if (!keepFocus) patch.focusedId = id
    if (asleep) {
      patch.availableModels = null
      patch.modelsStatus = 'loading'
    }
    let lc: Record<string, boolean> | null = null
    if (prev && prev !== id) {
      const prevRoom = findRoom(state.rooms, prev)
      const prevKey = roomExecutionId(prevRoom) ?? prev
      if (!everCaughtUp.has(prevKey)) {
        if (loadingTimers[prevKey]) {
          clearTimeout(loadingTimers[prevKey])
          delete loadingTimers[prevKey]
        }
        if (state.loadingConvo[prevKey]) lc = { ...state.loadingConvo, [prevKey]: false }
      }
    }
    if (fresh && execId) lc = { ...(lc ?? state.loadingConvo), [execId]: true }
    if (lc) patch.loadingConvo = lc
    set(patch)

    if (room.kind === 'dm' && room.sourceSessionId) {
      const sid = room.sourceSessionId
      if (!state.convos[sid]) set({ convos: { ...state.convos, [sid]: [] } })
      if (fresh) {
        if (loadingTimers[sid]) clearTimeout(loadingTimers[sid])
        loadingTimers[sid] = setTimeout(() => markCaughtUp(sid), CAUGHT_UP_FALLBACK_MS)
      }
      stream = openStream(
        sid,
        () => state.lastSeq[sid] ?? 0,
        (ev) => ingest(sid, ev),
        (conn) => actions.setConn(conn),
        (info) => {
          if (applyContractReload(info.contractVersion, AGENT_EVENT_CONTRACT_VERSION, reloadBusy())) set({ contractMismatch: true })
          markCaughtUp(sid, info)
        },
        (info) => setBacklogInfo(sid, info),
      )
      // 열기만 해서는 깨우지 않는다. 잠든 세션도 서버가 기억한 모델·명령 목록으로 답한다.
      loadSessionFacets(sid)
    }
    applyChromeFacets(chromeId())
  },

  /** 목록·손길·딥링크에서 방을 고른다. id는 방 id. beside면 옆에 연다(Cmd/Ctrl+클릭). */
  selectSession(id: string, opts?: { beside?: boolean }) {
    const room = findRoom(state.rooms, id)
    if (!room || room.status === 'corrupted') return
    // 옆에 열기는 openBeside가 맡는다(꽉 찼을 때 바뀔 칸 알림·낭독). 칸이 하나뿐이면 아래로 떨어져 포커스 칸을 바꾼다.
    if (opts?.beside && paneCapNow() >= 2) {
      actions.openBeside(id)
      return
    }
    const next = decideSelectSession(
      id,
      state.activeId,
      state.sideIds,
      state.focusedId,
      paneCapNow(),
      !!opts?.beside,
      state.focusOrder,
    )
    commitPanes(next)
  },

  /** 보이는 칸 번호(0부터)로 포커스. 그 칸이 없으면 아무것도 안 한다. */
  focusPaneAt(index: number) {
    const id = visibleIds()[index]
    if (id) actions.focusPane(id)
  },

  setPaneBox(w: number, h: number) {
    if (w === state.paneW && h === state.paneH) return
    const prevChrome = chromeId()
    set({ paneW: w, paneH: h })
    refreshSidePanes()
    if (chromeId() !== prevChrome) applyChromeFacets(chromeId())
  },

  /**
   * 잠든 세션을 깨운다 — 모델에게 아무것도 묻지 않으므로 토큰이 들지 않고 대화에도 안 남는다.
   *
   * 한 번 실패하면 잠시 쉬었다 딱 한 번 더 시도한다. 두 번째도 실패하면 화면 아래 토스트로 알린다 —
   * 조용히 넘기면 사용자는 칩이 왜 비어 있는지 알 수 없고, 그렇다고 확인 버튼이 있는 창을 띄울 만큼
   * 급한 일도 아니다. 실패해도 목록·명령·정책은 한 번 받아 본다. 그래야 화면이 '잠들어 있음'이라는
   * 정직한 상태로 자리 잡는다(안 그러면 '알아보는 중'에 갇힌다).
   *
   * 응답이 오는 사이 사용자가 다른 세션으로 옮겼으면 조용히 그만둔다.
   */
  wakeSession(id: string): Promise<void> {
    // 이미 같은 세션을 깨우는 중이면 그 약속을 같이 기다린다. 먼저 돌아가면 호출한 쪽이 덜 깬 세션에 요청을 보낸다.
    if (wakingId === id && wakingTask) return wakingTask
    wakingId = id
    wakingTask = wakeSessionNow(id)
    return wakingTask
  },

  /**
   * 실시간 연결이 *다시* 붙었을 때 활성 세션이 아직 살아 있는지 맞춘다.
   *
   * 백엔드를 재시작하면 서버에서 세션은 잠드는데, 화면은 SSE만 다시 붙을 뿐 세션 목록을 새로 받지 않아
   * 그 세션을 계속 '활성'으로 알고 있었다. 그러면 열려 있는 세션의 상태가 서버와 어긋난 채 남고, 같은 세션을
   * 다시 눌러도 setActive가 첫 줄에서 돌아간다(2026-07-30 검토에서 잡힌 결함). 연결이 붙는 이 시점이
   * 서버의 진짜 상태를 다시 물어볼 수 있는 자리다.
   */
  async reconcileActiveSession() {
    const id = state.activeId
    if (!id) return
    await actions.refreshSessions()
    if (state.activeId !== id) return // 기다리는 사이 다른 방으로 옮겼다
    // 깨우지 않는다. 잠든 세션은 다음에 메시지를 보내거나 모델·명령을 바꿀 때 깨어난다.
  },

  async send(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    sessionId?: string,
    brief?: boolean,
  ) {
    const id = paneTargetId(sessionId)
    if (!id) return
    signalScrollBottom(id) // 전송 즉시 최하단으로(위로 스크롤해 있어도)
    await actions.sendTo(id, text, images, documents, brief)
  },

  /** 카탈로그가 화면 동작이라고 표시한 슬래시 명령. 명령 이름은 보지 않는다. */
  runSlashUiAction(action: NonNullable<SlashCommandInfo['uiAction']>, args: string, sessionId?: string) {
    // 세션 목록·이름 변경 REST는 실행 id 기준 — 방 id로 찾으면 /rename·/delete·/login이 조용히 안 먹는다.
    const id = execOf(paneTargetId(sessionId))
    const session = id ? state.sessions.find((x) => x.id === id) : undefined
    switch (action) {
      case 'newSession':
        actions.openModal()
        return
      case 'rename': {
        const name = args.trim()
        if (!id) return
        if (!name) { set({ error: t('session.slash.renameNeeded') }); return }
        void actions.renameSession(id, name)
        return
      }
      case 'delete':
        if (session) actions.requestDelete(session)
        return
      case 'settings':
      case 'status':
        actions.openSettings()
        return
      case 'help':
        actions.openShortcuts()
        return
      case 'find':
        actions.toggleFind()
        return
      case 'login':
        if (session) actions.openProviderAuth(session.provider)
        return
    }
  },

  /** 슬래시 명령 단일 실행 경로. 명령 이름의 의미는 runtime adapter가 판정하고, 모르는 이름은 대화로 보내지 않는다. */
  async executeCommand(command: string, args: string, startsTurn: boolean, sessionId?: string): Promise<boolean> {
    const roomId = paneTargetId(sessionId)
    // 서버 명령 REST와 convos·pendingSend는 실행 id 기준. 방 id를 그대로 보내면 "세션 없음"이다.
    const id = execOf(roomId)
    if (!roomId || !id) return false
    const text = `/${command}${args.trim() ? ` ${args.trim()}` : ''}`
    const lseq = localSeq--
    if (startsTurn) {
      signalScrollBottom(id)
      pushLocal(id, { seq: lseq, ts: Date.now(), kind: 'local_user', text })
      set({ pendingSend: { ...state.pendingSend, [id]: true } })
    }
    try {
      await ensureAwake(id)
      const result = await api.executeCommand(id, command, args)
      if (startsTurn && !result.startsTurn) set({ pendingSend: { ...state.pendingSend, [id]: false } })
      else if (!startsTurn && result.startsTurn) set({ pendingSend: { ...state.pendingSend, [id]: true } })
      if (result.sessionUpdate?.model) {
        pushLocal(id, { seq: localSeq--, ts: Date.now(), kind: 'local_notice', variant: 'model', detail: result.sessionUpdate.model })
        reconcileEffortToModel()
      }
      if (result.sessionUpdate?.effort) {
        pushLocal(id, { seq: localSeq--, ts: Date.now(), kind: 'local_notice', variant: 'effort', detail: result.sessionUpdate.effort })
      }
      void actions.refreshSessions()
      void actions.fetchCommands(id)
      return true
    } catch (e) {
      const convos = startsTurn
        ? { ...state.convos, [id]: (state.convos[id] ?? []).filter((item) => !(item.kind === 'local_user' && item.seq === lseq)) }
        : state.convos
      set({ error: errMsg(e), convos, pendingSend: { ...state.pendingSend, [id]: false } })
      return false
    }
  },

  // id = 방 id 또는 실행 id(fan-out 직후).
  async sendTo(
    id: string,
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    brief?: boolean,
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!id || (!trimmed && !images?.length && !documents?.length)) return false
    const room = findRoom(state.rooms, id) ?? state.rooms.find((r) => r.sourceSessionId === id)
    const roomKey = room?.id ?? id
    const exec = roomExecutionId(room)
    const clientMessageId = pickClientMessageId({ sessionId: roomKey, text: trimmed, fill: state.composerFill })

    // 방 목록에 아직 없어도 실행 id면 dm 전송(fan-out).
    const sid = exec ?? room?.sourceSessionId ?? (!id.startsWith('dm:') && !id.startsWith('ch-') ? id : undefined)
    if (!sid) return false
    const lseq = localSeq--
    pushLocal(sid, {
      seq: lseq,
      ts: Date.now(),
      kind: 'local_user',
      text: trimmed,
      images,
      documents,
      clientMessageId,
      ...(room?.handoffDraftPending && room.handoffFrom ? { handoffFrom: room.handoffFrom } : {}),
    })
    const current = state.sessions.find((x) => x.id === sid)
    if (current && !current.named && !current.displayName.trim() && trimmed) {
      const auto = deriveWorkTitle(trimmed)
      if (auto) set({ sessions: state.sessions.map((x) => (x.id === sid ? { ...x, displayName: auto } : x)) })
    }
    set({ pendingSend: { ...state.pendingSend, [sid]: true } })
    try {
      // 브리프도 일반 전송처럼 잠든 세션을 깨운다.
      if (isSessionAsleep(state.sessions, sid)) await actions.wakeSession(sid)
      await api.sendMessage(sid, trimmed, images, documents, clientMessageId, brief === true)
      actions.refreshSessions()
      if (state.composerFill?.id === id || state.composerFill?.id === sid) set({ composerFill: null })
      if (!policyCache.get(sid)) void actions.fetchPermissionPolicy(sid)
      const modelsStatus = modelCache.get(sid)?.status
      if (modelsStatus === 'asleep' || modelsStatus === 'failed') void actions.fetchModels(sid)
      return true
    } catch (e) {
      set({
        error: e instanceof RequestTimeoutError ? t('session.send.timeout') : errMsg(e),
        pendingSend: { ...state.pendingSend, [sid]: false },
        convos: { ...state.convos, [sid]: (state.convos[sid] ?? []).filter((it) => !(it.kind === 'local_user' && it.seq === lseq)) },
        composerFill: { id, text: trimmed, nonce: Date.now(), images, documents, clientMessageId },
      })
      return false
    }
  },

  // 브리프 질문지 카드의 답을 보낸다. 턴이 끝난 뒤에만 열려 있는 질문지라 대기열을 거치지 않고 바로 간다.
  //   `clientMessageId`는 카드가 들고 있다가 같은 답을 다시 보낼 때 같은 값을 넘긴다(서버가 재시도로 알아본다).
  //   실패하면 false — 카드가 오류를 보이고 고른 답을 그대로 둔다. 화면 말풍선은 서버 사건(user_msg)이 만든다.
  async sendQuestionnaireAnswer(execId: string, questionnaireId: string, answers: QuestionnaireAnswers, clientMessageId: string): Promise<boolean> {
    if (!execId) return false
    set({ pendingSend: { ...state.pendingSend, [execId]: true } })
    try {
      if (isSessionAsleep(state.sessions, execId)) await actions.wakeSession(execId)
      await api.sendMessage(execId, '', undefined, undefined, clientMessageId, false, { id: questionnaireId, answers })
      actions.refreshSessions()
      return true
    } catch {
      // API와 세션 깨우기가 원인을 처리했으므로 전송 중 표시만 해제한다.
      set({ pendingSend: { ...state.pendingSend, [execId]: false } })
      return false
    }
  },

  // 턴 진행 중 입력한 후속 메시지를 큐에 추가(idle 전환 시 자동 전송). Composer가 busy일 때 호출.
  enqueue(
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    sessionId?: string,
    brief?: boolean,
  ) {
    const id = paneTargetId(sessionId)
    const trimmed = text.trim()
    if (!id || (!trimmed && !images?.length && !documents?.length)) return
    signalScrollBottom(id) // 큐에 넣을 때도 최하단으로(큐 버블이 보이게)
    const item: QueuedItem = {
      qid: `q${queueSeq++}`,
      text: trimmed,
      images,
      documents,
      ...(brief === true ? { brief: true } : {}),
    }
    set({ queued: { ...state.queued, [id]: [...(state.queued[id] ?? []), item] } })
  },

  // 무한스크롤 — oldestSeq 이전 페이지 로드. untilSeq 지정 시 그 seq(약간 위 여유 포함)까지 전 구간(검색 점프용).
  //   반환 = 실제 prepend 발생 여부(Stream이 앵커 정리 판단에 사용).
  async loadOlder(id: string, untilSeq?: number): Promise<boolean> {
    const o = state.older[id]
    if (!o || !o.hasOlder || o.loading) return false
    set({ older: { ...state.older, [id]: { ...o, loading: true } } })
    try {
      const page =
        untilSeq != null
          ? await api.getEvents(id, { before: o.oldestSeq, from: Math.max(1, untilSeq - 10) })
          : await api.getEvents(id, { before: o.oldestSeq, limit: OLDER_PAGE })
      return prependEvents(id, page.events, page.hasOlder, page.oldestSeq)
    } catch (e) {
      const cur = state.older[id]
      if (cur) set({ older: { ...state.older, [id]: { ...cur, loading: false } }, error: errMsg(e) })
      return false
    }
  },

  // 대기 중인 글을 입력창으로 되돌리고 줄에서 뺀다. 그림과 문서도 같이 돌아온다.
  editQueued(execId: string, qid: string) {
    const id = roomOf(execId)
    const q = state.queued[id]
    const item = q?.find((it) => it.qid === qid)
    if (!item || !q) return
    set({
      queued: { ...state.queued, [id]: q.filter((it) => it.qid !== qid) },
      composerFill: { id, text: item.text, nonce: Date.now(), images: item.images, documents: item.documents },
    })
  },

  // 진행 중인 턴을 멈추고, 그 중단이 이 탭에서 온 것일 때만 대기열의 다음 글을 보낸다.
  // 멈추기 버튼은 대기열을 비우므로 여기선 부르지 않는다.
  sendQueuedNow(execId: string) {
    if (!execId) return
    flushAfterStop.add(execId)
    void api.interrupt(execId).catch(() => {
      // 공통 API가 실패를 처리했으므로 자동 전송 예약만 취소한다.
      flushAfterStop.delete(execId)
    })
  },

  // 대기 큐에서 qid 항목 취소(인덱스 아님 — flush로 배열이 줄어도 정확히 그 항목만 제거).
  dequeue(sessionId: string, qid: string) {
    const id = roomOf(sessionId) // 대화 화면은 실행 id를 넘긴다 — 큐는 방 id 기준(방 id는 그대로 돌아온다)
    const q = state.queued[id]
    if (!q) return
    set({ queued: { ...state.queued, [id]: q.filter((it) => it.qid !== qid) } })
  },

  /** id를 주면 그 세션을 바꾼다. 없으면 포커스 칸. 키보드로 고르면 칸 포커스가 안 옮겨 가므로 칩은 자기 세션을 넘긴다. */
  async setModel(arg: string, target?: string | null) {
    const id = target ?? chromeId()
    if (!id) return
    // ★ 별칭붕괴 금지 — 소문자 정규화만 하고 값은 보존해 전달(현 Claude 모델ID는 전부 소문자).
    //   정식 ID(claude-sonnet-5-…)·SDK 피커값(sonnet[1m]·opus[1m])이 'sonnet' 짧은 별칭으로 뭉개져
    //   특정 버전 지정이 불가해지던 버그 수정. SDK가 별칭·정식ID 모두 수용.
    const model = arg.trim().toLowerCase()
    if (!model) return
    try {
      await ensureAwake(id)
      await api.setModel(id, model)
      forgetObservedEffort(id)
      pushLocal(id, { seq: localSeq--, ts: Date.now(), kind: 'local_notice', variant: 'model', detail: model })
      // 모델 변경 → effort를 새 모델 지원범위로 clamp(+SDK 재적용). model notice 반영된 state 기준으로 계산.
      reconcileEffortToModel(id)
      // 모델에 따라 고를 수 있는 권한 모드가 달라지고, 서버가 지금 모드를 수동으로 내렸을 수 있다.
      void actions.fetchPermissionModes(id)
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async setEffort(arg: string, target?: string | null) {
    const id = target ?? chromeId()
    if (!id) return
    const effort = arg.trim().toLowerCase()
    if (!effort) return
    // 모델이 알려준 단계 목록을 갖고 있을 때만 미리 거른다. 없으면(잠든 세션·목록 조회 실패) 서버 판정에 맡긴다 —
    //   목록을 못 받았다는 이유로 사용자가 아는 단계까지 막으면, 슬래시 명령마저 쓸 수 없게 된다.
    const supported = supportedEfforts(paneView(state, roomOf(id)))
    if (supported.length && !supported.includes(effort as SessionEffort)) {
      set({ error: t('core.effort.unknown', { arg, list: supported.join(' · ') }) })
      return
    }
    try {
      await ensureAwake(id)
      await api.setEffort(id, effort)
      forgetObservedEffort(id)
      pushLocal(id, { seq: localSeq--, ts: Date.now(), kind: 'local_notice', variant: 'effort', detail: effort })
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  /**
   * 권한 칩 — 권한 모드를 바꾼다. 어느 모드가 가능한지와 바꾸는 수단은 서버의 provider 어댑터가 정한다.
   * 성공하면 목록의 세션 값을 고치고, 실효 정책 요약을 다시 받아 칩 글자를 맞춘다.
   */
  async setPermissionMode(mode: PermissionMode, target?: string | null) {
    const id = target ?? chromeId()
    if (!id) return
    try {
      await ensureAwake(id)
      await api.setPermissionMode(id, mode)
      set({ sessions: state.sessions.map((x) => (x.id === id ? { ...x, permissionMode: mode } : x)) })
      pushLocal(id, { seq: localSeq--, ts: Date.now(), kind: 'local_notice', variant: 'permission', detail: mode })
      policyCache.delete(id)
      void actions.fetchPermissionPolicy(id)
      void actions.fetchPermissionModes(id)
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  /**
   * 이 세션이 고를 수 있는 권한 모드 목록. 모델 목록과 달리 잠든 세션도 서버가 저장해 둔 목록으로 답한다.
   * 실패하면 목록 없이 현재 모드만 보이게 두고 다음 기회에 다시 받는다.
   */
  async fetchPermissionModes(id: string) {
    if (!id) return
    try {
      const { modes, current } = await api.getPermissionModes(id)
      permissionModesCache.set(id, modes)
      // 서버가 정한 현재 모드가 목록과 다르면(새 세션의 시작 모드, 모델 변경으로 내려간 경우) 서버 값을 따른다.
      set({
        facetsRev: state.facetsRev + 1,
        sessions: state.sessions.map((x) => (x.id === id && x.permissionMode !== current ? { ...x, permissionMode: current } : x)),
        ...(chromeId() === id ? { permissionModes: modes } : {}),
      })
    } catch {
      /* 잠시 못 받은 것이다. 칩은 현재 모드만 보이고, 다음 세션 전환·모델 변경 때 다시 받는다. */
    }
  },

  /**
   * 이 세션이 고를 수 있는 모델 목록을 가져온다 — 세션을 열 때, 잠든 세션이 깨어날 때, 실패 후 다시 시도할 때.
   *
   * 라이브 세션만 응답하고 잠든 세션은 404를 준다. 404는 고장이 아니라 정상 상태라서 다시 물어보지 않는다 —
   * 메시지를 한 번 보내면 세션이 깨어나고, 그때 다시 부른다.
   * 그 밖의 실패(네트워크·서버 지연)는 잠시 쉬었다 세 번 더 시도한다. 목록 취득에 1초 가까이 걸리는 것이
   * 실측이라 첫 요청 한 번으로 판단하면 멀쩡한 세션도 실패로 보이기 때문이다.
   *
   * `quiet` = 턴이 끝날 때마다 도는 조용한 재시도. 자리표시자를 다시 띄우지 않고 한 번만 물어본다
   * (매 턴 칩이 회색으로 깜빡이면 실패 사실보다 깜빡임이 더 거슬린다).
   */
  async fetchModels(id: string, opts?: { quiet?: boolean }) {
    if (!id) return
    const token = (modelFetchTokens.get(id) ?? 0) + 1
    modelFetchTokens.set(id, token)
    if (!opts?.quiet) {
      cacheModels(id, { models: null, status: 'loading' })
      if (chromeId() === id) set({ availableModels: null, modelsStatus: 'loading' })
    }
    const delays = opts?.quiet ? [] : MODEL_RETRY_DELAYS
    // 목록 없이 계속하는 기능 축소다. 재시도하는 동안 같은 실패는 첫 건만 남긴다.
    const loadFailure = createClientErrorReporter({ component: 'models', operation: 'web.models.load', session_id: id, severity: 'warning' })
    for (let i = 0; ; i++) {
      // 이 세션에 더 새로운 요청이 시작됐으면 이 응답은 버린다. 칸마다 칩을 그리므로 포커스 밖 세션의 응답도 캐시에 담는다.
      const stale = () => token !== modelFetchTokens.get(id)
      try {
        const { models } = await api.getModels(id)
        if (stale()) return
        // 빈 목록은 성공이 아니라 빈 손이다 — 고를 것이 없는 목록창을 여는 대신 안내를 띄운다.
        const status: ModelsStatus = models?.length ? 'ok' : 'failed'
        cacheModels(id, { models: models ?? [], status })
        if (chromeId() === id) set({ availableModels: models ?? [], modelsStatus: status })
        reconcileEffortToModel(id) // 목록이 오고 나서야 현재 강도가 이 모델 범위 안인지 판단할 수 있다
        return
      } catch (e) {
        if (stale()) return
        loadFailure.report(e)
        const status = (e as { status?: number }).status
        if (status === 404) {
          cacheModels(id, { models: null, status: 'asleep' })
          if (chromeId() === id) set({ modelsStatus: 'asleep' }) // 잠든 세션 — 재시도 대상이 아니다
          wakeForUnknownList(id)
          return
        }
        // 501 = 이 서비스는 모델 목록을 줄 줄 모른다. 다시 물어도 답이 달라지지 않으므로 재시도하지 않는다
        //   (안 그러면 6초를 기다린 뒤 "다시 시도해 보세요"라는 거짓 안내를 하게 된다).
        if (status === 501) {
          cacheModels(id, { models: null, status: 'failed' })
          if (chromeId() === id) set({ modelsStatus: 'failed' })
          return
        }
        if (i >= delays.length) {
          cacheModels(id, { models: null, status: 'failed' })
          if (chromeId() === id) set({ modelsStatus: 'failed' })
          return
        }
        await sleep(delays[i])
        if (stale()) return
      }
    }
  },

  /**
   * 이 세션에 실제 적용 중인 승인 정책 요약 취득(8d-3 ⑥ⓕ) — setActive 시. live 세션만 응답한다.
   *
   * 잠든 세션이 404를 주면 배지가 사라지는데, 그게 맞는 동작이다. 도구는 턴 중에만 실행되고 턴이 돌면
   * 세션은 이미 live이므로, 뭔가 카드 없이 실행될 수 있는 모든 순간에는 이 값이 있다.
   */
  /** 포커스 밖 칸의 칩이 쓸 값을 받아 둔다. 이미 받았으면 묻지 않는다. */
  ensurePaneFacets(id: string) {
    if (!modelCache.has(id)) void actions.fetchModels(id)
    if (!policyCache.has(id)) void actions.fetchPermissionPolicy(id)
    if (!permissionModesCache.has(id)) void actions.fetchPermissionModes(id)
  },

  async fetchPermissionPolicy(id: string) {
    if (!id) return
    try {
      const policy = await api.getPermissionPolicy(id)
      cachePolicy(id, policy)
      if (chromeId() === id) set({ permissionPolicy: policy })
    } catch {
      // API가 수집·정상 거절을 판정했으며 배지 없는 상태로 돌아간다.
      cachePolicy(id, null)
      if (chromeId() === id) set({ permissionPolicy: null }) // 잠든 세션·미지원 — 배지 없음
    }
  },

  // provider interface 명령 카탈로그 취득 — setActive·commands_changed·명령 실행 뒤 갱신. live 세션만.
  async fetchCommands(id: string) {
    if (!id) return
    try {
      const { commands } = await api.getCommands(id)
      set({ slashRich: { ...state.slashRich, [id]: commands ?? [] } })
      commandsLoadFailure.reset()
    } catch (error) {
      commandsLoadFailure.report(error, { session_id: id })
      /* live 아님 or 실패 — 마지막 카탈로그와 replay 이름을 유지 */
      if ((error as { status?: number }).status === 404) wakeForUnknownList(id)
    }
  },

  async interrupt(sessionId?: string) {
    // 무장 해제가 먼저다. 아래 early return 뒤에 두면, 멈출 세션이 없을 때 "ESC" 글자가 풀리지 않고 굳는다.
    actions.disarmInterrupt()
    const roomId = paneTargetId(sessionId)
    if (!roomId) return
    const room = findRoom(state.rooms, roomId)
    const id = roomExecutionId(room) ?? room?.sourceSessionId
    if (!id) return
    flushAfterStop.delete(id)
    try {
      await api.interrupt(id)
    } catch {
      /* 이미 끝난 턴일 수 있음 */
    }
    // Stop = "지금 흐름 중단" → 대기 큐도 비운다(터미널 Esc와 동형 — 멈췄는데 큐가 자동 발사되지 않게).
    set({ pendingSend: { ...state.pendingSend, [id]: false }, queued: { ...state.queued, [id]: [] } })
    pushLocal(id, { seq: localSeq--, ts: Date.now(), kind: 'local_notice', variant: 'stop', detail: t('core.notice.stopped') })
  },

  /**
   * 진행 중인 턴에서 Esc를 눌렀다 — 첫 번째면 무장만 하고, 무장된 상태면 실제로 중단한다.
   *
   * Esc는 습관적으로 누르는 키다. 한 번에 중단시키면 몇 분짜리 작업이 실수로 날아간다. 그렇다고 확인
   * 대화상자를 띄우면 급할 때 거추장스럽다. 그래서 멈춤 버튼 자신이 "ESC"로 바뀌어 다음 한 번이 무엇을
   * 할지 보여주는 방식을 쓴다 — 물어보지 않고 알려만 준다.
   */
  armOrInterrupt() {
    if (state.interruptArmed) { void actions.interrupt(); return }
    clearTimeout(armTimer)
    set({ interruptArmed: true })
    armTimer = setTimeout(() => actions.disarmInterrupt(), INTERRUPT_ARM_MS)
  },

  /** 무장 해제 — 시간이 지났거나, 중단됐거나, 멈출 것이 사라졌을 때(버튼이 화면에서 내려갈 때). */
  disarmInterrupt() {
    clearTimeout(armTimer)
    if (state.interruptArmed) set({ interruptArmed: false })
  },

  // 알림 클릭/딥링크로 특정 세션 열기 — 목록에 없으면 새로고침 후 활성화. 모바일 드로어는 닫음.
  async openSessionFromPush(id: string) {
    // 방 id 또는 sessionId.
    if (!findRoom(state.rooms, id) && !state.rooms.some((r) => r.sourceSessionId === id)) {
      await actions.refreshSessions()
    }
    const room = findRoom(state.rooms, id) ?? state.rooms.find((r) => r.sourceSessionId === id)
    if (!room || room.status === 'corrupted') return
    actions.selectSession(room.id)
    if (state.drawerOpen) set({ drawerOpen: false })
  },

  // 세션 표시 이름 변경(rename). 낙관적 갱신 후 서버 확정값으로 동기화. 빈값이면 서버가 자동 제목으로 복귀.
  async renameSession(id: string, name: string) {
    const trimmed = name.trim().slice(0, 80)
    const prev = state.sessions
    if (trimmed) set({ sessions: prev.map((x) => (x.id === id ? { ...x, displayName: trimmed, named: true } : x)) })
    try {
      await api.renameSession(id, trimmed)
      await actions.refreshSessions() // 서버 확정(빈값→cwd 파생 폴백 포함)으로 동기화
    } catch (e) {
      set({ sessions: prev, error: errMsg(e) }) // 롤백
    }
  },

  // 세션 보관/해제. 성공하면 목록·방에 바로 반영한다(곧 같은 값이 presence로도 온다). 실패(409 포함)는 서버 문구를 오류로 띄운다.
  //   id = 실행 id(sourceSessionId). 방은 sourceSessionId 또는 id로 찾는다.
  async setArchived(id: string, archived: boolean): Promise<boolean> {
    try {
      const r = await api.archiveSession(id, archived)
      const at = archived ? r.archivedAt ?? Date.now() : undefined
      set({
        sessions: state.sessions.map((x) => (x.id === id ? { ...x, archivedAt: at } : x)),
        rooms: state.rooms.map((x) => ((x.sourceSessionId ?? x.id) === id ? { ...x, archivedAt: at } : x)),
      })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  async archiveSession(id: string) {
    if (!(await actions.setArchived(id, true))) return
    actions.showNotice({
      icon: Archive,
      title: t('nav.toast.archived'),
      message: t('nav.toast.archivedHint'),
      // 실행 취소는 보관한 바로 이 세션을 푼다(그 사이 다른 걸 보관했어도).
      action: { label: t('nav.toast.undo'), onClick: () => void actions.unarchiveSession(id, { undo: true }) },
    })
  },

  async unarchiveSession(id: string, opts?: { undo?: boolean }) {
    if (!(await actions.setArchived(id, false))) return
    if (!opts?.undo) {
      actions.showNotice({ title: t('nav.toast.unarchived') })
      return
    }
    // 실행 취소 — 원래 묶음에 다시 그려진 뒤 그 줄을 잠깐 강조한다(index.css .row-flash).
    window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`[data-session-id="${id}"], [data-room-id="${id}"]`)
      if (!row) return
      row.classList.add('row-flash')
      row.addEventListener('animationend', () => row.classList.remove('row-flash'), { once: true })
    }, 60)
  },

  async deleteSession(id: string, purge = false): Promise<{ ok: true } | { ok: false; error: string }> {
    const prevChrome = chromeId()
    try {
      await api.deleteSession(id, purge)
    } catch (e) {
      const error = errMsg(e)
      set({ error })
      return { ok: false, error }
    }
    dropLocalSessionState(id)
    await actions.refreshSessions()
    pruneOpenPanes()
    if (!state.activeId) {
      const next = state.rooms.find((r) => r.status !== 'corrupted')
      if (next) actions.selectSession(next.id)
    } else {
      ensurePrimaryStream()
      refreshSidePanes()
    }
    if (chromeId() !== prevChrome) applyChromeFacets(chromeId())
    return { ok: true }
  },

  // 삭제+같은 cwd/model/effort/permissionMode로 재생성 = "초기화". 완전히 새 SDK 세션이라
  //   frozen systemPrompt(memory 스냅샷)도 새로 읽힘 — 네이티브 /clear로는 안 되는 부분.
  async resetSession(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const target = state.sessions.find((x) => x.id === id)
    if (!target) return { ok: false, error: t('session.delete.deleteTitle') }
    const prevChrome = chromeId()
    try {
      await api.deleteSession(id)
    } catch (e) {
      const error = errMsg(e)
      set({ error })
      return { ok: false, error }
    }
    dropLocalSessionState(id)
    try {
      // provider도 그대로 물려받는다 — 초기화는 '같은 세션을 새로 여는 것'이라 서비스가 바뀌면 안 된다(8h).
      const r = await api.createSession({
        cwd: target.workspaceSource || target.cwd,
        provider: target.provider,
        model: target.model,
        permissionMode: target.permissionMode,
        isolateWorkspace: !!target.isolated,
      })
      if (target.effort) await api.setEffort(r.id, target.effort)
      await actions.refreshSessions()
      actions.selectSession(`dm:${r.id}`)
      return { ok: true }
    } catch (e) {
      const error = errMsg(e)
      set({ error })
      await actions.refreshSessions() // 삭제는 이미 됐으니 목록만이라도 동기화
      ensurePrimaryStream()
      refreshSidePanes()
      if (chromeId() !== prevChrome) applyChromeFacets(chromeId())
      return { ok: false, error }
    }
  },

  async resolvePlan(planId: string, decision: 'approve' | 'revise' | 'cancel', message?: string) {
    const id = sessionOwningCard(visibleExecIds(), state.convos, 'plan_request', planId, execOf(state.activeId))
    if (!id) return
    try {
      await api.resolvePlan(id, planId, decision, message)
    } catch (e) {
      const resolved = (state.convos[id] ?? []).some((it) => it.kind === 'plan_resolved' && it.id === planId)
      if (!ignoreStaleCardResolve((e as { status?: number }).status, resolved)) set({ error: errMsg(e) })
    }
  },

  async applyWorkspace(id?: string) {
    const target = id || state.activeId
    if (!target) return
    try {
      await api.applyWorkspace(target)
      await actions.refreshSessions()
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async discardWorkspace(id?: string, force = false): Promise<{ ok: true } | { ok: false; error: string }> {
    const target = id || state.activeId
    if (!target) return { ok: false, error: t('session.delete.discardTitle') }
    try {
      await api.discardWorkspace(target, force)
      await actions.refreshSessions()
      return { ok: true }
    } catch (e) {
      const error = errMsg(e)
      set({ error })
      return { ok: false, error }
    }
  },

  async resolvePermission(permissionId: string, decision: 'allow' | 'deny') {
    const id = sessionOwningCard(visibleExecIds(), state.convos, 'permission_request', permissionId, execOf(state.activeId))
    if (!id) return
    try {
      await api.resolvePermission(id, permissionId, decision)
    } catch (e) {
      const resolved = (state.convos[id] ?? []).some((it) => it.kind === 'permission_resolved' && it.id === permissionId)
      if (!ignoreStaleCardResolve((e as { status?: number }).status, resolved)) set({ error: errMsg(e) })
    }
  },

  // answers = 고른 선택지 이름들, custom = 직접 적은 문장(질문별, 없으면 null). 서버가 둘을 구분해 검증한다(8d-3 ⑥ⓒ).
  //   화면에 다시 그릴 답(state.answers)은 예전처럼 합쳐서 보관한다 — 해결된 카드의 표시가 바뀌지 않게.
  async resolveQuestion(questionId: string, answers: string[][], custom: (string | null)[]) {
    const id = sessionOwningCard(visibleExecIds(), state.convos, 'question_request', questionId, execOf(state.activeId))
    if (!id) return
    const shown = answers.map((a, i) => (custom[i] ? [...a, custom[i] as string] : a))
    try {
      await api.resolveQuestion(id, questionId, answers, custom)
      set({ answers: { ...state.answers, [questionId]: shown } })
    } catch (e) {
      const resolved = (state.convos[id] ?? []).some((it) => it.kind === 'question_resolved' && it.id === questionId)
      if (!ignoreStaleCardResolve((e as { status?: number }).status, resolved)) set({ error: errMsg(e) })
    }
  },

  /**
   * 새 세션 만들기. 실패 이유를 **돌려준다** — 전역 오류 알림으로 띄우지 않는다.
   *
   * 모델 이름을 잘못 적은 것이 실패의 주된 이유인데, 그건 방금 그 팝업 안에서 고쳐야 하는 일이다.
   * 팝업을 닫고 화면 구석에 알림을 띄우면 사용자는 적었던 이름도 잃고 고칠 자리도 잃는다.
   * 그래서 성공했을 때만 팝업을 닫고, 실패는 부르는 쪽(팝업)이 자기 안에 표시한다.
   */
  async createSession(cwd: string | undefined, opts: { provider: string; model?: string; isolateWorkspace?: boolean; name?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const r = await api.createSession({ cwd, provider: opts.provider, model: opts.model, isolateWorkspace: opts.isolateWorkspace, name: opts.name })
      set({ modalOpen: false, modalCwd: null })
      await actions.refreshSessions()
      actions.selectSession(`dm:${r.id}`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },

  /**
   * 같은 일을 여러 장으로 시작. 있는 만들기·보내기 문을 서비스마다 한 번씩 부른다.
   * 한 장이 실패해도 이미 만든 장은 지우지 않는다. 하나라도 성공하면 창을 닫고 첫 장을 연다.
   */
  async startSameWork(
    cwd: string | undefined,
    opts: {
      providers: string[]
      prompt: string
      isolateWorkspace?: boolean
      name?: string
    },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const providers = opts.providers.filter((id) => !!id)
    if (providers.length === 0) return { ok: false, error: t('session.newSession.fanout.needProvider') }
    const result = await startSameWorkFanout({
      providers,
      prompt: opts.prompt,
      base: {
        cwd,
        isolateWorkspace: opts.isolateWorkspace,
        name: opts.name,
      },
      create: (input) => api.createSession(input),
      send: async (id, text) => {
        const ok = await actions.sendTo(id, text)
        if (!ok) throw new Error(t('session.newSession.fanout.sendFailed'))
      },
    })
    if (result.created.length === 0) {
      return { ok: false, error: result.failed[0]?.error || t('session.newSession.fanout.allFailed') }
    }
    set({ modalOpen: false, modalCwd: null })
    await actions.refreshSessions()
    if (result.firstId) actions.selectSession(`dm:${result.firstId}`)
    if (result.failed.length > 0) {
      const n = String(result.failed.length)
      const detail = result.failed.map((f) => f.error).filter(Boolean).join(' · ')
      set({ error: detail ? t('session.newSession.fanout.partial', { n, detail }) : t('session.newSession.fanout.partialNoDetail', { n }) })
    }
    return { ok: true }
  },

  openSettings: () => {
    set({ settingsOpen: true })
    void loadVapid()
  },
  closeSettings: () => set({ settingsOpen: false }),

  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),

  // 현재 이 기기의 구독 여부를 SW에서 조회해 pushEnabled 동기화.
  async refreshPushState() {
    void loadVapid()
    if (!pushSupported()) return
    try {
      const reg = await swReady()
      const sub = await reg.pushManager.getSubscription()
      set({ pushEnabled: !!sub })
    } catch {
      /* SW 미준비/타임아웃 — 무시 */
    }
  },

  // 푸시 켜기: 알림 권한 요청 → VAPID 구독 → 서버 저장.
  async enablePush() {
    if (!pushSupported()) return set({ error: t('core.push.unsupported') })
    if (!state.vapidPublic) return set({ error: t('core.push.noVapid') })
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') return set({ error: t('core.push.denied') })
      const reg = await swReady()
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.vapidPublic) as BufferSource,
      })
      try {
        await api.subscribePush(sub.toJSON())
      } catch (e) {
        await sub.unsubscribe().catch(() => { /* 실패한 구독의 정리이므로 이미 해제됐어도 원래 오류 처리를 계속한다. */ }) // 서버 저장 실패 → SW 구독 롤백(UI on인데 서버 모르는 불일치 방지)
        throw e
      }
      set({ pushEnabled: true })
    } catch (e) {
      // 알림 권한 거부·미지원은 사용자의 브라우저 정책이며 화면 안내만 유지한다.
      if (e instanceof DOMException && ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(e.name)) markErrorReported(e)
      set({ error: t('core.push.enableFailed') + errMsg(e) })
    }
  },

  // 푸시 끄기: SW 구독 먼저 해제 후 서버 제거. 실패 시 실제 상태로 재동기화.
  async disablePush() {
    try {
      const reg = await swReady()
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await sub.unsubscribe() // SW 먼저 확실히 해제(여기 실패 시 아래 set 미실행 → 거짓 off 방지)
        await api.unsubscribePush(sub.endpoint).catch(() => { /* 제거할 서버 구독이 없어도 브라우저 구독 해제는 완료됐다. */ }) // 서버 제거 실패는 무해(만료로 정리)
      }
      set({ pushEnabled: false })
    } catch (e) {
      // 브라우저가 구독 관리를 거절한 경우에도 기존 오류 안내와 재동기화를 유지한다.
      if (e instanceof DOMException && ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(e.name)) markErrorReported(e)
      set({ error: t('core.push.disableFailed') + errMsg(e) })
      void actions.refreshPushState() // 실제 SW 상태로 재동기화
    }
  },

  openModal: (opts?: { cwd?: string }) => {
    const cwd = typeof opts?.cwd === 'string' ? opts.cwd.trim() : ''
    set({ modalOpen: true, modalCwd: cwd || null })
  },
  closeModal: () => set({ modalOpen: false, modalCwd: null }),
  requestDelete: (s: SessionListItem) => set({ deleteTarget: s, deleteMode: 'delete' }),
  requestReset: (s: SessionListItem) => set({ deleteTarget: s, deleteMode: 'reset' }),
  requestDiscard: (s: SessionListItem) => set({ deleteTarget: s, deleteMode: 'discard' }),
  cancelDelete: () => set({ deleteTarget: null }),
  openContextMenu: (menu: NonNullable<State['contextMenu']>) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  openRename: (id: string, name: string) => set({ renameTarget: { id, name } }),
  closeRename: () => set({ renameTarget: null }),

  // ── 다음 작업으로 넘기기 ── 서버가 끝까지 진행하고, 화면은 창을 띄우고 결과를 받아 칸을 바꾸기만 한다.
  openHandoff: (sessionId: string) => set({ handoffSheet: { sessionId, mode: 'form' } }),
  openHandoffResult: (sessionId: string) => set({ handoffSheet: { sessionId, mode: 'result' } }),
  closeHandoff: () => set({ handoffSheet: null }),
  /** 시작. 쓰는 중이면 창을 닫고, 한도 대기면 창을 '대기' 화면으로 바꾼다. 결과는 실시간 갱신으로 온다. */
  async startHandoff(sessionId: string, body: HandoffRequestBody): Promise<{ ok: true } | { ok: false; error: string }> {
    // 결과는 요청이 돌아오기 전에 실시간 갱신으로 먼저 올 수 있으니, 보내기 전에 이 탭이 시작했다고 적는다.
    //   다른 기기에서 시작한 넘기기는 건드리지 않는다. 실패하면 지운다.
    const was = myHandoffs.has(sessionId)
    myHandoffs.add(sessionId)
    try {
      const r = await api.startHandoff(sessionId, body)
      set({ handoffSheet: r.state === 'waiting_limit' ? { sessionId, mode: 'waiting' } : null })
      return { ok: true }
    } catch (e) {
      if (!was) myHandoffs.delete(sessionId)
      return { ok: false, error: errMsg(e) }
    }
  },

  // 범용 확인 다이얼로그 — 브라우저 confirm() 대체.
  showConfirm: (opts: { tone?: 'danger' | 'warn' | 'neutral'; icon?: LucideIcon; title: string; message: string; confirmLabel?: string; onConfirm: () => void }) =>
    set({ dialog: { tone: opts.tone ?? 'danger', icon: opts.icon, title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel, onConfirm: opts.onConfirm } }),
  closeDialog: () => set({ dialog: null }),
  openUpdateProgress: (p: NonNullable<State['updateProgress']>) => set({ updateProgress: p }),
  closeUpdateProgress: () => set({ updateProgress: null }),
  toggleDrawer: (open?: boolean) => set({ drawerOpen: open ?? !state.drawerOpen }),
  clearError: () => set({ error: null }),
  showError: (message: string) => set({ error: message }),
  // 알리기만 하는 소식은 가운데 창으로 막지 않고 위에 잠깐 띄운다(apple-design: 정보만 주는 창은 쓰지 않는다).
  showNotice: (notice: Notice) => set({ notice, noticeSeq: state.noticeSeq + 1 }),
  clearNotice: () => set({ notice: null }),

  // ── Agent Brain(7e) ──
  openBrain(tab?: BrainTab) {
    set({
      brainOpen: true,
      brainTab: tab ?? 'hub',
      brainOpenNonce: state.brainOpenNonce + 1,
      drawerOpen: false,
    })
  },
  closeBrain() {
    brainSearch.cancel()
    set({
      brainOpen: false,
      kSearch: { query: '', sort: 'relevance', results: [], status: 'idle', fromTs: '', toTs: '' },
    })
  },
  setBrainTab(tab: BrainTab) {
    if (tab === state.brainTab) return
    if (state.brainTab === 'search') brainSearch.cancel()
    set({
      brainTab: tab,
      ...(state.kSearch.status === 'loading' && tab !== 'search'
        ? { kSearch: { ...state.kSearch, status: 'idle' as const, results: [] } }
        : {}),
    })
  },

  runSearch(query: string, sort?: 'relevance' | 'recent' | 'oldest') {
    const sortV = sort ?? state.kSearch.sort
    const q = query.trim()
    const filters = {
      fromTs: state.kSearch.fromTs || '',
      toTs: state.kSearch.toTs || '',
    }
    if (!q) {
      brainSearch.cancel()
      set({ kSearch: { query, sort: sortV, results: [], status: 'idle', ...filters } })
      return
    }
    set({ kSearch: { query, sort: sortV, results: [], status: 'idle', ...filters } })
    brainSearch.schedule({ query, sort: sortV, ...filters }, (request, token) => { void executeBrainSearch(request, token) })
  },
  setSearchSort(sort: 'relevance' | 'recent' | 'oldest') {
    void actions.runSearch(state.kSearch.query, sort)
  },
  setSearchFilters(patch: {
    fromTs?: string
    toTs?: string
  }) {
    const next = {
      ...state.kSearch,
      fromTs: patch.fromTs ?? state.kSearch.fromTs ?? '',
      toTs: patch.toTs ?? state.kSearch.toTs ?? '',
    }
    set({ kSearch: next })
    if (next.query.trim()) void actions.runSearch(next.query, next.sort)
  },
  openSessionAt(sessionId: string, seq: number, hit?: SearchHit) {
    // 결과 클릭으로 팝업이 닫히는 것도 '닫힘' — 검색도 초기화(닫으면 빈값 규칙과 일관).
    brainSearch.cancel()
    set({
      brainOpen: false,
      kSearch: { query: '', sort: 'relevance', results: [], status: 'idle', fromTs: '', toTs: '' },
    })
    const roomId = hit?.sessionId ?? sessionId
    actions.selectSession(roomId)
    set({ jumpToSeq: { id: roomId, seq, nonce: Date.now() } })
  },

  // 세션 내 찾기 바(Ctrl+K) — 지금 클릭한 세션 대화 안에서 검색·점프.
  closeFind: () => set({ findOpen: false }),
  toggleFind: () => chromeId() && set({ findOpen: !state.findOpen }),
  // 사용자 말만 위·아래로 옮긴다. 더 위가 아직 안 불려 왔으면 한 페이지만 더 읽는다.
  async jumpUser(dir: -1 | 1) {
    const id = chromeId()
    if (!id) return
    const cursor = userCursor.has(id) ? (userCursor.get(id) ?? null) : null
    let next = stepUserSeq(userSeqsOf(state.convos[id] ?? []), cursor, dir)
    if (next == null && dir < 0 && state.older[id]?.hasOlder && !state.older[id]?.loading) {
      const loaded = await actions.loadOlder(id)
      if (loaded) next = stepUserSeq(userSeqsOf(state.convos[id] ?? []), cursor, dir)
    }
    if (next == null) return
    userCursor.set(id, next)
    actions.jumpInSession(next)
  },

  async exportTranscript(id: string) {
    if (!id) return
    try {
      const page = await api.getEvents(id, { before: Number.MAX_SAFE_INTEGER, from: 0 })
      const labels =
        state.locale === 'en'
          ? {
              user: 'User',
              images: (count: number) => (count === 1 ? '1 image' : `${count} images`),
              tool: (name: string, target?: string) => (target ? `Tool: ${name} ${target}` : `Tool: ${name}`),
            }
          : transcriptLabelsKo
      const markdown = eventsToMarkdown(page.events, labels)
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `conversation-${id.slice(0, 8)}.md`
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  requestRewind(execId: string, seq: number) {
    if (!execId || seq <= 0) return
    const items = state.convos[execId]
    const turn = sessionTurn(state, execId)
    if (turn === 'running' || turn === 'requires_action' || turn === 'operation' || pendingPermission(items) || pendingQuestion(items) || pendingPlan(items) || pendingQuestionnaire(items)) {
      actions.showNotice({ title: t('session.rewind.busy') })
      return
    }
    actions.showConfirm({
      tone: 'warn',
      title: t('session.rewind.title'),
      message: t('session.rewind.message'),
      confirmLabel: t('session.rewind.confirm'),
      onConfirm: () => {
        void actions.rewind(execId, seq)
      },
    })
  },

  async rewind(execId: string, seq: number) {
    try {
      const result = await api.rewind(execId, seq)
      const ranges = hiddenRanges[execId] ?? (hiddenRanges[execId] = [])
      ranges.push({ after: result.after, until: result.until })
      const kept = (state.convos[execId] ?? []).filter((item) => !hiddenSeq(execId, item.seq))
      // 서버가 숨김 범위 밖에 남긴 완료와 같은 순번이다. 새로고침하면 그 사건이 다시 온다.
      const arr = withRewindIdle(kept, result.idleSeq)
      set({ convos: { ...state.convos, [execId]: arr } })
      if (result.skipped.length) {
        actions.showNotice({
          title: t('session.rewind.skippedTitle'),
          message: result.skipped.map((item) => item.path).join(', '),
        })
      }
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  // 지금 클릭한 세션 내 특정 seq로 점프(Stream이 스크롤+플래시). 세션 전환 없음.
  // id를 주면 그 칸의 세션으로 간다(분할 화면에서 지금 고른 칸이 아닐 수 있다).
  jumpInSession(seq: number, id: string | null = chromeId()) {
    if (!id) return
    set({ jumpToSeq: { id, seq, nonce: Date.now() } })
  },

  // 유저 메시지 재전송·편집 — 컴포저에 텍스트를 채운다(Composer가 관측해 로드+포커스). 실제 전송은 사용자가.
  //   id를 동봉 → 채운 직후 세션 전환 시 다른 세션 컴포저·드래프트에 오염되는 것 방지(Composer에서 id 검증).
  editMessage(text: string, sessionId?: string) {
    const id = paneTargetId(sessionId)
    if (!text || !id) return
    set({ composerFill: { id, text, nonce: Date.now() } })
  },

  focusPane(id: string) {
    if (!sessionVisible(id) || state.focusedId === id) return
    set({ focusedId: id, focusOrder: noteFocus(state.focusOrder, id, paneIds(state.activeId, state.sideIds)) })
    applyChromeFacets(chromeId())
  },

  openBeside(id: string) {
    const room = findRoom(state.rooms, id)
    if (!room || room.status === 'corrupted') return
    if (!state.isWide) {
      actions.selectSession(id)
      return
    }
    const decided = decideOpenBeside(id, state.activeId, state.sideIds, state.focusedId, paneCapNow(), state.focusOrder)
    if (!decided.ok) return
    const victim = besideVictimIndex(id, state.activeId, state.sideIds, state.focusedId, paneCapNow(), state.focusOrder)
    commitPanes(decided)
    const n = visibleIds().indexOf(id) + 1
    if (victim != null) actions.showNotice({ title: t('nav.split.replacingToast', { n: victim + 1 }) })
    if (n > 0) announcePane(t('nav.split.openedAt', { n }))
  },

  /** 칸 자리를 한 칸 옮긴다(delta -1 왼쪽, +1 오른쪽). 옮긴 칸에 포커스를 준다. */
  movePane(id: string, delta: -1 | 1) {
    if (state.zoomedId) return // 확대 중에는 보이지 않는 순서를 바꾸지 않는다
    const order = paneIds(state.activeId, state.sideIds)
    const next = movePane(order, id, delta, visibleIds().length)
    reorderPanes(order, next, id, () => t('nav.split.movedTo', { n: visibleIds().indexOf(id) + 1 }))
  },

  /** 두 칸의 자리를 맞바꾼다. */
  swapPane(id: string, otherId: string) {
    const order = paneIds(state.activeId, state.sideIds)
    reorderPanes(order, swapPanes(order, id, otherId), id, () =>
      t('nav.split.swapped', { a: visibleIds().indexOf(id) + 1, b: visibleIds().indexOf(otherId) + 1 }),
    )
  },

  /** 칸 id의 자리에 다른 세션을 놓는다. 그 세션이 이미 칸에 있으면 자리를 맞바꾼다. */
  replacePaneSession(id: string, nextId: string) {
    const room = findRoom(state.rooms, nextId)
    if (!room || room.status === 'corrupted') return
    const order = paneIds(state.activeId, state.sideIds)
    reorderPanes(order, replacePane(order, id, nextId), nextId, () =>
      t('nav.split.replacedAt', { n: visibleIds().indexOf(nextId) + 1 }),
    )
  },

  setHandListOpen: (open: boolean) => set({ handListOpen: open }),

  toggleSidebarCollapsed() {
    const next = !state.sidebarCollapsed
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      sidebarWriteFailure.reset()
    } catch (error) {
      sidebarWriteFailure.report(error)
      /* 저장 불가 */
    }
    set({ sidebarCollapsed: next })
  },

  /** 칸 임시 확대/해제. 보이는 칸이 둘 이상일 때만 확대하고, 확대할 칸에 포커스를 준다. */
  toggleZoom(id: string) {
    const next = toggleZoomed(state.zoomedId, id, visibleIds())
    if (next === state.zoomedId) return
    if (next && state.focusedId !== next) {
      set({ focusedId: next, focusOrder: noteFocus(state.focusOrder, next, paneIds(state.activeId, state.sideIds)) })
      applyChromeFacets(chromeId())
    }
    set({ zoomedId: next })
  },

  closePane(id: string) {
    commitPanes(decideClosePane(id, state.activeId, state.sideIds, state.focusedId))
  },

  // ── provider 원격 재인증(중계) ── 8d-3 ④에서 Claude 고정을 풀었다. 어느 provider를 다시 로그인할지는
  //    설정 화면이 카탈로그 목록에서 골라 넘긴다(문구도 그 provider의 표시 이름으로 채운다).
  openProviderAuth: (provider: string) =>
    set({ providerAuth: { provider, open: true, phase: 'idle', loginId: null, url: null, userCode: null, message: null }, settingsOpen: false, drawerOpen: false }),
  closeProviderAuth: () => {
    const la = state.providerAuth
    if (la.loginId && la.phase !== 'success') void api.providerAuthCancel(la.provider, la.loginId).catch(() => { /* 닫힌 로그인은 정리할 대상이 없어도 된다. */ }) // 미완 로그인 프로세스 정리
    set({ providerAuth: { ...state.providerAuth, open: false, phase: 'idle', loginId: null, url: null, userCode: null, message: null } })
  },
  async startProviderAuth() {
    const before = state.providerAuth
    const provider = before.provider
    if (!provider) return
    // submit 실패 뒤 재시도라면 이전 로그인 프로세스를 먼저 닫는다. 그대로 새 start를 열면 provider마다
    // 로그인 프로세스가 겹쳐 남고, 늦게 온 응답이 새 모달 상태를 덮을 수 있다.
    if (before.loginId) await api.providerAuthCancel(provider, before.loginId).catch(() => { /* 이전 로그인이 이미 끝났으면 새 로그인 준비를 계속한다. */ })
    if (!state.providerAuth.open || state.providerAuth.provider !== provider) return
    set({ providerAuth: { provider, open: true, phase: 'starting', loginId: null, url: null, userCode: null, message: null } })
    try {
      const started = await api.providerAuthStart(provider)
      const { loginId, url } = started
      // 시작 중 닫았거나 다른 provider를 열었으면 이 응답은 stale이다. UI를 다시 열지 말고 방금 생긴
      // 서버 로그인 프로세스까지 정리한다.
      if (!state.providerAuth.open || state.providerAuth.provider !== provider || state.providerAuth.phase !== 'starting') {
        void api.providerAuthCancel(provider, loginId).catch(() => { /* 늦게 온 로그인 응답은 정리 대상이 없어도 버린다. */ })
        return
      }
      // 로그인 방식이 둘이다(8f). 코드를 우리가 받아야 하는 쪽(Claude)과, 서버가 코드를 주고 사용자가
      //   저쪽 화면에서 끝내는 쪽(Codex 기기 코드). 뒤쪽은 되돌려 보낼 코드가 없고 완료가 나중에 오므로
      //   화면은 코드를 보여 주고 완료를 주기적으로 확인한다.
      if (started.mode === 'deviceCode') {
        set({ providerAuth: { provider, open: true, phase: 'awaiting_device', loginId, url, userCode: started.userCode ?? null, message: null } })
        void actions.watchProviderAuth(provider, loginId)
        return
      }
      set({ providerAuth: { provider, open: true, phase: 'awaiting_code', loginId, url, userCode: null, message: null } })
    } catch (e) {
      if (state.providerAuth.open && state.providerAuth.provider === provider && state.providerAuth.phase === 'starting') {
        set({ providerAuth: { ...state.providerAuth, phase: 'error', message: errMsg(e) } })
      }
    }
  },
  /**
   * 기기 코드 로그인이 끝났는지 주기적으로 확인한다(8f).
   *
   * 완료가 서버 쪽 알림으로 오는데, 브라우저로 실시간으로 밀어 주는 통로는 대화 세션마다 붙는 것이고
   * 로그인은 세션 밖에서 일어난다. 그래서 화면이 물어보는 방식으로 맞췄다.
   * 모달을 닫거나 다른 로그인을 시작하면 이 반복은 스스로 멈춘다.
   */
  async watchProviderAuth(provider: string, loginId: string) {
    const mine = () => state.providerAuth.open && state.providerAuth.provider === provider && state.providerAuth.loginId === loginId
    // 실패가 이어지면 그만둔다. 안 그러면 서버가 껐거나 경로가 사라진 경우처럼 **절대 낫지 않을 실패**를
    //   화면이 영원히 되물으면서 "기다리는 중"만 띄운다. 일시적 끊김은 몇 번 더 시도해 넘긴다.
    let failures = 0
    while (mine()) {
      await new Promise((r) => setTimeout(r, 2500))
      if (!mine()) return
      let r: { status: 'pending' | 'success' | 'error'; message?: string }
      try {
        r = await api.providerAuthPoll(provider, loginId)
        failures = 0
      } catch (e) {
        if (++failures < 5) continue // 일시적인 통신 실패로 로그인을 접지 않는다
        if (mine()) set({ providerAuth: { ...state.providerAuth, phase: 'error', message: errMsg(e) } })
        return
      }
      if (!mine() || r.status === 'pending') continue
      set({ providerAuth: { ...state.providerAuth, phase: r.status === 'success' ? 'success' : 'error', message: r.message ?? null } })
      return
    }
  },
  async submitProviderAuthCode(code: string) {
    const la = state.providerAuth
    if (!la.loginId || !la.provider || !code.trim()) return
    const { provider, loginId } = la
    set({ providerAuth: { ...state.providerAuth, phase: 'submitting', message: null } })
    try {
      const r = await api.providerAuthCode(provider, loginId, code.trim())
      if (!state.providerAuth.open || state.providerAuth.provider !== provider || state.providerAuth.loginId !== loginId) return
      if (r.status === 'success') set({ providerAuth: { ...state.providerAuth, phase: 'success', message: r.message } })
      else if (r.status === 'invalid_code') set({ providerAuth: { ...state.providerAuth, phase: 'awaiting_code', message: r.message } })
      else set({ providerAuth: { ...state.providerAuth, phase: 'error', message: r.message } })
    } catch (e) {
      if (state.providerAuth.open && state.providerAuth.provider === provider && state.providerAuth.loginId === loginId) {
        set({ providerAuth: { ...state.providerAuth, phase: 'error', message: errMsg(e) } })
      }
    }
  },
}

/**
 * provider 표시 이름 — 서버 목록에 있으면 그 이름, 없으면 id 그대로.
 * 문구에 "Claude"를 박지 않기 위한 출처다(8d-3 ④). 목록이 아직 안 왔으면 id가 그대로 보인다.
 */
export function providerName(s: State, provider: string | undefined): string {
  if (!provider) return ''
  return s.providers?.find((p) => p.id === provider)?.displayName || provider
}

/** 지금 열린 세션의 provider id. 열린 세션이 없으면 빈 문자열(목록 첫 항목으로 짐작하지 않는다). */
export function activeProviderId(s: State): string {
  return s.sessions.find((x) => x.id === chromeSessionId(s))?.provider ?? ''
}

/** 활성 세션의 provider 표시 이름 — 인증 만료 안내처럼 "지금 이 세션의 서비스"를 가리키는 문구용. */
export function activeProviderName(s: State): string {
  return providerName(s, activeProviderId(s))
}

/**
 * 새 세션을 만들 때 미리 골라 둘 서비스 (8h).
 *
 * 지금 열려 있는 세션과 같은 서비스를 기본으로 둔다 — 대개 하던 일을 이어서 하나 더 여는 것이기 때문이다.
 * 열린 세션이 없거나 그 서비스가 서버 목록에 없으면 등록된 첫 서비스로 떨어진다. 이는 시작 값일 뿐이고,
 * 새 작업 창이 쓸 수 있는 서비스인지 보고 실제로 시작할 서비스를 정한다(newSessionProviderView).
 * 목록 자체가 아직 안 왔으면 빈 문자열이다(화면이 이름을 지어내지 않는다).
 */
/**
 * 새 작업 창이 처음 고를 폴더 후보(절대 경로, 앞이 우선). 지금 보는 세션의 폴더, 그다음 최근 활동 순 폴더.
 * 후보가 루트 밖일 수 있어서 하나로 정하지 않는다. 창이 루트 이름을 안 뒤에 첫 쓸 만한 후보를 고른다.
 */
export function newSessionFolderCandidates(s: State): string[] {
  const active = s.sessions.find((x) => x.id === chromeSessionId(s))
  const keys = groupSessions(s.sessions).map((g) => g.key)
  return active ? [projectKey(active), ...keys] : keys
}

export function defaultNewSessionProvider(s: State): string {
  const list = s.providers ?? []
  const active = s.sessions.find((x) => x.id === chromeSessionId(s))?.provider
  if (active && list.some((p) => p.id === active)) return active
  return list[0]?.id ?? ''
}

/**
 * 이 서비스에 다시 로그인할 수 있나 (8h).
 *
 * 인증 만료 안내의 "재인증" 버튼이 이 값을 본다. 눌러도 아무것도 못 하는 버튼을 그리면 사용자는
 * 고칠 방법이 있다고 믿고 시간을 버린다. 그래서 **못 한다는 것을 아는 경우에만** 감춘다.
 *   - 서버가 원격 재로그인을 통째로 껐으면 확실히 못 한다.
 *   - 그 서비스에 인증 구현이 없다고 서버가 말했으면 확실히 못 한다.
 *   - 서비스 목록을 아직 못 받았으면 모른다 — 그때는 감추지 않는다(유일한 복구 통로를 없애지 않는다).
 */
export function canReauthProvider(s: State, provider: string): boolean {
  if (!s.reloginEnabled) return false
  const entry = s.providers?.find((p) => p.id === provider)
  return entry ? entry.authSupported : true
}

/**
 * 세션 카드·상단바에 서비스 이름을 달까 (8h).
 *
 * 등록된 서비스가 하나뿐이면 모든 세션이 같은 서비스라 꼬리표가 정보를 하나도 더하지 않는다.
 * 둘 이상일 때만 단다 — 그때부터는 "이 세션이 무엇으로 도는가"가 매번 다를 수 있는 사실이 된다.
 */
export function showProviderTag(s: State): boolean {
  return (s.providers?.length ?? 0) > 1
}

/**
 * 승인 정책 배지의 강도. 전면 우회는 세션의 권한 모드(full)뿐 아니라 provider가 계산한 실효 정책에서도
 * 올 수 있다(Claude의 `permissions.defaultMode=bypassPermissions` 등). 둘을 같은 강한 표시로 합친다.
 */
export function permissionBadgeKind(
  mode: PermissionMode | undefined,
  policy: PermissionPolicy | null,
): 'all' | 'partial' | null {
  if (mode === 'full' || policy?.bypassAll) return 'all'
  return policy && (policy.autoApproveRules > 0 || !!policy.autoApproveMode) ? 'partial' : null
}
