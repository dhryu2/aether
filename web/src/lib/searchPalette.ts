// 검색 팝업의 순수 계산. 빈 입력의 최근 세션과 위아래 키 이동.
import type { WorkspaceRoom } from './types'

/** 빈 입력에서 보이는 최근 세션 수. */
export const RECENT_LIMIT = 8

/** 보관하지 않은 세션을 사이드바와 같은 기준(마지막 입력, 없으면 마지막 활동)으로 최신순 정렬해 앞에서 limit개. 원본은 건드리지 않는다. */
export function recentRooms(rooms: readonly WorkspaceRoom[], limit = RECENT_LIMIT): WorkspaceRoom[] {
  const ts = (r: WorkspaceRoom) => r.lastInputAt ?? r.lastActivityAt ?? 0
  return rooms.filter((r) => !r.archivedAt).sort((a, b) => ts(b) - ts(a)).slice(0, limit)
}

/** 결과 행의 요소 id. 검색 입력칸이 aria-activedescendant로 현재 행을 가리킨다. */
export const hitOptionId = (hitId: number) => `search-opt-${hitId}`

/** 위아래 키로 옮긴 다음 행. 끝에서 반대쪽 끝으로 돈다. 행이 없으면 -1. */
export function stepActive(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1
  return (Math.max(0, current) + delta + count) % count
}
