// 칸 머리의 ⋯ 메뉴 — 칸 자리 옮기기·맞바꾸기·다른 세션으로 바꾸기·닫기. WorkMenu와 같은 팝오버·항목 모양을 쓴다.
import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { actions, useStore } from '../../lib/store'
import { useDismiss } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { IconButton, PopoverSurface } from '../ui'
import { MenuItem } from '../WorkMenu'
import { HandoffMenuItems } from '../HandoffMenuItems'
import { executionId, findRoom } from '../../lib/workspaceRooms'
import { C } from '../../design/tokens'

/** 「다른 세션으로 바꾸기」에 보여 줄 세션 수 상한. 길면 스크롤된다. */
const PICK_MAX = 20

export function PaneMenu({
  sessionId,
  visibleIds,
  zoomed,
  onClose,
}: {
  sessionId: string
  /** 지금 화면에 보이는 칸의 방 id, 왼쪽 위부터. */
  visibleIds: readonly string[]
  /** 확대 중에는 자리를 옮기지 않는다(옆 칸이 숨어 있다). */
  zoomed?: boolean
  onClose?: () => void
}) {
  const t = useT()
  const s = useStore()
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const index = visibleIds.indexOf(sessionId)
  const exec = executionId(findRoom(s.rooms, sessionId))
  const close = () => {
    setOpen(false)
    setPicking(false)
  }
  useDismiss(box, close, open)
  // 키보드: 열거나 고르기 목록으로 바뀌면 첫 항목에 포커스를 준다.
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [open, picking])
  const run = (fn: () => void) => () => {
    close()
    btn.current?.focus()
    fn()
  }
  const candidates = picking
    ? s.rooms
        .filter((r) => !r.archivedAt && r.status !== 'corrupted' && !visibleIds.includes(r.id))
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, PICK_MAX)
    : []

  return (
    <div
      ref={box}
      className="relative"
      style={{ flexShrink: 0 }}
      onKeyDown={(e) => {
        // Esc는 useDismiss가 닫는다. 닫힌 뒤 포커스는 ⋯ 버튼으로 돌린다.
        if (e.key === 'Escape' && open) btn.current?.focus()
      }}
    >
      <IconButton
        ref={btn}
        type="button"
        data-pane-menu-btn
        aria-haspopup="menu"
        aria-expanded={open}
        label={t('nav.split.menu')}
        title={t('nav.split.menu')}
        onClick={() => (open ? close() : setOpen(true))}
        size={28}
        color={C.label2}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      {open && (
        <PopoverSurface align="right" direction="down" minWidth={196} role="menu" style={picking ? { maxHeight: 280, overflowY: 'auto' } : undefined}>
          <div className="flex flex-col" style={{ padding: 6 }}>
            {picking ? (
              <>
                <MenuItem onClick={() => setPicking(false)}>{t('nav.split.back')}</MenuItem>
                {candidates.length === 0 && (
                  <span style={{ padding: '4px 10px 6px', fontSize: 12.5, color: C.label3 }}>{t('nav.split.noOtherSession')}</span>
                )}
                {candidates.map((r) => (
                  <MenuItem key={r.id} onClick={run(() => actions.replacePaneSession(sessionId, r.id))}>
                    {r.title || t('nav.session.untitled')}
                  </MenuItem>
                ))}
              </>
            ) : (
              <>
                {/* 키보드로 고르면 칸 포커스가 안 옮겨 가므로 먼저 이 칸으로 옮긴다. 찾기는 포커스 칸을 뒤진다. */}
                <MenuItem onClick={run(() => { actions.focusPane(sessionId); actions.toggleFind() })}>{t('nav.topbar.findInSession')}</MenuItem>
                {exec && <MenuItem onClick={run(() => void actions.exportTranscript(exec))}>{t('nav.topbar.export')}</MenuItem>}
                <div role="separator" style={{ height: 0.5, margin: '5px 4px', background: C.sep }} />
                <MenuItem disabled={zoomed || index <= 0} onClick={run(() => actions.movePane(sessionId, -1))}>
                  {t('nav.split.moveLeft')}
                </MenuItem>
                <MenuItem disabled={zoomed || index < 0 || index >= visibleIds.length - 1} onClick={run(() => actions.movePane(sessionId, 1))}>
                  {t('nav.split.moveRight')}
                </MenuItem>
                {visibleIds.map((id, i) =>
                  id === sessionId ? null : (
                    <MenuItem key={id} disabled={zoomed} onClick={run(() => actions.swapPane(sessionId, id))}>
                      {t('nav.split.swapWith', { n: i + 1 })}
                    </MenuItem>
                  ),
                )}
                <MenuItem onClick={() => setPicking(true)}>{t('nav.split.replaceSession')}</MenuItem>
                <HandoffMenuItems id={sessionId} close={() => { close(); btn.current?.focus() }} />
                {onClose && (
                  <>
                    <div role="separator" style={{ height: 0.5, margin: '5px 4px', background: C.sep }} />
                    <MenuItem onClick={run(onClose)}>{t('nav.split.close')}</MenuItem>
                  </>
                )}
              </>
            )}
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}
