/** 검토함 계산 시험. 실행: npx tsx web/test/review.test.ts */
import type { ReviewRow } from '@shared/brain'
import { displayPath, flatReview, groupReview, nextAfterDone, rowSubtitle, stepReview } from '../src/lib/review'

let fail = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) fail++
}

const row = (id: string, at: number, extra: Partial<ReviewRow> = {}): ReviewRow => ({
  id, title: id, projectPath: '/w/app', projectName: 'app', cwd: '/w/app', lastActivityAt: at, lastSeq: 1, partial: false,
  fileCount: 1, failureCount: 0, todoCount: 0, needsAttention: false, ...extra,
})
const rows = [
  row('old-fail', 10, { needsAttention: true, failureCount: 1 }),
  row('new-change', 50),
  row('new-todo', 40, { needsAttention: true, todoCount: 2 }),
  row('old-change', 5),
]
const g = groupReview(rows)
const ids = (list: ReviewRow[]) => list.map((r) => r.id).join(',')

check('먼저 볼 것은 최신순', ids(g.attention) === 'new-todo,old-fail')
check('변경만 있음은 최신순', ids(g.changes) === 'new-change,old-change')
check('한 줄 목록은 먼저 볼 것이 위', ids(flatReview(g)) === 'new-todo,old-fail,new-change,old-change')
check('원본 순서 유지', rows[0].id === 'old-fail')
check('빈 묶음', groupReview([]).attention.length === 0)

const flat = flatReview(g)
check('아래로 이동', stepReview(flat, 'new-todo', 1) === 'old-fail')
check('끝에서 멈춘다', stepReview(flat, 'old-change', 1) === 'old-change')
check('처음에서 멈춘다', stepReview(flat, 'new-todo', -1) === 'new-todo')
check('고른 행이 없으면 첫 행', stepReview(flat, null, 1) === 'new-todo')
check('행이 없으면 null', stepReview([], 'x', 1) === null)

check('완료 뒤 아래 행', nextAfterDone(flat, 'old-fail') === 'new-change')
check('마지막 행이면 위 행', nextAfterDone(flat, 'old-change') === 'new-change')
check('하나뿐이면 null', nextAfterDone([flat[0]], flat[0].id) === null)

const t = (key: string, p?: Record<string, string | number>) => `${key.split('.').pop()}:${p?.n}`
check('0인 값은 뺀다', rowSubtitle(row('a', 1, { fileCount: 3, failureCount: 0, todoCount: 2 }), t) === 'app · files:3 · todos:2')
check('중단된 턴은 글자로 알린다', rowSubtitle(row('a', 1, { fileCount: 0, turnFailed: 'interrupted' }), t) === 'app · turnInterruptedShort:undefined')
check('프로젝트만', rowSubtitle(row('a', 1, { fileCount: 0 }), t) === 'app')

check('프로젝트 안은 상대 경로', displayPath('/w/app/src/a.ts', '/w/app') === 'src/a.ts')
check('프로젝트 밖은 그대로', displayPath('/etc/hosts', '/w/app') === '/etc/hosts')
check('이름만 비슷한 폴더는 줄이지 않는다', displayPath('/w/app2/a.ts', '/w/app') === '/w/app2/a.ts')

process.exit(fail ? 1 : 0)
