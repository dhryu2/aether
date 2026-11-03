/**
 * 대화 스트림의 스크롤 기계장치 — Stream.tsx는 그리기만 하고 위치 계산은 전부 여기 있다.
 *
 * 다섯 가지 관심사를 훅 하나씩으로 갈랐다. 서로 스크롤 위치를 놓고 경합하지 않도록 '누가 언제 scrollTop을
 * 쓰는가'를 아래처럼 나눠 뒀다(예전 주석은 ResizeObserver 하나가 유일한 writer라고 적혀 있었지만, 실제로는
 * 아래 여섯 자리가 전부 scrollTop을 쓴다 — 다만 조건이 겹치지 않는다):
 *   1. useStickyBottom · 진입/전환 직후 1회 바닥으로(스켈레톤이 걷힌 프레임)
 *   2. useStickyBottom · ResizeObserver — 바닥 추적 중일 때만 콘텐츠가 자랄 때마다 다시 바닥으로
 *   3. useStickyBottom · 사용자가 메시지를 보냈을 때(스토어 신호)
 *   4. useStickyBottom · '맨 아래로' 버튼
 *   5. useInfiniteOlder · 이전 묶음을 앞에 붙인 뒤 보던 위치로 되돌리는 보정(+= 델타)과, 맨 위 '이전 대화' 줄이 사라질 때 줄어든 높이 보정(-= 델타)
 *   6. useJumpToSeq · 검색 결과로 이동(scrollIntoView)
 * 1~4는 전부 '정확히 바닥'이고 5는 보던 위치를 지키는 보정, 6은 사용자가 명시적으로 시킨 이동이라 서로 싸우지 않는다.
 *
 * 이전 기록 불러오기(useInfiniteOlder)의 '지금 해도 되는가·어디서 실패했는가'는 olderLoadMachine.ts의 순수 상태기계가 정하고,
 * 앵커 보정량 계산은 scrollAnchor.ts의 createAnchorFixer가 한다. 이 파일은 그 결과를 DOM에 적용만 한다.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { actions, getState } from '../../lib/store'
import { useSignal } from '../../lib/hooks'
import type { StreamSeg } from '../../lib/streamSegments'
import { captureAnchor, createAnchorFixer, findJumpIdx, spinnerRemovalShift, type PrependAnchor } from './scrollAnchor'
import { emptyHistorySearchCursor } from './olderHistorySearch'
import { canFetchOlder, OLDER_IDLE, olderLoadNext, type OlderLoadEvent } from './olderLoadMachine'

const BOTTOM_PX = 8 // 이 거리 이내면 '바닥'으로 보고 자동 추적(재부착 포함). 이탈은 거리 임계치가 아니라 '위로 이동' 자체로 판정
const INITIAL_WINDOW = 18 // 진입 시 최초로 그리는 최근 세그먼트 수 — 한 번에 그리는 양의 상한(작게 잡아 첫 렌더 비용 최소화)
const WINDOW_CHUNK = 24 // 위로 스크롤할 때 추가로 그리는 묶음
const LOAD_OLDER_PX = 300 // 상단에서 이 거리 이내로 스크롤하면 이전 묶음을 미리 로드(도달 전에 준비)
const SKELETON_THRESHOLD = 12 // 이보다 많은 메시지를 가진 세션 전환만 스켈레톤으로 defer(작은 세션은 즉시 렌더 — 플래시 방지)

/** 서버 미로드 과거 구간의 상태(store의 `older[id]`). */
export type OlderPaging = { oldestSeq: number; hasOlder: boolean; loading: boolean }

/* ─────────────── 세션 전환 자리표시자 ─────────────── */

/**
 * 큰 세션으로 전환할 때 한 프레임 동안 스켈레톤을 보여 클릭이 멈추지 않게 한다.
 * `onSessionChange`는 세션이 바뀐 그 렌더에서 함께 초기화할 것(윈도 고정 해제)을 부른다.
 */
