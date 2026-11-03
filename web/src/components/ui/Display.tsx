/**
 * 보여주기만 하는 작은 조각들 — 배지·아이콘 타일·점·구분선·진행바·자리표시자·회전자·빈 상태.
 * 전부 원래 여러 파일에 같은 모양으로 흩어져 있던 것들이다(아이콘 타일 14곳, 배지 9곳, 구분선 5곳 등).
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { C, R, alpha } from '../../design/tokens'
import type { DerivedStatus, SessionAttention } from '../../lib/types'

/* ─────────────── 점 ─────────────── */

/** 색을 직접 주는 작은 원. 칩 안의 6px 상태 점 5곳이 각자 적던 모양. */
export function Dot({ color, size = 6, glow, dashed, className, style }: {
  color: string
  size?: number
  /** 살아 있음을 나타내는 번짐. */
  glow?: string
  /** 점선 테두리만 있는 속 빈 점(손상된 세션). */
  dashed?: boolean
  /** '움직임 줄이기'에서 깜빡임을 끄기 위한 손잡이 등. */
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        ...(dashed
          ? { border: `1.5px dashed ${color}`, background: 'transparent', opacity: 0.6 }
          : { background: color, boxShadow: glow ? `0 0 7px ${glow}` : undefined }),
        ...style,
      }}
    />
  )
}

/**
 * 세션 수명 상태 5색(사용자 결정).
 * running/requires_action은 세션이 아니라 '지금 턴'의 상태라 여기 없다 — 따로 처리한다.
 */
const STATUS: Record<DerivedStatus, { color: string; glow?: string; dashed?: boolean }> = {
  active: { color: C.ok, glow: alpha.ok(0.7) },
  interrupted: { color: C.attn },
  ended: { color: C.label3 },
  crashed: { color: C.del },
  corrupted: { color: C.label3, dashed: true },
}

export function StatusDot({ status, size = 9 }: { status: DerivedStatus; size?: number }) {
  const d = STATUS[status] ?? STATUS.ended
  return <Dot color={d.color} size={size} glow={d.glow} dashed={d.dashed} />
}

/**
 * 다음에 사람이 할 일. 수명 점(StatusDot)과 색·의미가 달라 합치지 않는다.
 * 대기=보라, 일함=노랑, 끝남=초록, 실패=빨강, 쉼=회색.
 */
const ATTENTION: Record<SessionAttention, { color: string; glow?: string }> = {
  waiting: { color: C.tintFill, glow: alpha.tint(0.7) },
  running: { color: C.attn },
  background: { color: C.attn },
  done: { color: C.ok, glow: alpha.ok(0.7) },
  failed: { color: C.del },
  idle: { color: C.label3 },
}

export function AttentionDot({ attention, size = 9 }: { attention: SessionAttention; size?: number }) {
  const d = ATTENTION[attention] ?? ATTENTION.idle
  return <Dot color={d.color} size={size} glow={d.glow} />
}

/* ─────────────── 배지 ─────────────── */

