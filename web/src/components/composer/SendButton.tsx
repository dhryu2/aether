import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, ListChecks } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { useDismiss } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { Button, PopoverSurface } from '../ui'

const LONG_PRESS_MS = 450

// 전송 버튼 — 입력창 알약 오른쪽 끝의 동그라미. 켜졌을 때만 파랑 채움이고, 꺼지면 회색 면(C.fill)에 흐린 화살표다.
// 갈래는 메시지 앱의 전송 버튼처럼 길게 누르기(마우스는 우클릭도)로만 연다. 버튼 위에 표시를 겹치지 않는다 —
//   동그라미 아래 작은 꺾쇠를 겹쳤더니 화살표가 위로 밀려 보이고 손가락으로는 누를 수도 없었다.
//   늘 보이는 버튼을 더하면 폰 너비의 버튼 개수가 바뀐다. 키보드는 버튼에서 ↑ 또는 메뉴 키로 연다.
export function SendButton({
  enabled,
  size,
  sent,
  onClick,
  onSendBrief,
}: {
  enabled: boolean
  size: number
  /** 보낸 횟수. 바뀔 때마다 버튼이 한 번 눌렸다 돌아온다 — Enter로 보내도 버튼이 반응한다. */
  sent: number
  onClick: () => void
  onSendBrief?: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // 누르고 있는 동안 버튼이 천천히 작아진다 — 길게 누르면 무언가 열린다는 것을 손에 알려 준다.
  const [holding, setHolding] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const longFired = useRef(false)
  const focusFirst = useRef(false)
  const hasMenu = !!onSendBrief && enabled
  useDismiss(boxRef, () => setOpen(false), open && !!onSendBrief)

  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setHolding(false)
  }
  useEffect(() => clearTimer, [])
  // 글을 지워 버튼이 꺼지면 열린 메뉴도 닫는다. 보낼 것이 없는데 고를 수 있으면 안 된다.
  //   effect가 아니라 렌더 중에 맞춘다 — 꺼진 채로 한 번 그려졌다가 닫히는 깜빡임이 없다.
  const [wasEnabled, setWasEnabled] = useState(enabled)
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled)
    if (!enabled) setOpen(false)
  }
  // 키보드로 열었을 때만 첫 항목에 초점을 준다. 손가락으로 열 때 초점을 옮기면 폰 키보드가 내려간다.
  useEffect(() => {
    if (!open || !focusFirst.current) return
    focusFirst.current = false
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])

  const openMenu = (byKeyboard: boolean) => {
    focusFirst.current = byKeyboard
    setOpen(true)
  }
  const closeMenu = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) btnRef.current?.focus()
  }
  const pick = (run: () => void) => {
    setOpen(false)
    run()
  }

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (to: number) => {
      event.preventDefault()
      items[(to + items.length) % items.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(items.length - 1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
    } else if (event.key === 'Tab') setOpen(false)
  }

  const button = (
    <Button
      ref={btnRef}
      tone="primary"
      disabled={!enabled}
      title={hasMenu ? t('composer.send.more') : undefined}
      aria-haspopup={onSendBrief ? 'menu' : undefined}
      aria-expanded={onSendBrief ? open : undefined}
      onClick={() => {
        if (longFired.current) {
          longFired.current = false
          return
        }
        onClick()
      }}
      onPointerDown={(event) => {
        if (!hasMenu || event.button !== 0) return
        clearTimer()
        setHolding(true)
        timer.current = window.setTimeout(() => {
          timer.current = null
          setHolding(false)
          longFired.current = true
          openMenu(false)
        }, LONG_PRESS_MS)
      }}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onPointerLeave={clearTimer}
      onContextMenu={(event) => {
        if (!onSendBrief) return
        event.preventDefault()
        if (!enabled) return
        // 안드로이드는 길게 누르면 이 이벤트도 온다. 이어지는 click이 그냥 보내기로 새지 않게 막는다.
        if (timer.current != null) longFired.current = true
        clearTimer()
        // 마우스 우클릭은 초점 링이 없고, 키보드의 메뉴 키는 초점 링이 있는 상태에서 온다.
        openMenu(!!btnRef.current?.matches(':focus-visible'))
      }}
      onKeyDown={(event) => {
        if (!hasMenu || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        openMenu(true)
      }}
      // send-btn = 켜지고 꺼지는 색이 번지듯 바뀐다(양방향).
      //   Button은 비활성일 때 lift 클래스를 떼므로 transition이 사라지는데, 이 클래스는 남아서 양방향 모두 이어진다.
      // send-fired-a·b = 보낸 순간 한 번 눌렸다 돌아온다. 보낼 때마다 이름을 번갈아 바꿔야 애니메이션이 다시 돈다.
      // send-hold = 길게 누르는 동안 작아진다(index.css).
      className={['send-btn hit-44', sent > 0 && (sent % 2 ? 'send-fired-a' : 'send-fired-b'), holding && 'send-hold'].filter(Boolean).join(' ')}
      aria-label={t('composer.send.aria')}
      height={size}
      paddingX={0}
      radius={R.full}
      style={{
        width: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...(enabled ? null : { background: C.fill }),
      }}
    >
      <ArrowUp size={19} strokeWidth={2.5} />
    </Button>
  )

  if (!onSendBrief) return button

  return (
    <div ref={boxRef} style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {open && (
        <PopoverSurface
          direction="up"
          align="right"
          role="menu"
          aria-label={t('composer.send.branch')}
          minWidth={232}
          className="send-menu"
        >
          <div ref={menuRef} role="none" onKeyDown={onMenuKey}>
            <SendMenuItem data-send-plain icon={<ArrowUp size={17} strokeWidth={2.2} />} title={t('composer.send.plain')} onPick={() => pick(onClick)} />
            <SendMenuItem
              data-send-brief
              icon={<ListChecks size={17} strokeWidth={2} />}
              title={t('composer.send.brief')}
              sub={t('composer.send.briefSub')}
              onPick={() => pick(onSendBrief)}
            />
          </div>
        </PopoverSurface>
      )}
      {button}
    </div>
  )
}

// 메뉴 한 줄 — iOS 문맥 메뉴처럼 글은 왼쪽, 단색 기호는 오른쪽 끝에 둔다. 줄 사이 가는 선과 눌림 색은 index.css .send-menu-item.
function SendMenuItem({ icon, title, sub, onPick, ...data }: {
  icon: ReactNode
  title: string
  sub?: string
  onPick: () => void
  'data-send-plain'?: boolean
  'data-send-brief'?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      {...data}
      className="send-menu-item"
      // 누르는 순간 입력칸 초점을 뺏지 않는다. 실행은 click에서 해서 키보드 Enter도 같은 길로 간다.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1">
        <span style={{ display: 'block', fontSize: 14.5, fontWeight: 500, color: C.label, letterSpacing: '-0.01em' }}>{title}</span>
        {sub && <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.label3 }}>{sub}</span>}
      </span>
      <span aria-hidden style={{ display: 'inline-flex', color: C.label2, flexShrink: 0 }}>{icon}</span>
    </button>
  )
}
