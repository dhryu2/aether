// 사용량 표시에 붙은 「새 세션으로 넘기기」 입구. 넘기기는 답변 하나가 아니라 세션 전체의 일이라 세션 상태를 보이는 이 자리에 둔다.
//   표시를 누르면 메뉴가 열리고, 경고가 시작되는 사용률부터는 넘기기 창을 바로 여는 글자 버튼이 옆에 보인다.
//   항목과 막힌 이유는 다른 메뉴와 같은 HandoffMenuItems가 그린다. 항목이 하나도 없는 세션과 불러오는 중에는 표시만 보인다.
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { actions, useStore } from '../lib/store'
import { handoffMenuState } from '../lib/handoff'
import { useDismiss } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { executionId, findRoom } from '../lib/workspaceRooms'
import { HandoffMenuItems } from './HandoffMenuItems'
import { CTX_WARN_PCT, UsageChip } from './UsageChip'
import { ctxOf } from './ctxOf'
import { PopoverSurface } from './ui'

type Props = ComponentProps<typeof UsageChip> & {
  roomId: string | null | undefined
  direction?: 'up' | 'down'
  align?: 'left' | 'right'
  /** 칸이 좁아 글자 버튼을 둘 수 없으면 끈다. 메뉴로는 그대로 넘길 수 있다. */
  suggestion?: boolean
}

export function UsageHandoff({ roomId, direction = 'down', align = 'right', suggestion = true, ...chip }: Props) {
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

  const execId = executionId(room)
  const suggest = suggestion && execId && state?.kind === 'ready' && ctx != null && ctx >= CTX_WARN_PCT
  return (
    <div
      ref={box}
      className="relative inline-flex items-center"
      style={{ gap: 4, flexShrink: 0 }}
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
        aria-label={ctx != null ? t('nav.usage.pctTitle', { pct: ctx }) : t('nav.usage.noDataTitle')}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <UsageChip {...chip} />
      </button>
      {suggest && (
        <button
          type="button"
          className="usage-handoff-btn press hit-44"
          aria-label={t('handoff.title')}
          onClick={() => actions.openHandoff(execId)}
        >
          {t('handoff.usage.action')}
        </button>
      )}
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