export function useSessionSwitchSkeleton(id: string | null, loading: boolean, itemCount: number, onSessionChange: () => void) {
  const [switching, setSwitching] = useState(false) // 전환 직후 1프레임 스켈레톤(무거운 렌더 defer)
  const [renderId, setRenderId] = useState<string | null>(id)

  // 세션 전환 감지 — 렌더 시점에 파생(passive effect로 미루면 첫 렌더에서 큰 세션이 그대로 그려져 클릭이 멈춘다).
  const idChanged = id !== renderId
  const heavySwitch = idChanged && !loading && itemCount > SKELETON_THRESHOLD
  const showSkeleton = loading || switching || heavySwitch // 스켈레톤 표시(=무거운 빌드/렌더 스킵)
  if (idChanged) {
    // setState-during-render(React 권장 '파생 상태' 패턴) — 현재 렌더를 버리고 새 상태로 즉시 재렌더 → 첫 페인트부터 적용.
    //   (pendingAnchor 초기화는 렌더 중 ref 변경 금지라 useInfiniteOlder의 layout effect에서 처리.)
    setRenderId(id)
    onSessionChange() // 새 세션은 바닥 추적부터
    setSwitching(heavySwitch)
  }

  // 전환 스켈레톤 해제 — 스켈레톤이 한 프레임 페인트된 뒤(double rAF) 콘텐츠 렌더 허용.
  //   deps에 renderId 포함: 빠른 heavy→heavy 연속 전환에서 switching이 true→true로 동일해도, 세션이 바뀌면
  //   effect가 cleanup(이전 rAF 취소)+재스케줄해 새 세션의 defer 프레임을 온전히 확보(stale rAF 조기 해제 방지).
  useEffect(() => {
    if (!switching) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSwitching(false))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [switching, renderId])

  return { renderId, showSkeleton }
}

/* ─────────────── 보이는 구간만 렌더 ─────────────── */

/**
 * 윈도잉 — frozenKey==null이면 최근 INITIAL_WINDOW개만(바닥 추적·슬라이드), 아니면 그 key 세그먼트에서 꼬리까지 고정 렌더.
 *   고정 시 라이브 append가 와도 start가 전진하지 않아 머리가 안 잘리고 화면이 위로 튀지 않으며,
 *   무한스크롤 prepend로 인덱스가 밀려도 key가 따라가 같은 세그먼트에 고정된다(스크롤백 안정).
 *   ★ 인덱스가 아니라 key인 이유: 무한스크롤로 과거 이벤트가 convos 앞에 prepend되면 인덱스가 전부 밀리지만 key는 불변.
 *
 * 자르기(`slice`)를 훅 밖으로 낸 이유: 세그먼트는 스켈레톤 여부가 정해진 뒤에야 만들어지는데, 그 판정이
 * 다른 훅(useSessionSwitchSkeleton)에서 오기 때문에 훅 호출 시점에는 아직 세그먼트가 없다.
 */
export function useSegmentWindow() {
  const [frozenKey, setFrozenKey] = useState<string | null>(null)
  const reset = useCallback(() => setFrozenKey(null), [])
  const slice = (segs: StreamSeg[]) => {
    const autoStart = Math.max(0, segs.length - INITIAL_WINDOW)
    let start = autoStart
    if (frozenKey != null) {
      const fi = segs.findIndex((sg) => sg.key === frozenKey)
      if (fi >= 0) start = fi // key 소실(이론상 없음) 시 autoStart 폴백
    }
    return { start, visibleSegs: segs.slice(start) }
  }
  return { frozenKey, setFrozenKey, reset, slice }
}

/* ─────────────── 맨 아래 고정 ─────────────── */

