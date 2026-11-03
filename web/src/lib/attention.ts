// 세션·방 주의 상태 — 수명 status와 섞지 않는다. 화면 점·손길 칩이 같은 판정을 쓴다.
import type {
  AutoResumePlan,
  BackgroundTask,
  HandoffFields,
  HandoffState,
  PresenceSession,
  PresenceSnapshot,
  SessionAttention,
  SessionListItem,
  WorkspaceRoom,
} from './types'

const ATTENTION: ReadonlySet<string> = new Set(['idle', 'running', 'background', 'waiting', 'done', 'failed'])

export function isSessionAttention(v: unknown): v is SessionAttention {
  return typeof v === 'string' && ATTENTION.has(v)
}

const TASK_KINDS: ReadonlySet<string> = new Set(['agent', 'command', 'other'])

/** 뒤 작업 칸 검증 — 배열이고 각 항목이 문자열 id·kind·description이어야 한다. 모양이 틀린 항목은 그 항목만, 배열이 아니면 그 칸만 버린다. */
export function parseBackgroundTasks(v: unknown): BackgroundTask[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: BackgroundTask[] = []
  for (const row of v) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) continue
    if (typeof r.kind !== 'string' || !TASK_KINDS.has(r.kind)) continue
    if (typeof r.description !== 'string') continue
    out.push({ id: r.id, kind: r.kind as BackgroundTask['kind'], description: r.description })
  }
  return out
}

/** 자동 재개 예약 칸 검증 — 옛 서버에는 없고, 모양이 틀리면 버린다. */
export function parseAutoResume(v: unknown): AutoResumePlan | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const action = r.action as { type?: unknown; text?: unknown } | undefined
  // 실행 종류는 문장 보내기와 인계서 쓰기 둘이다. 모르는 종류는 버린다(옛 화면이 새 종류를 만나도 깨지지 않게).
  const planAction: AutoResumePlan['action'] | null =
    action?.type === 'send' && typeof action.text === 'string' ? { type: 'send', text: action.text } : action?.type === 'handoff' ? { type: 'handoff' } : null
  if (!planAction) return undefined
  if (typeof r.attempts !== 'number') return undefined
  const out: AutoResumePlan = { action: planAction, attempts: r.attempts }
  if (typeof r.at === 'number') out.at = r.at
  if (r.gaveUp === true) out.gaveUp = true
  return out.at === undefined && !out.gaveUp ? undefined : out
}

export function parsePresenceSession(raw: unknown): PresenceSession | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  if (!isSessionAttention(o.attention)) return null
  if (typeof o.status !== 'string' || !o.status) return null
  const out: PresenceSession = {
    id: o.id,
    attention: o.attention,
    status: o.status as PresenceSession['status'],
  }
  if (typeof o.displayName === 'string') out.displayName = o.displayName
  if (typeof o.attentionKind === 'string') out.attentionKind = o.attentionKind as PresenceSession['attentionKind']
  if (typeof o.attentionPreview === 'string') out.attentionPreview = o.attentionPreview
  if (typeof o.attentionSince === 'number') out.attentionSince = o.attentionSince
  if (typeof o.lastActivityAt === 'number') out.lastActivityAt = o.lastActivityAt
  if (typeof o.preview === 'string') out.preview = o.preview
  if (typeof o.lastViewedAt === 'number') out.lastViewedAt = o.lastViewedAt
  if (typeof o.archivedAt === 'number') out.archivedAt = o.archivedAt
  const tasks = parseBackgroundTasks(o.backgroundTasks)
  if (tasks) out.backgroundTasks = tasks
  if (typeof o.backgroundCanStop === 'boolean') out.backgroundCanStop = o.backgroundCanStop
  const autoResume = parseAutoResume(o.autoResume)
  if (autoResume) out.autoResume = autoResume
  Object.assign(out, parseHandoffFields(o))
  return out
}

const HANDOFF_STATES: ReadonlySet<string> = new Set(['writing', 'waiting_limit', 'copy_ready'])

/** 넘기기 연결 칸 검증 — 옛 서버에는 없고, 모양이 틀린 칸은 그 칸만 버린다. */
export function parseHandoffFields(o: Record<string, unknown>): HandoffFields {
  const out: HandoffFields = {}
  if (typeof o.handoffFrom === 'string' && o.handoffFrom) out.handoffFrom = o.handoffFrom
  if (typeof o.handoffTo === 'string' && o.handoffTo) out.handoffTo = o.handoffTo
  if (typeof o.handoffState === 'string' && HANDOFF_STATES.has(o.handoffState)) out.handoffState = o.handoffState as HandoffState
  if (o.handoffDraftPending === true) out.handoffDraftPending = true
  return out
}

