// 마지막 답변 아래의 「다음 작업으로 넘기기」. 사용자는 답을 읽은 바로 그 자리에서 다음 세션을 정하므로 여기에 둔다.
//   모든 턴에 붙으면 소음이라 lib/handoff.ts의 lastAnswerIndex가 고른 답변 하나에만 그린다.
//   지금 넘길 수 없는 세션에서는 숨긴다. 막힌 이유는 세션 메뉴의 같은 항목이 글로 보여 준다.
import { ArrowRight } from 'lucide-react'
import { actions, useStore } from '../../lib/store'
import { handoffMenuState } from '../../lib/handoff'
import { executionId, findRoom } from '../../lib/workspaceRooms'
import { useT } from '../../lib/i18n'

export function ResponseHandoff({ sessionId }: { sessionId: string }) {
  const t = useT()
  const s = useStore()
  const room = findRoom(s.rooms, sessionId) ?? s.rooms.find((r) => executionId(r) === sessionId)
  const execId = executionId(room)
  if (!room || !execId || handoffMenuState(room).kind !== 'ready') return null
  return (
    <button type="button" className="response-handoff-btn press hit-44" onClick={() => actions.openHandoff(execId)}>
      <ArrowRight size={14} aria-hidden="true" />
      {t('handoff.menu.item')}
    </button>
  )
}
