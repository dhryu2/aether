import { createStorageErrorReporter } from './errors'
// 사이드바 검색·상태 점·접힘 영속. 화면은 여기 순수 함수만 쓰고 필터 로직을 인라인으로 늘리지 않는다.
import type { SessionListItem } from './types'
import { sessionWorkTitle } from './workTitle'

const readFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.sidebar.read' })
const writeFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.sidebar.write' })

export const ATTENTION_DOT_ORDER = ['waiting', 'failed', 'running', 'done'] as const
export type AttentionDotKind = (typeof ATTENTION_DOT_ORDER)[number]

export function sessionMatchesQuery(session: SessionListItem, query: string, untitled: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const fields = [
    session.displayName ?? '',
    sessionWorkTitle(session, untitled),
    session.preview ?? '',
    session.attentionPreview ?? '',
  ]
  return fields.some((field) => field.toLowerCase().includes(q))
}

export function countAttentions(sessions: SessionListItem[]): Record<AttentionDotKind, number> {
  const counts: Record<AttentionDotKind, number> = { waiting: 0, failed: 0, running: 0, done: 0 }
  for (const session of sessions) {
    const a = session.attention
    if (a === 'waiting' || a === 'failed' || a === 'done') counts[a] += 1
    else if (a === 'running' || a === 'background') counts.running += 1 // 백그라운드 작업 중도 일하는 중 칸에 센다
  }
  return counts
}

/** 그리는 순서: 대기 → 실패 → 일함 → 끝남. idle은 안 그린다. 종류당 1개, 최대 4개. */
export function attentionDotKinds(counts: Record<AttentionDotKind, number>): AttentionDotKind[] {
  return ATTENTION_DOT_ORDER.filter((kind) => counts[kind] > 0)
}

export function formatAttentionTitle(
  counts: Record<AttentionDotKind, number>,
  label: (kind: AttentionDotKind, n: number) => string,
): string {
  return attentionDotKinds(counts)
    .map((kind) => label(kind, counts[kind]))
    .join(' · ')
}

export function parseOpenSet(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((item): item is string => typeof item === 'string'))
  } catch {
    // 선택적 접힘 저장값이 JSON이 아니면 기본 접힘 상태를 쓴다.
    return new Set()
  }
}

export function serializeOpenSet(keys: Iterable<string>): string {
  return JSON.stringify([...keys])
}

export function loadOpenSet(storageKey: string): Set<string> {
  try {
    const value = parseOpenSet(localStorage.getItem(storageKey))
    readFailure.reset()
    return value
  } catch (error) {
    readFailure.report(error)
    return new Set()
  }
}

export function saveOpenSet(storageKey: string, keys: Set<string>): void {
  try {
    localStorage.setItem(storageKey, serializeOpenSet(keys))
    writeFailure.reset()
  } catch (error) {
    writeFailure.report(error)
    /* 메모리만 유지 */
  }
}

export function toggleSet(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
