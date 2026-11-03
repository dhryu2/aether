/** 대화 칸 — 최대 4개. 창 폭 1100 미만은 1칸. 그 이상은 대화 영역(W, H)에 칸 하나의 최소 크기가 들어가는 만큼. */

export const WIDE_MIN = 1100
export const WIDE_QUERY = `(min-width: ${WIDE_MIN}px)`
/** 칸 하나의 최소 크기. 이보다 좁거나 낮아지게 칸을 더 놓지 않는다. */
export const PANE_MIN_W = 420
export const PANE_MIN_H = 300
/** 칸 사이 간격(index.css .pane-grid gap). */
export const PANE_GAP = 8
/** 3칸을 한 줄로 놓는 대화 영역 폭. 그보다 좁으면 왼쪽 한 칸 + 오른쪽 위아래. */
export const PANE_THREE_ROW_MIN_W = 1320
export const MAX_PANES = 4
export const PANES_KEY = 'aether.panes.v1'
/** 목록 기둥이 대화 영역에서 가져가는 가로 폭(기둥 + 바깥 여백). 펼침 288 + 20, 접힘 56 + 10. */
export const SIDEBAR_INSET = 308
export const SIDEBAR_RAIL_INSET = 66

export function sidebarInset(collapsed: boolean): number {
  return collapsed ? SIDEBAR_RAIL_INSET : SIDEBAR_INSET
}

export type StoredPanes = { ids: string[]; focusedId: string | null }

export type PaneSnap = {
  activeId: string | null
  sideIds: string[]
  focusedId: string | null
}

export type PanePlace = {
  column?: string
  row?: string
  /** 위쪽 줄. 상단 섬 높이(--bar-h)만큼 비운다. */
  top: boolean
}

export type PaneLayout = {
  columns: string
  rows: string
  places: PanePlace[]
}

/** 길이 L 안에 최소 크기 m짜리 칸이 간격 포함으로 몇 개 들어가는가. */
function fits(L: number, m: number): number {
  return Math.max(0, Math.floor((L + PANE_GAP) / (m + PANE_GAP)))
}

/**
 * 대화 칸 영역의 폭 W, 높이 H로 놓을 수 있는 칸 수(1~4).
 * 가로 2칸 이상 + 세로 2칸 이상이면 4(2×2). 높이가 모자라도 폭이 3칸 한 줄 기준(PANE_THREE_ROW_MIN_W)이면 3.
 * 가로 2칸이면 2. 그보다 좁으면 1. 창 폭 1100 미만의 1칸은 visibleCapacity가 맡는다.
 */
export function paneCapacity(W: number, H: number): 1 | 2 | 3 | 4 {
  const cols = fits(W, PANE_MIN_W)
  if (cols >= 2 && fits(H, PANE_MIN_H) >= 2) return 4
  if (W >= PANE_THREE_ROW_MIN_W && fits(H, PANE_MIN_H) >= 1) return 3
  return cols >= 2 ? 2 : 1
}

/** 지금 화면에 놓을 수 있는 칸 수. windowWide가 거짓이면 1. */
export function visibleCapacity(windowWide: boolean, W: number, H: number): 1 | 2 | 3 | 4 {
  if (!windowWide) return 1
  return paneCapacity(W, H)
}

/** 칸 순서. 첫 값이 왼쪽 위(active), 나머지는 옆 칸. 중복·빈 값·5번째 이후는 버린다. */
export function paneIds(activeId: string | null, sideIds: readonly string[]): string[] {
  const out: string[] = []
  const push = (id: string | null | undefined) => {
    if (!id || out.includes(id) || out.length >= MAX_PANES) return
    out.push(id)
  }
  push(activeId)
  for (const id of sideIds) push(id)
  return out
}

export function visibleSessionIds(activeId: string | null, sideIds: readonly string[], capacity: number): string[] {
  const cap = Math.max(0, Math.min(MAX_PANES, Math.floor(capacity)))
  if (cap < 1) return []
  return paneIds(activeId, sideIds).slice(0, cap)
}

export function isVisibleSession(
  id: string,
  activeId: string | null,
  sideIds: readonly string[],
  capacity: number,
): boolean {
  return visibleSessionIds(activeId, sideIds, capacity).includes(id)
}

/** 클릭으로 포커스 준 칸. 없거나 지금 안 보이면 첫 칸. */
export function focusedSessionId(
  focusedId: string | null,
  activeId: string | null,
  sideIds: readonly string[],
  capacity: number,
): string | null {
  if (focusedId && isVisibleSession(focusedId, activeId, sideIds, capacity)) return focusedId
  return activeId
}

