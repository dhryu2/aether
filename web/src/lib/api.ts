import { isExpectedClientError, reportClientError, markErrorReported } from './errorReporting'
// REST 호출. 응답 모양은 shared/http.ts · shared/brain.ts. 모든 경로 /api.
import type {
  AetherEvent,
  ImageAttachment,
  DocAttachment,
  ModelInfo,
  PermissionPolicy,
  PermissionRequest,
  ProvidersResponse,
  AccountUsageResponse,
  ProviderAvailabilityResponse,
  RememberedModelsResponse,
  QuestionnaireAnswerValue,
  WorkspaceListResponse,
  SlashCommandInfo,
  CommandExecutionResult,
  UsageResponse,
  FsListing,
  FsPlaces,
} from './types'
import type { DeletedSessionRow, SearchHit } from './brain'
import type { FileTraceResponse, ProjectRecapResponse, ReviewDetailResponse, ReviewFileDiffResponse, ReviewListResponse, ReviewMarkResponse, ReviewRequestBody, ReviewRequestResponse } from '@shared/brain'
import type { WorkspaceFileResponse, WorkspaceFilesResponse, PermissionMode, PermissionModesResponse, AutoResumePlan, AutoResumeSettings, HandoffInfo, HandoffRequestBody, BackupItem, BackupListResponse, AuthDevicesResponse, ChangePasswordResponse, EventsPageResponse, ServerInfoResponse, ServerLogLevel, RemoteAccessResponse, ServerLogResponse, UpdateStatusResponse } from '@shared/http'
import type { ErrorGroupDetailResponse, ErrorGroupListResponse, ErrorLogPeriod, ErrorLogSource } from '@shared/errors'
import { authHeaders } from './clientAuth'

export const REQUEST_TIMEOUT_DEFAULT_MS = 30_000
export const REQUEST_TIMEOUT_MAX_MS = 300_000

/**
 * fetch 대기 상한. 작은 JSON은 30초(FE-05: pendingSend 영구 고착 차단).
 * 이미지 첨부는 base64 JSON이 수 MB라, 30초면 업로드 도중에 클라이언트가 끊는다.
 * 본문 길이를 10바이트/ms(≈10KB/s)로 환산해 늘리고 5분에서 자른다.
 */
export function requestTimeoutMs(body: unknown, overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs
  const n = typeof body === 'string' ? body.length : 0
  return Math.min(REQUEST_TIMEOUT_MAX_MS, Math.max(REQUEST_TIMEOUT_DEFAULT_MS, REQUEST_TIMEOUT_DEFAULT_MS + Math.ceil(n / 10)))
}

export class RequestTimeoutError extends Error {
  override name = 'RequestTimeoutError'
  readonly errorOrigin = 'external_environment'
  constructor() {
    super('request timeout')
  }
}

function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/** REST와 직접 여는 스트림이 같은 네트워크 판정을 쓴다. 오류 문구 규칙은 이 경계에만 둔다. */
export function classifyTransportError(e: unknown): unknown {
  const error = e
  const network = (e instanceof DOMException && e.name === 'NetworkError') ||
    (e instanceof TypeError && /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(e.message))
  if (error && typeof error === 'object' && network) {
    markErrorReported(error)
    return Object.assign(error, { errorOrigin: 'external_environment' })
  }
  return error
}

/** 직접 fetch하는 화면도 서버의 기록 완료·정상 거절 표시를 그대로 재사용한다. */
export function reportApiResponseError(err: Error, res: Response) {
  const origin = res.headers.get('X-Aether-Error-Origin')
  if (res.headers.get('X-Aether-Error-Recorded') === '1' || res.status < 500 || origin === 'external_environment' || origin === 'user_action') markErrorReported(err)
  else reportClientError(err, { component: 'api', operation: 'api.response', request_id: res.headers.get('X-Request-Id') ?? undefined })
}

const decodeFailures = new Set<string>()

type ReqInit = Omit<RequestInit, 'signal'> & { timeoutMs?: number }

