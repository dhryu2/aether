// 자동 재개 칩 — 한도로 멈춘 세션이 언제 다시 이어지는지, 또는 사람 확인이 필요한지를 칸 머리·상단 도구 섬에 작게 보인다.
//   읽기 전용이다. 시각·문장 편집은 입력창 위 막대(AutoResumeBar)에서 한다. 색만으로 전하지 않는다(아이콘+글자).
import { Clock, CircleAlert } from 'lucide-react'
import type { AutoResumePlan } from '../lib/types'
import { autoResumeTimeText } from '../lib/autoResume'
import { useT } from '../lib/i18n'
import { C, R } from '../design/tokens'

/** placement: 'pane' = 칸 머리, 'island' = 상단 도구 섬(칸이 하나일 때). compact: 폰에서는 시각만 보인다. */
export function AutoResumeChip({ plan, placement, compact }: { plan: AutoResumePlan | undefined; placement: 'pane' | 'island'; compact?: boolean }) {
  const t = useT()
  if (!plan || (plan.at === undefined && !plan.gaveUp)) return null
  const gaveUp = plan.gaveUp === true
  const time = plan.at !== undefined ? autoResumeTimeText(plan.at) : ''
  const text = gaveUp ? t('nav.autoResume.gaveUp') : compact ? time : t('nav.autoResume.at', { time })
  const aria = gaveUp ? t('nav.autoResume.gaveUpAria') : t('nav.autoResume.atAria', { time })
  const Icon = gaveUp ? CircleAlert : Clock
  const island = placement === 'island'
  return (
    <span
      data-auto-resume-chip={gaveUp ? 'gaveup' : 'wait'}
      className="inline-flex items-center"
      role="status"
      aria-label={aria}
      title={aria}
      style={{
        flexShrink: 0,
        gap: 5,
        height: island ? 28 : 24,
        padding: '0 8px',
        borderRadius: R.full,
        background: island ? 'transparent' : C.fill,
        color: gaveUp ? C.attn : C.label2,
        fontSize: 12.5,
        fontWeight: gaveUp ? 600 : 500,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={14} aria-hidden />
      <span className="tabular-nums">{text}</span>
    </span>
  )
}
