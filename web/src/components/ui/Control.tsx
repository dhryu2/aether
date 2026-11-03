/**
 * 사용자가 값을 고르는 조각 — 토글 스위치와 세그먼트 선택.
 * 스위치는 두 곳에 4px만 다른 크기로 각각 구현돼 있었고(하나는 컴포넌트, 하나는 본문에 그대로),
 * 세그먼트 선택은 네 곳에 있었는데 그중 둘은 투명도 0.8과 0.85만 다른 사실상 같은 코드였다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { C, R, SH } from '../../design/tokens'

/* ─────────────── 토글 스위치 ─────────────── */

type SwitchShape = {
  on: boolean
  width?: number
  height?: number
  knob?: number
  /** 켜졌을 때 트랙 색. 위험한 설정은 호출부가 다른 색을 넘긴다. */
  onColor?: string
  offColor?: string
  className?: string
}

/**
 * 스위치에는 두 가지 쓰임이 있다.
 *
 *   조작형 — 스위치 자신이 클릭을 받는다. `onChange`와 `label`을 준다.
 *   장식형 — 바깥의 더 큰 버튼이 클릭을 받고 스위치는 상태만 보여준다. 아무것도 주지 않는다.
 *
 * 장식형은 바깥 버튼이 클릭을 받을 때만 쓴다. 줄 전체가 스위치면 조작형이다.
 * 조작형에 `data-session-opt`를 주면 그 값이 스위치 버튼에 붙는다.
 * 시험이 줄이 아니라 스위치 자신을 찾는다.
 *
 * 타입을 둘로 갈라 둔 덕에 조작형인데 `label`을 빠뜨리면 컴파일이 막힌다.
 */
type SwitchProps = SwitchShape &
  (
    | { onChange: (next: boolean) => void; label: string; disabled?: boolean; 'data-session-opt'?: string }
    | { onChange?: undefined; label?: undefined; disabled?: undefined; 'data-session-opt'?: undefined }
  )

export function Switch({
  on,
  onChange,
  label,
  disabled,
  width = 46,
  height = 28,
  knob = 22,
  onColor = C.tintFill,
  offColor = C.fill,
  className,
  'data-session-opt': sessionOpt,
}: SwitchProps) {
  // 손잡이가 좌우 끝에서 같은 간격을 갖도록 여백을 크기에서 역산한다.
  // 원래 두 구현이 각자 `left: on ? 20 : 2`, `left: on ? 21 : 3`처럼 숫자를 박아 놨다.
  const inset = (height - knob) / 2
  const track: CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    width,
    height,
    borderRadius: R.full,
    border: 'none',
    flexShrink: 0,
    background: on ? onColor : offColor,
    transition: 'background var(--dur-in) var(--ease-state)',
  }
  const dot = (
    <span
      style={{
        position: 'absolute',
        top: inset,
        left: inset,
        // 손잡이는 left가 아니라 transform으로 옮긴다. left를 바꾸면 매 프레임 배치를 다시 계산한다.
        transform: on ? `translateX(${width - knob - inset * 2}px)` : 'none',
        width: knob,
        height: knob,
        borderRadius: '50%',
        // 손잡이는 두 밝기 모드 모두 흰색이다. 카드 면 색을 쓰면 어두운 화면에서 손잡이가 어두워진다.
        background: C.onTint,
        boxShadow: SH.knob,
        transition: 'transform var(--dur-in) var(--ease-state)',
      }}
    />
  )

  if (!onChange) return <span className={className} style={track}>{dot}</span>

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-session-opt={sessionOpt}
      disabled={disabled}
      className={className}
      onClick={() => onChange(!on)}
      style={{ ...track, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {dot}
    </button>
  )
}

/* ─────────────── 세그먼트 선택 ─────────────── */

export type SegmentItem<T extends string> = {
  value: T
  label: ReactNode
}