/** 실시간 갱신 한 줄이 가진 넘기기 칸. 없는 칸은 지워진 것이라 undefined로 덮는다. */
function handoffPatch(p: PresenceSession): HandoffFields {
  return { handoffFrom: p.handoffFrom, handoffTo: p.handoffTo, handoffState: p.handoffState, handoffDraftPending: p.handoffDraftPending }
}

/**
 * 새 화면 파서 — `channels`만 병합 대상으로 인정.
 * 옛 `sessions`만 있는 스냅샷은 null(방을 바꾸지 않음).
 */
export function parsePresenceSnapshot(raw: unknown): PresenceSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const channelsRaw = o.channels
  if (!Array.isArray(channelsRaw)) return null
  const channels: PresenceSession[] = []
  for (const row of channelsRaw) {
    const p = parsePresenceSession(row)
    if (p) channels.push(p)
  }
  const sessions: PresenceSession[] = []
  if (Array.isArray(o.sessions)) {
    for (const row of o.sessions) {
      const p = parsePresenceSession(row)
      if (p) sessions.push(p)
    }
  }
  const contractVersion = typeof o.contractVersion === 'number' ? o.contractVersion : 0
  return { contractVersion, channels, sessions }
}

/** 옛 화면 호환 — sessions 배열만 있는 스냅샷. 결정적 시험에서만. */
export function parseLegacyPresenceSnapshot(raw: unknown): { sessions: PresenceSession[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const sessions = (raw as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return null
  const out: PresenceSession[] = []
  for (const row of sessions) {
    const p = parsePresenceSession(row)
    if (p) out.push(p)
  }
  return { sessions: out }
}

export function patchSessionFromPresence(item: SessionListItem, p: PresenceSession): SessionListItem {
  return {
    ...item,
    displayName: p.displayName ?? item.displayName,
    attention: p.attention,
    attentionKind: p.attentionKind,
    attentionPreview: p.attentionPreview,
    attentionSince: p.attentionSince,
    backgroundTasks: p.backgroundTasks,
    backgroundCanStop: p.backgroundCanStop,
    lastActivityAt: p.lastActivityAt ?? item.lastActivityAt,
    preview: p.preview ?? item.preview,
    status: p.status,
    lastViewedAt: p.lastViewedAt,
    observedEffort: p.observedEffort, // 없으면 강도나 모델을 바꾼 것이다 — 그대로 덮어쓴다
    archivedAt: p.archivedAt, // 없으면 보관 해제 — 그대로 덮어쓴다
    autoResume: p.autoResume, // 없으면 예약이 없어졌다 — 그대로 덮어쓴다
    ...handoffPatch(p), // 없으면 지워진 것이다 — 그대로 덮어쓴다
  }
}

export function patchRoomFromPresence(room: WorkspaceRoom, p: PresenceSession): WorkspaceRoom {
  return {
    ...room,
    title: p.displayName ?? room.title,
    attention: p.attention,
    attentionKind: p.attentionKind,
    attentionPreview: p.attentionPreview,
    attentionSince: p.attentionSince,
    backgroundTasks: p.backgroundTasks,
    backgroundCanStop: p.backgroundCanStop,
    lastActivityAt: p.lastActivityAt ?? room.lastActivityAt,
    preview: p.preview ?? room.preview,
    status: p.status,
    lastViewedAt: p.lastViewedAt,
    archivedAt: p.archivedAt, // 없으면 보관 해제 — 그대로 덮어쓴다
    autoResume: p.autoResume, // 없으면 예약이 없어졌다 — 그대로 덮어쓴다
    ...handoffPatch(p), // 없으면 지워진 것이다 — 그대로 덮어쓴다
  }
}

export function mergePresenceSnapshot(items: SessionListItem[], snapshot: PresenceSession[]): SessionListItem[] {
  if (snapshot.length === 0) return items
  const byId = new Map(snapshot.map((p) => [p.id, p]))
  return items.map((item) => {
    const p = byId.get(item.id)
    return p ? patchSessionFromPresence(item, p) : item
  })
}

export function mergeRoomPresenceSnapshot(rooms: WorkspaceRoom[], snapshot: PresenceSession[]): WorkspaceRoom[] {
  if (snapshot.length === 0) return rooms
  const byId = new Map(snapshot.map((p) => [p.id, p]))
  return rooms.map((room) => {
    const p = byId.get(room.id)
    return p ? patchRoomFromPresence(room, p) : room
  })
}

export function mergePresenceUpdate(items: SessionListItem[], update: PresenceSession): SessionListItem[] {
  const i = items.findIndex((s) => s.id === update.id)
  if (i < 0) return items
  const next = items.slice()
  next[i] = patchSessionFromPresence(items[i], update)
  return next
}

export function mergeRoomPresenceUpdate(rooms: WorkspaceRoom[], update: PresenceSession): WorkspaceRoom[] {
  const i = rooms.findIndex((r) => r.sourceSessionId === update.id)
  if (i < 0) return rooms
  const next = rooms.slice()
  next[i] = patchRoomFromPresence(rooms[i], update)
  return next
}

/** 손길 칩이 세는 것 — 대기·끝남·실패. 일하는 중은 안 센다. 집계된 attention만. */
export function needsHand(s: { attention?: SessionAttention }): boolean {
  return s.attention === 'waiting' || s.attention === 'done' || s.attention === 'failed'
}

const HAND_RANK: Record<'waiting' | 'failed' | 'done', number> = { waiting: 0, failed: 1, done: 2 }

/** 대기끼리는 오래 기다린 순(since가 이른 쪽이 먼저). 한쪽이라도 시작 시각이 없으면 0(그대로 다음 기준으로). */
function waitingOrder(a: { attention?: SessionAttention; attentionSince?: number }, b: { attention?: SessionAttention; attentionSince?: number }): number {
  if (a.attention !== 'waiting' || b.attention !== 'waiting') return 0
  if (a.attentionSince == null || b.attentionSince == null) return 0
  return a.attentionSince - b.attentionSince
}

export function handSessions(items: SessionListItem[]): SessionListItem[] {
  return items
    .filter(needsHand)
    .slice()
    .sort((a, b) => {
      const ra = HAND_RANK[a.attention as 'waiting' | 'failed' | 'done'] ?? 9
      const rb = HAND_RANK[b.attention as 'waiting' | 'failed' | 'done'] ?? 9
      if (ra !== rb) return ra - rb
      return waitingOrder(a, b) || (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt)
    })
}

export function handRooms(rooms: WorkspaceRoom[]): WorkspaceRoom[] {
  return rooms
    .filter(needsHand)
    .slice()
    .sort((a, b) => {
      const ra = HAND_RANK[a.attention as 'waiting' | 'failed' | 'done'] ?? 9
      const rb = HAND_RANK[b.attention as 'waiting' | 'failed' | 'done'] ?? 9
      if (ra !== rb) return ra - rb
      return waitingOrder(a, b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })
}

/** 손상 카드는 수명 점선이 이긴다. 주의 칸이 없으면 수명 점(옛 서버). */
export function cardUsesAttentionDot(s: SessionListItem | WorkspaceRoom): boolean {
  return s.status !== 'corrupted' && s.attention != null
}

export function cardPreviewLine(s: SessionListItem | WorkspaceRoom, livePreview: string): string {
  if (needsHand(s) && s.attentionPreview) return s.attentionPreview
  return livePreview || s.preview || ''
}

/** 이만큼 기다리면 「오래 기다림」으로 강조한다. */
export const LONG_WAIT_MS = 10 * 60_000

export type WaitAge = { unit: 'now' | 'minutes' | 'hours' | 'yesterday'; n: number }

/** 기다린 시간을 거친 단위로. 1분 미만 방금, 1시간 미만 분, 하루 미만 시간, 그 이상은 어제부터. */
export function waitAge(since: number, now: number): WaitAge {
  const m = Math.floor(Math.max(0, now - since) / 60_000)
  if (m < 1) return { unit: 'now', n: 0 }
  if (m < 60) return { unit: 'minutes', n: m }
  const h = Math.floor(m / 60)
  if (h < 24) return { unit: 'hours', n: h }
  return { unit: 'yesterday', n: 0 }
}

export function isLongWait(since: number, now: number): boolean {
  return now - since >= LONG_WAIT_MS
}