export function paneLayout(n: number, W: number): PaneLayout {
  const count = Math.max(1, Math.min(MAX_PANES, Math.floor(n)))
  const col = '1fr'
  if (count <= 1) return { columns: col, rows: col, places: [{ top: true }] }
  if (count === 2) {
    return { columns: `${col} ${col}`, rows: col, places: [{ top: true }, { top: true }] }
  }
  if (count === 3) {
    if (W >= PANE_THREE_ROW_MIN_W) {
      return {
        columns: `${col} ${col} ${col}`,
        rows: col,
        places: [{ top: true }, { top: true }, { top: true }],
      }
    }
    return {
      columns: `${col} ${col}`,
      rows: `${col} ${col}`,
      places: [
        { column: '1', row: '1 / span 2', top: true },
        { column: '2', row: '1', top: true },
        { column: '2', row: '2', top: false },
      ],
    }
  }
  return {
    columns: `${col} ${col}`,
    rows: `${col} ${col}`,
    places: [{ top: true }, { top: true }, { top: false }, { top: false }],
  }
}

/** 가장 최근에 포커스한 id가 끝. alive를 주면 그 칸들만 남긴다. */
export function noteFocus(order: readonly string[], id: string | null, alive?: readonly string[]): string[] {
  const keep = alive ? new Set(alive) : null
  if (id && keep) keep.add(id)
  const next = order.filter((x) => x && x !== id && (!keep || keep.has(x)))
  if (id) next.push(id)
  return next
}

function focusRank(id: string, order: readonly string[]): number {
  const i = order.indexOf(id)
  return i === -1 ? -1 : i
}

/** 포커스되지 않은 칸 중 가장 오래 전에 포커스된 것. 없으면 null. */
export function oldestUnfocused(
  candidates: readonly string[],
  focusOrder: readonly string[],
  focusedId: string | null,
): string | null {
  const pool = candidates.filter((id) => id !== focusedId)
  if (!pool.length) return null
  let best = pool[0]
  let bestRank = focusRank(best, focusOrder)
  for (const id of pool.slice(1)) {
    const rank = focusRank(id, focusOrder)
    if (rank < bestRank) {
      best = id
      bestRank = rank
    }
  }
  return best
}

export type OpenBeside =
  | { ok: true; activeId: string; sideIds: string[]; focusedId: string; replacedId: string | null }
  | { ok: false; reason: 'missing' | 'narrow' }

function pack(ids: string[], focusedId: string, replacedId: string | null): OpenBeside {
  const order = paneIds(ids[0] ?? null, ids.slice(1))
  if (!order.length) return { ok: false, reason: 'missing' }
  return {
    ok: true,
    activeId: order[0],
    sideIds: order.slice(1),
    focusedId: order.includes(focusedId) ? focusedId : order[0],
    replacedId,
  }
}

/**
 * 옆에 연다. 이미 보이는 칸이면 그 칸만 포커스한다.
 * 보이는 칸이 꽉 찼으면 포커스되지 않은 칸 중 가장 오래 전에 포커스된 칸을 바꾼다.
 * 연 칸에 포커스를 준다. 칸 수 1이면 거부(폰은 그냥 연다 — 호출부가 선택으로 넘긴다).
 */
export function decideOpenBeside(
  targetId: string,
  activeId: string | null,
  sideIds: readonly string[],
  focusedId: string | null,
  capacity: number,
  focusOrder: readonly string[],
): OpenBeside {
  if (!targetId) return { ok: false, reason: 'missing' }
  if (capacity < 2) return { ok: false, reason: 'narrow' }
  const cap = Math.min(MAX_PANES, capacity)
  const full = paneIds(activeId, sideIds)
  const visible = full.slice(0, cap)
  if (visible.includes(targetId)) return pack(full, targetId, null)
  const rest = full.filter((id) => id !== targetId)
  const visibleRest = rest.slice(0, cap)
  if (visibleRest.length < cap && rest.length < MAX_PANES) {
    const hidden = rest.slice(visibleRest.length)
    return pack([...visibleRest, targetId, ...hidden], targetId, null)
  }
  const victim = oldestUnfocused(visibleRest, focusOrder, focusedId)
  if (!victim) return pack([targetId, ...rest], targetId, null)
  return pack(rest.map((id) => (id === victim ? targetId : id)), targetId, victim)
}

