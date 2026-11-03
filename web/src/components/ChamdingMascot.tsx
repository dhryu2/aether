// 참딩 마스코트 — 화면은 "지금 무슨 상태인가"만 알려주고, 어떤 자세로 어떻게 움직일지는 여기서 정한다.
//   화면 코드가 이미지 파일을 직접 부르지 않는 이유: 자세가 늘거나 움직임 규칙이 바뀔 때 고칠 곳이 한 군데여야 한다.
//   근거 문서(저장소 밖 비공개 브랜드 원본) — PNG_RUNTIME_CONTRACT.md(런타임 계약),
//   CHAMDING_MOTION.md(기본 움직임), AETHER_CHAMDING_MOTION.md(Aether 동작).
//
// 지키는 규칙 세 가지:
//   1. 몸통은 통짜 한 장이다. 쪼개거나 늘이거나 찌그러뜨리지 않는다. 허용은 작은 회전·이동·투명도뿐.
//      딱 하나 예외가 등에 달린 태엽 손잡이다. 런타임 계약이 "보이는 8자 부분만 따로 떼어내 축을 중심으로
//      돌려도 된다"고 명시적으로 허용한다. 그래서 그림이 몸통 두 장 + 손잡이 한 장으로 되어 있다.
//   2. 계속 들썩이는 숨쉬기 동작은 금지다. 대기 상태는 거의 멈춰 있고 아주 가끔 한 번 자세를 고친다.
//   3. 어떤 움직임도 도중에 끊을 수 있어야 한다. 그래서 전부 CSS 전환으로 처리한다 — 상태가 바뀌면 그 자리에서 목표만 바뀐다.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import idleUrl from '../assets/chamding-idle.webp'
import inspectUrl from '../assets/chamding-inspect.webp'
import keyUrl from '../assets/chamding-key.webp'
import { useMediaQuery } from '../lib/hooks'
import { useChamdingSlot } from './chamdingSlot'
import { chamdingWidth } from './chamdingWidth'

/** 렌즈를 내리기 전 뜸 — 규칙이 "먼저 바라보고, 잠깐 생각하고, 움직인다"고 정한 그 뜸이다. */
const LOOK_BEFORE_LENS_MS = 200
/** 눌렀을 때 살펴보는 시간. 규칙의 Inspect 동작(0.9~1.2초) 안쪽. */
const PEEK_MS = 1000
/** 그림을 바꾸는 시점 = 고개 숙임/듦이 가장 깊은 지점. index.css의 키프레임 28%·26%와 같은 값이어야 한다. */
const LENS_DOWN_CUT_MS = Math.round(380 * 0.28)
const LENS_UP_CUT_MS = Math.round(340 * 0.26)
/** 손을 따르는 몫을 따로 남긴다. interactive에서는 안쪽 몸짓을 절반으로 줄여 합쳐도 3°·3px 이하다. */
const TILT_MAX_DEG = 1.5
const TILT_MAX_PX = 1
/** 태엽 판을 3D로 돌릴 때 쓰는 원근 거리(상자 높이의 배수). 작을수록 가까이서 본 것처럼 원근이 세다. */
const KEY_PERSPECTIVE = 1.6
/** 일하는 중이 이만큼 끊기지 않고 이어지면 지친 몸짓을 한 번 걸고 다시 잰다(M09 Tired). */
const TIRED_MS = 100_000
/** 1회성 몸짓이 끝나지 않아도 이 시간이 지나면 클래스를 뗀다. 가장 긴 몸짓(tired 2.1초)보다 길다. */
const GESTURE_SAFETY_MS = 2400

type Shot = { cls: string; n: number }

/** 1회성 상태가 들어오는 프레임에 걸 CSS 클래스. waiting·idle·working·loading은 몸짓이 따로 없다. */
const ONE_SHOT_CLASS: Partial<Record<ChamdingState, string>> = {
  thinking: 'chamding-thinking',
  success: 'chamding-success',
  error: 'chamding-error',
  confused: 'chamding-confused',
  surprise: 'chamding-surprise',
  empty: 'chamding-empty',
}
/** 렌즈를 내리는 상태. 로딩은 살펴보는 일이 아니라서 렌즈를 올인 채 둔다. */
const LENS_DOWN_STATES: ReadonlySet<ChamdingState> = new Set(['working'])
/** 태엽이 도는 상태. 로딩은 일하는 것과 다른 속도(is-loading)로 돈다. */
const WINDING_STATES: ReadonlySet<ChamdingState> = new Set(['working', 'loading'])

