// 오류 기록 화면의 순수 함수. 화면 부품을 모르고 번역 함수만 받는다.
import type { ErrorGroupDetailResponse, ErrorGroupSummary, ErrorLogPeriod } from '@shared/errors'
import { settings } from './i18n/settings'

type T = (key: string) => string

/** 기간 넓히기 순서. 끝(`all`)이면 더 넓힐 곳이 없다. */
export const NEXT_PERIOD: Record<ErrorLogPeriod, ErrorLogPeriod | null> = { '24h': '7d', '7d': 'all', all: null }

/** 위치 이름. 사전에 있으면 번역하고 모르는 이름은 원문 그대로 둔다. */
export function componentLabel(component: string, t: T): string {
  const key = `settings.errorLog.component.${component}`
  return key in settings ? t(key) : component
}

/** 이슈 트래커·채팅에 붙여 넣을 평문. 어느 언어에서든 읽히도록 이름표는 영어로 고정한다. */
export function errorCopyText(summary: ErrorGroupSummary, detail: ErrorGroupDetailResponse): string {
  const e = detail.latest
  return [
    e.message,
    `Where: ${e.component} / ${e.operation}`,
    `Count: ${detail.count}`,
    `First: ${detail.firstAt}`,
    `Last: ${detail.lastAt}`,
    `Source: ${summary.source}`,
    `Code: ${e.code}`,
    ...(e.release ? [`Release: ${e.release}`] : []),
    ...(e.request_id ? [`Request: ${e.request_id}`] : []),
    `Context: ${JSON.stringify(e.context, null, 2)}`,
    ...(e.stack ? ['Stack:', e.stack] : []),
  ].join('\n')
}
