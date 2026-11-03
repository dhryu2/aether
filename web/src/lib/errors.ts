import { isErrorReported, isExpectedClientError, markErrorReported, reportClientError } from './errorReporting'
import type { ClientErrorInput } from '@shared/errors'

/** 주기 작업·저장 호출의 연속 실패는 첫 건만 남기고 성공하면 해제한다. */
export function createClientErrorReporter(details: Partial<ClientErrorInput>) {
  let failed = false
  const pending = new WeakSet<object>()
  return {
    reset() { failed = false },
    report(error: unknown, extra: Partial<ClientErrorInput> = {}) {
      // 공통 호출기가 이미 기록했거나 제외한 오류로는 연속 실패 상태를 켜지 않는다. 뒤따르는 다른 결함을 가리면 안 된다.
      if (isExpectedClientError(error) || isErrorReported(error)) return
      if (!failed) {
        // 모듈 초기화 중 실패도 main의 수집기 설치 뒤에 전달한다.
        const fields = { ...details, ...extra }
        if (error && typeof error === 'object') pending.add(error)
        queueMicrotask(() => {
          reportClientError(error, fields)
          if (error && typeof error === 'object') pending.delete(error)
        })
      }
      else if (error && typeof error === 'object' && !pending.has(error)) markErrorReported(error)
      failed = true
    },
  }
}

/** 저장 제한·서버 렌더링·선택적 JSON 대안은 정상 경로다. 나머지 저장 실패는 수집한다. */
export function createStorageErrorReporter(details: Partial<ClientErrorInput>) {
  const reporter = createClientErrorReporter(details)
  return {
    reset: reporter.reset,
    report(error: unknown, extra: Partial<ClientErrorInput> = {}) {
      const name = (error as { name?: string } | null)?.name
      if (name === 'SecurityError' || name === 'QuotaExceededError' || error instanceof SyntaxError ||
        (error instanceof ReferenceError && typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined')) return
      reporter.report(error, extra)
    },
  }
}
/**
 * 에러를 사람이 읽을 문장으로 바꾸는 자리.
 *
 * 원래 같은 일을 세 곳이 조금씩 다르게 하고 있었다. store는 `String(e.message ?? e)`,
 * 폴더 고르기 화면은 같은 식을 그대로 다시 적었고, 설정 화면만 `e instanceof Error`로 갈랐다.
 * 세 번째만 `{ message: undefined }` 같은 객체에서 다르게 동작했다.
 */

/** 무엇이 던져졌든 화면에 띄울 한 줄로. */
export function errMsg(e: unknown): string {
  reportClientError(e)
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string') return e
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === 'string' && m ? m : String(e)
}

/**
 * API 호출 실패에서 HTTP 상태 코드 꺼내기.
 * `lib/api.ts`가 실패 응답에 `status`를 붙여 던지는데, 받는 쪽 두 곳이 각자 타입 단언으로 꺼내고 있었다.
 */
export function httpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}