export type ChamdingState =
  /** 일 없음 — 렌즈를 올리고 거의 멈춰 있다. */
  | 'idle'
  /** 막 턴이 시작돼 아직 도구 호출도 글도 없음 — 렌즈를 올린 채 한 번 기울였다 선다(M04 Curious 대체안). */
  | 'thinking'
  /** 도구가 실제로 도는 중 — 렌즈를 내리고 태엽이 돈다. */
  | 'working'
  /** 턴이 성공으로 끝난 순간 1회 — 몸을 살짝 들어올렸다 내린다(M07 Success 대체안). */
  | 'success'
  /** 도구가 실패했거나 턴이 실패로 끝난 순간 1회 — 몸을 살짝 숙인다(M08 Error 대체안). */
  | 'error'
  /** 과금 한도 등 예상 밖 알림을 받은 순간 1회 — 몸이 좌우로 살짝 흔들린다(M05 Confused 대체안). */
  | 'confused'
  /** 채팅 턴과 무관한 앱 수준 대기 — 렌즈는 올리고 태엽만 천천히 돈다(M12 Loading). */
  | 'loading'
  /** 대화가 하나도 없는 세션에 막 들어온 순간 1회 — 작게 콕콕 숙였다 정면을 본다(M13 Empty 대체안). */
  | 'empty'
  /** provider가 모델을 강제로 바꾼 순간 1회 — 몸이 살짝 움찔한다(M10 Surprise 대체안). */
  | 'surprise'
  /** 사용자 답을 기다리는 중 — 렌즈를 올리고 더 드물게 자세를 고친다(M14 Waiting). */
  | 'waiting'

type Props = {
  state: ChamdingState
  /** 상자 높이(px). 너비는 그림 비율대로 정해진다. */
  size: number
  /** 참이면 손이 닿는 위치로 몸을 기울이고, 누르면 잠깐 렌즈를 내려 살펴본다. */
  interactive?: boolean
  ariaLabel?: string
  className?: string
  /** 참이면 처음 그려질 때의 상태 몸짓도 한 번 건다. working이면 일 시작 몸짓이다. */
  playOnMount?: boolean
  /** 이 값이 바뀌면 일 시작 몸짓을 다시 한 번 허용한다. 진행 줄은 턴 번호를 넘긴다. */
  taskKey?: number | string
  /** 화면당 하나 규칙의 우선순위. 숫자가 클수록 이긴다. 같으면 먼저 요청한 쪽. */
  priority?: number
  /**
   * 넘기면 스스로 슬롯을 다투지 않고 이 값을 따른다.
   * 진행 줄처럼 바깥이 이미 슬롯을 잡은 경우다. 못 가지면 그림은 두고 움직임만 멈춘다.
   */
  slot?: boolean
}