async function req<T>(url: string, init?: ReqInit): Promise<T> {
  // 타임아웃 — 네트워크 무응답 시 fetch가 영원히 await되어 send()의 pendingSend가 영구 고착되는 것 차단(FE-05).
  const ctrl = new AbortController()
  const timeoutMs = requestTimeoutMs(init?.body, init?.timeoutMs)
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    const { timeoutMs: _timeoutMs, headers: initHeaders, ...rest } = init ?? {}
    void _timeoutMs
    const headers: Record<string, string> = {
      ...authHeaders(),
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
    }
    if (initHeaders) {
      const h = new Headers(initHeaders)
      h.forEach((v, k) => {
        headers[k] = v
      })
    }
    res = await fetch(url, {
      credentials: 'same-origin',
      ...rest,
      headers,
      signal: ctrl.signal,
    })
  } catch (e) {
    const error = isAbortError(e) ? new RequestTimeoutError() : classifyTransportError(e)
    reportClientError(error, { component: 'api', operation: 'api.transport' })
    throw error
  } finally {
    clearTimeout(to)
  }
  if (!res.ok) {
    let body: { error?: string } | null
    try {
      body = (await res.json()) as { error?: string }
    } catch {
      // JSON이 아닌 실패 응답은 HTTP 상태 번호와 상태 문구를 그대로 표시한다.
      body = null
    }
    const detail = body?.error ?? ''
    const err = new Error(detail || `${res.status} ${res.statusText}`) as Error & { status?: number }
    err.status = res.status
    reportApiResponseError(err, res)
    throw err
  }
  const resource = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
  try {
    const body = res.status === 204 ? (undefined as T) : ((await res.json()) as T)
    decodeFailures.delete(resource)
    return body
  } catch (e) {
    const error = classifyTransportError(e)
    if (!decodeFailures.has(resource)) {
      reportClientError(error, { component: 'api', operation: 'web.response.decode', request_id: res.headers.get('X-Request-Id') ?? undefined })
      // 같은 응답 경로의 손상이 이어지면 첫 건만 기록하고 성공 때 해제한다.
      if (!isExpectedClientError(error)) {
        if (decodeFailures.size >= 1000) decodeFailures.delete(decodeFailures.values().next().value!)
        decodeFailures.add(resource)
      }
    } else if (error && typeof error === 'object') markErrorReported(error)
    throw error
  }
}

