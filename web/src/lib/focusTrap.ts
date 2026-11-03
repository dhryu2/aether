// 창 안 키보드 초점 가두기.
// Brain 창의 focusables와 같은 규칙이다. 보이는 누름 요소만 센다.
// 꺼져 있거나, 숨었거나, 화면에서 크기가 0인 요소는 빼는다.
//
// 열린 창은 쌓아서 맨 위만 초점을 다룬다. 아래 창이 닫혀도 초점을 옮기지 않는다.
// 맨 위가 닫히면 그 창을 열기 직전 초점으로 돌아가되, 그 요소가 아래에 남은 창 밖이면
// 그 창의 첫 초점으로 보낸다. 가두기는 초점이 창 밖에 있으면 창 안으로 되돌린다.
import { useEffect, useRef } from 'react'

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex="0"]'

type FocusLayer = {
  rootRef: { readonly current: HTMLElement | null }
  opener: HTMLElement | null
}

const focusStack: FocusLayer[] = []

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute('disabled') || el.tabIndex < 0) return false
    if (getComputedStyle(el).visibility === 'hidden') return false
    return el.getClientRects().length > 0
  })
}

// 화면 밖에 있거나 크기가 0이면 초점을 두지 않는다. 닫힌 서랍 안의 버튼이 그렇다.
export function isOnScreen(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
}

function restoreFocus(opener: HTMLElement | null, below: HTMLElement | null) {
  const openerOk = opener != null && opener.isConnected && isOnScreen(opener)
  const insideBelow = below != null && opener != null && below.contains(opener)
  if (openerOk && (below == null || insideBelow)) {
    opener.focus()
    return
  }
  if (below) {
    const first = focusables(below)[0]
    if (first) {
      first.focus()
      return
    }
  }
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) active.blur()
}

function trapKey(e: KeyboardEvent, root: HTMLElement) {
  if (e.key !== 'Tab') return
  const items = focusables(root)
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const activeEl = document.activeElement
  const inside = activeEl instanceof HTMLElement && root.contains(activeEl)
  if (!inside) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (e.shiftKey && activeEl === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && activeEl === last) {
    e.preventDefault()
    first.focus()
  }
}

// resolveInitial은 매 렌더 새 함수여도 된다. 효과를 다시 걸면 창이 닫혔다 열린 것처럼
// 초점이 튀므로, ref에만 담아 두고 마운트 한 번만 등록한다.
export function useFocusTrap(
  rootRef: { readonly current: HTMLElement | null },
  resolveInitial?: () => HTMLElement | null | undefined,
) {
  const resolveRef = useRef(resolveInitial)
  resolveRef.current = resolveInitial
  useEffect(() => {
    const root = rootRef.current
    const before = document.activeElement
    const opener =
      before instanceof HTMLElement &&
      before !== document.body &&
      before !== document.documentElement &&
      !(root && root.contains(before))
        ? before
        : null
    const entry: FocusLayer = { rootRef, opener }
    focusStack.push(entry)
    const onKey = (e: KeyboardEvent) => {
      if (focusStack[focusStack.length - 1] !== entry) return
      const current = rootRef.current
      if (!current) return
      trapKey(e, current)
    }
    document.addEventListener('keydown', onKey)
    const frame = requestAnimationFrame(() => {
      if (focusStack[focusStack.length - 1] !== entry) return
      const preferred = resolveRef.current?.()
      const next = preferred ?? (rootRef.current ? focusables(rootRef.current)[0] : undefined)
      next?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      const index = focusStack.lastIndexOf(entry)
      const wasTop = index !== -1 && index === focusStack.length - 1
      if (index !== -1) focusStack.splice(index, 1)
      if (!wasTop) return
      const below = focusStack[focusStack.length - 1]?.rootRef.current ?? null
      restoreFocus(entry.opener, below)
    }
  }, [rootRef])
}
