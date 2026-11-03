// 메뉴에 들어가는 「다음 작업으로 넘기기」 묶음 — 작업 메뉴(WorkMenu)와 칸 머리 메뉴(PaneMenu)가 같이 쓴다.
//   항목 상태는 lib/handoff.ts가 정한다. 막힌 이유는 보관 항목처럼 항목 바로 밑에 글로 보인다.
import { useId } from 'react'
import { actions, useStore } from '../lib/store'
import { handoffMenuState } from '../lib/handoff'
import { executionId, findRoom, roomIdForExecution } from '../lib/workspaceRooms'
import { useT } from '../lib/i18n'
import { C } from '../design/tokens'
import { MenuItem } from './WorkMenu'

/** id는 방 id 또는 서버 실행 id. close는 항목을 누르면 메뉴를 닫는 함수다. */
export function HandoffMenuItems({ id, close }: { id: string; close: () => void }) {
  const t = useT()
  const s = useStore()
  const noteId = useId()
  const room = findRoom(s.rooms, id) ?? s.rooms.find((r) => executionId(r) === id)
  const execId = executionId(room)
  if (!room || !execId) return null
  const state = handoffMenuState(room)
  const go = (fn: () => void) => () => {
    close()
    fn()
  }
  const open = (other: string) => go(() => actions.selectSession(roomIdForExecution(s.rooms, other)))
  const blocked = state.kind === 'blocked'
  return (
    <>
      {state.kind !== 'hidden' && (
        <>
          <MenuItem data-session-opt="handoff" disabled={blocked} aria-describedby={blocked ? noteId : undefined} onClick={go(() => actions.openHandoff(execId))}>
            {t('handoff.menu.item')}
          </MenuItem>
          {state.kind === 'blocked' && (
            <span id={noteId} style={{ padding: '0 10px 4px', fontSize: 12, color: C.label3 }}>
              {t(state.reason === 'busy' ? 'handoff.menu.busy' : 'handoff.menu.inProgress')}
            </span>
          )}
          {room.handoffState === 'copy_ready' && (
            <MenuItem data-session-opt="handoff-result" onClick={go(() => actions.openHandoffResult(execId))}>
              {t('handoff.menu.showResult')}
            </MenuItem>
          )}
        </>
      )}
      {room.handoffFrom && (
        <MenuItem data-session-opt="handoff-open-prev" onClick={open(room.handoffFrom)}>
          {t('handoff.menu.openPrev')}
        </MenuItem>
      )}
      {room.handoffTo && (
        <MenuItem data-session-opt="handoff-open-next" onClick={open(room.handoffTo)}>
          {t('handoff.menu.openNext')}
        </MenuItem>
      )}
    </>
  )
}