export function useStickyBottom({ ref, renderId, showSkeleton, scrollBottomNonce, setFrozenKey }: {
  ref: RefObject<HTMLDivElement | null>
  renderId: string | null
  showSkeleton: boolean
  scrollBottomNonce: number
  setFrozenKey: (key: string | null) => void
}) {
  const atBottomRef = useRef(true) // 최신값(rAF/effect 클로저 stale 방지). state는 버튼 렌더용 미러.
  const lastScrollTopRef = useRef<number | null>(null) // 직전 scrollTop(위로 스크롤 중인지 판정용)
  const [atBottom, setAtBottom] = useState(true)

  // 진입 하단 점프 — 콘텐츠가 처음 보이는 순간(스켈레톤 해제 또는 라이트 전환), 페인트 전에 동기 설정(깜빡임 없음).
  //   deps=[renderId, showSkeleton]: 한 진입에서 showSkeleton는 true→false로 1회만 떨어지므로(세션 내 재상승 없음) 점프도 1회.
  useLayoutEffect(() => {
    if (showSkeleton) return // 콘텐츠 미표시 — 대기
    const el = ref.current
    if (el) {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
      setAtBottom(true)
      lastScrollTopRef.current = el.scrollTop // 세션 전환 후 첫 onScroll이 이전 세션 값과 비교하지 않도록
    }
  }, [renderId, showSkeleton])

  // 바닥 추적의 자동 재고정 — 콘텐츠 높이가 바뀔 때마다(새 메시지 append·스트리밍 텍스트 성장·비동기 Prism/마크다운·
  //   툴카드 확장·이미지 로드·큐 버블 추가 전부 = 콘텐츠 div 높이 변화) ResizeObserver가 바닥에 재고정한다.
  //   추적 중(atBottomRef)일 때만 — 사용자가 위로 스크롤하면 onScroll이 atBottomRef를 false로 내려 pin을 건너뛴다.
  //   ★ '콘텐츠가 자라서 따라 내려간다'는 일은 오직 이 RO만 한다(과거 items.length 기반 rAF 핀과 병행 시 경합·이중 쓰기 원인).
  //   observe 시작 시 스펙상 초기 콜백이 1회 발화 → 마운트 직후 바닥 고정도 이 경로로 처리된다.
  //   콜백 ref로 콘텐츠 div 마운트/언마운트(세션 전환·스켈레톤)에 정확히 맞춰 attach/disconnect(deps 타이밍 이슈 없음).
  const roRef = useRef<ResizeObserver | null>(null)
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!node) return
    const ro = new ResizeObserver(() => {
      if (!atBottomRef.current) return // 추적 중일 때만(이탈 상태에선 뷰포트를 절대 건드리지 않는다 — sticky bottom 표준)
      const el = ref.current
      if (el) el.scrollTop = el.scrollHeight // scrollTop만 변경 → 관측 대상 크기 불변 → RO 루프 없음
    })
    ro.observe(node)
    roRef.current = ro
  }, [ref])

  // 사용자가 메시지를 전송하면(위로 스크롤해 읽던 중이어도) 즉시 최하단으로 복귀 — store의 scrollBottomNonce 증가를 추적.
  //   바닥 추적(frozenKey=null)으로 윈도를 리셋하고 스크롤·atBottom 상태를 동기화(버튼 scrollToBottom과 동형). 증가분에만 반응.
  useSignal(scrollBottomNonce, () => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
    setFrozenKey(null)
    lastScrollTopRef.current = el.scrollTop
  })

  const scrollToBottom = () => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
    setFrozenKey(null) // 바닥 추적 재개 → 윈도 18로 축소(버튼 복귀 시 onScroll 토글이 안 도는 비대칭 보정)
    lastScrollTopRef.current = el.scrollTop
  }

  // 스크롤 추적 — 바닥 이탈 시 현재 윈도 시작을 고정(머리 보존), 바닥 복귀 시 자동 추적으로 해제.
  //   판정은 순수 기하학: 제스처 이벤트(휠·터치 타임스탬프)로 '사용자 스크롤'을 추측하지 않는다 — 표준 wheel 이벤트는
  //   관성·사용자를 구분할 방법 자체가 없고(w3c/uievents#58), 스크롤바 드래그·키보드는 wheel/touch를 아예 안 낸다.
  //   ★ 이탈 = 'scrollTop 감소 && 바닥 아님(dist>1)'. 이 조건은 오직 사용자만 만든다:
  //     - 우리의 프로그램적 쓰기는 전부 '정확히 바닥으로'(dist=0) 또는 아래 방향(prepend 앵커 보정 +=)이라 안 걸린다.
  //     - 스트리밍 중 콘텐츠 높이 변동의 브라우저 클램프(윈도 슬라이드·버블 리플로우)도 결과가 정확한 바닥(dist=0)이라 제외.
  //     - iOS 러버밴드 바운스는 dist를 0으로 클램프해 제외(바운스 복귀 중 scrollTop 감소 오탐 방지).
  //   재부착 = 바닥 도달(dist ≤ BOTTOM_PX)만. 그 외엔 현 상태 유지(성장 프레임에 흔들리지 않게).
  //   `leaveKey` = 바닥에서 벗어날 때 윈도를 고정할 세그먼트 key(현재 창의 첫 세그먼트).
  const trackScroll = (el: HTMLDivElement, leaveKey: string | null) => {
    const prevTop = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    const dist = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    const movedUp = prevTop != null && el.scrollTop < prevTop - 1 && dist > 1 // 1px 노이즈 무시
    const near = movedUp ? false : dist <= BOTTOM_PX ? true : atBottomRef.current
    if (near !== atBottomRef.current) {
      atBottomRef.current = near
      setAtBottom(near)
      setFrozenKey(near ? null : leaveKey) // 바닥=추적(null), 이탈=현재 start 세그먼트 고정
    }
  }

  /**
   * 바닥 추적을 강제로 끊는다 — 사용자가 명시적으로 위쪽 어딘가로 이동했을 때(검색 결과 점프)만 쓴다.
   *   ref만 내리면 '맨 아래로' 버튼이 안 뜬다(버튼은 state를 본다). 또 scrollIntoView는 결과 scrollTop을
   *   알려주지 않으므로 직전값을 비워, 다음 onScroll이 스테일 비교로 '위로 이동'을 오판하지 않게 한다.
   */
  const leaveBottom = () => {
    atBottomRef.current = false
    setAtBottom(false)
    lastScrollTopRef.current = null
  }

  // ref 자체(atBottomRef·lastScrollTopRef)는 내보내지 않는다 — 밖에서 렌더 중에 읽으면 화면이 갱신되지
  //   않는 버그가 되고(react-hooks/refs), 필요한 조작은 전부 아래 함수들로 감싸 두었다.
  return { atBottom, contentRef, scrollToBottom, trackScroll, leaveBottom }
}

