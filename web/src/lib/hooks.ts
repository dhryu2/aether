import { reportClientError } from './errorReporting'
// 공용 UI 훅 — 여러 화면이 똑같이 반복하던 곁가지 동작을 한 곳에.
//   onClose는 ref에 담아 최신값을 부르되 effect deps에서 제외한다 → 팝오버·모달이 열린 채 부모가 자주 리렌더돼도
//   (스트리밍 시 useStore가 초당 ~60회) 리스너를 재구독하지 않는다.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

// 바깥을 누르거나 Esc로 닫기 — 팝오버 공용(ModelPicker·EffortPicker·입력창 ＋ 메뉴·슬래시 명령·찾기 바).
//   마우스 이벤트가 아니라 pointer 이벤트를 듣는다: iOS Safari는 버튼이 아닌 영역을 손가락으로 눌렀을 때
//   마우스 이벤트를 보내지 않는 경우가 있어, 폰에서 바깥을 눌러도 안 닫히는 일이 생긴다.
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
  /**
   * 이 CSS 선택자에 해당하는 요소를 누른 것은 '바깥'으로 치지 않는다.
   * 팝오버 밖에 있는 여닫기 버튼을 위한 것 — 그 버튼을 누를 때 여기서 먼저 닫아 버리면
   * 이어지는 클릭이 다시 열어서, 버튼이 안 먹는 것처럼 보인다(찾기 바의 상단바 돋보기).
   */
  ignoreSelector?: string,
) {
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!ref.current || ref.current.contains(el)) return
      if (ignoreSelector && el?.closest?.(ignoreSelector)) return
      cb.current()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cb.current() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [ref, active, ignoreSelector])
}

// 뒤를 덮는 어두운 막을 눌러 닫기 — 모달·Agent Brain·모바일 서랍이 같은 판을 쓴다.
//   반환값을 막 요소에 그대로 펼쳐 넣는다: <div {...useScrimClose(close)} />
//   · click이 아니라 pointer 이벤트인 이유는 useDismiss와 같다(손가락으로 막을 눌러도 click이 안 올 수 있다).
//   · 누르기 시작한 곳과 손을 뗀 곳이 둘 다 막일 때만 닫는다 — 카드 안에서 글자를 드래그해 고르다가
//     막 위에서 손을 떼면 창이 닫혀 버리던 문제를 없앤다.
//   여기는 다른 훅들과 달리 onClose를 ref에 담지 않는다 — 문서에 리스너를 붙이는 게 아니라 그때그때
//   요소에 넘길 핸들러만 만들므로, 매 렌더 새로 만들어도 다시 구독하는 비용이 없다.
export function useScrimClose(onClose: () => void) {
  const startedOnScrim = useRef(false)
  return {
    onPointerDown: (e: ReactPointerEvent) => { startedOnScrim.current = e.target === e.currentTarget },
    onPointerUp: (e: ReactPointerEvent) => {
      const onScrim = startedOnScrim.current && e.target === e.currentTarget
      startedOnScrim.current = false
      if (onScrim) onClose()
    },
  }
}

// Esc로 닫기 — 모달 공용(오버레이 클릭 닫기는 ModalShell가 처리).
//   LIFO 스택으로 '가장 위(마지막 활성) 오버레이' 하나만 Esc에 반응 → 다이얼로그가 다른 모달 위에 겹쳐도
//   Esc가 밑 모달까지 같이 닫지 않는다. 동시에 하나만 활성이면 종전과 동일(스택 top=자기 자신).
const escStack: Array<RefObject<() => void>> = []
export function useEscape(active: boolean, onClose: () => void) {
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    if (!active) return
    escStack.push(cb)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && escStack[escStack.length - 1] === cb) cb.current() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = escStack.lastIndexOf(cb)
      if (i !== -1) escStack.splice(i, 1)
    }
  }, [active])
}

// 클립보드 복사 + "복사됨" 잠깐 표시 — Markdown의 코드블록과 로그인 화면이 각자 같은 코드를 갖고 있었다.
//   원래 두 구현 모두 화면을 떠날 때 타이머를 정리하지 않아, 복사 직후 창을 닫으면 사라진 컴포넌트에 상태를 쓰려 했다.
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), resetMs)
        })
        .catch(error => {
          // 권한 거부·비보안 컨텍스트는 복사 기능의 정상 거절이다.
          if (!(error instanceof DOMException && ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(error.name))) {
            reportClientError(error, { component: 'clipboard', operation: 'web.clipboard.write' })
          }
        })
    },
    [resetMs],
  )
  return { copied, copy }
}

// 열릴 때 특정 요소에 포커스 — 다섯 군데가 서로 다른 방식(effect·rAF·autoFocus)으로 같은 일을 했다.
//   rAF를 한 번 거치는 이유: 모달이 이제 막 붙은 프레임에서는 요소가 아직 배치 전이라 focus()가 씹힌다.
export function useAutoFocus<T extends HTMLElement>(active: boolean, opts?: { selectEnd?: boolean }) {
  const ref = useRef<T>(null)
  const selectEnd = opts?.selectEnd ?? false
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      // 글 끝으로 커서 보내기 — 이어 쓰기 좋게(컴포저에 값을 채워 넣을 때).
      if (selectEnd && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
        const n = el.value.length
        el.setSelectionRange(n, n)
      }
    })
    return () => cancelAnimationFrame(id)
  }, [active, selectEnd])
  return ref
}

