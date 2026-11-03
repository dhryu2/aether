export type OlderSearchPaging = { oldestSeq: number; hasOlder: boolean; loading: boolean } | undefined

/**
 * 초기 꼬리에 대화가 하나도 없을 때 다음 과거 페이지를 찾을지 결정한다.
 * 같은 cursor의 진행 중 요청과 이미 실패한 요청은 다시 시작하지 않아 중복·무한 재시도를 막는다.
 */
export function emptyHistorySearchCursor({
  hasConvo,
  paging,
  inFlightAt,
  failedAt,
}: {
  hasConvo: boolean
  paging: OlderSearchPaging
  inFlightAt: number | null
  failedAt: number | null
}): number | null {
  if (hasConvo || !paging?.hasOlder || paging.loading || paging.oldestSeq <= 0) return null
  if (inFlightAt === paging.oldestSeq || failedAt === paging.oldestSeq) return null
  return paging.oldestSeq
}

/**
 * 초기 replay에 동봉된 대화 씨앗과 과거 페이지가 겹쳐도 양수 seq의 시간순을 보존한다.
 * 로컬 낙관 이벤트(음수 seq)는 현재 자리에 남기고, 그 앞까지 과거 사건을 병합한다.
 */
/** 다음 이전 페이지의 before. 서버가 읽은 페이지의 첫 순번이 우선이다. */
export function nextOlderBoundary(pageOldestSeq: number | undefined, freshFirstSeq: number | undefined, current: number): number {
  if (typeof pageOldestSeq === 'number' && Number.isFinite(pageOldestSeq)) return pageOldestSeq
  if (typeof freshFirstSeq === 'number' && Number.isFinite(freshFirstSeq)) return freshFirstSeq
  return current
}

export function mergeOlderPageEvents<T extends { seq: number }>(current: T[], freshPage: T[]): T[] {
  if (!freshPage.length) return current
  const fresh = [...freshPage].sort((a, b) => a.seq - b.seq)
  const merged: T[] = []
  let pageIndex = 0
  for (const item of current) {
    if (item.seq <= 0) {
      while (pageIndex < fresh.length) merged.push(fresh[pageIndex++])
    } else {
      while (pageIndex < fresh.length && fresh[pageIndex].seq < item.seq) merged.push(fresh[pageIndex++])
    }
    merged.push(item)
  }
  while (pageIndex < fresh.length) merged.push(fresh[pageIndex++])
  return merged
}
