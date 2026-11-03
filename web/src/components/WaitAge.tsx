// 「12분째」 — 사람을 기다린 시간. 상대 시간만 보이고 정확한 시각은 툴팁에 둔다.
//   10분이 넘으면 주황·굵게. 빨강과 새 색은 쓰지 않는다. 낭독기에는 알리지 않는다(aria-live 없음) — 호출부 aria-label에 담는다.
import { fmtDateTime, waitAgeText } from '../lib/format'
import { isLongWait } from '../lib/attention'
import { useNow } from '../lib/hooks'
import { C } from '../design/tokens'

export function WaitAge({ since, prefix }: { since: number; prefix?: string }) {
  const now = useNow()
  const long = isLongWait(since, now)
  return (
    <span
      data-wait-age={long ? 'long' : 'short'}
      title={fmtDateTime(since)}
      style={{ flexShrink: 0, fontSize: 12.5, color: long ? C.attn : C.label3, fontWeight: long ? 600 : 400 }}
    >
      {prefix}
      {waitAgeText(since, now)}
    </span>
  )
}
