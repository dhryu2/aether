/** 검색 팝업의 최근 세션 고르기와 위아래 이동 계산 시험. 실행: npx tsx web/test/searchPalette.test.ts */
import { recentRooms, stepActive } from '../src/lib/searchPalette'
import type { WorkspaceRoom } from '../src/lib/types'

let fail = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) fail++
}

const room = (id: string, extra: Partial<WorkspaceRoom> = {}) => ({ id, ...extra }) as WorkspaceRoom

const rooms = [
  room('old', { lastActivityAt: 10 }),
  room('input', { lastInputAt: 50, lastActivityAt: 5 }),
  room('arch', { lastInputAt: 99, archivedAt: 1 }),
  room('none'),
  room('mid', { lastActivityAt: 30 }),
]
const ids = (list: WorkspaceRoom[]) => list.map((r) => r.id).join(',')

check('보관 세션을 빼고 최신순', ids(recentRooms(rooms)) === 'input,mid,old,none')
check('limit 적용', ids(recentRooms(rooms, 2)) === 'input,mid')
check('기본 한도 8', recentRooms(Array.from({ length: 12 }, (_, i) => room(`r${i}`, { lastInputAt: i }))).length === 8)
check('원본 순서 유지', rooms[0].id === 'old')

check('아래로 이동', stepActive(0, 1, 3) === 1)
check('끝에서 처음으로', stepActive(2, 1, 3) === 0)
check('처음에서 위로 끝으로', stepActive(0, -1, 3) === 2)
check('행이 없으면 -1', stepActive(0, 1, 0) === -1)

process.exit(fail ? 1 : 0)
