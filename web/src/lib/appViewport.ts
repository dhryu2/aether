// iOS PWA 키보드 대응용 앱 뷰포트 바인딩.
//
// WebKit은 백그라운드/알림 복귀 때 키보드는 닫혔는데 visualViewport.height만 축소값으로
// 남기는 경우가 있다. 따라서 visualViewport는 "실제 편집 요소가 포커스된 동안"에만 신뢰하고,
// 그 밖에는 CSS의 100dvh 폴백으로 즉시 복구한다.

type ViewportLike = Pick<VisualViewport, 'height' | 'offsetTop'>

export type AppViewportVars = {
  height: string | null
  top: string | null
}

/** DOM과 분리한 판정 함수 — null은 인라인 변수를 제거하고 CSS 100dvh 폴백을 쓰라는 뜻이다. */
export function resolveAppViewport(editableFocused: boolean, viewport?: ViewportLike | null): AppViewportVars {
  if (!editableFocused || !viewport || !Number.isFinite(viewport.height) || viewport.height <= 0) {
    return { height: null, top: null }
  }
  const top = Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0
  return { height: `${viewport.height}px`, top: `${top}px` }
}

/** 사용자가 방금 탭·키 입력을 했으면 복귀 복구가 포커스를 빼앗지 않는 시간 창(ms). */
export const USER_INPUT_GRACE_MS = 1000

/**
 * 복귀 복구가 편집 요소 포커스를 풀어도 되는지. 사용자가 방금 입력칸을 눌렀다면 그 포커스는 WebKit이
 * 되살린 것이 아니라 사용자의 것이다 — iOS는 창 focus·visibilitychange를 탭보다 늦게 보내기도 해서,
 * 이 판정이 없으면 방금 연 키보드가 바로 닫히고 입력이 안 먹는다.
 */
export function shouldReleaseFocus(now: number, lastUserInputAt: number): boolean {
  return now - lastUserInputAt >= USER_INPUT_GRACE_MS
}

function isEditableElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true
  if (!(el instanceof HTMLInputElement)) return false
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type)
}

function activeEditable(): HTMLElement | null {
  const el = document.activeElement
  return isEditableElement(el) ? el : null
}

function writeVars(vars: AppViewportVars) {
  const style = document.documentElement.style
  if (vars.height === null) style.removeProperty('--app-h')
  else style.setProperty('--app-h', vars.height)
  if (vars.top === null) style.removeProperty('--app-top')
  else style.setProperty('--app-top', vars.top)
}

let recoverInstalledViewport: (() => void) | null = null

/** 알림 딥링크처럼 일반 페이지 라이프사이클 이벤트가 누락될 수 있는 경로에서 호출한다. */
export function recoverAppViewport() {
  recoverInstalledViewport?.()
}

export function installAppViewportBinding(): () => void {
  const viewport = window.visualViewport
  let suspended = false
  let recovering = false
  let recoveryFrame = 0
  let lastUserInputAt = -Infinity

  const restoreFullViewport = () => writeVars({ height: null, top: null })
  const apply = () => writeVars(resolveAppViewport(!!activeEditable(), viewport))

  const cancelRecoveryForUserInput = () => {
    lastUserInputAt = Date.now()
    recovering = false
    if (recoveryFrame) cancelAnimationFrame(recoveryFrame)
    recoveryFrame = 0
  }

  const recover = () => {
    // 방금 사용자가 입력칸을 눌렀다면 복구하지 않고 현재 포커스 기준으로 높이만 맞춘다.
    if (!shouldReleaseFocus(Date.now(), lastUserInputAt)) {
      apply()
      return
    }
    recovering = true
    activeEditable()?.blur()
    restoreFullViewport()
    if (recoveryFrame) cancelAnimationFrame(recoveryFrame)
    // WebKit이 client.focus() 직후 DOM 포커스를 한 프레임 늦게 복원하는 경우까지 제거한다.
    // 사용자가 그 사이 직접 탭/키입력을 하면 아래 pointerdown/keydown이 이 프레임을 취소한다.
    recoveryFrame = requestAnimationFrame(() => {
      recoveryFrame = 0
      if (!recovering) return
      activeEditable()?.blur()
      restoreFullViewport()
      recovering = false
    })
  }

  const suspend = () => {
    suspended = true
    activeEditable()?.blur()
    restoreFullViewport()
  }
  const resume = () => {
    if (document.visibilityState !== 'visible') return
    suspended = false
    recover()
  }
  const onWindowFocus = () => {
    if (suspended) resume()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') suspend()
    else resume()
  }
  const onFocusIn = () => {
    // WebKit이 자동으로 되살린 포커스라면 recoveryFrame에서 다시 해제된다.
    // 정상 사용자 포커스는 pointerdown/keydown이 recovering을 먼저 취소한다.
    requestAnimationFrame(apply)
  }
  const onFocusOut = () => requestAnimationFrame(apply)

  recoverInstalledViewport = recover
  apply()
  requestAnimationFrame(apply)

  window.addEventListener('blur', suspend)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('pagehide', suspend)
  window.addEventListener('pageshow', resume)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  document.addEventListener('pointerdown', cancelRecoveryForUserInput, true)
  document.addEventListener('keydown', cancelRecoveryForUserInput, true)
  if (viewport) {
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
  } else {
    window.addEventListener('resize', apply)
  }

  return () => {
    if (recoverInstalledViewport === recover) recoverInstalledViewport = null
    if (recoveryFrame) cancelAnimationFrame(recoveryFrame)
    window.removeEventListener('blur', suspend)
    window.removeEventListener('focus', onWindowFocus)
    window.removeEventListener('pagehide', suspend)
    window.removeEventListener('pageshow', resume)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('pointerdown', cancelRecoveryForUserInput, true)
    document.removeEventListener('keydown', cancelRecoveryForUserInput, true)
    if (viewport) {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
    } else {
      window.removeEventListener('resize', apply)
    }
    restoreFullViewport()
  }
}
