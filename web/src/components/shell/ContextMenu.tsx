// 우클릭 메뉴 — 앱 전체에 한 벌만 그린다. 위젯은 항목(요소)만 store에 넘긴다(components/contextMenuFor.tsx).
//   위젯 안에 그리면 React 이벤트가 위젯까지 올라가, 메뉴를 누를 때 세션 카드의 왼쪽 클릭이 함께 실행된다.
//   닫힘: 항목 누르기, 바깥 누르기, 휠·터치 스크롤, 창 크기 변경, Esc, Tab. 다른 곳을 우클릭하면 옮겨 열린다.
//   s.contextMenu는 shell/useGlobalShortcuts.ts의 overlayOpen에 들어 있다. 열려 있는 동안 전역 Esc가 세션 중단을 하지 않게 한다.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { actions, useStore } from '../../lib/store'
import { clampMenuPos } from '../../lib/contextMenu'
import { PopoverSurface } from '../ui'
import { MenuCloseCtx } from '../WorkMenu'
import { Z } from '../../design/tokens'

type Menu = NonNullable<ReturnType<typeof useStore>['contextMenu']>

export function ContextMenu() {
  const menu = useStore().contextMenu
  return menu ? <MenuLayer menu={menu} /> : null
}

function MenuLayer({ menu }: { menu: Menu }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  // 열리기 직전의 초점. 옮겨 열릴 때는 그대로 두고, 닫히면 여기로 돌린다.
  const prevFocus = useRef(document.activeElement)

  // 바깥 누르기와 Esc를 window 캡처 단계에서 먼저 받는다. document 단계에서 닫으면 같은 Esc를 전역 단축키와 창의
  //   useEscape가 "메뉴 없음"으로 보고 또 처리해 중단·찾기·창 닫기가 함께 일어난다. 여기서 삼키면 메뉴만 닫힌다.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      actions.closeContextMenu()
    }
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (ref.current?.contains(el)) return
      // 점 버튼(WorkMenu)이 같은 메뉴를 여닫는다. 여기서 먼저 닫으면 이어지는 클릭이 다시 연다.
      if (el?.closest('[data-session-opt="work-menu"]')) return
      actions.closeContextMenu()
      // 창 뒤의 어두운 막(useScrimClose가 data-scrim을 붙인다)을 왼쪽으로 누르면 메뉴만 닫고 창은 둔다.
      if (e.button === 0 && el?.hasAttribute('data-scrim')) e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [])

  // 화면 밖으로 나가면 안쪽으로 민다. 항목이 바뀌어 크기가 달라져도(칸 메뉴의 세션 목록) 다시 잰다.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const place = () => {
      const p = clampMenuPos(menu.x, menu.y, node.offsetWidth, node.offsetHeight, window.innerWidth, window.innerHeight)
      setPos((cur) => (cur.x === p.x && cur.y === p.y ? cur : p))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(node)
    return () => ro.disconnect()
  }, [menu])

  // 메뉴 키(키보드)로 열었으면 첫 항목, 마우스면 메뉴 자체에 초점을 둔다. 화살표가 어느 쪽이든 먹도록.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const first = node.querySelector<HTMLElement>('[role="menuitem"]')
    ;(menu.byKeyboard && first ? first : node).focus({ preventScroll: true })
  }, [menu])
  useEffect(() => () => {
    const prev = prevFocus.current
    if (prev instanceof HTMLElement && prev.isConnected) prev.focus({ preventScroll: true })
  }, [])

  // 어느 위젯의 메뉴인지 보이게 한다(index.css [data-menu-target]).
  useEffect(() => {
    const anchor = menu.anchor
    anchor?.setAttribute('data-menu-target', '')
    return () => anchor?.removeAttribute('data-menu-target')
  }, [menu])

  // 스크롤·크기 변경에 닫는다. scroll 이벤트는 대화가 흘러나올 때 저절로 자동 스크롤로도 오므로 사람이 한 휠·터치로 센다.
  useEffect(() => {
    const onMove = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      actions.closeContextMenu()
    }
    window.addEventListener('wheel', onMove, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('resize', actions.closeContextMenu)
    return () => {
      window.removeEventListener('wheel', onMove)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('resize', actions.closeContextMenu)
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => {
      event.preventDefault()
      items[(to + items.length) % items.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at < 0 ? items.length - 1 : at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(items.length - 1)
    else if (event.key === 'Tab') {
      event.preventDefault()
      actions.closeContextMenu()
    }
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-context-menu
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: Z.root.contextMenu, outline: 'none' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <PopoverSurface
        align="left"
        minWidth={188}
        role="menu"
        zIndex={Z.root.contextMenu}
        style={{ position: 'relative', top: 'auto', bottom: 'auto', left: 'auto', right: 'auto', maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      >
        {/* 항목(MenuItem)이 자기 일을 한 뒤 이 닫기 함수를 부른다. keepMenu 항목과 회색 항목은 부르지 않는다. */}
        <MenuCloseCtx.Provider value={actions.closeContextMenu}>
          <div className="flex flex-col" style={{ padding: 6 }}>{menu.items}</div>
        </MenuCloseCtx.Provider>
      </PopoverSurface>
    </div>
  )
}