export function ChamdingMascot({
  state,
  size,
  interactive = false,
  ariaLabel,
  className,
  playOnMount = false,
  taskKey = 0,
  priority = 0,
  slot,
}: Props) {
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  // slot을 넘기면 그 값만 따른다. 안 넘기면 우선순위로 하나를 다툰다.
  const selfSlot = useChamdingSlot(slot === undefined, priority)
  const held = slot ?? selfSlot
  const still = reduce || !held

  const [lensDown, setLensDown] = useState(false)
  const [peek, setPeek] = useState(false)
  const [tilt, setTilt] = useState({ deg: 0, px: 0 })
  const [shot, setShot] = useState<Shot | null>(null)
  const [spinning, setSpinning] = useState(false)
  const [windup, setWindup] = useState(false)
  const [slip, setSlip] = useState(false)
  const [paused, setPaused] = useState(false)
  const peekTimer = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const keyRef = useRef<HTMLDivElement>(null)
  const prevState = useRef(state)

  // 렌즈를 내리기까지의 뜸. 일하는 자세로 바뀐 그 프레임에 바로 내리면 "생각하는" 박자가 사라진다.
  //   내리는 집합에 없을 때는 렌더 중에 바로 올린다 — effect에서 내리면 한 프레임 늦고, 린트에도 걸린다.
  useEffect(() => {
    if (!LENS_DOWN_STATES.has(state)) return
    const id = window.setTimeout(() => setLensDown(true), LOOK_BEFORE_LENS_MS)
    return () => window.clearTimeout(id)
  }, [state])
  if (!LENS_DOWN_STATES.has(state) && lensDown) setLensDown(false)

  // 처음 그릴 때의 몸짓. 슬롯을 아직 못 받았으면 미루고, 움직임 줄이기는 그냥 넘어간다(되살리지 않음).
  const [introPlayed, setIntroPlayed] = useState(false)
  if (!introPlayed && reduce) setIntroPlayed(true)
  else if (!introPlayed && !still && playOnMount && state !== 'working') {
    setIntroPlayed(true)
    const cls = ONE_SHOT_CLASS[state] ?? ''
    if (cls) setShot({ cls, n: 1 })
  } else if (!introPlayed && !still) setIntroPlayed(true)

  // 상태 몸짓. 같은 클래스를 다시 걸려면 한 프레임은 비워야 브라우저가 애니메이션을 다시 시작한다.
  //   working→thinking은 기울이지 않고 렌즈만 올린다. 일 시작은 아래 태엽 효과 쪽이다.
  useEffect(() => {
    if (prevState.current === state) return
    const from = prevState.current
    if (still || !introPlayed) {
      prevState.current = state
      return
    }
    let cls = ''
    if (!(from === 'working' && state === 'thinking') && state !== 'working') cls = ONE_SHOT_CLASS[state] ?? ''
    if (!cls) {
      prevState.current = state
      return
    }
    let raf2 = 0
    let cancelled = false
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return
      setShot(null)
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return
        prevState.current = state
        setShot((cur) => ({ cls, n: (cur?.n ?? 0) + 1 }))
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [state, still, introPlayed])

  // 일 시작은 taskKey마다 한 번. 직전 상태가 생각이든 아니든, 이 키로 working을 처음 보이면 감는다.
  //   키가 바뀌면 기록을 지워서, 이미 일하는 중에도 그 순간 다시 감긴다.
  const [seenTask, setSeenTask] = useState(taskKey)
  const [woundFor, setWoundFor] = useState<number | string | undefined>(
    state === 'working' && !playOnMount ? taskKey : undefined,
  )
  if (seenTask !== taskKey) {
    setSeenTask(taskKey)
    setWoundFor(undefined)
    setShot(null)
    setWindup(false)
  }
  // 움직임을 줄이거나 슬롯을 잃으면 감기를 소모만 한다. 다시 움직여도 지난 몸짓은 되살리지 않는다.
  if (still && state === 'working' && woundFor !== taskKey) setWoundFor(taskKey)
  useEffect(() => {
    if (still || state !== 'working' || woundFor === taskKey) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
      setWoundFor(taskKey)
      setWindup(true)
      setSpinning(false)
      setShot((cur) => ({ cls: 'chamding-startwork', n: (cur?.n ?? 0) + 1 }))
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [still, state, taskKey, woundFor])

  // 실패로 들어가면 태엽은 반 바퀴를 마저 돌지 않고 바로 멈춰 뒤로 미끄러진다.
  const [seenState, setSeenState] = useState(state)
  if (seenState !== state) {
    setSeenState(state)
    if (state === 'error') {
      // 슬롯이 없거나 원래 멈춰 있던 태엽에는 급정지할 회전이 없다.
      setSlip(!still && (spinning || windup))
      setSpinning(false)
      setWindup(false)
    } else {
      if (slip) setSlip(false)
      if (state !== 'working') setWindup(false)
    }
  }

  // 줄이기가 켜지면 몸짓·회전을 그 프레임에 지운다. 꺼지면 지금 필요한 연속 회전만 다시 켠다.
  const [wasStill, setWasStill] = useState(still)
  if (still !== wasStill) {
    setWasStill(still)
    if (still) {
      setTilt({ deg: 0, px: 0 })
      setShot(null)
      setSpinning(false)
      setWindup(false)
      setSlip(false)
    }
  }

  const windOwed = state === 'working' && !still && woundFor !== taskKey
  // 실패로 들어온 프레임의 태엽은 미끄러짐만 한다. 연속 회전 판정에 넣으면 같은 렌더에서 급정지가 되돌려진다.
  const wantSpin = !still && !slip && state !== 'error' && !windup && !windOwed && (WINDING_STATES.has(state) || peek)
  if (state === 'error' && spinning) setSpinning(false)
  else if (wantSpin && !spinning) setSpinning(true)

  // 안전 타이머 — animationend가 안 와도(클래스가 바뀌어 취소된 경우) 몸짓을 끝낸다.
  useEffect(() => {
    if (!shot) return
    const n = shot.n
    const id = window.setTimeout(() => {
      setShot((cur) => (cur && cur.n === n ? null : cur))
    }, GESTURE_SAFETY_MS)
    return () => window.clearTimeout(id)
  }, [shot])

  // 일하는 중이 아주 오래 이어지면 지친 몸짓을 한 번 걸고, 그래도 계속되면 또 건다.
  useEffect(() => {
    if (state !== 'working' || still) return
    let raf = 0
    let cancelled = false
    const id = window.setInterval(() => {
      setShot(null)
      raf = requestAnimationFrame(() => {
        if (cancelled) return
        setShot((cur) => ({ cls: 'chamding-tired', n: (cur?.n ?? 0) + 1 }))
      })
    }, TIRED_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
      cancelAnimationFrame(raf)
    }
  }, [state, still])

  useEffect(() => () => {
    if (peekTimer.current != null) window.clearTimeout(peekTimer.current)
  }, [])

  // 화면 밖이거나 탭이 가려지면 애니메이션을 멈춘다. 돌아오면 이어서 돈다.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let off = false
    const apply = () => setPaused(document.visibilityState === 'hidden' || off)
    const io = new IntersectionObserver((entries) => {
      off = !entries.some((e) => e.isIntersecting)
      apply()
    })
    io.observe(el)
    document.addEventListener('visibilitychange', apply)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', apply)
    }
  }, [])

  const lowered = lensDown || peek
  const [seenLowered, setSeenLowered] = useState(lowered)
  const [lensAnim, setLensAnim] = useState('')
  // 처음 그릴 때는 숙임 동작을 걸지 않는다 — 아직 바뀐 게 없다.
  if (seenLowered !== lowered) {
    setSeenLowered(lowered)
    if (!still) setLensAnim(lowered ? 'chamding-down' : 'chamding-up')
  }

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive || still) return
    const r = e.currentTarget.getBoundingClientRect()
    // 상자 가운데를 0, 양끝을 ±1로 본다. 끝에 닿아도 상한을 넘지 않는다.
    const rel = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)))
    setTilt({ deg: rel * TILT_MAX_DEG, px: rel * TILT_MAX_PX })
  }
  const onLeave = () => setTilt({ deg: 0, px: 0 })
  const onDown = () => {
    if (!interactive || !held) return
    if (peekTimer.current != null) window.clearTimeout(peekTimer.current)
    setPeek(true)
    peekTimer.current = window.setTimeout(() => setPeek(false), PEEK_MS)
  }

  const w = chamdingWidth(size)
  const quiet = still ? '' : state === 'waiting' ? 'chamding-quiet-slow' : 'chamding-quiet'
  const keyClass = [
    'chamding-key',
    !still && slip ? 'is-slip' : '',
    !still && !slip && windup ? 'is-windup' : '',
    !still && !slip && !windup && spinning && state === 'loading' ? 'is-loading' : '',
    !still && !slip && !windup && spinning && state !== 'loading' ? 'is-winding' : '',
  ].filter(Boolean).join(' ')

  // 태엽 클래스는 여기서만 바꾼다. React가 먼저 바꾸면 이전 회전 행렬이 사라져 정면으로 튄다.
  //   그리기 전 현재 행렬에서 축의 15° 기울임을 풀어 각도를 읽는다. 앞뒤 두 장이라 180°마다 같다.
  useLayoutEffect(() => {
    const el = keyRef.current
    if (!el || el.className === keyClass) return
    const transform = getComputedStyle(el).transform
    const matrix = new DOMMatrix(transform === 'none' ? undefined : transform)
    const upright = new DOMMatrix().rotate(-15).multiply(matrix).rotate(15)
    const angle = ((Math.atan2(upright.m31, upright.m11) * 180 / Math.PI) % 180 + 180) % 180
    const continuous = keyClass.includes('is-winding') || keyClass.includes('is-loading')
    // 연속 회전은 정면에서 끝나는 반 바퀴 주기를 유지하고, 음수 지연으로 지금 각도부터 잇는다.
    el.style.setProperty('--chamding-key-from', `${continuous ? 0 : angle}deg`)
    el.className = keyClass
    el.style.animationDelay = continuous ? `${-angle / 180 * (state === 'loading' ? 1600 : 1700)}ms` : '0ms'
    // 로딩과 작업은 같은 키프레임을 써서 기존 시계가 남는다. 지연에 각도를 담았으므로 시계만 새로 맞춘다.
    if (continuous) {
      for (const animation of el.getAnimations()) animation.currentTime = 0
    }
  }, [keyClass, state])

  return (
    // 상자를 셋으로 나눈 이유: 한 요소는 transform을 하나만 가질 수 있어서, 세 가지 움직임을
    //   한 요소에 얹으면 서로를 덮어쓴다. 바깥부터 — 손을 따라가는 기울임 / 렌즈 여닫을 때 고개 숙임 / 조용한 대기.
    <div
      ref={rootRef}
      className={[className, paused ? 'is-paused' : ''].filter(Boolean).join(' ') || undefined}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onPointerDown={onDown}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
      style={{
        '--chamding-motion': interactive ? 0.5 : 1,
        width: w,
        height: size,
        flexShrink: 0,
        transform: interactive && !still ? `rotate(${tilt.deg.toFixed(2)}deg) translateX(${tilt.px.toFixed(2)}px)` : 'none',
        transition: still || !interactive ? 'none' : 'transform 420ms cubic-bezier(.2,.7,.2,1)',
        touchAction: 'manipulation',
      } as CSSProperties}
    >
      {/* 1회성 몸짓 전용 층 — 렌즈 숙임·기울임과 transform 채널이 겹치지 않게 따로 둔다. */}
      <div
        className={shot?.cls}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget || !shot) return
          const n = shot.n
          setShot((cur) => (cur && cur.n === n ? null : cur))
        }}
        style={{ width: '100%', height: '100%' }}
      >
        {/* 가운데 상자 = 렌즈를 내리고 올릴 때 고개를 한 번 숙였다 펴는 동작. */}
        <div className={still ? undefined : lensAnim || undefined} style={{ width: '100%', height: '100%' }}>
          <div
            className={['chamding-key-stage', quiet].filter(Boolean).join(' ')}
            style={{ position: 'relative', width: '100%', height: '100%', perspective: size * KEY_PERSPECTIVE }}
          >
            {/* 태엽 손잡이 — 몸통 그림에서 오려낸 자리에 맞춰 뒤에 깔고, 원뿔 축 줄기를 중심으로 3D로 돌린다(CSS 참고).
                뒤에 두는 이유: 판과 원뿔 축 끝이 만나는 이음매를 몸통에 남겨 둔 원뿔이 앞에서 덮어 가려 준다.
                판은 앞면과 뒷면 두 장이다. 뒷면은 미리 뒤집어 둔 같은 그림이라, 판이 90°를 넘어 뒤를 보이면
                뒷면이 앞면처럼 보인다. 두께는 따로 그리지 않는다 — 어두운 층을 겹쳐 깔아 봤더니 면과 1px 남짓
                떨어진 층의 앞뒤 순서를 브라우저가 못 가려 테두리가 검게 뜯겨 보였다(2026-09-27 실측).
                그래서 판이 모로 서는 한순간(약 0.1초)은 거의 안 보인다. 실제 얇은 태엽도 그렇다. */}
            <div
              ref={keyRef}
              className="chamding-key"
              onAnimationIteration={(e) => {
                if (e.target === e.currentTarget && !wantSpin) setSpinning(false)
              }}
              onAnimationEnd={(e) => {
                if (e.target !== e.currentTarget) return
                if (windup) {
                  setWindup(false)
                  if (state === 'working' && !still) setSpinning(true)
                } else if (slip) setSlip(false)
              }}
              style={{ position: 'absolute', inset: 0 }}
            >
              <img src={keyUrl} alt="" draggable={false} className="chamding-key-front" />
              <img src={keyUrl} alt="" draggable={false} className="chamding-key-back" />
            </div>
            {/* 두 자세를 겹쳐 두고 한쪽만 보이게 한다.
                녹여서 넘기지 않고 한 번에 바꾸는 이유: 두 그림은 렌즈 위치뿐 아니라 몸 자세가 다르다.
                섞이는 동안에는 부리와 돋보기가 두 개로 보인다. 그래서 고개가 가장 깊이 숙여진 순간에
                딱 잘라 바꾼다. 그 순간이 위 CSS 동작의 정점이라 교체 자체가 눈에 안 띈다.
                움직임 줄이기를 켠 사람에게는 숙이는 동작이 없으므로, 대신 짧게 녹여서 덜 튀게 한다. */}
            {[idleUrl, inspectUrl].map((url, i) => (
              <img
                key={url}
                src={url}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: (i === 1) === lowered ? 1 : 0,
                  transition: still
                    ? 'opacity 120ms linear'
                    : `opacity 0ms linear ${lowered ? LENS_DOWN_CUT_MS : LENS_UP_CUT_MS}ms`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