/* ─────────────── 위로 올려 이전 대화 불러오기 ─────────────── */

/** 렌더마다 바뀌는 값 — 훅이 만든 콜백·effect가 최신 세그먼트를 보게 하는 통로. */
type OlderCtx = {
  id: string | null
  segs: StreamSeg[]
  start: number
  older: OlderPaging | undefined
  setFrozenKey: (key: string | null) => void
  spinnerShown: boolean // 맨 위 '이전 대화' 줄을 그리는 중인가 — 사라질 때 줄어든 높이를 보정한다
}

export function useInfiniteOlder({ ref, renderId, showSkeleton, itemCount, frozenKey, hasConvo, hasOlder, olderLoading }: {
  ref: RefObject<HTMLDivElement | null>
  renderId: string | null
  showSkeleton: boolean
  itemCount: number
  frozenKey: string | null
  hasConvo: boolean
  hasOlder: boolean | undefined
  olderLoading: boolean | undefined
}) {
  const pendingAnchor = useRef<PrependAnchor | null>(null) // 이전 묶음 prepend 직전의 기준점(앵커링용)
  const loadRef = useRef(OLDER_IDLE) // 불러오기 상태(대기·보정·실패 지점) — 전이 규칙은 olderLoadMachine.ts
  const dispatch = useCallback((e: OlderLoadEvent) => {
    loadRef.current = olderLoadNext(loadRef.current, e)
  }, [])
  const olderSentinelRef = useRef<HTMLDivElement | null>(null) // 상단 OlderLoading 센티널(보이면 자동 로드)
  const spinnerRef = useRef({ shown: false, height: 0, renderId: null as string | null }) // 직전 커밋의 '이전 대화' 줄 상태와 차지하던 높이
  const anchorRafRef = useRef(0) // 앵커 재검증 rAF id(세션 전환·재부착 시 취소용)
  const ctxRef = useRef<OlderCtx>({ id: null, segs: [], start: 0, older: undefined, setFrozenKey: () => {}, spinnerShown: false })
  const olderNow = renderId ? getState().older[renderId] : undefined

  // 세션 전환 시 '이전 묶음 로드' 앵커 상태 초기화 — 스테일 앵커가 새 세션 loadOlder를 막거나 잘못 보정하지 않게.
  //   (아래 앵커 effect보다 먼저 정의 → 같은 전환 커밋에서 먼저 null로 비운 뒤 앵커 effect가 읽음.)
  useLayoutEffect(() => {
    pendingAnchor.current = null
    dispatch({ type: 'reset' })
  }, [renderId, dispatch])

  /**
   * 서버에서 이전 페이지를 한 장 받는다 — 세 경로(스크롤·센티널·빈 대화 탐색)가 모두 여기로 온다.
   *   `anchor`가 있으면 반영 뒤 앵커 effect가 위치를 맞춘다. 없으면(빈 대화 탐색) 화면에 보이는 게 없어 맞출 것이 없다.
   *   실패·빈 페이지면 items가 안 변해 앵커 effect가 안 돌므로 앵커를 직접 비운다(다음 불러오기 차단 방지).
   */
  const fetchOlder = useCallback((id: string, cursor: number, anchor: PrependAnchor | null) => {
    dispatch({ type: 'fetch', cursor })
    if (anchor) pendingAnchor.current = anchor
    void actions.loadOlder(id).then((changed) => {
      if (ctxRef.current.id !== id) return // 그새 다른 세션으로 옮겼다
      dispatch({ type: 'fetched', cursor, changed, anchored: anchor != null })
      if (!changed && anchor && pendingAnchor.current === anchor) pendingAnchor.current = null
    })
  }, [dispatch])

  /** 이미 받은 데이터로 렌더 창만 한 묶음 넓힌다. 기준점을 먼저 기록해 앵커 effect가 위치를 맞추게 한다. */
  const expandWindow = useCallback((el: HTMLDivElement) => {
    const { segs, start, setFrozenKey } = ctxRef.current
    dispatch({ type: 'expand' })
    pendingAnchor.current = captureAnchor(el)
    setFrozenKey(segs[Math.max(0, start - WINDOW_CHUNK)].key)
  }, [dispatch])

  // 초기 꼬리가 메타데이터뿐이면 상단 센티널을 만들 대화 컨테이너 자체가 없다. 이 경로는 DOM 기하와 무관하게
  // 이전 페이지를 한 장씩 직렬 조회한다. 메타데이터-only 페이지가 이어지면 oldestSeq 변경으로 다음 장을 찾고,
  // 대화를 찾거나 hasOlder=false가 되면 멈춘다. 같은 cursor 실패는 자동 재시도하지 않는다.
  useEffect(() => {
    if (showSkeleton || loadRef.current.phase !== 'idle') return
    const { id, older } = ctxRef.current
    const cursor = emptyHistorySearchCursor({ hasConvo, paging: older, inFlightAt: null, failedAt: loadRef.current.failedAt })
    if (!id || cursor == null) return
    fetchOlder(id, cursor, null)
  }, [showSkeleton, renderId, itemCount, hasConvo, hasOlder, olderLoading, olderNow?.oldestSeq, fetchOlder])

  // 맨 위 '이전 대화' 줄이 사라질 때(마지막 페이지가 비어 있었거나 창이 처음에 닿을 때) 줄어든 높이만큼 위치를 당긴다.
  //   보던 곳이 바닥이 아니면 콘텐츠가 위로 그만큼 밀려 보던 글이 움직인다. 아래 앵커 effect보다 먼저 선언해, 같은 커밋에서
  //   앵커 보정이 있어도 이미 맞춰진 뒤에 재므로 이중으로 보정되지 않는다. 높이는 줄이 보이는 동안 매 커밋 잰다(다음 형제와의 간격 포함).
  useLayoutEffect(() => {
    const el = ref.current
    const sp = spinnerRef.current
    const { spinnerShown } = ctxRef.current
    const sn = olderSentinelRef.current
    if (sp.renderId !== renderId || showSkeleton) {
      sp.renderId = renderId // 세션이 바뀌었거나 뼈대 화면이면 비교 기준만 다시 잡는다
      sp.shown = spinnerShown && !showSkeleton
    } else {
      if (el) el.scrollTop -= spinnerRemovalShift(sp.shown, spinnerShown, sp.height, el.scrollHeight - el.scrollTop - el.clientHeight, BOTTOM_PX)
      sp.shown = spinnerShown
    }
    const next = sn?.nextElementSibling
    if (spinnerShown && sn && next) sp.height = next.getBoundingClientRect().top - sn.getBoundingClientRect().top
  })

  // 이전 묶음 prepend 후 스크롤 위치 보존(앵커링) — 기록해둔 '첫 가시 세그먼트'가 화면상 같은 y에 오도록 scrollTop 보정.
  //   (꼬리 성장으로 인한 frozenKey 고정 케이스에선 frozenKey·itemCount 불변 → 이 effect 미실행, 보정 불필요.)
  //   커밋 직후(페인트 전) 1회 + 페인트 후 2프레임 재검증: iOS 모멘텀 스크롤은 별도 스레드라 관성 중의 scrollTop 쓰기가
  //   컴포지터에 덮여 무시될 수 있고(보정 소실 → 뷰포트가 prepend된 머리로 순간이동), 인라인 이미지 디코드 등
  //   1~2프레임 지연 높이 변화도 있다 — 재검증이 둘 다 흡수한다. 재검증 끝날 때까지 pendingAnchor 유지 → 중복 로드 차단 겸용.
  //   deps=[frozenKey, itemCount]: 윈도 확장은 frozenKey 변경으로, 무한스크롤 데이터 prepend는 itemCount 변경으로 발화.
  //   바닥 추적 중 append로도 발화하지만 pendingAnchor==null 가드로 no-op.
  useLayoutEffect(() => {
    const el = ref.current
    const a = pendingAnchor.current
    if (!el || a == null) return
    const correct = createAnchorFixer(a.top)
    const fix = (): boolean => {
      const n = a.node
      if (!n || !n.isConnected) return false
      const r = n.getBoundingClientRect()
      if (r.height === 0 && r.width === 0) return false // 박스 소실(숨김 등) — 0 기준 오보정 방지
      const delta = correct({ nodeTop: r.top, boxTop: el.getBoundingClientRect().top, scrollTop: el.scrollTop })
      if (delta) el.scrollTop += delta
      return true
    }
    if (!fix()) el.scrollTop += el.scrollHeight - a.height // 앵커 요소 소실 폴백(종전 scrollHeight 델타)
    let tries = 0
    const tick = () => {
      fix()
      if (++tries < 2) {
        anchorRafRef.current = requestAnimationFrame(tick)
      } else {
        pendingAnchor.current = null
        anchorRafRef.current = 0
        dispatch({ type: 'settled' })
      }
    }
    anchorRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (anchorRafRef.current) {
        cancelAnimationFrame(anchorRafRef.current)
        anchorRafRef.current = 0
        pendingAnchor.current = null
        dispatch({ type: 'settled' })
      }
    }
  }, [frozenKey, itemCount, dispatch])

  // 센티널 자동 로드 본체 — 스피너가 뷰포트 상단 선로드 범위(LOAD_OLDER_PX)보다 위면 no-op. 보이면 아래 handleScroll의
  //   로드 블록과 동일하게 로컬 윈도 확장 → 소진 시 서버 loadOlder. 실패 지점은 상태기계가 기억해 자동 무한 재시도를 막는다.
  const loadMore = useCallback(() => {
    const el = ref.current
    const sn = olderSentinelRef.current
    if (!el || !sn) return
    if (sn.getBoundingClientRect().bottom <= el.getBoundingClientRect().top - LOAD_OLDER_PX) return // 범위 밖 — 불필요
    const { id, start, older } = ctxRef.current
    if (start > 0) expandWindow(el)
    else if (id && older && canFetchOlder(loadRef.current, older, true)) fetchOlder(id, older.oldestSeq, captureAnchor(el))
  }, [ref, fetchOlder, expandWindow])

  // 상단 센티널 자동 로드 — OlderLoading 스피너가 화면(+선로드 여유) 안에 보이면 스크롤과 무관하게 이전 구간을 로드.
  //   onScroll만으로는 콘텐츠가 뷰포트보다 짧은 세션에서 스크롤 이벤트 자체가 발생하지 않아(스크롤 불가)
  //   이전 대화를 불러올 방법이 없었다(진입 직후 스피너만 영원히 도는 데드락). 커밋 후 기하 검사로 발동하고,
  //   로드 후에도 스피너가 여전히 보이면 deps 변경(itemCount·frozenKey)으로 재실행돼 화면이 찰 때까지 연쇄 로드.
  useEffect(() => {
    if (showSkeleton || !hasConvo) return
    let timer = 0
    const check = () => {
      if (loadRef.current.phase !== 'idle') {
        timer = window.setTimeout(check, 80) // 앵커 보정 소비 중 — 끝난 뒤 재검사(연쇄 로드 유지)
        return
      }
      loadMore()
    }
    check()
    return () => window.clearTimeout(timer)
  }, [showSkeleton, renderId, itemCount, frozenKey, hasConvo, hasOlder, olderLoading, olderNow?.oldestSeq, loadMore])

  /** 스크롤이 상단 근접 시 이전 묶음 로드. useStickyBottom의 추적 판정 뒤에 이어서 부른다. */
  const handleScroll = (el: HTMLDivElement) => {
    // 응답을 기다리는 동안 사용자가 계속 스크롤하면, 요청 시점의 위치로 되돌리지 않도록 기준점을 지금 화면으로 갱신한다.
    if (loadRef.current.phase === 'fetching' && pendingAnchor.current != null) {
      pendingAnchor.current = captureAnchor(el)
      return
    }
    if (frozenKey == null || loadRef.current.phase !== 'idle' || el.scrollTop > LOAD_OLDER_PX) return
    const { id, start, older } = ctxRef.current
    if (start > 0) expandWindow(el) // 로컬 윈도 확장 — 앵커 effect가 위치 보정+재검증
    else if (id && older && canFetchOlder(loadRef.current, older, false)) fetchOlder(id, older.oldestSeq, captureAnchor(el)) // 로컬 소진 → 서버에서 이전 페이지
  }

  /** 렌더마다 최신 세그먼트·페이징 상태를 넘긴다(stale 클로저 방지). */
  const bind = (ctx: OlderCtx) => {
    ctxRef.current = ctx
  }

  return { pendingAnchor, olderSentinelRef, handleScroll, bind }
}

