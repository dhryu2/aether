import { executionId, executionIdFor, isRoomId, roomIdForExecution } from '../src/lib/workspaceRooms'
import type { WorkspaceRoom } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

const rooms: WorkspaceRoom[] = [
  { id: 'dm:a', kind: 'dm', title: 'A', sourceSessionId: 'a', status: 'active' },
]

check('dm executionId', executionId(rooms[0]) === 'a')

// [회귀] 방 id를 서버에 그대로 보내면 "세션 없음"이 난다 — 서버 호출 전에 실행 id로 바꾼다.
check('방 id → 실행 id (dm)', executionIdFor(rooms, 'dm:a') === 'a')
check('실행 id는 그대로', executionIdFor(rooms, 'a') === 'a')
check('없는 값은 null', executionIdFor(rooms, null) === null)
check('실행 id → 방 id (dm)', roomIdForExecution(rooms, 'a') === 'dm:a')
check('모르는 실행 id는 그대로', roomIdForExecution(rooms, 'zzz') === 'zzz')

check('dm: ok', isRoomId('dm:fixture-claude'))
check('접두 없는 uuid 거부', !isRoomId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'))

console.log(`\n${fail === 0 ? '✅' : '❌'} workspaceRooms: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
