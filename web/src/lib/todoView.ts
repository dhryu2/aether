import { latestTodoOf, todoCounts, type TodoView } from './agentEvents'
import type { State } from './store'

/**
 * 이 세션의 보여 줄 할 일 목록. 초기 재생 중에는 숫자가 오르내리므로 없는 것으로 본다.
 * 다 끝난 목록은 그 턴까지만 보인다. 남겨 두면 새 작업을 하는 동안에도 낡은 "4/4"가 떠 있다.
 */
export function todoViewOf(s: State, sessionId: string | null | undefined): TodoView | null {
  if (!sessionId || s.loadingConvo[sessionId]) return null
  const view = latestTodoOf(s.convos[sessionId])
  return view && !view.inLatestTurn && todoCounts(view.items).left === 0 ? null : view
}
