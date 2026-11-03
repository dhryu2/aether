// W2. 연결 인디케이터 — 정상(연결됨)일 땐 *아무것도 표시 안 함*(노이즈 제거, task8).
//   문제 상태(연결 중·재연결·오프라인)에서만 작은 정적 점(+라벨)을 노출. 흐르는 혜성 애니메이션·"연결됨" 텍스트 제거.
import type { ConnState } from '../lib/types'
import { useT } from '../lib/i18n'
import { C } from '../design/tokens'
import { Dot } from './ui'

// 재설계 A: 상단 제목 섬 아래 줄에 들어가므로 상자 없이 점과 글자만 둔다.
const MAP: Record<ConnState, { key: string; color: string } | null> = {
  connected: null, // 정상 — 표시 없음
  connecting: { key: 'nav.conn.connecting', color: C.tint },
  reconnecting: { key: 'nav.conn.reconnecting', color: C.attn },
  offline: { key: 'nav.conn.offline', color: C.del },
}

export function ConnectionIndicator({ state, compact }: { state: ConnState; compact?: boolean }) {
  const t = useT()
  const c = MAP[state]
  if (!c) return null
  const label = t(c.key)
  return (
    <span className="inline-flex items-center" style={{ flexShrink: 0, gap: 5 }} title={label} role={compact ? 'img' : undefined} aria-label={compact ? label : undefined}>
      <Dot color={c.color} size={7} />
      {!compact && <span style={{ fontSize: 12, color: C.label2 }}>{label}</span>}
    </span>
  )
}
