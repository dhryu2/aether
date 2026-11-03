/**
 * 버튼 아래(또는 위)에 떠오르는 목록 — 네 곳(모델·effort·슬래시 명령·입력창 ＋ 메뉴)이
 * 위치 계산과 최대 너비, 겹침 순서를 각자 똑같이 적고 있었다.
 *
 * ChipPicker는 그중 모델·effort 두 개를 위한 것이다. 두 파일은 본문의 85%가 같았고
 * EffortPicker의 주석에도 "ModelPicker와 동형"이라고 적혀 있었다.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { C, R, Z } from '../../design/tokens'
import { useDismiss } from '../../lib/hooks'
import { leaveGhost } from '../../lib/leaveGhost'
import { Skeleton, Dot } from './Display'

/* ─────────────── 떠 있는 면 ─────────────── */

/** 나뉜 칸 안의 목록이 칸 가장자리와 띄우는 거리. */
const PANE_EDGE = 8

export function PopoverSurface({ direction = 'down', align = 'right', minWidth, zIndex = Z.inApp.picker, role, className, children, style, ...aria }: {
  /** 버튼 아래로 펼칠지 위로 펼칠지. 컴포저처럼 화면 아래에 붙은 것은 'up'. */
  direction?: 'up' | 'down'
  /** 어느 모서리에 맞춰 펼칠지. 좁은 화면에서 밖으로 새지 않는 쪽을 고른다. */
  align?: 'left' | 'right'
  minWidth?: number
  zIndex?: number
  role?: string
  /** 등장 움직임처럼 면 자체에 붙일 클래스. */
  className?: string
  'aria-label'?: string
  children: ReactNode
  style?: CSSProperties
}) {
  // 목록은 쓰는 곳마다 {open && ...}로 바로 빠진다. 창처럼 빠지기 직전 모습을 복사해 흐리게 치운다.
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    return () => {
      if (node) leaveGhost(node, 'popover-ghost')
    }
  }, [])
  // 나뉜 칸은 넘치는 것을 잘라 낸다. 칸 안에 들도록 옆으로 밀고, 그래도 높으면 스크롤시킨다.
  //   등장 움직임이 면을 키우는 중이라 면이 아니라 기준 단추의 자리와 면의 원래 크기로 잰다. 내용이 바뀌면 다시 재도록 매번 돈다.
  useLayoutEffect(() => {
    const node = ref.current
    const pane = node?.closest('[data-pane-multi="1"]')
    if (!node || !pane || !node.parentElement) return
    const box = pane.getBoundingClientRect()
    const anchor = node.parentElement.getBoundingClientRect()
    const w = node.offsetWidth
    const left = align === 'left' ? anchor.left : anchor.right - w
    const shift = left < box.left + PANE_EDGE ? box.left + PANE_EDGE - left : Math.min(0, box.right - PANE_EDGE - (left + w))
    node.style.translate = shift ? `${Math.round(shift)}px 0` : ''
    const room = direction === 'up' ? anchor.top - box.top : box.bottom - anchor.bottom
    const avail = Math.floor(room - 6 - PANE_EDGE)
    if (node.offsetHeight > avail) {
      node.style.maxHeight = `${avail}px`
      node.style.overflowY = 'auto'
    }
  })
  return (
    <div
      ref={ref}
      role={role}
      {...aria}
      // scroll-area = 스크롤바 공통 모양(index.css). 여기서 펼치는 목록 중 슬래시 명령처럼 길어져
      // 세로 스크롤이 생기는 것이 있다. 스크롤이 없는 팝오버에서는 아무 일도 하지 않는다.
      className={['popover-surface scroll-area', className].filter(Boolean).join(' ')}
      style={{
        position: 'absolute',
        [direction === 'up' ? 'bottom' : 'top']: 'calc(100% + 6px)',
        [align]: 0,
        minWidth,
        maxWidth: 'calc(100vw - 32px)',
        // 열릴 때 기준 단추 쪽 모서리에서 자라난다(index.css .popover-surface 애니메이션).
        transformOrigin: `${direction === 'up' ? 'bottom' : 'top'} ${align}`,
        overflow: 'hidden',
        zIndex,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/* ─────────────── 칩으로 여는 선택 목록 ─────────────── */

export type ChipOption<T extends string> = {
  value: T
  /** 첫 줄(굵게) */
  title: ReactNode
  /** 둘째 줄(작게) */
  subtitle?: ReactNode
}

/** 고른 항목의 색(점·글자·바탕). */
const ACCENT = { dot: C.tintFill, text: C.label, activeBg: C.tintSoft }

/** 아직 값을 모르거나 고르지 않은 항목의 점 — 켜진 점과 대비되는 흐린 파랑. */
const IDLE_DOT = C.sep

/**
 * 상단바·컴포저의 작은 칩을 눌러 목록을 펼치는 컨트롤.
 * `compact`는 모바일 컴포저에 놓이는 형태다 — 더 크고, 목록이 왼쪽 기준으로 펼쳐진다.
 */
export function ChipPicker<T extends string>({
  options,
  value,
  isActive,
  onPick,
  onOpen,
  panel,
  label,
  title,
  loading,
  loadingLabel,
  skeletonWidth = 44,
  compact,
  direction = 'down',
  align,
  labelMaxWidth,
  minWidth = 216,
  subtitleMono,
}: {
  options: readonly ChipOption<T>[]
  value: T | undefined
  /**
   * 어느 항목에 선택 표시를 할지 직접 정한다. 기본은 값이 같은 항목이다.
   *
   * 모델 피커가 이걸 쓴다. 세션이 흘려보내는 이름은 정식 id인데(claude-haiku-4-5-20251001)
   * 목록의 그 줄은 별칭으로 적혀 있어서(haiku), 값만 비교하면 아무 줄에도 체크가 안 붙는다.
   */
  isActive?: (optionValue: T) => boolean
  onPick: (next: T) => void
  /**
   * 칩을 눌렀을 때 목록을 열어도 되는지 묻는다. `false`를 돌려주면 열지 않는다.
   * 잠든 세션의 모델 칩이 이걸 쓴다 — 고를 것이 없으므로 빈 목록을 펼치는 대신 왜 없는지 알려 준다.
   */
  onOpen?: () => boolean
  /**
   * 목록 자리에 대신 그릴 내용. 주면 `options`는 그리지 않는다.
   * 목록을 끝내 못 받았을 때 안내와 "다시 시도"를 놓는 자리다. 인자로 받는 함수를 부르면 팝오버가 닫힌다.
   */
  panel?: (close: () => void) => ReactNode
  /** 칩에 보이는 현재 값. */
  label: ReactNode
  /** 칩에 마우스를 올렸을 때 뜨는 설명. */
  title: string
  /** 아직 실제 값을 모를 때 자리표시자를 보여 준다. */
  loading?: boolean
  loadingLabel: string
  skeletonWidth?: number
  compact?: boolean
  direction?: 'up' | 'down'
  /** 목록을 펼치는 기준. 기본은 compact면 왼쪽, 아니면 오른쪽. */
  align?: 'left' | 'right'
  /** 칩 글자의 최대 폭. 넘으면 말줄임으로 자른다. */
  labelMaxWidth?: number
  minWidth?: number
  /** 둘째 줄을 고정폭 글꼴로(모델 식별자처럼 코드일 때). */
  subtitleMono?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), open)

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => {
          if (loading) return
          if (!open && onOpen && !onOpen()) return // 여는 대신 다른 것을 하기로 한 경우(예: 알림만 띄우기)
          setOpen((o) => !o)
        }}
        // compact = 입력창 위에 뜬 작은 유리 알약(재설계 4단계). 뒤에 받쳐 주던 입력창 띠가 없어져 칩마다 유리를 입는다.
        //   칩은 색 없이 둔다 — 색은 손길·자동승인·ctx 같은 상태 신호에만 쓴다(감사 F5).
        className={compact ? 'glass press hit-44 inline-flex items-center' : 'press chip-ghost inline-flex items-center'}
        title={title}
        style={
          compact
            ? {
                height: 34,
                padding: '0 10px 0 13px',
                borderRadius: R.full,
                gap: 4,
                cursor: 'pointer',
              }
            : {
                // 재설계 A: 상단 도구 섬 안의 칩 — 테두리·바탕 없이 글자와 꺾쇠만, 올리면 회색 면(index.css .chip-ghost).
                //   모델 이름도 사람이 읽는 이름이라 고정폭을 쓰지 않는다(SPEC 5절).
                height: 32,
                padding: '0 10px 0 12px',
                borderRadius: R.full,
                gap: 4,
                cursor: 'pointer',
              }
        }
      >
        {loading ? (
          <Skeleton width={skeletonWidth} height={compact ? 12 : 11} aria-label={loadingLabel} />
        ) : (
          <span className={labelMaxWidth ? 'truncate' : undefined} style={{ fontSize: 13, fontWeight: 500, color: C.label, whiteSpace: 'nowrap', maxWidth: labelMaxWidth }}>{label}</span>
        )}
        <ChevronDown size={14} style={{ color: C.label3 }} aria-hidden />
      </button>

      {open && (
        <PopoverSurface
          // 안내판을 그릴 때는 고를 것이 없으므로 '목록'이라고 알리지 않는다(화면 낭독기 기준).
          role={panel ? undefined : 'listbox'}
          direction={direction}
          // compact(모바일 컴포저)는 칩이 왼쪽에 있어 왼쪽 기준으로 펼쳐야 화면 밖으로 안 나간다.
          align={align ?? (compact ? 'left' : 'right')}
          minWidth={minWidth}
        >
          {panel ? panel(() => setOpen(false)) : options.map((o) => {
            const active = isActive ? isActive(o.value) : value === o.value
            const a = ACCENT
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { setOpen(false); onPick(o.value) }}
                className="flex w-full items-center text-left"
                style={{ gap: 8, padding: '9px 12px', background: active ? a.activeBg : 'transparent', cursor: 'pointer' }}
              >
                <Dot color={active ? a.dot : IDLE_DOT} />
                <span className="min-w-0 flex-1">
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: a.text }}>{o.title}</span>
                  {o.subtitle !== undefined && (
                    <span
                      className={subtitleMono ? 'font-mono' : undefined}
                      style={{ fontSize: subtitleMono ? 10 : 10.5, color: C.label3 }}
                    >
                      {o.subtitle}
                    </span>
                  )}
                </span>
                {active && <span style={{ fontSize: 11, color: a.dot, flexShrink: 0 }}>✓</span>}
              </button>
            )
          })}
        </PopoverSurface>
      )}
    </div>
  )
}
