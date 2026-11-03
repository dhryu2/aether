// 스크롤 위치 보정에 쓰는 순수 DOM 계산 — React 상태를 건드리지 않는다.

/**
 * 이전 묶음 prepend 직전의 '첫 가시 세그먼트' 기준점. scrollHeight 델타 방식은 쓰기 1회뿐이라
 *   iOS 모멘텀(비동기 스크롤 스레드)이 그 쓰기를 덮으면 복구 수단이 없다 — 요소 기준점은 페인트 후 재검증으로 재보정 가능.
 *   노드 참조를 직접 앵커로 쓴다(data-seq는 같은 이벤트의 text·tools 세그먼트가 공유해 재조회가 모호). key 안정 → prepend에도 노드 보존.
 */
export type PrependAnchor = { node: HTMLElement | null; top: number; height: number } // height = scrollHeight(노드 소실 시 폴백용)

export function captureAnchor(el: HTMLDivElement): PrependAnchor {
  const boxTop = el.getBoundingClientRect().top
  const nodes = el.querySelectorAll<HTMLElement>('[data-seq]')
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].getBoundingClientRect()
    // height 0 제외: text 세그먼트 래퍼는 display:contents(박스 없음 → rect 전부 0)라 앵커로 못 쓴다.
    if (r.height > 0 && r.bottom > boxTop) return { node: nodes[i], top: r.top, height: el.scrollHeight }
  }
  return { node: null, top: 0, height: el.scrollHeight }
}

/** 앵커 노드 한 번의 측정값 — 전부 뷰포트 기준 y와 스크롤 영역의 scrollTop이다. */
export type AnchorMeasure = { nodeTop: number; boxTop: number; scrollTop: number }

/**
 * 이전 묶음을 앞에 붙인 뒤 scrollTop에 더할 보정량을 계산한다(DOM을 읽거나 쓰지 않는다).
 *   첫 호출: 앵커가 화면에서 기록한 y(`anchorTop`) 그대로 보이게 맞춘다.
 *   이후 호출(재검증): 앵커의 '내용 좌표'(스크롤 영역 맨 위 기준 y)가 첫 보정 때보다 변한 만큼만 맞춘다.
 *     내용 좌표는 사용자가 스크롤해도 변하지 않고 위쪽 높이만 바뀔 때 변하므로, 사용자가 계속 올리는 중에도 끌려가지 않는다.
 *   노드가 사라졌으면(`null` 측정) 보정량도 `null` — 호출부가 scrollHeight 델타 폴백을 쓴다.
 *   1px 이하 흔들림은 무시한다.
 */
export function createAnchorFixer(anchorTop: number): (m: AnchorMeasure | null) => number | null {
  let base: number | null = null
  return (m) => {
    if (!m) return null
    const contentY = m.nodeTop - m.boxTop + m.scrollTop
    const raw = base == null ? m.nodeTop - anchorTop : contentY - base
    base = contentY // 보정 뒤에도 내용 좌표는 같다(스크롤을 옮기면 nodeTop이 그만큼 따라 움직인다)
    return Math.abs(raw) > 1 ? raw : 0
  }
}

/**
 * 맨 위 '이전 대화' 줄이 사라질 때 scrollTop에서 빼야 할 양. 줄이 있던 만큼 콘텐츠가 위로 밀리므로, 보던 글을 지키려면 그만큼 당긴다.
 *   바닥에 붙어 보는 중(`distToBottom`이 임계 이하)이면 바닥 추적이 맡으므로 0이다.
 */
export function spinnerRemovalShift(wasShown: boolean, shown: boolean, height: number, distToBottom: number, bottomPx: number): number {
  return wasShown && !shown && height > 0 && distToBottom > bottomPx ? height : 0
}

/** 대상 seq의 세그먼트 인덱스. 정확 매칭 없으면 seq 차 최소 세그먼트(근접 폴백). */
export function findJumpIdx(segs: { seq: number }[], seq: number): number {
  let best = -1
  let bestDiff = Infinity
  for (let i = 0; i < segs.length; i++) {
    const sq = segs[i].seq
    if (sq === seq) return i
    const d = Math.abs(sq - seq)
    if (d < bestDiff) {
      bestDiff = d
      best = i
    }
  }
  return best
}
