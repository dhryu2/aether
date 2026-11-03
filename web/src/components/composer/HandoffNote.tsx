import { FileText } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { actions, getState } from '../../lib/store'
import { roomIdForExecution } from '../../lib/workspaceRooms'
import { useT } from '../../lib/i18n'
import type { HandoffSource } from '../../lib/types'

// 입력창 위 한 줄 안내 — 넘겨받은 인계서가 입력창에 들어 있으니 확인하고 보내라고 알린다. 모달 없이 한 줄이다.
//   인계서를 AI가 쓰지 못해 Aether가 뼈대를 만든 경우는 문구가 다르다. 글자색은 본문 보조색이라 배경 대비 4.5:1 이상이다.
export function HandoffNote({ fromId, source }: { fromId: string; source: HandoffSource | null }) {
  const t = useT()
  return (
    <div
      className="glass flex items-center"
      data-testid="handoff-note"
      style={{ borderRadius: R.card, minWidth: 0, gap: 8, padding: '4px 6px 4px 14px' }}
    >
      <FileText size={16} aria-hidden style={{ flexShrink: 0, color: C.tint }} />
      <span role="status" className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.label2 }}>
        {source === 'skeleton' ? t('handoff.note.skeleton') : t('handoff.note.model')}
      </span>
      <button
        type="button"
        className="press hit-44"
        onClick={() => actions.selectSession(roomIdForExecution(getState().rooms, fromId))}
        style={{ flexShrink: 0, minHeight: 28, padding: '0 12px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        {t('handoff.note.open')}
      </button>
    </div>
  )
}
