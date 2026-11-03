/**
 * 사이드바 검색·상태 점·접힘 영속.
 *   실행: npx tsx web/test/sidebarQuery.test.ts
 */
import {
  attentionDotKinds,
  countAttentions,
  formatAttentionTitle,
  parseOpenSet,
  serializeOpenSet,
  sessionMatchesQuery,
  toggleSet,
} from '../src/lib/sidebarQuery'
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

const untitled = '새 작업'
const titled = sess({ id: 'a', displayName: '세션탭 밀도 개선', preview: 'Hello Preview', attentionPreview: '권한을 묻는다' })

check('빈 쿼리는 전부 통과', sessionMatchesQuery(titled, '', untitled))
check('공백만 있는 쿼리도 전부 통과', sessionMatchesQuery(titled, '   ', untitled))
check('제목 대소문자 무시', sessionMatchesQuery(titled, '  밀도 ', untitled))
check('제목 영어 대소문자 무시', sessionMatchesQuery(sess({ id: 'b', displayName: 'Sidebar Density' }), 'sidebar', untitled))
check('미리보기 매칭', sessionMatchesQuery(titled, 'hello preview', untitled))
check('주의 미리보기 매칭', sessionMatchesQuery(titled, '권한을', untitled))
check('안 맞는 말은 탈락', !sessionMatchesQuery(titled, '없는말', untitled))
check('빈 제목은 untitled로 매칭', sessionMatchesQuery(sess({ id: 'c', displayName: '' }), '새 작업', untitled))
check('검색은 필터를 모름(대기 세션도 제목만 봄)', sessionMatchesQuery(sess({
  id: 'd',
  displayName: '대기 중',
  attention: 'waiting',
}), '대기', untitled))

const counts = countAttentions([
  sess({ id: 'w', attention: 'waiting' }),
  sess({ id: 'w2', attention: 'waiting' }),
  sess({ id: 'f', attention: 'failed' }),
  sess({ id: 'r', attention: 'running' }),
  sess({ id: 'd', attention: 'done' }),
  sess({ id: 'i', attention: 'idle' }),
  sess({ id: 'n' }),
])
eq('idle과 빈 칸은 안 센다', counts, { waiting: 2, failed: 1, running: 1, done: 1 })
eq('백그라운드 작업 중은 일하는 중으로 센다', countAttentions([sess({ id: 'b', attention: 'background' }), sess({ id: 'r', attention: 'running' })]).running, 2)
eq('점 순서는 대기·실패·일함·끝남', attentionDotKinds(counts), ['waiting', 'failed', 'running', 'done'])
eq('없는 종류는 점 목록에서 빠진다', attentionDotKinds({ waiting: 1, failed: 0, running: 0, done: 2 }), ['waiting', 'done'])
eq(
  '점 title 조합',
  formatAttentionTitle(counts, (kind, n) => `${kind}:${n}`),
  'waiting:2 · failed:1 · running:1 · done:1',
)

eq('잘못된 JSON은 빈 Set', [...parseOpenSet('{nope')], [])
eq('배열이 아니면 빈 Set', [...parseOpenSet('{"a":1}')], [])
eq('null은 빈 Set', [...parseOpenSet(null)], [])
eq('문자만 남긴다', [...parseOpenSet('["/a",1,null,"/b"]')], ['/a', '/b'])
eq('직렬화 왕복', [...parseOpenSet(serializeOpenSet(new Set(['/a', '/b'])))], ['/a', '/b'])
eq('토글 추가', [...toggleSet(new Set(['/a']), '/b')].sort(), ['/a', '/b'])
eq('토글 제거', [...toggleSet(new Set(['/a', '/b']), '/a')], ['/b'])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