/** 칸을 닫는다. 첫 칸을 닫으면 다음 칸이 첫 칸이 된다. */
export function decideClosePane(
  closeId: string,
  activeId: string | null,
  sideIds: readonly string[],
  focusedId: string | null,
): PaneSnap {
  const order = paneIds(activeId, sideIds).filter((id) => id !== closeId)
  const nextFocus = focusedId && order.includes(focusedId) ? focusedId : (order[0] ?? null)
  return { activeId: order[0] ?? null, sideIds: order.slice(1), focusedId: nextFocus }
}

/**
 * 칸 자리를 한 칸 옮긴다(delta -1 왼쪽, +1 오른쪽). 보이는 칸(visibleCount) 안에서만 이웃과 맞바꾼다.
 * 끝이거나 없는 id면 순서를 그대로 돌려준다.
 */
export function movePane(order: readonly string[], id: string, delta: -1 | 1, visibleCount: number): string[] {
  const i = order.indexOf(id)
  const j = i + delta
  const limit = Math.min(order.length, visibleCount)
  if (i < 0 || i >= limit || j < 0 || j >= limit) return [...order]
  return swapPanes(order, id, order[j])
}

/** 두 칸의 자리를 맞바꾼다. 없는 id가 끼면 그대로. */
export function swapPanes(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  const out = [...order]
  if (i < 0 || j < 0 || i === j) return out
  out[i] = b
  out[j] = a
  return out
}

/** 칸 id의 자리를 다른 세션으로 바꾼다. 그 세션이 이미 칸에 있으면 둘의 자리를 맞바꾼다. */
export function replacePane(order: readonly string[], id: string, nextId: string): string[] {
  if (!nextId || order.indexOf(id) < 0) return [...order]
  if (order.includes(nextId)) return swapPanes(order, id, nextId)
  return order.map((x) => (x === id ? nextId : x))
}

/** 칸이 꽉 찬 채 옆에 열면 바뀌게 될 칸의 번호(0부터). 바뀌는 칸이 없으면 null. */
export function besideVictimIndex(
  targetId: string,
  activeId: string | null,
  sideIds: readonly string[],
  focusedId: string | null,
  capacity: number,
  focusOrder: readonly string[],
): number | null {
  const r = decideOpenBeside(targetId, activeId, sideIds, focusedId, capacity, focusOrder)
  if (!r.ok || !r.replacedId) return null
  const i = paneIds(activeId, sideIds).indexOf(r.replacedId)
  return i < 0 ? null : i
}

/** 칸 수보다 넘쳐 숨은 칸의 id. 칸 순서 뒤쪽이다. */
export function hiddenPaneIds(activeId: string | null, sideIds: readonly string[], capacity: number): string[] {
  const cap = Math.max(1, Math.min(MAX_PANES, Math.floor(capacity) || 1))
  return paneIds(activeId, sideIds).slice(cap)
}

/** 보이는 칸이 둘 이상일 때 id의 칸 번호(1부터). 안 떠 있거나 칸이 하나면 0. */
export function paneNumberOf(id: string, activeId: string | null, sideIds: readonly string[], capacity: number): number {
  const vis = visibleSessionIds(activeId, sideIds, capacity)
  return vis.length >= 2 ? vis.indexOf(id) + 1 : 0
}

export type ReconnectMaskDecision = {
  /** 대기 중인 재연결 가림막 타이머를 취소할지. */
  cancelTimer: boolean
  reconnectMask: boolean
}

/**
 * 첫 칸 통로를 닫은 뒤의 재연결 가림막.
 * 첫 칸이 없어지면 타이머를 취소하고 가림막을 내린다. 연결 성공이 더 오지 않아 가림막이 남지 않게.
 * 다른 세션이 첫 칸이 되면 그 통로가 새로 열리므로 기존 재연결을 유지한다.
 */
export function decideReconnectMask(
  nextActiveId: string | null,
  reconnectMask: boolean,
): ReconnectMaskDecision {
  if (nextActiveId == null) return { cancelTimer: true, reconnectMask: false }
  return { cancelTimer: false, reconnectMask }
}

/**
 * 목록에서 고른다.
 * 이미 보이는 칸이면 포커스만. 아니면 포커스된 칸을 그 세션으로 바꾼다.
 * beside면 옆에 열기와 같다. 칸이 하나면(거부) 포커스된 칸을 바꾸는 쪽으로 떨어진다.
 */
