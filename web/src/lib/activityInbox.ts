/**
 * 손길 활동함 라벨·행. handRooms가 정본이다.
 */
import { handRooms } from './attention'
import { permissionArgs } from './format'
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

/** 브라우저 탭 제목 — 사람을 기다리는 방이 있으면 `(2) Aether`. 알림 종과 같게 live일 때만 센다. */
export function tabTitle(rooms: WorkspaceRoom[], live: boolean): string {
  const n = live ? rooms.filter((r) => r.attention === 'waiting').length : 0
  return n > 0 ? `(${n}) Aether` : 'Aether'
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

type PermReq = { id: string; mutation?: unknown; input?: Record<string, unknown>; toolKind?: string; blockedPath?: string }

/** 알림 목록 줄에 보일 인자 전문. 인자가 하나면 값만, 여럿이면 `키: 값`을 줄바꿈으로 잇는다. */
export function inboxPermissionText(req: PermReq): string {
  const args = permissionArgs(req.input)
  return args.length === 1 ? args[0].value : args.map((a) => `${a.key}: ${a.value}`).join('\n')
}

// 화면에 보이는 것과 실제가 달라질 수 있는 글자: 제어 문자, 글자 방향 바꿈, 폭 없는 글자.
// eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적이다
const DECEPTIVE_CHARS = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/

/**
 * 줄에서 바로 승인해도 되는 요청 — 파일 변경이 아니고, 값이 한 줄에 120자 이하일 때만. 인자 이름은 보지 않는다.
 * 파일 변경은 미리보기가 없는 요청도 있어, 어댑터가 싣는 도구 종류로 가린다. 종류를 모르는 요청(옛 서버)은 세션에서 본다.
 */
export function inlinePermissionOk(req: PermReq): boolean {
  if (!req.toolKind || req.toolKind === 'file_change') return false
  if (req.mutation || req.blockedPath) return false
  const args = permissionArgs(req.input)
  if (args.some((a) => a.value.includes('\n') || DECEPTIVE_CHARS.test(a.value))) return false
  return inboxPermissionText(req).length <= 120
}

/** 고른 id 가운데 지금 받아 둔 목록에 있고 바로 승인할 수 있는 것만. */
export function liveSelection(selected: Iterable<string>, perms: PermReq[]): string[] {
  const ok = new Set(perms.filter(inlinePermissionOk).map((p) => p.id))
  return [...selected].filter((id) => ok.has(id))
}

/** 차례로 보낸다. 404는 다른 곳에서 이미 답한 것(gone)이고, 실패해도 남은 요청을 계속 보낸다. */
export async function resolveInOrder(
  pairs: { sessionId: string; permissionId: string }[],
  call: (sessionId: string, permissionId: string) => Promise<unknown>,
): Promise<{ done: number; gone: number; failed: number }> {
  const r = { done: 0, gone: 0, failed: 0 }
  for (const p of pairs) {
    try {
      await call(p.sessionId, p.permissionId)
      r.done++
    } catch (e) {
      if ((e as { status?: number })?.status === 404) r.gone++
      else r.failed++
    }
  }
  return r
}
