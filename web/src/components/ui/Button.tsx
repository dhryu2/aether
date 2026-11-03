/**
 * 버튼 — 배경색·글자색·테두리·굵기·비활성 분기를 한곳에 둔다.
 * 높이·모서리·글자 크기는 자리마다 달라 호출부가 넘긴다. 좌우 여백은 기본값이 있고, 다르면 넘긴다.
 */
import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from 'react'
import { C, R } from '../../design/tokens'

/** 버튼의 의미. 색이 여기서 결정된다. */
export type ButtonTone = 'primary' | 'gray' | 'danger' | 'warn'

type ToneStyle = { background: string; color: string; border: string }

const TONE: Record<ButtonTone, ToneStyle> = {
  /** 파랑 채움 = 실행·주요 행동. 한 화면에 하나. */
  primary: { background: C.tintFill, color: C.onTint, border: 'none' },
  /** 회색 채움 = 거부·취소·부차 행동. */
  gray: { background: C.fill, color: C.label, border: 'none' },
  /** 삭제처럼 되돌릴 수 없는 행동. */
  danger: { background: C.delFill, color: C.onTint, border: 'none' },
  /** 초기화처럼 위험하지만 파괴적이지 않은 행동. */
  warn: { background: C.attnFill, color: C.onTint, border: 'none' },
}

/** 비활성일 때의 회색. 글자는 꺼진 것에만 쓰는 색. */
const DISABLED: ToneStyle = { background: C.sepSoft, color: C.label4, border: 'none' }

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'children'> & {
  tone?: ButtonTone
  children: ReactNode
  /** 비활성처럼 보이지만 눌린다. 누르면 왜 안 되는지 알려 줄 때 쓴다. */
  looksDisabled?: boolean
  /** 높이(px). 자리마다 달라 호출부가 정한다. */
  height?: number
  radius?: number
  fontSize?: number
  /** 좌우 여백. 아이콘만 든 고정 폭 버튼은 0을 넘긴다. */
  paddingX?: number
  fullWidth?: boolean
  /** 남는 가로 공간을 나눠 갖는다(대화상자의 취소/확인 두 개처럼). */
  grow?: boolean
  ref?: Ref<HTMLButtonElement>
  /** 위 속성으로 표현 안 되는 나머지(marginTop 등). */
  style?: CSSProperties
}

export function Button({
  tone = 'gray',
  children,
  height = 40,
  // 버튼은 알약. R.pill은 상자에도 쓰이는 이름이라 12다. 여기서는 full을 쓴다.
  radius = R.full,
  fontSize = 13.5,
  paddingX = 18,
  fullWidth,
  grow,
  disabled,
  looksDisabled,
  className,
  style,
  ref,
  ...rest
}: Props) {
  const off = disabled || looksDisabled
  const t = off ? DISABLED : TONE[tone]
  // 비활성일 땐 떠오르는 효과를 빼야 한다. 누를 수 없는 버튼이 마우스에 반응하면 눌리는 줄 안다.
  const cls = [!off && 'lift', className].filter(Boolean).join(' ')
  return (
    <button
      ref={ref}
      disabled={disabled}
      aria-disabled={looksDisabled || undefined}
      className={cls}
      style={{
        height,
        borderRadius: radius,
        fontSize,
        fontWeight: 600,
        background: t.background,
        color: t.color,
        border: t.border,
        cursor: off ? 'default' : 'pointer',
        padding: `0 ${paddingX}px`,
        ...(fullWidth && { width: '100%' }),
        ...(grow && { flex: 1 }),
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ─────────────── 작은 알약 버튼 ─────────────── */

/** 카드 안에서 쓰는 작은 행동 버튼. 지금 쓰는 조합은 테두리 한 벌뿐이다. */
export type PillTone = 'outline'

const PILL: Record<PillTone, { background: string; color: string; border: string }> = {
  outline: { background: C.cell, color: C.label2, border: C.sep },
}

/**
 * 목록 항목이나 카드 안의 작은 행동 버튼.
 * 크기(5px 11px)와 모서리는 예전과 같다.
 */
export function ActionPill({
  tone = 'outline',
  children,
  radius = R.btn,
  fontSize = 12,
  className,
  style,
  ref,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'children'> & {
  tone?: PillTone
  children: ReactNode
  radius?: number
  fontSize?: number
  ref?: Ref<HTMLButtonElement>
  style?: CSSProperties
}) {
  const p = PILL[tone]
  return (
    <button
      ref={ref}
      className={['lift inline-flex items-center', className].filter(Boolean).join(' ')}
      style={{
        gap: 4,
        padding: '5px 11px',
        borderRadius: radius,
        fontSize,
        fontWeight: 600,
        background: p.background,
        color: p.color,
        border: `1px solid ${p.border}`,
        cursor: 'pointer',
        flexShrink: 0,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
