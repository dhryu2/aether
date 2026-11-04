// 사용량 표시에 붙은 「새 세션으로 넘기기」 입구. 넘기기는 답변 하나가 아니라 세션 전체의 일이라 세션 상태를 보이는 이 자리에 둔다.
//   옆의 모델·권한 칩과 같은 화살표로 메뉴가 있음을 알린다. 사용률과 상관없이 모습이 같다. 경고는 표시의 색이 맡는다.
//   항목과 막힌 이유는 다른 메뉴와 같은 HandoffMenuItems가 그린다. 항목이 하나도 없는 세션과 불러오는 중에는 표시만 보인다.
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { ChevronDown } from 'lucide-react'
import { useStore } from '../lib/store'
import { handoffMenuState } from '../lib/handoff'
import { useDismiss } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { findRoom } from '../lib/workspaceRooms'
import { HandoffMenuItems } from './HandoffMenuItems'
import { UsageChip } from './UsageChip'
import { ctxOf } from './ctxOf'
import { C } from '../design/tokens'
import { PopoverSurface } from './ui'

type Props = ComponentProps<typeof UsageChip> & {
  roomId: string | null | undefined
  direction?: 'up' | 'down'
  align?: 'left' | 'right'
}

export function UsageHandoff({ roomId, direction = 'down', align = 'right', ...chip }: Props) {
  const t = useT()
  const s = useStore()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    btn.current?.focus()
  }
  useDismiss(box, () => setOpen(false), open)
  // 키보드: 열면 첫 항목에 포커스를 준다.
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [open])

  const room = roomId ? findRoom(s.rooms, roomId) : undefined
  const ctx = ctxOf(chip.items)
  const state = room ? handoffMenuState(room) : null
  const hasItems = !!room && (state?.kind !== 'hidden' || !!room.handoffFrom || !!room.handoffTo)
  // 폰의 표시는 값이 생기기 전에 비어 있다. 빈 버튼을 만들지 않는다.
  if (!room || !hasItems || chip.loading || (chip.compact && ctx == null)) return <UsageChip {...chip} />

  const hint = t('handoff.usage.hint')
  return (
    <div
      ref={box}
      className="relative inline-flex items-center"
      style={{ flexShrink: 0 }}
      onKeyDown={(e) => {
        // Esc는 useDismiss가 닫는다. 닫힌 뒤 포커스는 표시 버튼으로 돌린다.
        if (e.key === 'Escape' && open) btn.current?.focus()
      }}
    >
      <button
        ref={btn}
        type="button"
        data-usage-menu-btn
        className="usage-menu-btn press hit-44"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={(ctx != null ? t('nav.usage.pctTitle', { pct: ctx }) : t('nav.usage.noDataTitle')) + hint}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <UsageChip {...chip} hint={hint} />
        <ChevronDown size={14} style={{ color: C.label3, flexShrink: 0 }} aria-hidden />
      </button>
      {open && (
        <PopoverSurface align={align} direction={direction} minWidth={196} role="menu">
          <div className="flex flex-col" style={{ padding: 6 }}>
            <HandoffMenuItems id={room.id} close={close} />
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}
