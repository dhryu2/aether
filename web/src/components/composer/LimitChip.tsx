// 입력창 아랫줄의 구독 한도 경고 — 남은 한도가 30% 이하인 창을 모두 보인다. 한도 임박을 대화 배너로 알리던 것을 대신한다.
//   값은 세션 프로그램이 아니라 설정의 "AI 서비스 한도"와 같은 계정 조회에서 읽는다. 프로그램마다 저장해 둔 값이 달라 세션끼리 숫자가 어긋났다.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../../lib/api'
import { fmtDateTime, fmtShortDateTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import type { UsageWindow } from '../../lib/types'
import { useStore } from '../../lib/store'
import { projectedLimitAt, rateLimitLabel, warningWindows } from '../../lib/usageLabels'
import { ctxTone } from '../UsageChip'

// 서비스별 마지막 경고. 한 칸이 새로 읽으면 같은 서비스의 다른 칸도 함께 바뀐다.
// at = 읽은 시각(ms). 남은 한도 예측의 기준 시각으로 쓴다.
const latest = new Map<string, { windows: UsageWindow[]; at: number }>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function refresh(provider: string) {
  void api
    .accountUsage(false, provider)
    .then(({ providers }) => {
      const entry = providers.find((p) => p.provider === provider)
      if (entry && !entry.usage) return // 읽기가 늦거나 실패했다. 알던 값을 지우지 않는다.
      latest.set(provider, { windows: entry?.usage?.windowsAvailable ? warningWindows(entry.usage.windows) : [], at: Date.now() })
      listeners.forEach((listener) => listener())
    })
    .catch(() => { /* 표시만 그대로 둔다. 막히면 대화 배너가 알린다. */ })
}

export function LimitChip({ sessionId, provider, busy }: { sessionId: string; provider: string; busy: boolean }) {
  const t = useT()
  const narrow = useStore().isNarrow
  const snap = useSyncExternalStore(subscribe, () => latest.get(provider))
  const windows = snap?.windows

  // shortcut: 턴의 시작과 끝, 세션 전환 때만 새로 읽어 아주 긴 턴 도중에는 값이 멈춘다. 막히면 대화 배너가 알리므로 이대로 둔다.
  //   같은 이유로 오래 쉬면 이미 지난 소진 예측 시각이 남을 수 있다. 다음 읽기에서 고쳐진다.
  useEffect(() => refresh(provider), [sessionId, provider, busy])

  return (windows ?? []).map((win) => {
    const tone = ctxTone(Math.round(win.utilization!))
    const text = `${rateLimitLabel(win.key, t, win.windowMinutes)} ${Math.round(win.utilization!)}%`
    const reset = win.resetsAt ? new Date(win.resetsAt) : null
    const projected = projectedLimitAt(win, snap!.at)
    const by = projected ? t('session.status.limitBy', { time: fmtDateTime(projected) }) : ''
    const withBy = by ? `${text} · ${by}` : text
    const title = reset && !Number.isNaN(reset.getTime())
      ? `${withBy} · ${t('session.status.resetAt', { date: fmtShortDateTime(reset.getTime()) })}`
      : withBy
    return (
      <span
        key={win.key}
        className="tabular-nums"
        title={title}
        aria-label={title}
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
        {narrow ? text : withBy}
      </span>
    )
  })
}
