// 세션 목록의 표시 순서 — 사이드바 렌더와 부팅 시 기본 세션 선택이 같은 기준을 쓰도록 여기 하나만 둔다.
//   (분리돼 있으면 "화면 최상단"과 "자동 선택된 세션"이 어긋난다)
import type { SessionListItem } from './types'

/** 정렬에 쓰는 시각. 에이전트 응답으로 순서가 뒤바뀌지 않도록 사람의 마지막 입력을 본다. 이 값을 안 주는 옛 서버면 마지막 활동을 쓴다. */
export function sortTs(s: SessionListItem): number {
  return s.lastInputAt ?? s.lastActivityAt ?? s.createdAt
}

/** 마지막 입력 DESC → 활성 세션 우선 → 세션명 ASC. 원본 배열은 건드리지 않는다. */
export function sortSessions(sessions: SessionListItem[]): SessionListItem[] {
  return [...sessions].sort((a, b) => {
    const at = sortTs(a)
    const bt = sortTs(b)
    if (bt !== at) return bt - at
    const aActive = a.status === 'active' ? 0 : 1
    const bActive = b.status === 'active' ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return a.displayName.localeCompare(b.displayName)
  })
}
