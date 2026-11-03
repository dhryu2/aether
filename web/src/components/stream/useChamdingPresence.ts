// 대화 칸 참딩의 마운트·국면 시계. effect 안에서 setState를 부르지 않으려고 저장소를 컴포넌트 밖에 둔다.
//   입력은 타이머보다 먼저 반영되고, 타이머는 항상 하나다. 입력이 바뀌면 이전 타이머를 지우고 다시 건다.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { INITIAL_PRESENCE, nextWake, stepPresence, tickPresence, type Presence } from '../../lib/chamdingPresence'
import type { ChamdingPhase } from '../../lib/types'

type Store = {
  get: () => Presence
  subscribe: (l: () => void) => () => void
  input: (sessionId: string, active: boolean, phase: ChamdingPhase, turnKey: string | null) => void
  dispose: () => void
}

function createPresenceStore(): Store {
  let presence = INITIAL_PRESENCE
  let sessionId: string | null = null
  let timer: number | null = null
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const l of listeners) l()
  }
  const clearTimer = () => {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
  // 아직 안 온 기한이 있으면 그 시각에 한 번만 깨운다. 깨운 뒤 다음 기한을 다시 잡는다.
  const arm = () => {
    clearTimer()
    const now = Date.now()
    const wake = nextWake(presence, now)
    if (wake == null) return
    timer = window.setTimeout(() => {
      timer = null
      presence = tickPresence(presence, Date.now())
      emit()
      arm()
    }, Math.max(0, wake - now))
  }

  return {
    get: () => presence,
    subscribe: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    input: (sid, active, phase, turnKey) => {
      // 세션이 바뀌면 이전 턴의 마무리를 들고 가지 않는다.
      if (sid !== sessionId) {
        sessionId = sid
        presence = INITIAL_PRESENCE
      }
      presence = stepPresence(presence, { active, phase, turnKey }, Date.now())
      clearTimer()
      arm()
      emit()
    },
    dispose: clearTimer,
  }
}

/**
 * 이 세션의 참딩을 붙잡을지, 어떤 국면으로 보일지.
 * 세션 id가 바뀌면 처음 상태로 되돌린 뒤 그 세션의 입력을 적용한다.
 */
export function useChamdingPresence(sessionId: string, active: boolean, phase: ChamdingPhase, turnKey: string | null): Presence {
  const [store] = useState(createPresenceStore)
  useEffect(() => {
    store.input(sessionId, active, phase, turnKey)
    // StrictMode는 effect를 두 번 돌린다. 타이머만 지우고 저장소의 값은 이어서 쓴다.
    return () => store.dispose()
  }, [store, sessionId, active, phase, turnKey])
  return useSyncExternalStore(store.subscribe, store.get)
}
