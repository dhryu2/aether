// SSE 클라이언트 — ?since=lastSeq 재연결 + 지수 백오프 + visibilitychange/online 복귀 + half-open 워치독.
// 백엔드는 since 이후 놓친 이벤트를 replay한 뒤 실시간 합류시킨다(끊김 없는 복원). 중복은 store가 seq로 제거.
import { parsePresenceSession, parsePresenceSnapshot } from './attention'
import { createClientErrorReporter } from './errors'
import { openSse, type SseHandle } from './sseTransport'
import type { AetherEvent, CaughtUpInfo, ConnState, PresenceSession, PresenceSnapshot } from './types'

// web_boundary 정적 계약: 토큰 없을 때 EventSource 경로(실행은 openSse).
// 호출하지 않는다. 검사기는 이 소스 문자열만 본다.
function presenceStreamContract(): void {
  new EventSource('/api/presence/stream')
}
void presenceStreamContract

export type StreamHandle = { close: () => void }
export type { CaughtUpInfo }

const HEARTBEAT_MS = 15000 // 백엔드 config.heartbeatMs와 동일(서버가 'ping' named 이벤트를 이 주기로 보냄)
const STALE_MS = HEARTBEAT_MS * 2.5 // 이 시간 동안 아무것도(이벤트·ping) 못 받으면 half-open으로 보고 강제 재연결

export function openStream(
  sessionId: string,
  getSince: () => number,
  onEvent: (ev: AetherEvent) => void,
  onConn: (c: ConnState) => void,
  onCaughtUp: (info: CaughtUpInfo) => void, // 초기 백로그 replay 완료 표지(named 이벤트 'caught_up') — 로딩 해제·하단 점프 트리거
  onBacklogInfo: (info: { oldestSeq: number; hasOlder: boolean }) => void, // 초기 replay 꼬리 절단 정보 — 무한스크롤 페이징 상태 세팅
): StreamHandle {
  let handle: SseHandle | null = null
  let closed = false
  let backoff = 600
  let timer: ReturnType<typeof setTimeout> | null = null
  let everConnected = false
  let lastRecv = Date.now()
  const bump = () => (lastRecv = Date.now())
  // 손상 프레임은 버리고 스트림을 계속한다. 기능 축소이므로 warning이며, 연속 실패는 첫 건만 남긴다.
  const frameFailure = createClientErrorReporter({ component: 'stream', operation: 'web.stream.frame', session_id: sessionId, severity: 'warning' })

  function connect() {
    if (closed) return
    onConn(everConnected ? 'reconnecting' : 'connecting')
    bump()
    handle = openSse({
      url: `/api/sessions/${sessionId}/stream?since=${getSince()}`,
      sessionId,
      onOpen: () => {
        backoff = 600
        everConnected = true
        bump()
        onConn('connected')
      },
      onMessage: (data) => {
        bump()
        try {
          onEvent(JSON.parse(data) as AetherEvent)
          frameFailure.reset()
        } catch (error) {
          frameFailure.report(error)
          /* 손상 프레임 무시 */
        }
      },
      onNamed: (name, data) => {
        bump()
        if (name === 'ping') return
        if (name === 'caught_up') {
          onCaughtUp(data && typeof data === 'object' ? (data as CaughtUpInfo) : {})
          return
        }
        if (name === 'backlog_info') {
          if (data && typeof data === 'object') onBacklogInfo(data as { oldestSeq: number; hasOlder: boolean })
        }
      },
      onError: () => {
        handle?.close()
        handle = null
        if (closed) return
        onConn(navigator.onLine ? 'reconnecting' : 'offline')
        timer = setTimeout(connect, backoff)
        backoff = Math.min(Math.round(backoff * 1.8), 10000)
      },
    })
  }

  const reconnectNow = () => {
    if (closed) return
    handle?.close()
    handle = null
    if (timer) clearTimeout(timer)
    backoff = 600
    connect()
  }

  const watchdog = setInterval(() => {
    if (closed) return
    if (Date.now() - lastRecv > STALE_MS) reconnectNow()
  }, HEARTBEAT_MS)

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastRecv > STALE_MS) reconnectNow()
  }
  const onOnline = () => reconnectNow()
  const onOffline = () => onConn('offline')

  connect()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  return {
    close() {
      closed = true
      clearInterval(watchdog)
      if (timer) clearTimeout(timer)
      handle?.close()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    },
  }
}

export function openPresenceStream(
  onSnapshot: (snap: PresenceSnapshot) => void,
  onUpdate: (row: PresenceSession) => void,
): StreamHandle {
  let handle: SseHandle | null = null
  let closed = false
  let backoff = 600
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRecv = Date.now()
  const bump = () => (lastRecv = Date.now())
  // 손상 프레임을 버리고 계속하는 기능 축소다. 사건과 전체 상태를 따로 세어 연속 실패는 첫 건만 남긴다.
  const updateFailure = createClientErrorReporter({ component: 'stream', operation: 'web.presence.update', severity: 'warning' })
  const snapshotFailure = createClientErrorReporter({ component: 'stream', operation: 'web.presence.snapshot', severity: 'warning' })

  function connect() {
    if (closed) return
    bump()
    handle = openSse({
      url: '/api/presence/stream',
      onOpen: () => {
        backoff = 600
        bump()
      },
      onMessage: (data) => {
        bump()
        try {
          const row = parsePresenceSession(JSON.parse(data))
          if (row) onUpdate(row)
          updateFailure.reset()
        } catch (error) {
          updateFailure.report(error)
          /* 손상 프레임 무시 */
        }
      },
      onNamed: (name, data) => {
        bump()
        if (name === 'ping') return
        if (name === 'snapshot') {
          try {
            const snap = parsePresenceSnapshot(data)
            if (snap) onSnapshot(snap)
            snapshotFailure.reset()
          } catch (error) {
            snapshotFailure.report(error)
            /* 손상 프레임 무시 */
          }
        }
      },
      onError: () => {
        handle?.close()
        handle = null
        if (closed) return
        timer = setTimeout(connect, backoff)
        backoff = Math.min(Math.round(backoff * 1.8), 10000)
      },
    })
  }

  const reconnectNow = () => {
    if (closed) return
    handle?.close()
    handle = null
    if (timer) clearTimeout(timer)
    backoff = 600
    connect()
  }

  const watchdog = setInterval(() => {
    if (closed) return
    if (Date.now() - lastRecv > STALE_MS) reconnectNow()
  }, HEARTBEAT_MS)

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastRecv > STALE_MS) reconnectNow()
  }
  const onOnline = () => reconnectNow()

  connect()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)

  return {
    close() {
      closed = true
      clearInterval(watchdog)
      if (timer) clearTimeout(timer)
      handle?.close()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    },
  }
}
