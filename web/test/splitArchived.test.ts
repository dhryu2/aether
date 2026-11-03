/**
 * 보관된 방을 일반 목록에서 빼고 보관됨 목록을 최신 보관 순으로 만드는 규칙.
 *   실행: npx tsx web/test/splitArchived.test.ts
 */
import { groupRoomsByProject, splitArchived } from '../src/lib/sessionGroups'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${JSON.stringify({ got, want })}`}`)
}

const rooms = [
  { id: 'a', kind: 'dm', cwd: '/p/x' },
  { id: 'b', kind: 'dm', cwd: '/p/x', archivedAt: 100 },
  { id: 'c', kind: 'dm', cwd: '/p/y', archivedAt: 300 },
  { id: 'd', kind: 'dm', cwd: '/p/y', archivedAt: 200 },
]
const { active, archived } = splitArchived(rooms)
eq('보관 안 된 방만 일반 목록에 남는다', active.map((r) => r.id), ['a'])
eq('보관됨은 보관 시각 내림차순', archived.map((r) => r.id), ['c', 'd', 'b'])
eq('원본 순서는 그대로', rooms.map((r) => r.id), ['a', 'b', 'c', 'd'])
eq('프로젝트 묶음에 보관 방이 없다', groupRoomsByProject(active, []).flatMap((g) => g.rooms.map((r) => r.id)), ['a'])
eq('빈 입력', splitArchived([]), { active: [], archived: [] })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
