// 새 세션으로 넘기기 — 화면이 쓰는 순수 판정. React도 저장소도 모른다.
import type { WorkspaceRoom } from './types'

/** 서버가 받는 다음에 할 일 글의 상한. */
export const HANDOFF_FOCUS_MAX = 4000

export type HandoffMenuState =
  | { kind: 'hidden' }
  | { kind: 'blocked'; reason: 'busy' | 'inProgress' }
  | { kind: 'ready' }

/** 메뉴 항목의 상태. 보관·손상된 세션은 항목을 숨기고, 일하는 중이거나 이미 넘기는 중이면 이유와 함께 막는다. */
export function handoffMenuState(room: Pick<WorkspaceRoom, 'archivedAt' | 'status' | 'attention' | 'handoffState'>): HandoffMenuState {
  if (room.archivedAt || room.status === 'corrupted') return { kind: 'hidden' }
  if (room.handoffState === 'writing' || room.handoffState === 'asking' || room.handoffState === 'waiting_limit') return { kind: 'blocked', reason: 'inProgress' }
  if (room.attention === 'running' || room.attention === 'waiting' || room.attention === 'background') return { kind: 'blocked', reason: 'busy' }
  return { kind: 'ready' }
}

export type HandoffTransition = 'swap' | 'copy' | 'waiting' | 'asking' | 'stopped' | null

type HandoffView = Pick<WorkspaceRoom, 'handoffState' | 'handoffTo'>

/**
 * 같은 방의 앞뒤 모습에서 넘기기 결과를 읽는다.
 *   swap    쓰던 작업이 끝나고 새 세션이 연결됨
 *   copy    복사 결과가 생김(복사만, 또는 새 세션을 만들지 못함)
 *   waiting 한도 대기로 바뀜
 *   asking  이전 세션 AI가 넘기기 전에 사람에게 물어 답을 기다림
 *   stopped 새 세션 없이 작업이 사라짐(사람이 멈췄거나 취소함)
 * 값이 그대로이면 null.
 */
export function handoffTransition(prev: HandoffView | undefined, next: HandoffView): HandoffTransition {
  if (!prev || !prev.handoffState) return null
  if (next.handoffState === prev.handoffState) return null
  if (next.handoffState === 'copy_ready') return 'copy'
  if (next.handoffState === 'waiting_limit') return 'waiting'
  if (next.handoffState === 'asking') return 'asking'
  if (next.handoffState === 'writing') return null // 한도 대기가 끝났거나 질문에 답을 받아 다시 쓰는 중
  return next.handoffTo && next.handoffTo !== prev.handoffTo ? 'swap' : 'stopped'
}
