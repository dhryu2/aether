// 설정 창의 묶음 목록. iOS 설정처럼 제목, 둥근 면, 글 시작선부터 긋는 구분선.
import type { ReactNode } from 'react'
import { C, FONT } from '../../design/tokens'
import { Skeleton } from '../ui'
import { t as tNow } from '../../lib/i18n'
import { onCopyMenu } from '../contextMenuFor'
import { rowMin, useNarrow } from './settingsLayout'

/** 묶음 제목. `trailing`은 오른쪽 메타(고른 경로처럼 제목이 못 담는 값). */
export function GroupTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0, padding: '0 16px', margin: '0 0 8px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.label2, flexShrink: 0 }}>{children}</div>
      {trailing}
    </div>
  )
}

export function GroupNote({ children }: { children: ReactNode }) {
  return (
    <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '8px 0 0', padding: '0 16px' }}>
      {children}
    </p>
  )
}

export function Group({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: C.cell, borderRadius: 12, overflow: 'hidden' }}>
      {children}
    </div>
  )
}

/** 구분선은 글이 시작하는 자리에서 시작한다. */
export function Sep() {
  return <div aria-hidden style={{ height: 1, marginLeft: 16, background: C.sepSoft }} />
}

export function TextRow({
  color,
  onClick,
  children,
  providerId,
  expanded,
}: {
  color?: string
  onClick: () => void
  children: ReactNode
  providerId?: string
  /** 펼치고 접는 줄이면 지금 펼쳐졌는지. 낭독기가 "펼쳐짐/접힘"을 읽는다. */
  expanded?: boolean
}) {
  const narrow = useNarrow()
  return (
    <button
      type="button"
      data-provider-id={providerId}
      aria-expanded={expanded}
      onClick={onClick}
      className="press"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        width: '100%',
        minHeight: rowMin(narrow),
        padding: '0 16px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit',
        fontSize: 15,
        color: color ?? C.label,
      }}
    >
      {children}
    </button>
  )
}

/** 이름과 값만 있는 읽기 줄. 값은 오른쪽에 숫자 폭을 맞춰 둔다. `color`는 값에만 입힌다(이름은 늘 본문색). */
export function ValueRow({ label, value, color, copy }: { label: string; value: ReactNode; color?: string; copy?: string | number }) {
  const narrow = useNarrow()
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: rowMin(narrow), padding: '0 16px', fontSize: 15 }}
      onContextMenu={copy != null ? onCopyMenu(String(copy), tNow('menu.copyValue')) : undefined}
    >
      <span style={{ minWidth: 0, color: C.label }}>{label}</span>
      <span className="tabular-nums" style={{ flexShrink: 0, color: color ?? C.label2 }}>{value}</span>
    </div>
  )
}

/** 이름 위, 값 아래로 쌓는 읽기 줄. 경로처럼 긴 값이 줄바꿈되고 선택·복사할 수 있다. */
export function StackRow({ label, value, copy }: { label: string; value: ReactNode; copy?: string }) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', fontSize: 15 }}
      onContextMenu={copy != null ? onCopyMenu(copy, tNow('menu.copyValue')) : undefined}
    >
      <span style={{ color: C.label }}>{label}</span>
      <span style={{ fontFamily: FONT.mono, fontSize: 13, color: C.label2, overflowWrap: 'anywhere', userSelect: 'text' }}>{value}</span>
    </div>
  )
}

/** 불러오는 동안 값 줄 자리를 같은 높이로 잡아 두어, 응답이 와도 아래가 밀리지 않게 한다. */
export function SkeletonRows({ count }: { count: number }) {
  const narrow = useNarrow()
  return (
    <Group>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          {i > 0 && <Sep />}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: rowMin(narrow), padding: '0 16px' }}>
            <Skeleton width={96} height={14} />
            <Skeleton width={64} height={14} />
          </div>
        </div>
      ))}
    </Group>
  )
}
