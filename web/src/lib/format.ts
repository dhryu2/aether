// 표시용 포맷 헬퍼.
import { t } from './i18n'
import { getState } from './store'
import { waitAge } from './attention'

/**
 * 브라우저 날짜 포맷 함수에 넘길 언어 태그.
 *
 * 원래 Agent Brain과 세션 상태 화면이 `'ko-KR'`을 그대로 박아 놨다. 앱은 영어도 지원하므로
 * 영어로 바꿔도 시각이 "오후 3:04"처럼 한국어로 나오던 자리다.
 */
function bcp47(): string {
  return getState().locale === 'en' ? 'en-US' : 'ko-KR'
}

/** 단축키 표기용 수식키 — 실제 핸들러는 metaKey/ctrlKey 둘 다 받으므로 이건 라벨 전용. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'

/** 상대시각. 단일사용자라 createdAt = "세션 생성 경과"로 표기(백엔드에 lastActivity 없음). 로케일별 t(). */
export function relTime(ts: number, now = Date.now()): string {
  if (!ts || ts < 1) return ''
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return t('core.relTime.now')
  const m = Math.floor(s / 60)
  if (m < 60) return t('core.relTime.minutes', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('core.relTime.hours', { n: h })
  const d = Math.floor(h / 24)
  if (d < 7) return t('core.relTime.days', { n: d })
  const w = Math.floor(d / 7)
  if (w < 5) return t('core.relTime.weeks', { n: w })
  const mo = Math.floor(d / 30)
  if (mo < 12) return t('core.relTime.months', { n: mo })
  return t('core.relTime.years', { n: Math.floor(d / 365) })
}

/** 「N분째」 같은 대기 시간 표기. 상대 시간만 쓴다(정확한 시각은 호출부가 툴팁으로 둔다). */
export function waitAgeText(since: number, now = Date.now()): string {
  const a = waitAge(since, now)
  return a.unit === 'now' ? t('nav.wait.now') : t(`nav.wait.${a.unit}`, { n: a.n })
}

/** 응답 완료 시각 — 오늘이면 "HH:MM", 올해면 "M/D HH:MM", 그 외 "YYYY. M. D.". 답변 푸터용(디자인 간결 우선). */
export function fmtDateTime(ts?: number, now = new Date()): string {
  if (!ts || ts < 1) return ''
  const d = new Date(ts)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hhmm
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
}

/**
 * 절대 시각 — 오늘/어제는 그렇게 부르고, 그 전은 "10월 3일 15:04"처럼 날짜와 함께 보여준다.
 * Agent Brain의 검색 결과·메모리·활동 기록처럼 "언제 있었던 일인지"가 중요한 목록에 쓴다.
 */
export function fmtDate(ts: number, now = new Date()): string {
  if (!ts) return ''
  const d = new Date(ts)
  const loc = bcp47()
  const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return t('brain.date.today', { hm })
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return t('brain.date.yesterday', { hm })
  return `${d.toLocaleDateString(loc, { month: 'long', day: 'numeric' })} ${hm}`
}

/** 짧은 날짜+시각("1/1 09:00") — 한도 초기화 예정 시각처럼 가까운 미래를 가리킬 때. */
export function fmtShortDateTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString(bcp47(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function tokensShort(n?: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

export function bytes(n?: number): string {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** ctx 사용률(%) = totalTokens / maxTokens. 백엔드 getContextUsage(ctx 이벤트)의 정확값에서 계산. */
export function ctxPctFromTokens(totalTokens: number, maxTokens: number): number | null {
  if (!maxTokens) return null
  return Math.min(100, Math.round((totalTokens / maxTokens) * 100))
}


const TOOL_PATH_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'url']
/** tool_use input에서 경로/명령 best-effort 추출(경로 개념 없는 툴은 빈 문자열 → 칩에서 슬롯 생략). */
export function toolPath(input: Record<string, unknown>): string {
  for (const k of TOOL_PATH_KEYS) {
    const v = input?.[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/** 권한 카드가 그리는 도구 인자 전부. 키를 거르거나 해석하지 않는다 — 승인하는 사람이 실행될 값을 다 봐야 한다. */
export function permissionArgs(input: Record<string, unknown> | undefined): { key: string; value: string }[] {
  return Object.entries(input ?? {}).map(([key, v]) => ({ key, value: typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v)) }))
}

/** tool_result content를 문자열로 평탄화. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? ''))
      .join('')
  }
  return ''
}

/** "✓ N lines" 류 결과 메타 best-effort. 실패/길이 정보 없으면 빈 문자열. */
export function toolResultMeta(content: unknown, isError?: boolean): { ok: boolean; label: string } {
  const text = toolResultText(content)
  if (isError) return { ok: false, label: t('core.toolResult.failed') }
  if (!text) return { ok: true, label: t('core.toolResult.done') }
  const lines = text.split('\n').length
  if (lines > 1) return { ok: true, label: t('core.toolResult.lines', { n: lines }) }
  if (text.length > 0) return { ok: true, label: t('core.toolResult.chars', { n: text.length }) }
  return { ok: true, label: t('core.toolResult.done') }
}
