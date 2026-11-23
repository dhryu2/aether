import { ListTodo } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { actions } from '../../lib/store'
import { useT } from '../../lib/i18n'

// 입력창 위 한 줄 안내 — 이 세션이 작업 대기열에 들어 있다고 알리고 대기열 탭으로 보낸다. HandoffNote와 같은 모양이다.
export function QueueNote() {
  const t = useT()
  return (
    <div
      className="glass flex items-center"
      data-testid="queue-note"
      style={{ borderRadius: R.card, minWidth: 0, gap: 8, padding: '4px 6px 4px 14px' }}
    >
      <ListTodo size={16} aria-hidden style={{ flexShrink: 0, color: C.tint }} />
      <span role="status" className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.label2 }}>
        {t('composer.queue.note')}
      </span>
      <button
        type="button"
        className="press hit-44"
        onClick={() => actions.openBrain('queue')}
        style={{ flexShrink: 0, minHeight: 28, padding: '0 12px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        {t('composer.queue.view')}
      </button>
    </div>
  )
}
