// Agent Brain 안에서만 쓰는 작은 조각. 묶음 목록과 구분선.
import type { ReactNode } from 'react'
import { C, R } from '../../design/tokens'

/** 카드가 아니라 한 덩어리로 붙는 목록. 면은 창보다 한 단계 밝다. */
export function Group({ children }: { children: ReactNode }) {
  return <div style={{ background: C.cell, borderRadius: R.card, overflow: 'hidden' }}>{children}</div>
}

/** 묶음 목록의 구분선. 글이 시작하는 16px부터 긋고, 첫 줄 위에는 긋지 않는다. */
export function RowLine({ index }: { index: number }) {
  if (index === 0) return null
  return <div aria-hidden style={{ marginLeft: 16, borderTop: `0.5px solid ${C.sepSoft}` }} />
}
