// 세션 목록을 작업 폴더 기준으로 묶는다. 화면 사이드바가 쓰고, 부팅 시 기본 세션 선택은 여전히 sessionOrder.ts다.
//   묶음 열쇠 = 원래 고른 폴더(workspaceSource)가 있으면 그것, 없으면 지금 도는 폴더(cwd).
//   작업 폴더를 분리한 세션이 원 프로젝트 밖으로 빠지지 않게 하려는 규칙이다.
import type { SessionListItem } from './types'
import { sortSessions } from './sessionOrder'

/** 경로가 비어 있는 세션을 한곳에 모을 때 쓰는 열쇠. */
export const UNKNOWN_PROJECT_KEY = ''

export type SessionProjectGroup = {
  key: string
  /** 폴더 마지막 이름. 열쇠가 비면 빈 문자열 — 화면이 번역 문구로 채운다. */
  label: string
  sessions: SessionListItem[]
}

/** 끝 슬래시만 걷는다. 대소문자는 그대로 둔다(같은 글자면 같은 프로젝트). */
export function normalizeFolder(raw: string | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return UNKNOWN_PROJECT_KEY
  if (s === '/') return '/'
  return s.replace(/\/+$/, '')
}

export function projectKey(session: SessionListItem): string {
  return normalizeFolder(session.workspaceSource || session.cwd)
}

export function folderName(key: string): string {
  if (!key) return ''
  // 서버가 윈도우면 경로 구분이 `\`다. 둘 중 더 뒤에 있는 쪽으로 자른다.
  const i = Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\'))
  const base = i === -1 ? key : key.slice(i + 1)
  return base || key
}

/**
 * 프로젝트를 최근 활동 순으로, 안쪽 세션은 sortSessions와 같은 기준으로 정렬한다.
 * 원본 배열은 건드리지 않는다.
 */
export function groupSessions(sessions: SessionListItem[]): SessionProjectGroup[] {
  const map = new Map<string, SessionListItem[]>()
  for (const session of sessions) {
    const key = projectKey(session)
    const list = map.get(key)
    if (list) list.push(session)
    else map.set(key, [session])
  }
  const groups: SessionProjectGroup[] = []
  for (const [key, items] of map) {
    const sorted = sortSessions(items)
    groups.push({ key, label: folderName(key), sessions: sorted })
  }
  groups.sort((a, b) => {
    const at = activityTs(a.sessions[0])
    const bt = activityTs(b.sessions[0])
    if (bt !== at) return bt - at
    return a.label.localeCompare(b.label)
  })
  return groups
}

/**
 * 새 작업 창의 최근 폴더. 사이드바 묶음과 같은 최근 활동 순으로 절대 경로를 돌려준다.
 * 경로가 빈 세션(열쇠가 빈 묶음)만 뺀다. 홈 자체도 고를 수 있는 폴더다.
 */
export function recentFolders(sessions: SessionListItem[], limit: number): string[] {
  const out: string[] = []
  for (const group of groupSessions(sessions)) {
    if (out.length >= limit) break
    if (group.key && !out.includes(group.key)) out.push(group.key)
  }
  return out
}

function activityTs(session: SessionListItem | undefined): number {
  if (!session) return 0
  return session.lastActivityAt ?? session.createdAt
}

export type SessionBucketKind = 'source' | 'copy'

export type SessionBucket = {
  kind: SessionBucketKind
  sessions: SessionListItem[]
}

/**
 * 한 프로젝트 안에서 원 폴더 세션과 복사본 세션이 섞였을 때만 두 단으로 나눈다.
 * 한쪽만 있으면 null — 화면은 프로젝트 바로 아래 세션 줄을 그린다.
 */
export function splitIsolatedBuckets(sessions: SessionListItem[]): SessionBucket[] | null {
  const source: SessionListItem[] = []
  const copy: SessionListItem[] = []
  for (const session of sessions) {
    if (session.isolated === true) copy.push(session)
    else source.push(session)
  }
  if (source.length === 0 || copy.length === 0) return null
  return [
    { kind: 'source', sessions: sortSessions(source) },
    { kind: 'copy', sessions: sortSessions(copy) },
  ]
}

