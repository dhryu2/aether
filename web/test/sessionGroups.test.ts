/**
 * 세션을 프로젝트(작업 폴더)로 묶는 규칙.
 *   실행: npx tsx web/test/sessionGroups.test.ts
 */
import {
  UNKNOWN_PROJECT_KEY,
  folderName,
  disambiguateFolderTitles,
  groupRoomsByProject,
  groupSessions,
  normalizeFolder,
  projectKey,
  recentFolders,
  splitIsolatedBuckets,
} from '../src/lib/sessionGroups'
import type { SessionListItem } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want })
}

function sess(partial: Partial<SessionListItem> & { id: string }): SessionListItem {
  return {
    cwd: '/x',
    displayName: partial.id,
    provider: 'claude',
    model: '',
    permissionMode: 'manual',
    status: 'active',
    createdAt: 0,
    ...partial,
  }
}

eq('끝 슬래시를 걷는다', normalizeFolder('/a/b/'), '/a/b')
eq('루트는 그대로', normalizeFolder('/'), '/')
eq('빈 값은 빈 열쇠', normalizeFolder('  '), UNKNOWN_PROJECT_KEY)
eq('폴더 마지막 이름', folderName('/Users/me/aether'), 'aether')
eq('루트 이름은 슬래시', folderName('/'), '/')
eq('윈도우 경로도 마지막 이름', folderName('D:\\work\\app'), 'app')
eq('윈도우 드라이브 루트는 그대로', folderName('C:\\'), 'C:\\')
eq('섞인 구분자는 더 뒤의 것 기준', folderName('C:\\work/app'), 'app')

const isolated = sess({
  id: 'iso',
  cwd: '/tmp/aether-wt/iso',
  workspaceSource: '/Users/me/aether',
  isolated: true,
})
eq('분리 세션은 원래 고른 폴더로 묶인다', projectKey(isolated), '/Users/me/aether')
eq('분리 안 한 세션은 cwd', projectKey(sess({ id: 'n', cwd: '/Users/me/aether' })), '/Users/me/aether')

const input = [
  sess({ id: 'old', cwd: '/repo/aether', lastActivityAt: 10, displayName: 'old' }),
  sess({ id: 'new', cwd: '/repo/aether', lastActivityAt: 30, displayName: 'new' }),
  sess({ id: 'iso', cwd: '/tmp/wt', workspaceSource: '/repo/aether/', isolated: true, lastActivityAt: 20, displayName: 'iso' }),
  sess({ id: 'other', cwd: '/repo/other-repo', lastActivityAt: 40, displayName: 'other' }),
  sess({ id: 'web', cwd: '/repo/aether/web', lastActivityAt: 50, displayName: 'web' }),
  sess({ id: 'web2', cwd: '/other/web', lastActivityAt: 5, displayName: 'web2' }),
  sess({ id: 'ghost', cwd: '', lastActivityAt: 1, displayName: 'ghost' }),
]
const frozen = input.map((s) => ({ ...s }))
const groups = groupSessions(input)

eq('원본 배열을 바꾸지 않는다', input, frozen)
eq('그룹 열쇠 순서', groups.map((g) => g.key), [
  '/repo/aether/web',
  '/repo/other-repo',
  '/repo/aether',
  '/other/web',
  '',
])
eq('프로젝트 순서는 그 안 가장 최근 활동', groups.map((g) => g.label), ['web', 'other-repo', 'aether', 'web', ''])
eq('aether 안은 최근 활동 순(분리 세션 포함)', groups.find((g) => g.key === '/repo/aether')?.sessions.map((s) => s.id), [
  'new',
  'iso',
  'old',
])
eq('이름만 같고 경로가 다르면 다른 프로젝트', groups.filter((g) => g.label === 'web').map((g) => g.key), [
  '/repo/aether/web',
  '/other/web',
])
eq('세션 하나여도 그룹이 생긴다', groups.find((g) => g.key === '/repo/other-repo')?.sessions.length, 1)
eq('경로 없는 세션은 한 그룹', groups.find((g) => g.key === '')?.sessions.map((s) => s.id), ['ghost'])

const single = groupSessions([sess({ id: 'only', cwd: '/solo' })])
eq('목록에 하나여도 헤더용 그룹 1개', single.length, 1)
eq('하나짜리 그룹의 세션 id', single[0].sessions[0].id, 'only')

