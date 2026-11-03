// 넘겨받은 인계서 카드 — 새 세션의 첫 말이 길어서 접어 둔다. 이름으로 무엇이 접혔는지 밝히고, 눌러 펼친다.
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { actions } from '../../lib/store'
import { roomIdForExecution } from '../../lib/workspaceRooms'
import { getState } from '../../lib/store'
import { useT } from '../../lib/i18n'
import { C, R } from '../../design/tokens'
import { Collapse } from '../ui'
import { MenuItem } from '../WorkMenu'
import { copyItem, menuOf, onContextMenuFor } from '../contextMenuFor'

export function HandoffCard({ text, fromId }: { text: string; fromId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const openPrev = () => actions.selectSession(roomIdForExecution(getState().rooms, fromId))
  return (
    <div
      className="flex flex-col"
      data-handoff-card
      style={{ width: '100%', minWidth: 0, background: C.cell, borderRadius: R.card, overflow: 'hidden' }}
      onContextMenu={onContextMenuFor(() => menuOf(
        copyItem(text, t('menu.copyHandoff')),
        <MenuItem onClick={openPrev}>{t('handoff.card.open')}</MenuItem>,
      ))}
    >
      <button
        type="button"
        className="press hit-44 flex items-center"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        style={{ gap: 8, minHeight: 40, padding: '0 14px', border: 'none', background: 'transparent', color: C.label, fontSize: 14, fontWeight: 600, textAlign: 'left', cursor: 'pointer' }}
      >
        <ChevronRight size={16} aria-hidden style={{ flexShrink: 0, color: C.label2, transform: open ? 'rotate(90deg)' : undefined, transition: 'transform var(--dur-fast, 150ms)' }} />
        <span className="truncate">{t('handoff.card.title')}</span>
      </button>
      <Collapse open={open} id={bodyId}>
        <div style={{ padding: '0 14px 12px' }}>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.5, color: C.label }}>{text}</div>
          <button
            type="button"
            className="press hit-44"
            onClick={openPrev}
            style={{ marginTop: 8, height: 28, padding: '0 12px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
          >
            {t('handoff.card.open')}
          </button>
        </div>
      </Collapse>
    </div>
  )
}
