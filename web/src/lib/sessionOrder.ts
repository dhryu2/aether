// 세션 목록의 표시 순서 — 사이드바 렌더와 부팅 시 기본 세션 선택이 같은 기준을 쓰도록 여기 하나만 둔다.
//   (분리돼 있으면 "화면 최상단"과 "자동 선택된 세션"이 어긋난다)
import type { SessionListItem } from './types'

/** 마지막 사용일 DESC → 활성 세션 우선 → 세션명 ASC. 원본 배열은 건드리지 않는다. */
export function sortSessions(sessions: SessionListItem[]): SessionListItem[] {
  return [...sessions].sort((a, b) => {
    const at = a.lastActivityAt ?? a.createdAt
    const bt = b.lastActivityAt ?? b.createdAt
    if (bt !== at) return bt - at
    const aActive = a.status === 'active' ? 0 : 1
    const bActive = b.status === 'active' ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return a.displayName.localeCompare(b.displayName)
  })
}
