import { MS } from '../design/tokens'

/**
 * 창이 닫힐 때의 잔상. 창은 열림 상태가 꺼지는 즉시 React 트리에서 빠지고, 같은 순간 내용(지울 대상·대화상자 문구)도
 * 스토어에서 사라진다. 그래서 창마다 닫힘을 기다리게 고치는 대신, 빠지기 직전 모습을 복사해 같은 자리에 두고
 * 그것만 흐리게 치운다(index.css .modal-ghost, 떠 있는 목록은 .popover-ghost). 복사본은 누를 수 없고 화면 낭독기도 읽지 않는다.
 * 개발 모드(StrictMode)는 열자마자 정리 함수를 한 번 더 부른다. 그때는 원본이 그대로 붙어 있으므로 복사본을 버린다.
 */
export function leaveGhost(node: HTMLElement, ghostClass: string) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const parent = node.parentNode
  if (!parent) return
  const ghost = node.cloneNode(true) as HTMLElement
  // 입력값·체크·스크롤 위치는 복사되지 않으므로 원본에서 옮겨 적는다. 스크롤은 문서에 붙은 뒤에만 먹힌다.
  const src = node.querySelectorAll<HTMLElement>('*')
  const dst = ghost.querySelectorAll<HTMLElement>('*')
  const scrolls: [HTMLElement, number][] = []
  src.forEach((el, i) => {
    const g = dst[i]
    if (el instanceof HTMLInputElement) {
      ;(g as HTMLInputElement).value = el.value
      ;(g as HTMLInputElement).checked = el.checked
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      ;(g as HTMLTextAreaElement | HTMLSelectElement).value = el.value
    }
    if (el.scrollTop) scrolls.push([g, el.scrollTop])
  })
  ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
  ghost.removeAttribute('id')
  // 화면 전환 중에 닫히면 전환 이름까지 복사된다. 이름이 겹치면 다음 전환이 건너뛰어진다.
  ghost.querySelectorAll<HTMLElement>('[style*="view-transition-name"]').forEach((el) => { el.style.viewTransitionName = '' })
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  ghost.classList.remove('scrim-in')
  ghost.classList.add(ghostClass)
  queueMicrotask(() => {
    if (node.isConnected) return
    parent.appendChild(ghost)
    for (const [el, top] of scrolls) el.scrollTop = top
    window.setTimeout(() => ghost.remove(), MS.out)
  })
}
