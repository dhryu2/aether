// 입력창 아랫줄의 구독 한도 표시 — 가장 많이 찬 창 하나만 보인다. 한도 임박을 대화 배너로 알리던 것을 대신한다.
//   값은 설정의 사용량 패널과 같은 공통 API에서 온다. 창을 답하지 않는 provider와 잠든 세션에서는 그리지 않는다.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { fmtShortDateTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import type { UsageWindow } from '../../lib/types'
import { fullestWindow, rateLimitLabel } from '../../lib/usageLabels'
import { ctxTone } from '../UsageChip'

/** 칸이 좁을 때 평소 값을 뺀다. 주황으로 바뀌는 경계부터는 남긴다(UsageChip과 같은 경계). */
const CALM_BELOW_PCT = 70

export function LimitChip({ sessionId, busy, hideCalm }: { sessionId: string; busy: boolean; hideCalm: boolean }) {
  const t = useT()
  const [seen, setSeen] = useState<{ id: string; win: UsageWindow | null } | null>(null)

  // shortcut: 턴의 시작과 끝에만 새로 읽어 아주 긴 턴 도중에는 값이 멈춘다. 막히면 대화 배너가 알리므로 이대로 둔다.
  useEffect(() => {
    let stale = false
    api
      .getUsage(sessionId)
      .then((usage) => {
        if (!stale) setSeen({ id: sessionId, win: usage.windowsAvailable ? fullestWindow(usage.windows) : null })
      })
      .catch(() => {
        if (!stale) setSeen({ id: sessionId, win: null }) // 잠든 세션(404)과 미지원 provider(501)는 표시만 뺀다.
      })
    return () => {
      stale = true
    }
  }, [sessionId, busy])

  const win = seen?.id === sessionId ? seen.win : null
  if (!win || win.utilization == null) return null
  const pct = Math.round(win.utilization)
  if (hideCalm && pct < CALM_BELOW_PCT) return null

  const tone = ctxTone(pct)
  const text = `${rateLimitLabel(win.key, t, win.windowMinutes)} ${pct}%`
  const reset = win.resetsAt ? new Date(win.resetsAt) : null
  const title = reset && !Number.isNaN(reset.getTime())
    ? `${text} · ${t('session.status.resetAt', { date: fmtShortDateTime(reset.getTime()) })}`
    : text
  return (
    <span
      className="tabular-nums"
      title={title}
      style={{
        fontSize: 11,
        fontWeight: tone.warn ? 700 : 400,
        color: tone.text,
        padding: '0 6px',
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </span>
  )
}
