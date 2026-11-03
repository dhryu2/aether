import type { ClassifiedError, ClientErrorInput } from '@shared/errors'
import { authHeaders } from './clientAuth'
import { ErrorQueue, IndexedErrorStore } from './errorQueue'
declare const __AETHER_RELEASE__: string | null
const seen = new WeakSet<object>()
let queue: ErrorQueue | undefined
let flushing = false
export function markErrorReported(error: object) { seen.add(error) }
export function isErrorReported(error: unknown) { return !!error && typeof error === 'object' && seen.has(error) }
export function isExpectedClientError(error: unknown) {
  const e = error as (ClassifiedError & { name?: string; code?: string }) | null
  return e?.errorOrigin === 'external_environment' || e?.errorOrigin === 'user_action' || e?.name === 'RequestTimeoutError' || e?.name === 'AbortError' || e?.code === 'USER_CANCELLED'
}
export function reportClientError(error: unknown, details: Partial<ClientErrorInput> = {}) {
  if (!queue) return
  const e = error as { name?: string; message?: string; stack?: string; status?: number } | null
  if (isExpectedClientError(error)) return
  if (error && typeof error === 'object') { if (seen.has(error)) return; seen.add(error) }
  const event: ClientErrorInput = { id: crypto.randomUUID(), occurred_at: new Date().toISOString(), component: 'ui', operation: 'ui.action',
    release: typeof __AETHER_RELEASE__ === 'undefined' ? null : __AETHER_RELEASE__,
    message: e?.message ?? String(error), stack: e?.stack, ...details }
  event.message = String(event.message)
  // HTTP 입력 제한에 맞춰 큰 오류는 명시적인 크기 거절로 남긴다. 원문을 잘라 다른 오류처럼 저장하지 않는다.
  if (event.message.length > 64 * 1024 || (event.stack?.length ?? 0) > 128 * 1024) {
    event.message = '오류 원문이 수집 크기 제한을 초과했습니다.'; event.stack = undefined; event.code = 'ERROR_TOO_LARGE'
  }
  void queue.add(event).then(flushClientErrors)
}
export async function flushClientErrors() {
  if (!queue || flushing) return
  flushing = true
  try {
    if (navigator.locks) await navigator.locks.request('aether-errors-delivery', { ifAvailable: true }, async lock => { if (lock) await queue!.flush() })
    else await queue.flush()
  } catch { /* 브라우저 보관 실패는 상태 표시로 알린다. 재귀 기록하지 않는다. */ }
  finally { flushing = false }
}
export function clientErrorStatus() { return queue?.status() ?? { pending: 0, lost: 0, rejected: 0, storageFailed: false } }
export function installErrorReporting() {
  if (queue) return
  queue = new ErrorQueue(new IndexedErrorStore(), async event => {
    const response = await fetch('/api/errors', { method: 'POST', credentials: 'same-origin',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) })
    if (response.status === 400 || response.status === 413) return 'rejected'
    if (!response.ok) return false
    const body = await response.json()
    return body.id === event.id && body.durable === true
  })
  window.addEventListener('error', e => reportClientError(e.error ?? new Error(e.message), { operation: 'ui.global' }))
  window.addEventListener('unhandledrejection', e => reportClientError(e.reason, { operation: 'ui.promise' }))
  window.addEventListener('online', () => { void flushClientErrors() })
  // 재전송 주기는 탭이 보일 때만 돈다. 새 오류는 add 직후 바로 보내고 대기분은 보관소에 남으므로, 숨긴 동안 멈춰도 유실이 없다.
  let timer: ReturnType<typeof setInterval> | undefined
  const syncTimer = () => {
    if (document.visibilityState === 'hidden') { clearInterval(timer); timer = undefined; return }
    timer ??= setInterval(() => { void flushClientErrors() }, 5000)
    void flushClientErrors()
  }
  document.addEventListener('visibilitychange', syncTimer)
  syncTimer()
}
