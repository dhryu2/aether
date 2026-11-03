/**
 * 검색 필터 URL. HTTP·React 없음.
 */

export type SearchFilterOpts = {
  q: string
  sort?: 'relevance' | 'recent' | 'oldest'
  chatOnly?: boolean
  sessionId?: string
  fromTs?: number
  toTs?: number
}

/** 값이 있는 칸만 담은 질의 객체. 빈 문자열은 칸 없음. */
export function buildSearchQuery(opts: SearchFilterOpts): Record<string, string> {
  const out: Record<string, string> = { q: opts.q }
  if (opts.sort === 'recent') out.sort = 'newest'
  else if (opts.sort === 'oldest') out.sort = 'oldest'
  if (opts.chatOnly) out.chatOnly = '1'
  if (opts.sessionId) out.sessionId = opts.sessionId
  if (typeof opts.fromTs === 'number' && Number.isFinite(opts.fromTs)) out.fromTs = String(opts.fromTs)
  if (typeof opts.toTs === 'number' && Number.isFinite(opts.toTs)) out.toTs = String(opts.toTs)
  return out
}

/** `/api/search?...` 경로. 빈 필터 키는 넣지 않는다. */
export function searchRequestUrl(opts: SearchFilterOpts): string {
  const q = buildSearchQuery(opts)
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v !== '') p.set(k, v)
  }
  return `/api/search?${p.toString()}`
}