export const api = {
  health: () => req<{ ok: boolean; version?: string; auth?: 'off' | 'tailscale' | 'password'; setup?: boolean }>('/api/health'),
  // 첫 설정 서버 전용. 평소 서버에는 없다(404).
  setupDefaults: () => req<{ port: number; dataDir: string; projectRoot: string; termsUrl: string }>('/api/setup/defaults'),
  setupPickFolder: () => req<{ path: string | null }>('/api/setup/pick-folder', { method: 'POST' }),
  setupComplete: (body: { terms: boolean; password: string; port: number; dataDir: string; projectRoot: string }) =>
    req<{ ok: true; port: number }>('/api/setup/complete', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => req<unknown>('/api/auth/logout', { method: 'POST' }),
  login: (password: string) =>
    req<{ ok: true; token?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  pushVapid: () => req<{ vapidPublic?: string }>('/api/push/vapid'),

  // 오류 기록 조회(설정 > 점검). 목록은 지문별 묶음, 상세는 묶음 하나의 최근 행.
  errorGroups: (q: { since: ErrorLogPeriod; source: ErrorLogSource; cursor?: string }) =>
    req<ErrorGroupListResponse>('/api/errors?' + new URLSearchParams({ since: q.since, source: q.source, ...(q.cursor ? { cursor: q.cursor } : {}) })),
  errorGroup: (fingerprint: string, q: { since: ErrorLogPeriod; source: ErrorLogSource }) =>
    req<ErrorGroupDetailResponse>(`/api/errors/${encodeURIComponent(fingerprint)}?` + new URLSearchParams(q)),

  // UI 언어 통지 — 서버가 LLM 프롬프트·푸시 알림을 이 언어로 생성하도록 동기화. 단일사용자라 서버 전역 로케일.
  // 자동 재개(한도가 풀리면 이어 가기). 옛 서버에는 없어 404가 올 수 있다 — 호출하는 쪽이 견딘다.
  getAutoResumeSettings: () => req<AutoResumeSettings>('/api/auto-resume'),
  putAutoResumeSettings: (patch: { enabled?: boolean; text?: string }) =>
    req<AutoResumeSettings>('/api/auto-resume', { method: 'PUT', body: JSON.stringify(patch) }),
  // 검색 결과 요약 스위치. 검색이 꺼진 서버에는 라우트가 없어 404가 온다 — 호출하는 쪽이 견딘다.
  getSearchSummary: () => req<{ enabled: boolean }>('/api/search/summary-setting'),
  putSearchSummary: (enabled: boolean) =>
    req<{ enabled: boolean }>('/api/search/summary-setting', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  // 세션 제목 자동 요약 스위치.
  getTitleSummary: () => req<{ enabled: boolean }>('/api/title-summary'),
  putTitleSummary: (enabled: boolean) =>
    req<{ enabled: boolean }>('/api/title-summary', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  // 쉬는 세션 잠재우기 대기 시간(분, 0은 끔). 서버가 허용한 값만 받는다.
  getIdleSleep: () => req<{ minutes: number; choices: number[] }>('/api/idle-sleep'),
  putIdleSleep: (minutes: number) =>
    req<{ minutes: number; choices: number[] }>('/api/idle-sleep', { method: 'PUT', body: JSON.stringify({ minutes }) }),
  editAutoResume: (id: string, patch: { at?: number; text?: string }) =>
    req<{ autoResume: AutoResumePlan }>(`/api/sessions/${id}/auto-resume`, { method: 'PUT', body: JSON.stringify(patch) }),
  cancelAutoResume: (id: string) => req<{ ok: true }>(`/api/sessions/${id}/auto-resume`, { method: 'DELETE' }),

  // 다음 작업으로 넘기기. 옛 서버에는 없어 404가 올 수 있다 — 호출하는 쪽이 견딘다.
  startHandoff: (id: string, body: HandoffRequestBody) =>
    req<{ state: 'writing' | 'waiting_limit' }>(`/api/sessions/${id}/handoff`, { method: 'POST', body: JSON.stringify(body) }),
  getHandoff: (id: string) => req<HandoffInfo>(`/api/sessions/${id}/handoff`),
  clearHandoff: (id: string) => req<{ ok: true }>(`/api/sessions/${id}/handoff`, { method: 'DELETE' }),

  getLocale: () => req<{ locale: 'ko' | 'en' }>('/api/locale'),
  setLocale: (locale: 'ko' | 'en') => req<{ ok: true }>('/api/locale', { method: 'POST', body: JSON.stringify({ locale }) }),

  systemInfo: () => req<ServerInfoResponse>('/api/system/info'),
  systemUpdate: () => req<UpdateStatusResponse>('/api/system/update'),
  remoteAccess: () => req<RemoteAccessResponse>('/api/system/remote-access'),
  enableRemoteAccess: () => req<RemoteAccessResponse>('/api/system/remote-access', { method: 'POST' }),
  disableRemoteAccess: () => req<RemoteAccessResponse>('/api/system/remote-access', { method: 'DELETE' }),
  // 앱 안 원클릭 업데이트. 설치는 202로 시작만 알리고, 진행은 상태 조회로 본다.
  checkUpdateNow: () => req<UpdateStatusResponse>('/api/system/update/check', { method: 'POST' }),
  // 화면이 보여 준 버전을 함께 보낸다. 서버가 서명된 최신 값과 같을 때만 설치한다.
  installUpdate: (version: string) => req<unknown>('/api/system/update/install', { method: 'POST', body: JSON.stringify({ version }) }),
  cancelUpdate: () => req<unknown>('/api/system/update/cancel', { method: 'POST' }),
  serverLogs: (q: { lines: number; level: ServerLogLevel }) =>
    req<ServerLogResponse>('/api/system/logs?' + new URLSearchParams({ lines: String(q.lines), level: q.level })),
  // DB 백업·복원(설정 > 백업). 복원은 예약만 하고 실제 교체는 다음 서버 시작 때 일어난다.
  backups: () => req<BackupListResponse>('/api/system/backups'),
  createBackup: () => req<{ item: BackupItem }>('/api/system/backups', { method: 'POST' }),
  scheduleRestore: (id: string) =>
    req<BackupListResponse>('/api/system/backups/restore', { method: 'POST', body: JSON.stringify({ id }) }),
  cancelRestore: () => req<BackupListResponse>('/api/system/backups/restore', { method: 'DELETE' }),
  changePassword: (current: string, next: string) =>
    req<ChangePasswordResponse>('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
  authDevices: () => req<AuthDevicesResponse>('/api/auth/devices'),
  signOutDevice: (id: string) => req<{ ok: true }>(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  signOutOtherDevices: () => req<ChangePasswordResponse>('/api/auth/devices/sign-out-others', { method: 'POST' }),

  // 백엔드 프로세스 재시작(process.exit(1) → launchd 재기동). 응답 직후 서버가 죽으므로 200을 받는 것 = 요청 접수 성공.
  restartServer: () => req<{ ok: true }>('/api/system/restart', { method: 'POST' }),

  subscribePush: (subscription: unknown) =>
    req<{ ok: true }>('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) }),
  unsubscribePush: (endpoint: string) =>
    req<{ ok: true }>('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),

  // provider 모델·effort 카탈로그(D12) — 모델 이름·effort 목록을 프론트에 박아두지 않기 위한 출처.
  //   라이브 세션이 있으면 그 세션의 /models가 더 정확하므로 그쪽이 우선이고, 이건 세션 없을 때의 정본이다.
  listProviders: () => req<ProvidersResponse>('/api/providers'),
  // 지금 고를 수 있는 서비스인지(프로그램 설치, 로그인, 모델 서버). 새 세션 창이 열릴 때마다 묻는다.
  providerAvailability: () => req<ProviderAvailabilityResponse>('/api/providers/availability'),
  // 서비스마다 프로그램을 띄워 읽을 수 있어 일반 요청보다 오래 기다린다.
  accountUsage: (fresh: boolean, provider?: string) => {
    const query = new URLSearchParams({ ...(fresh ? { fresh: '1' } : {}), ...(provider ? { provider } : {}) }).toString()
    return req<AccountUsageResponse>(`/api/providers/usage${query ? `?${query}` : ''}`, { timeoutMs: 60_000 })
  },
  // 세션이 뜰 때 저장해 둔 모델 목록. 서버가 provider 프로그램을 띄우지 않는다.
  rememberedModels: () => req<RememberedModelsResponse>('/api/providers/remembered-models'),

  listSessions: () => req<WorkspaceListResponse>('/api/sessions'),

  createSession: (body: { cwd?: string; provider: string; model?: string; resume?: string; permissionMode?: PermissionMode; isolateWorkspace?: boolean; name?: string }) =>
    req<{ id: string; cwd: string; model: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  sendMessage: (
    id: string,
    text: string,
    images?: ImageAttachment[],
    documents?: DocAttachment[],
    clientMessageId?: string,
    brief?: boolean,
    // 브리프 질문지 카드의 답. 있으면 서버가 열린 질문지를 닫고, 글은 서버가 답에서 만든다.
    questionnaire?: { id: string; answers: Record<string, QuestionnaireAnswerValue> },
  ) =>
    req<{ ok: true; duplicate?: boolean }>(`/api/sessions/${id}/message`, {
      method: 'POST',
      timeoutMs: 120_000,
      body: JSON.stringify({
        text,
        ...(images?.length ? { images } : {}),
        ...(documents?.length ? { documents } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        // 불리언 true만 보낸다. 문자열 "true"는 서버가 일반 전송으로 본다.
        ...(brief === true ? { brief: true } : {}),
        ...(questionnaire ? { questionnaire } : {}),
      }),
    }),

  // 잠든 세션 깨우기 — 모델에게 아무것도 묻지 않고 프로세스만 띄운다(토큰 0, 대화 기록 없음).
  //   깨어나야 모델 목록·슬래시 명령·승인 정책을 물을 수 있다. 이미 깨어 있으면 서버가 그냥 성공으로 답한다.
  //   spawn이 30초를 넘길 수 있어 타임아웃만 늘린다.
  wakeSession: (id: string) =>
    req<{ ok: true; alreadyAwake: boolean }>(`/api/sessions/${id}/wake`, { method: 'POST', timeoutMs: 120_000 }),

  interrupt: (id: string) => req<{ ok: true }>(`/api/sessions/${id}/interrupt`, { method: 'POST' }),

  // 백그라운드 작업 하나를 멈춘다. 메인 턴 중단(interrupt)과 달리 그 작업만 끝낸다.
  stopBackgroundTask: (id: string, taskId: string) =>
    req<{ ok: true }>(`/api/sessions/${id}/background-tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' }),

  rewindPreview: (id: string, seq: number) =>
    req<{ restore: string[]; skipped: { path: string; reason: string }[] }>(`/api/sessions/${id}/rewind-preview?seq=${seq}`),

  rewind: (id: string, seq: number, restoreFiles = false) =>
    req<{ restored: string[]; skipped: { path: string; reason: string }[]; after: number; until: number; idleSeq?: number }>(
      `/api/sessions/${id}/rewind`,
      { method: 'POST', body: JSON.stringify({ seq, restoreFiles }) },
    ),

  // purge면 검색 글자까지 지운다. 빼면 대화 기록(검색 글자)을 남긴다.
  deleteSession: (id: string, purge = false) =>
    req<{ ok: true; existed: boolean }>(`/api/sessions/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),

  renameSession: (id: string, name: string) =>
    req<{ ok: true; name: string }>(`/api/sessions/${id}/name`, { method: 'POST', body: JSON.stringify({ name }) }),

  archiveSession: (id: string, archived: boolean) =>
    req<{ ok: true; archivedAt?: number }>(`/api/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),

  setModel: (id: string, model: string) =>
    req<{ ok: true; model: string }>(`/api/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) }),

  setEffort: (id: string, effort: string) =>
    req<{ ok: true; effort: string }>(`/api/sessions/${id}/effort`, { method: 'POST', body: JSON.stringify({ effort }) }),

  setPermissionMode: (id: string, permissionMode: PermissionMode) =>
    req<{ ok: true; permissionMode: PermissionMode; deferred?: boolean }>(`/api/sessions/${id}/permissions`, { method: 'POST', body: JSON.stringify({ permissionMode }) }),

  getPermissionModes: (id: string) => req<PermissionModesResponse>(`/api/sessions/${id}/permission-modes`),

  getModels: (id: string) => req<{ models: ModelInfo[] }>(`/api/sessions/${id}/models`),

  getUsage: (id: string) => req<UsageResponse>(`/api/sessions/${id}/usage`),

  // 이전 이벤트 페이지(무한스크롤) — before 미만 구간. limit=꼬리 페이징, from=특정 seq까지 채우기(검색 점프).
  getEvents: (id: string, p: { before: number; limit?: number; from?: number }) =>
    req<EventsPageResponse>(
      `/api/sessions/${id}/events?before=${p.before}${p.limit != null ? `&limit=${p.limit}` : ''}${p.from != null ? `&from=${p.from}` : ''}`,
    ),
  getCommands: (id: string) => req<{ commands: SlashCommandInfo[] }>(`/api/sessions/${id}/commands`),
  executeCommand: (id: string, command: string, args: string) =>
    req<CommandExecutionResult>(`/api/sessions/${id}/commands`, {
      method: 'POST',
      timeoutMs: 120_000,
      body: JSON.stringify({ command, arguments: args }),
    }),
  getStats: () => req<{ dataBytes: number; sessions: number }>(`/api/sessions/stats`),

  resolvePermission: (id: string, permissionId: string, decision: 'allow' | 'deny') =>
    req<{ ok: true }>(`/api/sessions/${id}/permission`, {
      method: 'POST',
      body: JSON.stringify({ permissionId, decision }),
    }),
  getPendingPermissions: (id: string) => req<{ pending: PermissionRequest[] }>(`/api/sessions/${id}/permissions`),

  // answers[i] = i번째 질문에서 고른 **선택지 이름**들, custom[i] = 그 질문에 직접 적은 문장(없으면 null).
  //   서버가 answers를 제시된 선택지와 대조하므로 자유 입력을 여기 섞어 보내면 400이 된다(8d-3 ⑥ⓒ).
  resolvePlan: (id: string, planId: string, decision: 'approve' | 'revise' | 'cancel', message?: string) =>
    req<{ ok: true }>(`/api/sessions/${id}/plan`, {
      method: 'POST',
      body: JSON.stringify({ planId, decision, ...(message ? { message } : {}) }),
    }),

  applyWorkspace: (id: string) => req<{ ok: true }>(`/api/sessions/${id}/workspace/apply`, { method: 'POST' }),
  discardWorkspace: (id: string, force = false) =>
    req<{ ok: true }>(`/api/sessions/${id}/workspace/discard`, {
      method: 'POST',
      body: JSON.stringify(force ? { force: true } : {}),
    }),

  resolveQuestion: (id: string, questionId: string, answers: string[][], custom: (string | null)[]) =>
    req<{ ok: true }>(`/api/sessions/${id}/question`, {
      method: 'POST',
      body: JSON.stringify({ questionId, answers, custom }),
    }),

  // 이 세션에 실제 적용 중인 승인 정책 요약(8d-3 ⑥ⓕ) — 상단 배지의 출처. live 세션만 응답.
  getPermissionPolicy: (id: string) => req<PermissionPolicy>(`/api/sessions/${id}/permission-policy`),

  // provider 원격 재인증(중계) — 8d-3 ④에서 Claude 고정 경로(/api/claude-auth/*)를 지우고 provider별로 바꿨다.
  // mode(8f) = 로그인 방식. 'submitCode'는 우리가 코드를 받아 되돌려 보내야 하고(Claude),
  //   'deviceCode'는 서버가 주소와 코드를 함께 주고 사용자가 그 화면에서 끝낸다(Codex).
  providerAuthStart: (provider: string) =>
    req<{ mode: 'submitCode' | 'deviceCode'; loginId: string; url: string; userCode?: string }>(`/api/provider-auth/${provider}/start`, { method: 'POST' }),
  // 기기 코드 방식의 유일한 완료 통로 — 완료가 서버 쪽 알림으로 오기 때문이다.
  providerAuthPoll: (provider: string, loginId: string) =>
    req<{ status: 'pending' | 'success' | 'error'; message?: string }>(`/api/provider-auth/${provider}/poll`, {
      method: 'POST',
      body: JSON.stringify({ loginId }),
    }),
  providerAuthCode: (provider: string, loginId: string, code: string) =>
    req<{ status: 'success' | 'invalid_code' | 'error'; message: string }>(`/api/provider-auth/${provider}/code`, {
      method: 'POST',
      body: JSON.stringify({ loginId, code }),
    }),
  providerAuthCancel: (provider: string, loginId?: string) =>
    req<{ ok: true }>(`/api/provider-auth/${provider}/cancel`, { method: 'POST', body: JSON.stringify({ loginId }) }),

  fsPlaces: () => req<FsPlaces>('/api/fs/places'),
  fsList: (path: string, showHidden = false) =>
    req<FsListing>(`/api/fs/list?path=${encodeURIComponent(path)}&showHidden=${showHidden ? 1 : 0}`),

  // ── 작업 폴더 파일(읽기 전용) ──
  workspaceFiles: (id: string) => req<WorkspaceFilesResponse>(`/api/files/${encodeURIComponent(id)}`),
  workspaceFile: (id: string, path: string) => req<WorkspaceFileResponse>(`/api/files/${encodeURIComponent(id)}/content?path=${encodeURIComponent(path)}`),

  // ── 작업 검토함 ──
  reviewList: () => req<ReviewListResponse>('/api/review'),
  /** git=false면 서버가 git 상태를 건너뛴다(기록만 먼저 그릴 때). */
  reviewDetail: (id: string, git: boolean) => req<ReviewDetailResponse>(`/api/review/${encodeURIComponent(id)}${git ? '' : '?git=0'}`),
  /** 새 세션 빈 화면용: 같은 프로젝트 폴더의 최근 세션 요약. 옛 서버는 404를 준다. */
  reviewRecap: (project: string) => req<ProjectRecapResponse>(`/api/review/recap?project=${encodeURIComponent(project)}`),
  /** 이 파일(세션 작업 폴더 기준 경로)을 고친 같은 프로젝트의 세션들. 첫 조회가 8초까지 걸릴 수 있다. */
  reviewTrace: (id: string, path: string) =>
    req<FileTraceResponse>(`/api/review/trace?session=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`),
  reviewFileDiff: (id: string, path: string) =>
    req<ReviewFileDiffResponse>(`/api/review/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`),
  reviewDone: (id: string, seq: number) =>
    req<ReviewMarkResponse>(`/api/review/${encodeURIComponent(id)}/done`, { method: 'POST', body: JSON.stringify({ seq }) }),
  /** seq를 생략하면 검토 위치를 지운다. expected는 그 완료가 저장한 값이고, 지금 값과 다르면 서버가 409로 거절한다. */
  reviewUndo: (id: string, seq: number | undefined, expected: number | null) =>
    req<ReviewMarkResponse>(`/api/review/${encodeURIComponent(id)}/undo`, { method: 'POST', body: JSON.stringify({ ...(seq === undefined ? {} : { seq }), expected }) }),
  /** 다른 AI에게 검토 맡기기. 같은 폴더에 새 세션이 열리고 검토 요청 글이 그 입력창 초안으로 들어간다. */
  requestReview: (id: string, provider: string) =>
    req<ReviewRequestResponse>(`/api/review/${encodeURIComponent(id)}/request`, { method: 'POST', body: JSON.stringify({ provider } satisfies ReviewRequestBody) }),

  // ── Agent Brain(7e) ──
  /** 지운 세션의 대화 글 한 쪽(검색 색인, 읽기 전용). after는 앞 쪽 마지막 줄의 id. */
  deletedSessionPage: (id: string, after = 0) =>
    req<{ rows: DeletedSessionRow[] }>(`/api/search/session/${encodeURIComponent(id)}?after=${after}`),
  search: (
    q: string,
    opts?: {
      sort?: 'relevance' | 'recent' | 'oldest'
      sessionId?: string
      chatOnly?: boolean
      fromTs?: number
      toTs?: number
    },
  ) => {
    const sortMap = { relevance: '', recent: 'newest', oldest: 'oldest' } as const
    const p = new URLSearchParams({ q })
    if (opts?.sort && sortMap[opts.sort]) p.set('sort', sortMap[opts.sort])
    if (opts?.sessionId) p.set('sessionId', opts.sessionId)
    if (opts?.chatOnly) p.set('chatOnly', '1')
    if (typeof opts?.fromTs === 'number' && Number.isFinite(opts.fromTs)) p.set('fromTs', String(opts.fromTs))
    if (typeof opts?.toTs === 'number' && Number.isFinite(opts.toTs)) p.set('toTs', String(opts.toTs))
    return req<{ results: SearchHit[] }>(`/api/search?${p.toString()}`)
  },
}

export type { AetherEvent }