/* ─────────────── 검색 결과로 점프 ─────────────── */

type JumpCtx = { segs: StreamSeg[]; start: number; older: OlderPaging | undefined }

/**
 * 검색 결과 클릭(openSessionAt) → jumpToSeq: 해당 채팅 위치로 스크롤 + 강조.
 *   대상이 현재 윈도 밖이면 frozenKey를 앞당겨 창을 넓힌 뒤(재실행) 스크롤, 미로드 과거 구간이면 범위 로드 후 재실행.
 *   페이지 경계나 로딩이 바뀌면 남은 구간을 다시 부른다. 경계가 더 이상 줄지 않거나 과거가 없으면 점프를 끝낸다.
 *   ★ useStickyBottom(진입 하단점프)보다 *뒤에* 호출해야 한다 → 같은 커밋에서 하단점프 후 이 효과가 대상으로 재이동(우선).
 *
 * 여기 nonce는 공용 useSignal로 못 바꾼다: 대상이 아직 로드 전이면 일부러 소비하지 않고 다음 렌더에 다시 시도해야 하는데,
 * useSignal은 신호가 오면 무조건 한 번에 소비하고 끝내기 때문이다(그리고 이 효과는 페인트 전에 돌아야 해서 layout effect다).
 */
export function useJumpToSeq({ ref, jumpToSeq, id, renderId, showSkeleton, itemCount, frozenKey, leaveBottom, setFrozenKey }: {
  ref: RefObject<HTMLDivElement | null>
  jumpToSeq: { id: string; seq: number; nonce: number } | null
  id: string | null
  renderId: string | null
  showSkeleton: boolean
  itemCount: number
  frozenKey: string | null
  /** useStickyBottom이 준다 — 바닥 추적 해제 + '맨 아래로' 버튼 노출. */
  leaveBottom: () => void
  setFrozenKey: (key: string | null) => void
}) {
  const jumpConsumedRef = useRef(0) // 마지막으로 소비한 jumpToSeq.nonce(중복 점프 방지)
  const jumpCursorRef = useRef<{ nonce: number; boundary: number } | null>(null) // 이 점프가 마지막으로 부른 페이지 경계
  const [flashSeq, setFlashSeq] = useState<number | null>(null) // 점프 대상 강조(잠깐)
  const ctxRef = useRef<JumpCtx>({ segs: [], start: 0, older: undefined })
  const olderNow = id ? getState().older[id] : undefined

  useLayoutEffect(() => {
    const j = jumpToSeq
    if (!j || j.id !== id || j.nonce === jumpConsumedRef.current || showSkeleton) return
    const { segs, start, older } = ctxRef.current
    // 대상 seq가 아직 미로드 과거 구간이면 그 seq까지 범위 로드 후 재실행. 경계가 줄지 않으면 더 부르지 않는다.
    if (older?.hasOlder && j.seq < older.oldestSeq) {
      if (older.loading) return
      const prev = jumpCursorRef.current
      const stalled = !!prev && prev.nonce === j.nonce && older.oldestSeq >= prev.boundary
      if (!stalled) {
        jumpCursorRef.current = { nonce: j.nonce, boundary: older.oldestSeq }
        void actions.loadOlder(id, j.seq)
        return
      }
    }
    const target = findJumpIdx(segs, j.seq)
    if (target < 0) {
      jumpConsumedRef.current = j.nonce
      return
    }
    if (target < start) {
      setFrozenKey(segs[Math.max(0, target - 3)].key) // 창 확장 → frozenKey 변경으로 이 효과 재실행
      return
    }
    const tseq = segs[target].seq
    // 찾을 수 있는 것 = 화면에 남는 말 전부. 작업 중 알림(`.work-note`)은 말풍선이 없으므로 따로 적어 준다 —
    //   빠뜨리면 검색 결과에는 나오는데 눌러도 아무 일이 안 일어난다.
    const box = ref.current?.querySelector(
      `[data-seq="${tseq}"] .bubble-assistant, [data-seq="${tseq}"] .bubble-user, [data-seq="${tseq}"] .work-note`,
    ) as HTMLElement | null
    if (box) {
      box.scrollIntoView({ block: 'center' })
      leaveBottom() // 위로 점프 — 자동 하단추적 해제(하단 버튼 노출) + 직전 scrollTop 비교값 리셋
      setFlashSeq(tseq)
      jumpConsumedRef.current = j.nonce
    }
  }, [jumpToSeq, renderId, showSkeleton, itemCount, frozenKey, olderNow?.oldestSeq, olderNow?.loading, olderNow?.hasOlder])

  // 강조는 잠깐만(2.5s) — 애니메이션이 끝난 뒤 클래스 제거.
  useEffect(() => {
    if (flashSeq == null) return
    const t = window.setTimeout(() => setFlashSeq(null), 2500)
    return () => window.clearTimeout(t)
  }, [flashSeq])

  const bind = (ctx: JumpCtx) => {
    ctxRef.current = ctx
  }

  return { flashSeq, bind }
}
