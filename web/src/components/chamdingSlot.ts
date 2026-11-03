// 움직이는 참딩은 한 화면에 하나. 원하는 쪽 가운데 우선순위가 가장 높고, 같으면 먼저 요청한 쪽만 참.
//   재로그인 창 3 > 브레인 창·로딩 덮개 2 > 대화 진행 줄 1 > 빈 세션·고른 세션 없음 0.
//   컴포넌트 파일에서 훅을 내보내면 린트가 막아서 여기 둔다.
import { useEffect, useState, useSyncExternalStore } from 'react'

type Claim = { id: symbol; priority: number; at: number }

const claims: Claim[] = []
let order = 0
const listeners = new Set<() => void>()

function winner(): symbol | null {
  let best: Claim | null = null
  for (const c of claims) {
    if (!best || c.priority > best.priority || (c.priority === best.priority && c.at < best.at)) best = c
  }
  return best?.id ?? null
}

function publish() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** `want`인 동안 슬롯을 다툰다. 이기면 참. 지면 호출자가 정지 자세나 점으로 그린다. */
export function useChamdingSlot(want: boolean, priority = 0): boolean {
  const [me] = useState(() => Symbol())
  useEffect(() => {
    if (!want) return
    const claim: Claim = { id: me, priority, at: ++order }
    claims.push(claim)
    publish()
    return () => {
      const i = claims.findIndex((c) => c.id === me)
      if (i !== -1) claims.splice(i, 1)
      publish()
    }
  }, [want, priority, me])
  return useSyncExternalStore(subscribe, () => winner() === me)
}