/**
 * 나란한 칸 중 하나를 고르는 컨트롤.
 *   compact — 설정 화면처럼 작고 촘촘한 것(트랙 모서리 9, 여백 2)
 *   roomy   — Agent Brain 탭처럼 넉넉한 것(트랙 모서리 11, 여백 4, 테두리 있음)
 *
 * 접근성: 기본은 눌린 칸을 `aria-pressed`로 알린다. `role="tablist"`를 쓰지 않는 이유는
 * 그게 화면 낭독기에 "화살표 키로 이동하는 탭"이라고 약속하는 것이기 때문이다.
 * 이 컨트롤은 그 키보드 규약을 구현하지 않으므로, 지키지 못할 약속을 하지 않는다.
 * `tabs`를 주면 그 약속을 지키는 진짜 탭이 된다: 탭 목록·탭 역할, 선택 표시(aria-selected),
 * 선택된 칸만 Tab 키로 들어가고 화살표·Home·End로 옮긴다. 짝이 되는 패널은 호출부가 `tabs.id`로 잇는다.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size = 'roomy',
  itemPadding,
  itemHeight,
  itemMinWidth,
  fontSize = 12.5,
  itemRadius,
  fullWidth,
  scrollable,
  tabs,
  style,
}: {
  items: readonly SegmentItem<T>[]
  value: T
  onChange: (next: T) => void
  size?: 'compact' | 'roomy'
  /** 칸 안쪽 여백. 탭처럼 넓게 쓸 때 지정한다. */
  itemPadding?: string
  itemHeight?: number
  /** 칸의 최소 너비. 폰에서 누름 44를 맞출 때 쓴다. */
  itemMinWidth?: number
  fontSize?: number
  itemRadius?: number
  fullWidth?: boolean
  /** 칸이 많아 넘칠 때 가로로 스크롤되게 한다(좁은 화면의 Agent Brain 탭). */
  scrollable?: boolean
  /** 탭으로 쓴다. 칸은 `${id}-tab-${value}`, 짝 패널은 `${id}-panel-${value}`를 가리킨다. */
  tabs?: { id: string; label: string }
  style?: CSSProperties
}) {
  const roomy = size === 'roomy'
  // 탭 키보드: 화살표는 양 끝에서 돌아 이어지고, 옮기면 곧바로 그 탭이 선택된다(자동 활성).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = items.length - 1
    const to = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (to < 0) return
    e.preventDefault()
    onChange(items[to].value)
    document.getElementById(`${tabs!.id}-tab-${items[to].value}`)?.focus()
  }
  // 선택 알약: 칸마다 배경을 칠하지 않고 알약 하나가 선택 칸으로 미끄러진다.
  //   위치는 선택 버튼의 offset으로 재고, 크기가 변하면(회전·글꼴 로딩) ResizeObserver로 다시 잰다.
  const trackRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [animate, setAnimate] = useState(false)
  const measure = () => {
    const el = btnRefs.current[items.findIndex((it) => it.value === value)]
    const next = el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null
    setBox((p) => (p && next && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h ? p : next))
  }
  const measureRef = useRef(measure)
  // 그릴 때마다 잰다(같은 값이면 상태가 안 바뀌어 다시 그리지 않는다).
  useLayoutEffect(() => { measureRef.current = measure; measure() })
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const ro = new ResizeObserver(() => measureRef.current())
    ro.observe(track)
    btnRefs.current.forEach((b) => b && ro.observe(b))
    return () => ro.disconnect()
  }, [items.length])
  // 첫 그림은 transition 없이 제자리에 둔다(열리자마자 미끄러지는 것 방지).
  useEffect(() => { const id = requestAnimationFrame(() => setAnimate(true)); return () => cancelAnimationFrame(id) }, [])
  return (
    <div
      ref={trackRef}
      role={tabs ? 'tablist' : undefined}
      aria-label={tabs?.label}
      className={`${fullWidth ? 'flex' : 'inline-flex'}${scrollable ? ' scroll-area' : ''}`}
      style={{
        position: 'relative',
        gap: roomy ? 5 : 2,
        padding: roomy ? 4 : 2,
        borderRadius: roomy ? R.track : R.pill,
        background: roomy ? 'color-mix(in srgb, var(--c-bg2) 85%, transparent)' : C.sepSoft,
        border: roomy ? `1px solid ${C.sep}` : undefined,
        ...(scrollable && { maxWidth: '100%', overflowX: 'auto' }),
        ...style,
      }}
    >
      {box && (
        <span
          aria-hidden
          className={animate ? 'seg-pill seg-pill-anim' : 'seg-pill'}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: box.w,
            height: box.h,
            transform: `translate(${box.x}px, ${box.y}px)`,
            borderRadius: itemRadius ?? (roomy ? R.sm : R.chip),
            background: C.segOn,
            boxShadow: SH.segActive,
            pointerEvents: 'none',
          }}
        />
      )}
      {items.map((it, i) => {
        const on = it.value === value
        return (
          <button
            key={it.value}
            ref={(el) => { btnRefs.current[i] = el }}
            id={tabs ? `${tabs.id}-tab-${it.value}` : undefined}
            role={tabs ? 'tab' : undefined}
            aria-pressed={tabs ? undefined : on}
            aria-selected={tabs ? on : undefined}
            aria-controls={tabs ? `${tabs.id}-panel-${it.value}` : undefined}
            tabIndex={tabs && !on ? -1 : undefined}
            onKeyDown={tabs ? (e) => onTabKey(e, i) : undefined}
            onClick={() => onChange(it.value)}
            className="relative"
            style={{
              flex: fullWidth ? 1 : undefined,
              minWidth: itemMinWidth,
              height: itemHeight,
              padding: itemPadding ?? (roomy ? '8px 16px' : '0 10px'),
              // 안쪽 칸은 바깥 트랙보다 덜 둥글어야 한다 — 트랙 안쪽 여백만큼 빼는 게 눈에 맞다.
              // 트랙을 8로 낮추면서 여백이 4인 roomy는 8에서 6으로 함께 내렸다(안 내리면 칸 모서리가 트랙보다 둥글어 보인다).
              borderRadius: itemRadius ?? (roomy ? R.sm : R.chip),
              border: 'none',
              fontSize,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              background: 'transparent',
              color: on ? C.label : roomy ? C.label2 : C.label3,
              transition: 'color var(--dur-press) var(--ease-state)',
            }}
          >
            {it.label}
          </button>
        )
      })}
    </div>
  )
}