/** 목록에 올릴 방. 채널은 묶기 전에 걸러진다. */
export type RoomForProject = {
  id: string
  kind: string
  cwd?: string
  sourceSessionId?: string
  lastActivityAt?: number
}

export type RoomProjectGroup<R> = {
  key: string
  /** 폴더 마지막 이름. 열쇠가 비면 빈 문자열. */
  label: string
  /** 같은 마지막 이름이 둘이면 `부모/이름`. */
  title: string
  rooms: R[]
}

/** 같은 폴더 이름이 둘 이상이면 부모 폴더를 붙여 가른다. */
export function disambiguateFolderTitles(keys: readonly string[]): Map<string, string> {
  const names = keys.map((key) => folderName(key))
  const count = new Map<string, number>()
  for (const name of names) count.set(name, (count.get(name) ?? 0) + 1)
  const out = new Map<string, string>()
  keys.forEach((key, i) => {
    const name = names[i] ?? ''
    if ((count.get(name) ?? 0) <= 1) {
      out.set(key, name)
      return
    }
    const parts = key.split('/').filter(Boolean)
    if (parts.length >= 2) out.set(key, `${parts[parts.length - 2]}/${parts[parts.length - 1]}`)
    else out.set(key, name || key)
  })
  return out
}

/**
 * 1대1 방을 세션의 작업 폴더로 묶는다. 열쇠는 groupSessions와 같다(workspaceSource 우선).
 * 묶음·안쪽 순서는 최근 활동 순(sortSessions와 같은 동점 규칙).
 */
export function groupRoomsByProject<R extends RoomForProject>(
  rooms: readonly R[],
  sessions: readonly SessionListItem[],
): RoomProjectGroup<R>[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const map = new Map<string, R[]>()
  for (const room of rooms) {
    const sess = room.sourceSessionId ? byId.get(room.sourceSessionId) : undefined
    const key = sess ? projectKey(sess) : normalizeFolder(room.cwd)
    const list = map.get(key)
    if (list) list.push(room)
    else map.set(key, [room])
  }
  const titles = disambiguateFolderTitles([...map.keys()])
  const groups: Array<RoomProjectGroup<R> & { ts: number }> = []
  for (const [key, items] of map) {
    const sortedSessions = sortSessions(items.map((room) => sessionForSort(room, byId.get(room.sourceSessionId ?? ''))))
    const order = new Map(sortedSessions.map((s, i) => [s.id, i]))
    const roomsSorted = [...items].sort((a, b) => {
      const ai = order.get(sortId(a)) ?? 0
      const bi = order.get(sortId(b)) ?? 0
      return ai - bi
    })
    const head = sortedSessions[0]
    groups.push({
      key,
      label: folderName(key),
      title: titles.get(key) ?? folderName(key),
      rooms: roomsSorted,
      ts: head ? (head.lastActivityAt ?? head.createdAt) : 0,
    })
  }
  groups.sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts
    return a.label.localeCompare(b.label)
  })
  return groups.map((group) => ({
    key: group.key,
    label: group.label,
    title: group.title,
    rooms: group.rooms,
  }))
}

function sortId(room: RoomForProject): string {
  return room.sourceSessionId || room.id
}

function sessionForSort(room: RoomForProject, sess: SessionListItem | undefined): SessionListItem {
  if (sess) return sess
  return {
    id: sortId(room),
    cwd: room.cwd ?? '',
    displayName: room.id,
    provider: '',
    model: '',
    permissionMode: 'manual',
    status: 'active',
    createdAt: 0,
    lastActivityAt: room.lastActivityAt,
  }
}

/** 보관된 것을 일반 목록에서 빼고, 보관됨 목록은 보관 시각 내림차순(최신 먼저)으로 만든다. 원본은 건드리지 않는다. */
export function splitArchived<T extends { archivedAt?: number }>(items: readonly T[]): { active: T[]; archived: T[] } {
  const active: T[] = []
  const archived: T[] = []
  for (const item of items) (item.archivedAt ? archived : active).push(item)
  archived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  return { active, archived }
}
