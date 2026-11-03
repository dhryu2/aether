/**
 * 펼침·접힘 높이 애니메이션. 열리면 0에서 내용 높이까지 자라고, 닫히면 줄어든 뒤 내용을 치운다.
 * 높이는 grid-template-rows 0fr↔1fr로 움직인다(내용 높이를 재지 않아도 된다). 투명도가 함께 변한다.
 * 닫힌 동안은 inert + aria-hidden이라 초점도 낭독도 닿지 않는다. 움직임 줄이기에서는 즉시 바뀐다(index.css .fold).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { MS } from '../../design/tokens'
import { useExitAnim } from '../../lib/hooks'

export function Collapse({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const { mounted } = useExitAnim(open, MS.out)
  // 열 때는 한 프레임 접힌 모습을 그린 뒤 펼쳐야 transition이 걸린다. 처음부터 열려 있으면 그대로 연다.
  const [ready, setReady] = useState(open)
  useEffect(() => {
    if (!open) return
    const f = requestAnimationFrame(() => setReady(true))
    return () => { cancelAnimationFrame(f); setReady(false) }
  }, [open])
  if (!mounted) return null
  return (
    <div id={id} className={open && ready ? 'fold fold-open' : 'fold'} inert={!open} aria-hidden={!open}>
      <div className="fold-inner">{children}</div>
    </div>
  )
}
