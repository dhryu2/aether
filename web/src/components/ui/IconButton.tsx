/**
 * 아이콘만 있는 버튼 — 원래 코드베이스에 14곳이 제각각 적혀 있었다.
 * 그중 모달 닫기 X만 7벌이었고, 그중 하나는 `flexShrink: 0`이 빠져 제목이 길면 찌그러졌다.
 *
 * 접근성: 아이콘만 있는 버튼은 화면 낭독기가 읽을 이름이 없다. 그래서 `label`을 필수로 받아
 * aria-label에 넣는다. 빠뜨릴 수 없게 타입으로 강제하는 게 이 컴포넌트의 핵심 이유 중 하나다.
 */
import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from 'react'
import { C, R } from '../../design/tokens'

/** 배경·테두리까지 있는 색 있는 아이콘 버튼(사이드바 세션 카드의 이름변경·초기화·삭제). */
export type IconTone = 'info' | 'warn' | 'danger'

const TONE: Record<IconTone, { background: string; border: string; color: string }> = {
  info: { background: C.tintSoft, border: `1px solid ${C.tintBorder}`, color: C.tint },
  warn: { background: C.attnSoft, border: `1px solid ${C.attnBorder}`, color: C.attn },
  danger: { background: C.delSoft, border: `1px solid ${C.delBorder}`, color: C.del },
}

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'children' | 'aria-label'> & {
  /** 화면 낭독기가 읽을 이름. 아이콘만 있으므로 생략 불가. */
  label: string
  children: ReactNode
  /** 정사각형 한 변(px). */
  size?: number
  radius?: number
  /** 배경 없는 기본형의 아이콘 색. `tone`을 주면 무시된다. */
  color?: string
  /** 배경+테두리가 있는 형태로 만든다. */
  tone?: IconTone
  /**
   * 카드 모서리에 붙는 닫기 버튼용 음수 여백. 버튼의 넉넉한 터치 영역이 카드 안쪽 여백을
   * 밀어내지 않게 당긴다. 원래 `marginTop:-8, marginRight:-8`로 4곳에 반복되던 값.
   */
  nudge?: boolean
  /**
   * 마우스를 올렸을 때 살짝 떠오르는 효과(index.css의 `.lift`).
   * 원래 이 효과가 없던 자리를 그대로 두려면 false를 준다.
   */
  lift?: boolean
  ref?: Ref<HTMLButtonElement>
  style?: CSSProperties
}

export function IconButton({
  label,
  children,
  size = 28,
  // 재설계 A: 아이콘 버튼은 원.
  radius = R.full,
  color = C.label3,
  tone,
  nudge,
  lift = true,
  className,
  style,
  ref,
  ...rest
}: Props) {
  const t = tone ? TONE[tone] : null
  return (
    <button
      ref={ref}
      aria-label={label}
      // `icon-tone`은 색 있는 버튼의 hover를 index.css에서 처리한다.
      //   배경을 인라인 스타일로 칠하면 Tailwind의 hover: 클래스가 우선순위에서 져서 아무 반응이 없다.
      className={[lift && 'lift', tone && 'icon-tone', 'inline-flex items-center justify-center', className]
        .filter(Boolean)
        .join(' ')}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        background: t?.background ?? 'transparent',
        border: t?.border ?? 'none',
        color: t?.color ?? color,
        cursor: 'pointer',
        ...(nudge && { marginTop: -8, marginRight: -8 }),
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
