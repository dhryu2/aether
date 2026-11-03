// 폴더 탐색기의 순수 함수. 화면이나 서버를 모르므로 시험이 그대로 부른다.
// 경로 구간은 서버가 쪼개 보낸다. 여기서는 표시용으로 마지막 구간을 자르거나 앞을 줄일 때만 `/`·`\`를 함께 본다.
import type { FsPlaces } from '../../lib/types'

/** 이름 비교용 정규화. 맥은 한글 이름을 풀어쓴 모양(NFD)으로 돌려주므로 NFC로 맞추고 소문자로 바꾼다. */
function fold(s: string): string {
  return s.normalize('NFC').toLowerCase()
}

/** 지금 목록 안에서 이름에 검색어가 들어 있는 것만 남긴다. 검색어가 비면 그대로다. */
export function filterEntries<T extends { name: string }>(entries: T[], query: string): T[] {
  const q = fold(query.trim())
  if (!q) return entries
  return entries.filter((e) => fold(e.name).includes(q))
}

export type SelectionKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/**
 * 키를 눌렀을 때 선택될 줄 번호. current가 -1(선택 없음)이면 위아래 어느 쪽이든 첫 줄이다.
 * 끝에서는 멈추고 되감지 않는다. 줄이 없으면 -1.
 */
export function moveSelection(entries: readonly unknown[], current: number, key: SelectionKey): number {
  const n = entries.length
  if (n === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return n - 1
  if (current < 0 || current >= n) return 0
  return Math.min(n - 1, Math.max(0, current + (key === 'ArrowDown' ? 1 : -1)))
}

/** "이 폴더 선택"이 고를 폴더. 선택한 줄이 있으면 그 줄이고, 없으면 보는 폴더다. 목록을 못 받았으면(불러오는 중·실패) 열 수 없는 폴더이므로 null이다. */
export function pickTarget(selected: string | null, at: string | null, hasListing: boolean): string | null {
  return selected ?? (hasListing ? at : null)
}

/** 창을 처음 열 때 고를 폴더. 후보(앞이 우선)에 쓸 만한 것이 없으면 홈. */
export function seedFolder(candidates: string[], home: string): string {
  return candidates.find((c) => c) ?? home
}

/** 끝의 구분자를 걷는다. 루트(`/`, `C:\`)는 그대로 둔다. */
function trimTail(p: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(p) || /^[\\/]+$/.test(p)) return p
  return p.replace(/[\\/]+$/, '')
}

/** 위치 자체(홈, 드라이브·디스크 루트)를 작업 폴더로 고르면 범위가 넓다. 표시 전용. */
export function isWideFolder(path: string, places: FsPlaces): boolean {
  if (!path) return false
  const key = trimTail(path)
  return [places.home, ...places.devices.map((d) => d.path)].some((p) => trimTail(p) === key)
}

/** 한 단계 위 경로(표시 전용). 루트의 위는 루트 자신이다. */
export function parentPath(abs: string): string {
  const p = trimTail(abs)
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return p
  const head = p.slice(0, i)
  if (head === '' || /^[A-Za-z]:$/.test(head)) return p.slice(0, i + 1) // `/x` → `/`, `C:\x` → `C:\`
  return head
}

/** 홈 아래 경로는 앞을 `~`로 줄인다(표시 전용). 홈 밖이면 그대로. */
export function tildeHome(abs: string, home: string): string {
  const a = trimTail(abs)
  const h = trimTail(home)
  if (!h || !a.startsWith(h)) return abs
  if (a.length === h.length) return '~'
  const next = a[h.length]
  return next === '/' || next === '\\' ? `~${a.slice(h.length)}` : abs
}
