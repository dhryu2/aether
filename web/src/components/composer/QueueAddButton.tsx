import { ListPlus } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'

// 보내기 옆 보조 버튼. 폰은 자리가 좁아 아이콘만 그리고 aria-label로 이름을 알린다.
//   첨부나 브리프 전송이라 넣을 수 없으면 비활성이고 이유를 title·aria-label로 알린다.
export function QueueAddButton({ enabled, onlyText, busy, size, narrow, onClick }: {
  enabled: boolean
  /** 첨부가 있거나 브리프로 보내는 중이라 글만 넣을 수 있다는 이유를 보인다. */
  onlyText: boolean
  busy: boolean
  size: number
  narrow: boolean
  onClick: () => void
}) {
  const t = useT()
  const off = !enabled || busy
  const label = onlyText ? t('composer.queue.textOnly') : t('composer.queue.add')
  return (
    <button
      type="button"
      className="press hit-44"
      disabled={off}
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        height: size,
        minWidth: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: narrow ? 0 : '0 14px',
        border: 'none',
        borderRadius: R.full,
        background: C.fill,
        color: off ? C.label4 : C.label,
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        cursor: off ? 'default' : 'pointer',
      }}
    >
      <ListPlus size={17} aria-hidden />
      {!narrow && t('composer.queue.add')}
    </button>
  )
}
