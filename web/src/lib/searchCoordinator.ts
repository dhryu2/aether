/** 입력 debounce와 느린 이전 응답 폐기를 한 토큰으로 관리한다. */
export const BRAIN_SEARCH_DEBOUNCE_MS = 220

export function createSearchCoordinator<T>(delayMs = BRAIN_SEARCH_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let currentToken = 0

  return {
    schedule(value: T, run: (value: T, token: number) => void) {
      clearTimeout(timer)
      const token = ++currentToken
      timer = setTimeout(() => {
        timer = undefined
        if (token === currentToken) run(value, token)
      }, delayMs)
      return token
    },
    cancel() {
      clearTimeout(timer)
      timer = undefined
      currentToken += 1
      return currentToken
    },
    isCurrent(token: number) {
      return token === currentToken
    },
  }
}
