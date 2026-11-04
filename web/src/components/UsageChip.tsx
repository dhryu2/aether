// W3. 사용량 칩 — 컨텍스트 창 사용률(ctx%) 게이지. 활성 세션의 마지막 ctx 이벤트에서 파생.
//  · ctx% = 백엔드가 매 턴 후 getContextUsage로 보낸 totalTokens/maxTokens(정확값). result.usage는 턴 누적이라 100% 고착이라 미사용.
//  · ctx 이벤트가 아직 없으면(턴 미실행/구버전 영속분) '—' 표시. 비용($)은 구독 OAuth라 명목 추정치 → 제외(사용자 결정 2026-06-16).
import type { ConvoItem } from '../lib/store'
import { useT } from '../lib/i18n'
import { C, R } from '../design/tokens'
import { Meter, Skeleton } from './ui'
import { ctxOf } from './ctxOf'

/** 사용률이 이 값 이상이면 주황으로 바뀌고 넘기기 버튼이 보인다. */
export const CTX_WARN_PCT = 70

// ctx 사용률 단계별 색상 — 100%에 가까울수록 경고(task6). 정상=회색 / 주의(70%+)=주황 / 경고(88%+)=빨강.
//   정상일 때 시안을 쓰던 것을 회색으로 바꿨다 — 색은 신경 쓸 때만 켜지는 신호여야 해서다(감사 F5).
export function ctxTone(pct: number | null): { fill: string; text: string; track: string; warn: boolean } {
  if (pct == null) return { fill: C.label3, text: C.label2, track: C.sep, warn: false }
  if (pct >= 88) return { fill: C.del, text: C.del, track: C.delSoft, warn: true }
  if (pct >= CTX_WARN_PCT) return { fill: C.attn, text: C.attn, track: C.attnSoft, warn: false }
  return { fill: C.label3, text: C.label2, track: C.sep, warn: false }
}

//   compact(폰 상단 도구 섬): "ctx" 낱말을 뺀다. 뜻은 title과 막대 모양으로 남긴다.
//   막대는 컴퓨터보다 조금만 짧다. 24로 줄였을 때는 점처럼 보여 차오른 정도가 안 읽혔다(2026-10-06 사용자 지적).
export function UsageChip({ items, loading, compact }: { items: ConvoItem[] | undefined; loading?: boolean; compact?: boolean }) {
  const t = useT()
  // 초기 replay 중엔 ctx 이벤트가 과거 순서대로 흘러들어 %가 오르내림 → 스켈레톤으로 가리고 caught_up 후 최종값 표시.
  if (loading) {
    return (
      <span className="inline-flex items-center font-mono" style={{ fontSize: 11, color: C.label2, gap: 5 }} title={t('nav.usage.loadingTitle')}>
        {!compact && <span>ctx</span>}
        <Skeleton width={compact ? 36 : 42} height={5} radius={R.full} />
        <Skeleton width={22} height={11} />
      </span>
    )
  }
  const ctx = ctxOf(items)
  // 폰 제목 아래 줄에서 빈 막대와 '—'만 남으면 뜻이 안 읽힌다 — 값이 생길 때까지 자리를 비운다.
  if (compact && ctx == null) return null
  const tone = ctxTone(ctx)
  const title = ctx != null
    ? `${t('nav.usage.pctTitle', { pct: ctx })}${tone.warn ? t('nav.usage.warnSuffix') : ''}`
    : t('nav.usage.noDataTitle')
  return (
    <span
      className="inline-flex items-center font-mono tabular-nums"
      style={{ fontSize: 11, color: tone.text, gap: 5 }}
      title={title}
    >
      {!compact && <span style={{ color: tone.warn ? C.del : C.label2 }}>ctx</span>}
      {/* 경고일 때 숨쉬듯 깜빡이는 효과는 트랙이 아니라 채워진 부분에만 준다(가득 차지 않았을 때 빈 자리까지 깜빡이지 않게). */}
      <Meter
        pct={ctx ?? 0}
        color={tone.fill}
        height={5}
        radius={R.full}
        track={tone.track}
        style={{ width: compact ? 36 : 42 }}
        fillClassName={tone.warn ? 'anim-breathe' : undefined}
        fillStyle={tone.warn ? { animation: 'aether-breathe 1.6s ease-in-out infinite' } : undefined}
      />
      <span style={{ fontWeight: tone.warn ? 700 : 400 }}>{ctx != null ? `${ctx}%` : '—'}</span>
    </span>
  )
}
