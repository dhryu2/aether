// 이전 기록 불러오기의 상태 전이 — 순수 함수만 둔다(React·DOM을 모른다).
//
// 이전에는 "서버 응답 대기 중인가", "앵커 보정 중인가", "이 지점은 실패했는가"를 ref 여러 개로 따로 들고 있어서
// 불러오는 경로(스크롤·상단 센티널·빈 대화 탐색)마다 규칙이 조금씩 달랐다. 상태를 여기 하나로 모은다.
//
//   idle ──fetch──▶ fetching ──fetched(changed, anchored)──▶ settling ──settled──▶ idle
//     │                 └──fetched(실패 또는 앵커 없음)──────────────────────────▶ idle (실패면 failedAt 기록)
//     └──expand──▶ settling   (서버가 아니라 이미 받은 데이터로 렌더 창만 넓힐 때)
//
// settling은 prepend가 화면에 반영된 뒤 위치를 맞추는 동안이다. 이 동안에는 새 불러오기를 시작하지 않는다.

import type { OlderSearchPaging } from './olderHistorySearch'

export type OlderLoadState = {
  phase: 'idle' | 'fetching' | 'settling'
  cursor: number | null // fetching일 때 요청한 지점(그 시점의 oldestSeq)
  failedAt: number | null // 실패·빈 페이지로 끝난 지점 — 같은 지점을 자동으로 다시 시도하지 않는다
}

export const OLDER_IDLE: OlderLoadState = { phase: 'idle', cursor: null, failedAt: null }

export type OlderLoadEvent =
  | { type: 'reset' }
  | { type: 'fetch'; cursor: number }
  | { type: 'expand' }
  | { type: 'fetched'; cursor: number; changed: boolean; anchored: boolean }
  | { type: 'settled' }

export function olderLoadNext(s: OlderLoadState, e: OlderLoadEvent): OlderLoadState {
  switch (e.type) {
    case 'reset':
      return OLDER_IDLE
    case 'fetch':
      return s.phase === 'idle' ? { ...s, phase: 'fetching', cursor: e.cursor } : s
    case 'expand':
      return s.phase === 'idle' ? { ...s, phase: 'settling' } : s
    case 'fetched':
      // 늦게 끝난 옛 요청(다른 지점·이미 리셋)은 지금 상태를 건드리지 않는다.
      if (s.phase !== 'fetching' || s.cursor !== e.cursor) return s
      if (!e.changed) return { phase: 'idle', cursor: null, failedAt: e.cursor }
      return { ...s, phase: e.anchored ? 'settling' : 'idle', cursor: null }
    case 'settled':
      return s.phase === 'settling' ? { ...s, phase: 'idle' } : s
  }
}

/** 지금 서버에서 한 페이지 더 받아도 되는가. `auto`(센티널·탐색)는 실패한 지점을 다시 시도하지 않는다. */
export function canFetchOlder(s: OlderLoadState, older: OlderSearchPaging, auto: boolean): boolean {
  if (s.phase !== 'idle' || !older?.hasOlder || older.loading) return false
  return !(auto && s.failedAt === older.oldestSeq)
}
