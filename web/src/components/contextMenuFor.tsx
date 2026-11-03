// 위젯이 우클릭 메뉴를 거는 공통 함수와 복사 항목 부품.
//   쓰는 법: <div onContextMenu={onContextMenuFor(() => <MenuItem …/>)}>
//   build가 null을 돌려주면 브라우저 기본 메뉴가 뜬다(복사 항목뿐인 위젯이 클립보드를 못 쓸 때).
//   판정(터치·입력칸·링크·글자 선택은 기본 메뉴)은 lib/contextMenu.ts, 메뉴를 그리는 곳은 shell/ContextMenu.tsx다.
import { createElement, Fragment, type MouseEvent, type ReactNode } from 'react'
import { actions, getState } from '../lib/store'
import { selectionTouches, wantsAppMenu, type SelectionLike } from '../lib/contextMenu'
import { canCopy, copyWithNotice } from '../lib/copyNotice'
import { MenuItem } from './WorkMenu'

/** 우클릭 직전의 선택 복제본. 한 번 쓰면 버린다. */
let rightDownSelection: (SelectionLike & { wasEmpty: boolean }) | null = null

// WebKit(Safari, Tauri의 WKWebView)은 우클릭의 기본 동작으로 눌린 단어를 자동 선택한다. contextmenu 때 보면 늘 선택이
//   있는 것처럼 보여 앱 메뉴가 안 뜬다. 그래서 누르는 순간(기본 동작 전)의 선택을 복제해 두고 그걸로 판정한다.
//   Chromium은 선택을 바꾸지 않아 복제본과 현재 선택이 같다. 메뉴 키로 열면 pointerdown이 없어 현재 선택을 쓴다.
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    rightDownSelection = null
    if (!(e.button === 2 || (e.button === 0 && e.ctrlKey))) return
    const sel = window.getSelection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    const text = sel?.toString() ?? ''
    rightDownSelection = {
      wasEmpty: !range || range.collapsed || text === '',
      isCollapsed: !range || range.collapsed,
      toString: () => text,
      containsNode: (node) => !!range && range.intersectsNode(node),
    }
  }, true)
  // 메뉴 키 등 다른 길로 열릴 때 낡은 복제본이 남지 않게 한다.
  document.addEventListener('keydown', () => { rightDownSelection = null }, true)
}

export function onContextMenuFor(build: () => ReactNode | null) {
  return (e: MouseEvent<HTMLElement>) => {
    if (getState().coarsePointer) return // 터치의 길게 누르기는 위젯의 기존 동작 몫이다.
    const widget = e.currentTarget
    // 가장 안쪽 위젯이 이긴다. 안쪽이 기본 메뉴로 두기로 했으면 바깥 위젯도 끼어들지 않는다.
    e.stopPropagation()
    const snap = rightDownSelection
    rightDownSelection = null
    const sel: SelectionLike | null = snap ?? window.getSelection()
    if (!wantsAppMenu({
      coarsePointer: false,
      target: e.target as Element,
      selectedText: sel?.toString() ?? '',
      selectionInWidget: sel ? selectionTouches(widget, sel) : false,
    })) return
    const items = build()
    if (!items) return
    e.preventDefault()
    // 누르기 전에 선택이 없었는데 브라우저가 단어를 자동으로 골랐으면 지운다(앱 메뉴가 뜨는 우클릭에는 선택이 남을 이유가 없다).
    const cur = window.getSelection()
    if (snap?.wasEmpty && cur && !cur.isCollapsed) cur.removeAllRanges()
    // 메뉴 키·Shift+F10은 좌표가 0으로 오고, 키보드 초점 링이 있는 위젯에서 온다. 그때는 위젯 위치에 띄운다.
    const byKeyboard = (e.clientX === 0 && e.clientY === 0) || (e.target as Element).matches(':focus-visible')
    const rect = widget.getBoundingClientRect()
    actions.openContextMenu({
      x: byKeyboard ? Math.max(rect.left, 0) + 8 : e.clientX,
      y: byKeyboard ? Math.max(rect.top, 0) + 8 : e.clientY,
      items,
      anchor: widget,
      byKeyboard,
    })
  }
}

/** 항목 여러 개를 하나로 묶는다. 모두 비었으면 null이라 기본 메뉴가 뜬다. */
export function menuOf(...nodes: ReactNode[]): ReactNode | null {
  return nodes.some(Boolean) ? createElement(Fragment, null, ...nodes) : null
}

/** 복사 항목 하나. 복사할 글이 없거나 클립보드를 못 쓰면 null(그리지 않는다). */
export function copyItem(text: string | null | undefined, label: string): ReactNode | null {
  if (!text || !canCopy()) return null
  return <MenuItem onClick={() => void copyWithNotice(text)}>{label}</MenuItem>
}

/** 복사 항목뿐인 위젯의 우클릭. 복사할 글을 늦게 계산해야 하면 함수로 넘긴다. */
export function onCopyMenu(text: string | null | undefined | (() => string | null | undefined), label: string) {
  return onContextMenuFor(() => copyItem(typeof text === 'function' ? text() : text, label))
}
