// 홈. 지금 환경과 지난 대화 검색 팝업으로 가는 입구.
import { C, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { actions, useStore } from '../../lib/store'
import { BrainApertureHero } from './BrainApertureHero'
import { projectLabel } from './helpers'

export function HubView() {
  const s = useStore()
  const t = useT()
  const narrow = s.isNarrow
  const env = projectLabel(s, t)

  return (
    <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'flex-start' : 'center', gap: narrow ? 8 : 20, marginBottom: 22 }}>
      <BrainApertureHero ariaLabel={t('brain.aperture.ariaLabel')} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.label3 }}>{env}</div>
        <div style={{ fontSize: narrow ? 22 : 26, fontWeight: 700, letterSpacing: '-0.02em', color: C.label, marginTop: 4, lineHeight: 1.25 }}>
          {t('brain.search.idleTitle')}
        </div>
        <button
          type="button"
          className="press"
          onClick={() => { actions.closeBrain(); actions.openSearch() }}
          style={{ height: narrow ? 44 : 36, padding: '0 16px', marginTop: 12, borderRadius: R.full, border: 'none', background: C.tintFill, color: C.onTint, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          {t('nav.sidebar.searchPast')}
        </button>
      </div>
    </div>
  )
}