eq('원본만이면 하위 단 없음', splitIsolatedBuckets([
  sess({ id: 'a', cwd: '/repo/aether' }),
  sess({ id: 'b', cwd: '/repo/aether', isolated: false }),
]), null)
eq('복사본만이면 하위 단 없음', splitIsolatedBuckets([
  sess({ id: 'c', cwd: '/tmp/wt', workspaceSource: '/repo/aether', isolated: true }),
  sess({ id: 'd', cwd: '/tmp/wt2', workspaceSource: '/repo/aether', isolated: true }),
]), null)

const mixed = splitIsolatedBuckets([
  sess({ id: 'old-src', cwd: '/repo/aether', lastActivityAt: 10, displayName: 'old-src' }),
  sess({ id: 'new-src', cwd: '/repo/aether', lastActivityAt: 30, displayName: 'new-src' }),
  sess({ id: 'old-copy', cwd: '/tmp/wt', workspaceSource: '/repo/aether', isolated: true, lastActivityAt: 5, displayName: 'old-copy' }),
  sess({ id: 'new-copy', cwd: '/tmp/wt2', workspaceSource: '/repo/aether', isolated: true, lastActivityAt: 40, displayName: 'new-copy' }),
])
eq('섞이면 원 폴더가 먼저', mixed?.map((b) => b.kind), ['source', 'copy'])
eq('원 폴더 칸은 sortSessions 순서', mixed?.[0].sessions.map((s) => s.id), ['new-src', 'old-src'])
eq('복사본 칸은 sortSessions 순서', mixed?.[1].sessions.map((s) => s.id), ['new-copy', 'old-copy'])

const rooms = [
  { id: 'dm:copy', kind: 'dm', sourceSessionId: 'copy', cwd: '/tmp/copy', lastActivityAt: 50 },
  { id: 'dm:web', kind: 'dm', sourceSessionId: 'web', cwd: '/repo/aether/web', lastActivityAt: 300 },
  { id: 'dm:other', kind: 'dm', sourceSessionId: 'other', cwd: '/repo/other/web', lastActivityAt: 200 },
]
const roomSessions = [
  sess({ id: 'copy', cwd: '/tmp/copy', workspaceSource: '/repo/aether', displayName: 'copy', lastActivityAt: 50 }),
  sess({ id: 'web', cwd: '/repo/aether/web', displayName: 'web', lastActivityAt: 300 }),
  sess({ id: 'other', cwd: '/repo/other/web', displayName: 'other', lastActivityAt: 200 }),
]
const groupedRooms = groupRoomsByProject(rooms, roomSessions)
check('복사본은 원래 고른 폴더로 묶인다', groupedRooms.some((g) => g.key === '/repo/aether' && g.rooms.some((r) => r.id === 'dm:copy')))
const webTitles = disambiguateFolderTitles(['/repo/aether/web', '/repo/other/web'])
eq('같은 폴더 이름은 부모를 붙인다', webTitles.get('/repo/aether/web'), 'aether/web')
eq('다른 부모도 붙인다', webTitles.get('/repo/other/web'), 'other/web')
eq('묶음 머리는 갈라진 이름', groupedRooms.find((g) => g.key === '/repo/aether/web')?.title, 'aether/web')
eq('묶음은 최근 활동 순', groupedRooms[0]?.key, '/repo/aether/web')

const recentSessions = [
  sess({ id: 'r1', cwd: '/Volumes/Disk1/Projects/aether', lastActivityAt: 100 }),
  sess({ id: 'r2', cwd: '/Volumes/Disk1/Projects/aether/web', lastActivityAt: 400 }),
  sess({ id: 'r3', cwd: '/tmp/copy', workspaceSource: '/Volumes/Disk1/Projects/nexus', isolated: true, lastActivityAt: 300 }),
  sess({ id: 'r4', cwd: '/Volumes/Disk1', lastActivityAt: 500 }),
  sess({ id: 'r5', cwd: '/elsewhere/x', lastActivityAt: 600 }),
  sess({ id: 'r8', cwd: '', lastActivityAt: 700 }),
  sess({ id: 'r6', cwd: '/Volumes/Disk1/Projects/aether', lastActivityAt: 50 }),
  sess({ id: 'r7', cwd: '/Volumes/Disk1/Projects/voca', lastActivityAt: 20 }),
]
eq('최근 폴더는 절대 경로를 활동 순으로, 빈 경로만 뺀다', recentFolders(recentSessions, 5), ['/elsewhere/x', '/Volumes/Disk1', '/Volumes/Disk1/Projects/aether/web', '/Volumes/Disk1/Projects/nexus', '/Volumes/Disk1/Projects/aether'])
eq('최근 폴더 개수 상한', recentFolders(recentSessions, 2), ['/elsewhere/x', '/Volumes/Disk1'])
eq('세션이 없으면 비어 있다', recentFolders([], 4), [])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
