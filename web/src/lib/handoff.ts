// 다음 작업으로 넘기기 — 화면이 쓰는 순수 판정. React도 저장소도 모른다.
import type { HandoffRequestBody, WorkspaceRoom } from './types'

export type HandoffPurpose = HandoffRequestBody['purpose']
export const HANDOFF_PURPOSES: readonly HandoffPurpose[] = ['continue', 'rediscuss', 'next']
/** 서버가 받는 초점 글의 상한. */
export const HANDOFF_FOCUS_MAX = 4000

/** 넘기기 단추를 켤 수 있는가. 다음 작업은 초점 글이 비어 있으면 안 된다. 초점 글은 모든 목적에서 상한을 지킨다. */
export function canSubmitHandoff(purpose: HandoffPurpose, focus: string): boolean {
  if (focus.length > HANDOFF_FOCUS_MAX) return false
  return purpose !== 'next' || focus.trim().length > 0
}

export type HandoffMenuState =
  | { kind: 'hidden' }
  | { kind: 'blocked'; reason: 'busy' | 'inProgress' }
  | { kind: 'ready' }

/** 메뉴 항목의 상태. 보관·손상된 세션은 항목을 숨기고, 일하는 중이거나 이미 넘기는 중이면 이유와 함께 막는다. */
export function handoffMenuState(room: Pick<WorkspaceRoom, 'archivedAt' | 'status' | 'attention' | 'handoffState'>): HandoffMenuState {
  if (room.archivedAt || room.status === 'corrupted') return { kind: 'hidden' }
  if (room.handoffState === 'writing' || room.handoffState === 'waiting_limit') return { kind: 'blocked', reason: 'inProgress' }
  if (room.attention === 'running' || room.attention === 'waiting' || room.attention === 'background') return { kind: 'blocked', reason: 'busy' }
  return { kind: 'ready' }
}

export type HandoffTransition = 'swap' | 'copy' | 'waiting' | 'stopped' | null

type HandoffView = Pick<WorkspaceRoom, 'handoffState' | 'handoffTo'>

/**
 * 같은 방의 앞뒤 모습에서 넘기기 결과를 읽는다.
 *   swap    쓰던 작업이 끝나고 새 세션이 연결됨
 *   copy    복사 결과가 생김(복사만, 또는 새 세션을 만들지 못함)
 *   waiting 한도 대기로 바뀜
 *   stopped 새 세션 없이 작업이 사라짐(사람이 멈췄거나 취소함)
 * 값이 그대로이면 null.
 */
export function handoffTransition(prev: HandoffView | undefined, next: HandoffView): HandoffTransition {
  if (!prev || !prev.handoffState) return null
  if (next.handoffState === prev.handoffState) return null
  if (next.handoffState === 'copy_ready') return 'copy'
  if (next.handoffState === 'waiting_limit') return 'waiting'
  if (next.handoffState === 'writing') return null // 한도 대기가 끝나 다시 쓰는 중
  return next.handoffTo && next.handoffTo !== prev.handoffTo ? 'swap' : 'stopped'
}

/**
 * 넘기기 입구를 달 답변 말풍선의 위치. 턴이 끝났고 그 뒤에 사람이 보낸 말이 없을 때의 마지막 답변 하나뿐이다.
 * 없으면 -1. 도구 줄이나 안내가 답변 뒤에 와도 사람의 다음 말이 없으면 그 답변이 마지막이다.
 */
export function lastAnswerIndex(segs: readonly { kind: string }[], turnOpen: boolean): number {
  if (turnOpen) return -1
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind === 'user') return -1
    if (segs[i].kind === 'text') return i
  }
  return -1
}
