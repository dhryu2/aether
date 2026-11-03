/**
 * 방 id와 실행 id 변환. 목록의 프로젝트 묶음은 sessionGroups.ts.
 */
import type { WorkspaceRoom } from './types'

/** dm → sourceSessionId. */
export function executionId(room: WorkspaceRoom | undefined): string | undefined {
  return room?.sourceSessionId
}

/**
 * 방 id 또는 실행 id → 실행 id. 서버 세션 REST·convos 키는 실행 id만 받는다.
 *   방 id를 그대로 보내면 서버가 "세션 없음"(404)을 돌려준다. 방이 아닌 값은 이미 실행 id로 본다.
 */
export function executionIdFor(
  rooms: WorkspaceRoom[] | undefined | null,
  id: string | null | undefined,
): string | null {
  if (!id) return null
  const room = findRoom(rooms, id)
  if (!room) return id
  return executionId(room) ?? null
}

/** 실행 id → 그 실행을 가진 방 id. 못 찾으면 받은 값 그대로(방 목록 도착 전·fan-out 직후). */
export function roomIdForExecution(
  rooms: WorkspaceRoom[] | undefined | null,
  execId: string,
): string {
  const room = rooms?.find((r) => executionId(r) === execId)
  return room?.id ?? execId
}

/** 방 id가 dm: 형태인지. 접두 없는 세션 uuid는 거부. */
export function isRoomId(id: string): boolean {
  return id.startsWith('dm:') && id.length > 3
}

export function findRoom(rooms: WorkspaceRoom[] | undefined | null, id: string | null | undefined): WorkspaceRoom | undefined {
  if (!id || !rooms) return undefined
  return rooms.find((r) => r.id === id)
}