export function decideSelectSession(
  targetId: string,
  activeId: string | null,
  sideIds: readonly string[],
  focusedId: string | null,
  capacity: number,
  beside: boolean,
  focusOrder: readonly string[],
): PaneSnap {
  if (!targetId) return { activeId, sideIds: paneIds(activeId, sideIds).slice(1), focusedId }
  if (beside) {
    const opened = decideOpenBeside(targetId, activeId, sideIds, focusedId, capacity, focusOrder)
    if (opened.ok) {
      return { activeId: opened.activeId, sideIds: opened.sideIds, focusedId: opened.focusedId }
    }
  }
  const order = paneIds(activeId, sideIds)
  const cap = Math.max(1, Math.min(MAX_PANES, Math.floor(capacity) || 1))
  const visible = order.slice(0, cap)
  if (visible.includes(targetId)) {
    return { activeId: order[0] ?? null, sideIds: order.slice(1), focusedId: targetId }
  }
  const focus = focusedId && visible.includes(focusedId) ? focusedId : (visible[0] ?? null)
  let next = order.filter((id) => id !== targetId)
  if (!focus) next = [targetId, ...next].slice(0, MAX_PANES)
  else {
    const i = next.indexOf(focus)
    if (i >= 0) next[i] = targetId
    else next = [targetId, ...next].slice(0, MAX_PANES)
  }
  const packed = paneIds(next[0] ?? null, next.slice(1))
  return { activeId: packed[0] ?? null, sideIds: packed.slice(1), focusedId: targetId }
}

/**
 * 칸 임시 확대. 확대한 칸이 칸 목록 안에 있고 지금 포커스 칸일 때만 유지한다.
 * 포커스가 다른 칸으로 옮겨 가거나 칸이 사라지면 해제(null). 포커스가 비면 첫 칸이 포커스다.
 */
export function zoomAfterChange(
  zoomedId: string | null,
  order: readonly string[],
  focusedId: string | null,
): string | null {
  if (!zoomedId || !order.includes(zoomedId)) return null
  return (focusedId && order.includes(focusedId) ? focusedId : (order[0] ?? null)) === zoomedId ? zoomedId : null
}

/** 확대 토글. 이미 확대한 칸이면 해제. 보이는 칸이 둘 미만이거나 목록에 없는 칸이면 확대하지 않는다. */
export function toggleZoomed(zoomedId: string | null, id: string, visible: readonly string[]): string | null {
  if (zoomedId === id) return null
  return visible.length >= 2 && visible.includes(id) ? id : null
}

/** 확대 중 다른 칸의 대기를 오래 기다린 순으로. 확대 칸이 아닌 보이는 칸 중 대기(waiting)인 id. */
export function otherWaitingPanes(
  visible: readonly string[],
  zoomedId: string,
  rooms: readonly { id: string; attention?: string; attentionSince?: number }[],
): string[] {
  return rooms
    .filter((r) => r.id !== zoomedId && visible.includes(r.id) && r.attention === 'waiting')
    .sort((a, b) => (a.attentionSince ?? Infinity) - (b.attentionSince ?? Infinity))
    .map((r) => r.id)
}

export function serializePanes(panes: StoredPanes): string {
  return JSON.stringify({ ids: panes.ids, focusedId: panes.focusedId })
}

export function parsePanes(raw: string | null): StoredPanes {
  const empty: StoredPanes = { ids: [], focusedId: null }
  if (!raw) return empty
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return empty
    const o = v as { ids?: unknown; focusedId?: unknown }
    if (!Array.isArray(o.ids)) return empty
    const ids: string[] = []
    for (const id of o.ids) {
      if (typeof id !== 'string' || !id || ids.includes(id)) continue
      if (ids.length >= MAX_PANES) break
      ids.push(id)
    }
    const focusedId =
      typeof o.focusedId === 'string' && ids.includes(o.focusedId) ? o.focusedId : (ids[0] ?? null)
    return { ids, focusedId }
  } catch {
    // 선택적 창 배치 저장값을 해석하지 못하면 기본 배치로 시작한다.
    return empty
  }
}

type CardItem = { kind: string; req?: { id: string } }

/** 권한·질문·계획 카드가 어느 칸의 대화에 있는지 찾는다. 없으면 주 세션으로 떨어진다. */
export function sessionOwningCard(
  ids: string[],
  convos: Record<string, ReadonlyArray<CardItem> | undefined>,
  requestKind: string,
  cardId: string,
  fallback: string | null,
): string | null {
  for (const id of ids) {
    const items = convos[id] ?? []
    if (items.some((e) => e.kind === requestKind && e.req?.id === cardId)) return id
  }
  return fallback
}
