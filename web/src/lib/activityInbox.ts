/**
 * 손길 활동함 라벨·행. handRooms가 정본이다.
 */
import { handRooms } from './attention'
import type { SessionAttention, SessionAttentionKind, WorkspaceRoom } from './types'

export function inboxLabel(
  attention: SessionAttention | undefined,
  attentionKind: SessionAttentionKind | string | undefined,
): string {
  if (attention === 'waiting') {
    if (attentionKind === 'plan') return '계획 승인'
    if (attentionKind === 'permission') return '권한'
    if (attentionKind === 'question') return '질문'
    if (attentionKind === 'rate_limit') return '사용 한도 도달'
    if (attentionKind === 'interrupted_request') return '중단된 요청'
    return '대기'
  }
  if (attention === 'done') return '완료'
  if (attention === 'failed') return '실패'
  return ''
}

/** 손길 목록. 읽은 done(lastViewedAt >= lastActivityAt)은 빠진다. */
export function inboxRows(rooms: WorkspaceRoom[]): WorkspaceRoom[] {
  return handRooms(rooms).filter((r) => {
    if (r.attention !== 'done') return true
    if (r.lastViewedAt == null || r.lastActivityAt == null) return true
    return r.lastViewedAt < r.lastActivityAt
  })
}

/** 알림 목록 미리보기용 — 마크다운 기호(코드 표시·굵게·제목·목록·링크)를 걷어 읽히는 글만 남긴다. */
export function plainPreview(md: string): string {
  return md
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}
