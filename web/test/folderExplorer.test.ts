/**
 * 폴더 탐색기의 순수 함수 시험.
 *   실행: npx tsx web/test/folderExplorer.test.ts
 */
import { filterEntries, isWideFolder, moveSelection, parentPath, pickTarget, seedFolder, tildeHome } from '../src/components/folderPicker/explorerModel'
import type { FsPlaces } from '../src/lib/types'

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

// filterEntries
const names = [{ name: '한글폴더' }, { name: 'Project' }, { name: 'docs' }]
const nfd = '한글폴더'.normalize('NFD')
eq('NFD 한글 이름이 NFC 검색어에 걸린다', filterEntries([{ name: nfd }, { name: 'docs' }], '한글').map((e) => e.name), [nfd])
eq('NFC 이름이 NFD 검색어에 걸린다', filterEntries(names, '한글'.normalize('NFD')).map((e) => e.name), ['한글폴더'])
eq('대소문자를 가리지 않는다', filterEntries(names, 'PROJ').map((e) => e.name), ['Project'])
eq('검색어가 비면 그대로', filterEntries(names, '  ').length, 3)
eq('맞는 것이 없으면 빈 목록', filterEntries(names, 'zzz'), [])

// moveSelection
const rows = [{}, {}, {}]
eq('처음 아래 키는 첫 줄', moveSelection(rows, -1, 'ArrowDown'), 0)
eq('처음 위 키도 첫 줄', moveSelection(rows, -1, 'ArrowUp'), 0)
eq('아래로 한 줄', moveSelection(rows, 0, 'ArrowDown'), 1)
eq('끝에서 멈춘다', moveSelection(rows, 2, 'ArrowDown'), 2)
eq('맨 위에서 멈춘다', moveSelection(rows, 0, 'ArrowUp'), 0)
eq('Home은 첫 줄', moveSelection(rows, 2, 'Home'), 0)
eq('End는 끝 줄', moveSelection(rows, 0, 'End'), 2)
eq('줄이 없으면 -1', moveSelection([], -1, 'ArrowDown'), -1)

// seedFolder
eq('후보 가운데 첫 것', seedFolder(['/a/b', '/c'], '/home/me'), '/a/b')
eq('후보가 없으면 홈', seedFolder([], '/home/me'), '/home/me')
eq('빈 후보는 건너뛴다', seedFolder(['', '/c'], '/home/me'), '/c')

// isWideFolder
const places: FsPlaces = {
  home: '/Users/me',
  favorites: [{ kind: 'home', name: 'me', path: '/Users/me' }],
  devices: [
    { kind: 'root', name: '/', path: '/' },
    { kind: 'volume', name: 'Disk1', path: '/Volumes/Disk1' },
    { kind: 'drive', name: 'C:', path: 'C:\\' },
  ],
}
eq('홈은 넓다', isWideFolder('/Users/me', places), true)
eq('끝 슬래시가 있어도 홈', isWideFolder('/Users/me/', places), true)
eq('디스크 루트는 넓다', isWideFolder('/Volumes/Disk1', places), true)
eq('드라이브 루트는 넓다', isWideFolder('C:\\', places), true)
eq('`/` 루트는 넓다', isWideFolder('/', places), true)
eq('하위 폴더는 넓지 않다', isWideFolder('/Users/me/work', places), false)
eq('드라이브 아래 폴더는 넓지 않다', isWideFolder('C:\\work', places), false)
eq('빈 경로는 넓지 않다', isWideFolder('', places), false)

// parentPath
eq('유닉스 한 단계 위', parentPath('/a/b'), '/a')
eq('유닉스 최상위 폴더의 위는 루트', parentPath('/a'), '/')
eq('루트의 위는 루트', parentPath('/'), '/')
eq('윈도우 한 단계 위', parentPath('C:\\x\\y'), 'C:\\x')
eq('윈도우 최상위 폴더의 위는 드라이브 루트', parentPath('C:\\x'), 'C:\\')
eq('드라이브 루트의 위는 루트', parentPath('C:\\'), 'C:\\')
eq('끝 구분자가 있어도 같다', parentPath('/a/b/'), '/a')

// pickTarget
eq('선택한 줄이 있으면 그 줄', pickTarget('/a/b', '/a', true), '/a/b')
eq('선택이 없으면 보는 폴더', pickTarget(null, '/a', true), '/a')
eq('목록이 없으면(불러오는 중·실패) 고를 폴더가 없다', pickTarget(null, '/a', false), null)
eq('위치 화면이면 없다', pickTarget(null, null, false), null)

// tildeHome
eq('홈 자체는 ~', tildeHome('/Users/me', '/Users/me'), '~')
eq('홈 아래는 ~로 줄인다', tildeHome('/Users/me/work', '/Users/me'), '~/work')
eq('이름이 비슷한 다른 폴더는 그대로', tildeHome('/Users/meow/x', '/Users/me'), '/Users/meow/x')
eq('홈 밖은 그대로', tildeHome('/tmp', '/Users/me'), '/tmp')
eq('윈도우 홈 아래', tildeHome('C:\\Users\\me\\work', 'C:\\Users\\me'), '~\\work')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