/** 아주 작은 라벨. 역할·출처·분류 표시에 쓴다. */
export function Badge({ background, color, border, children, fontSize = 9.5, padding = '2px 7px', radius = R.sm, mono = false, style }: {
  background: string
  color: string
  /** 테두리 색. 없으면 테두리 없음. */
  border?: string
  children: ReactNode
  fontSize?: number
  padding?: string
  radius?: number
  /** 기본은 본문 글꼴 — 배지 문구는 대부분 사람이 읽는 말이다. 식별자·수치 배지만 true. */
  mono?: boolean
  style?: CSSProperties
}) {
  return (
    <span
      className={['inline-flex items-center', mono && 'font-mono'].filter(Boolean).join(' ')}
      style={{
        gap: 3,
        flexShrink: 0,
        fontSize,
        padding,
        borderRadius: radius,
        background,
        color,
        border: border ? `1px solid ${border}` : undefined,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/* ─────────────── 아이콘 타일 ─────────────── */

/** 아이콘을 담는 둥근 사각형. 26·28·30·36·40·42·48px 일곱 크기로 14곳에 흩어져 있었다. */
export function IconTile({ size = 36, radius, background, color, children, style }: {
  size?: number
  /** 생략하면 크기에 맞춰 자연스러운 곡률을 쓴다. */
  radius?: number
  background: string
  color: string
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size / 3.5),
        background,
        color,
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/* ─────────────── 구분선 ─────────────── */

/** 1px 가로선. 설정 화면에 글자까지 똑같은 것이 5개 있었다. */
export function Divider({ margin = '14px 0', color = C.sepSoft }: { margin?: string; color?: string }) {
  return <div style={{ height: 1, background: color, margin }} />
}

/**
 * 흐름 기록 한 줄 — 양옆 가는 선 사이에 작은 아이콘과 글자. 대화 기록 압축·이어가기처럼 할 일은 없지만
 * "여기서 이런 일이 있었다"는 표시. 상자에 담으면 진짜 경고와 같은 무게로 보여서 선으로만 남긴다(감사 F3).
 */
export function RecordLine({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  const rule = <span aria-hidden style={{ flex: 1, minWidth: 16, height: 1, background: alpha.label2(0.22) }} />
  return (
    <div className="flex items-center" style={{ alignSelf: 'stretch', gap: 10, color: C.label2, fontSize: 12, lineHeight: 1.4 }}>
      {rule}
      <span className="flex items-center" style={{ gap: 6, minWidth: 0, textAlign: 'center' }}>
        {icon}
        <span className="min-w-0">{children}</span>
      </span>
      {rule}
    </div>
  )
}

/* ─────────────── 진행바 ─────────────── */

/**
 * 채워지는 가로 막대. 사용량·저장공간·컨텍스트 표시에 각각 따로 구현돼 있었다.
 * 셋의 위험 기준선이 85%·85%·88%로 달랐는데, 그 판정은 호출부가 하고 여기선 색만 받는다.
 */
export function Meter({ pct, color, height = 6, radius, track = C.sepSoft, style, fillStyle, fillClassName }: {
  /** 0~100. 범위를 넘어도 막대는 넘치지 않는다. */
  pct: number
  color: string
  height?: number
  radius?: number
  track?: string
  style?: CSSProperties
  /**
   * 채워진 부분에만 얹을 스타일(위험 구간의 깜빡임 등).
   * 트랙이 아니라 채움에 걸어야 하는 효과가 있어서 열어 둔다.
   */
  fillStyle?: CSSProperties
  /** 채움에 붙는 클래스 — '움직임 줄이기'에서 깜빡임을 끄기 위한 손잡이. */
  fillClassName?: string
}) {
  const r = radius ?? height / 2
  return (
    <div style={{ height, borderRadius: r, background: track, overflow: 'hidden', ...style }}>
      <div
        className={fillClassName}
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: '100%',
          borderRadius: r,
          background: color,
          // 색도 같이 부드럽게 — 사용량이 주의/위험 단계를 넘을 때 색이 툭 튀지 않게.
          transition: 'width .3s, background .3s',
          ...fillStyle,
        }}
      />
    </div>
  )
}

/* ─────────────── 자리표시자 / 회전자 ─────────────── */

/**
 * 값이 오기 전에 자리를 잡아 두는 회색 덩어리(index.css의 .skeleton이 반짝임을 담당).
 * 무엇을 기다리는지 화면 낭독기에 알리려면 `aria-label`을 넘긴다.
 */
export function Skeleton({ width, height, radius = R.xs, style, ...rest }: {
  width: number | string
  height: number
  radius?: number
  style?: CSSProperties
} & Pick<HTMLAttributes<HTMLSpanElement>, 'aria-label' | 'role'>) {
  return <span className="skeleton" style={{ display: 'block', width, height, borderRadius: radius, ...style }} {...rest} />
}

/**
 * 도넛 회전자. 원래 두 곳이 서로 다른 CSS 애니메이션(`spin`과 `orbit`)으로 같은 모양을 그리고 있었다.
 * 여기서는 index.css에 이미 있던 `.spin` 하나만 쓴다.
 */
export function Spinner({ size = 26, thickness = 3, color = C.tintFill, track = C.sep, style }: {
  size?: number
  thickness?: number
  color?: string
  track?: string
  style?: CSSProperties
}) {
  return (
    <span
      className="spin"
      aria-hidden
      style={{
        display: 'block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `${thickness}px solid ${track}`,
        borderTopColor: color,
        flexShrink: 0,
        ...style,
      }}
    />
  )
}

/* ─────────────── 빈 상태 ─────────────── */

/**
 * 목록이 비었거나 불러오는 중일 때의 가운데 정렬 안내. 9곳에 흩어져 있었고 그중 셋은 글자까지 같았다.
 * icon/desc는 선택 — 한 줄짜리 "불러오는 중"부터 아이콘 있는 빈 목록까지 같은 조각으로 덮는다.
 */
export function EmptyState({ icon, title, desc, padding = '24px 0', color = C.label3, fontSize = 13, align = 'center' }: {
  icon?: ReactNode
  title: ReactNode
  desc?: ReactNode
  padding?: string
  color?: string
  fontSize?: number
  /** 목록 안에 섞여 들어가는 한 줄짜리 안내는 왼쪽 정렬이 자연스럽다. */
  align?: 'center' | 'left'
}) {
  const centered = align === 'center'
  return (
    <div
      className={centered ? 'flex flex-col items-center justify-center' : 'flex flex-col'}
      style={{ gap: 8, padding, textAlign: centered ? 'center' : 'left' }}
    >
      {icon}
      <div style={{ color, fontSize, lineHeight: 1.5 }}>{title}</div>
      {desc && <div style={{ color: C.label4, fontSize: fontSize - 1, lineHeight: 1.5 }}>{desc}</div>}
    </div>
  )
}

/* ─────────────── 알림 띠 ─────────────── */

/** 정보·경고·오류를 알리는 가로 띠. 색 세 벌이 배너 정의 밖에 그대로 복사돼 3곳에 더 있었다. */
export function Notice({ background, border, color, icon, children, radius = R.field, padding = '9px 12px', fontSize = 12.5, className, style }: {
  background: string
  border: string
  color: string
  icon?: ReactNode
  children: ReactNode
  radius?: number
  padding?: string
  fontSize?: number
  /** 등장 애니메이션(toast-in) 같은 바깥 사정. 인라인 style로 넣으면 '움직임 줄이기' 설정이 못 끈다. */
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={['flex items-start', className].filter(Boolean).join(' ')}
      style={{ gap: 10, borderRadius: radius, padding, fontSize, lineHeight: 1.5, background, border: `1px solid ${border}`, color, ...style }}
    >
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
