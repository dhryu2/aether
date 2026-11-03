// W18. 빈 세션 히어로 — 참딩 마스코트 + 헤드라인.
//   인사(콕콕)는 처음 그릴 때 한 번. 덮개가 걷힌 뒤에 그리므로, 덮개 아래에서 미리 인사를 소모하지 않는다.
import { useT } from '../lib/i18n'
import { showLoadMask, useStore } from '../lib/store'
import { C } from '../design/tokens'
import { ChamdingMascot } from './ChamdingMascot'
import { chamdingWidth } from './chamdingWidth'

const EMPTY_H = 68

export function EmptyHero({ name }: { name: string }) {
  const t = useT()
  const masked = showLoadMask(useStore())
  return (
    <div className="flex h-full flex-col items-center justify-center" style={{ gap: 18, padding: 24 }}>
      {masked ? (
        <div style={{ width: chamdingWidth(EMPTY_H), height: EMPTY_H }} aria-hidden />
      ) : (
        <ChamdingMascot state="empty" size={EMPTY_H} playOnMount />
      )}
      <div className="text-center">
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: C.label }}>{t('nav.emptyHero.title', { name })}</div>
        <div style={{ fontSize: 13, color: C.label3, marginTop: 6 }}>{t('nav.emptyHero.desc')}</div>
      </div>
    </div>
  )
}
