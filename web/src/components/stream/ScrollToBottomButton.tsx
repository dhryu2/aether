// 바닥에서 벗어나 위를 읽는 동안에만 뜨는 '맨 아래로' 버튼 — 스크롤 영역 위에 절대위치로 겹친다.
//   조작이라 유리 동그라미다(재설계 4단계). 떠 있는 입력창(--composer-h) 바로 위에 놓인다.
import { ArrowDown } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { C, R, Z } from '../../design/tokens'

export function ScrollToBottomButton({ narrow, onClick }: { narrow: boolean; onClick: () => void }) {
  const t = useT()
  return (
    <button
      onClick={onClick}
      aria-label={t('stream.scrollBottom')}
      title={t('stream.scrollBottom')}
      className="glass press hit-44 inline-flex items-center justify-center"
      style={{
        position: 'absolute',
        right: narrow ? 16 : 24,
        bottom: 'calc(var(--composer-h, 0px) + 12px)',
        width: 40,
        height: 40,
        borderRadius: R.full,
        color: C.label,
        zIndex: Z.inApp.scrollFab,
      }}
    >
      <ArrowDown size={18} />
    </button>
  )
}