// 스토어가 보낸 일회성 신호에 딱 한 번 반응 — 세 곳이 각자 `*ConsumedRef`를 두고 같은 판을 짜고 있었다.
//   nonce가 이전과 다를 때만 fn을 부른다. undefined면 아무 일도 하지 않는다(초기 상태).
export function useSignal(nonce: number | undefined, fn: () => void) {
  const seen = useRef(nonce)
  const cb = useRef(fn)
  cb.current = fn
  useEffect(() => {
    if (nonce === undefined || nonce === seen.current) return
    seen.current = nonce
    cb.current()
  }, [nonce])
}

// 미디어 쿼리 구독 — 세 곳이 addEventListener/removeEventListener 짝을 각자 적고 있었다.
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches))
  useEffect(() => {
    const mq = window.matchMedia(query)
    setMatch(mq.matches) // query가 바뀌었을 수 있으니 구독 직전 값을 한 번 맞춘다.
    const onChange = (e: MediaQueryListEvent) => setMatch(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return match
}

// 닫히는 모습까지 보여주기 — React는 조건이 거짓이 되는 순간 요소를 지우기 때문에, 그냥 두면
//   열릴 때만 애니메이션이 붙고 닫힐 때는 툭 사라진다(같은 창이 들어올 땐 미끄러지고 나갈 땐 없어진다).
//   이 훅은 닫힌 뒤에도 애니메이션 길이만큼 요소를 남겨 둔다. 그동안 `closing`이 참이다.
//
//   움직임을 줄여 달라고 한 사람에게는 남기지 않는다 — 보여줄 애니메이션이 없는데 사라지는 것만
//   늦어지면 그냥 반응이 굼뜬 화면이 된다.
//   여닫힘 판정은 "이전 값과 비교해 렌더 중에 상태를 고친다"는 React 공식 패턴으로 한다. effect 안에서
//   하면 닫히는 것을 한 프레임 늦게 알아채 애니메이션 앞머리가 잘린다. effect는 타이머만 맡는다.
export function useExitAnim(open: boolean, ms: number) {
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  const hold = reduce ? 0 : ms
  const [wasOpen, setWasOpen] = useState(open)
  const [closing, setClosing] = useState(false)
  if (wasOpen !== open) {
    setWasOpen(open)
    setClosing(!open && hold > 0) // 닫히기 시작했다 / 닫히는 도중 다시 열렸으면 없던 일로
  }
  useEffect(() => {
    if (!closing) return
    const id = setTimeout(() => setClosing(false), hold)
    return () => clearTimeout(id)
  }, [closing, hold])
  return { mounted: open || closing, closing }
}

// 서랍·전체화면 오버레이가 열린 동안 뒤 문서가 스크롤되지 않게 막는다.
// 창이 겹치면 각자 이전 값을 저장하면 안 된다. 먼저 닫힌 쪽이 나중에 넣은 'hidden'을
// 원래 값으로 되돌리거나, 나중에 닫힌 쪽이 그 값을 다시 써 잠금이 남는다.
// 첫 사용자가 원래 overflow를 기억하고, 마지막 사용자가 그 값으로 되돌린다.
// 사용자가 하나일 때는 저장했다가 그대로 되돌리는 것과 같다.
let bodyScrollLocks = 0
let bodyScrollOverflow = ''
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    bodyScrollLocks += 1
    if (bodyScrollLocks === 1) {
      bodyScrollOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    return () => {
      bodyScrollLocks -= 1
      if (bodyScrollLocks === 0) document.body.style.overflow = bodyScrollOverflow
    }
  }, [active])
}

// 켜진 뒤 ms가 지나야 참이 된다. 꺼지면 그 프레임에 거짓.
//   로딩 자리는 0.7초 안에 끝나면 참딩을 아예 안 보여 주려고 쓴다.
//   참으로 바꾸는 일은 타이머만 한다. 거짓으로 되돌리는 일은 렌더 중에 한다 —
//   effect에서 하면 꺼진 뒤 한 프레임 참이 남아 늦게 뜬다.
export function useDelayedFlag(on: boolean, ms: number): boolean {
  const [flag, setFlag] = useState(false)
  useEffect(() => {
    if (!on) return
    const id = window.setTimeout(() => setFlag(true), ms)
    return () => window.clearTimeout(id)
  }, [on, ms])
  if (!on && flag) setFlag(false)
  return on && flag
}

// 공용 시계 — 구독자가 몇이든 타이머는 하나다. 탭이 숨겨지면 멈추고, 돌아오면 바로 갱신한다.
let nowValue = Date.now()
const nowSubs = new Set<() => void>()
let nowTimer: ReturnType<typeof setInterval> | undefined
function tickNow() {
  nowValue = Date.now()
  for (const fn of nowSubs) fn()
}
function onVisibility() {
  if (document.hidden) {
    clearInterval(nowTimer)
    nowTimer = undefined
  } else {
    tickNow()
    nowTimer ??= setInterval(tickNow, 30_000)
  }
}
function subscribeNow(fn: () => void) {
  if (nowSubs.size === 0) {
    nowValue = Date.now()
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) nowTimer = setInterval(tickNow, 30_000)
  }
  nowSubs.add(fn)
  return () => {
    nowSubs.delete(fn)
    if (nowSubs.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(nowTimer)
      nowTimer = undefined
    }
  }
}
/** 30초마다 갱신되는 현재 시각(ms). 「N분째」 같은 상대 시간 표기용. */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => nowValue)
}
