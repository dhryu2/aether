/**
 * 할 일 목록 읽기 테스트. 실행: npx tsx web/test/todoList.test.ts
 * 가장 나중 목록 고르기, 하위 작업 무시, 빈 목록 null, 옛 서버 모양 견디기, 사용자 입력 뒤 갱신 여부, 수 계산.
 */
import { latestTodoOf, todoCounts } from '../src/lib/agentEvents'
import { todoViewOf } from '../src/lib/todoView'
import type { State } from '../src/lib/store'
import type { AgentEvent } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

type Ev = { seq: number; ts: number; kind: string; events?: AgentEvent[] }
const base = { provider: 'x', part: 0, ts: 1 }
const plan = (seq: number, items: unknown, extra: Record<string, unknown> = {}): Ev => ({
  seq, ts: seq, kind: 'agent', events: [{ ...base, seq, type: 'plan_update', items, ...extra } as unknown as AgentEvent],
})
const user = (seq: number): Ev => ({ seq, ts: seq, kind: 'user_msg' })
const A = [{ text: '읽기', status: 'completed' }, { text: '고치기', status: 'in_progress' }, { text: '배포', status: 'pending' }]

check('목록이 없으면 null', latestTodoOf([user(1)]) === null)
check('undefined도 안전', latestTodoOf(undefined) === null)

const latest = latestTodoOf([plan(2, [{ text: '옛것', status: 'pending' }]), plan(5, A)])
check('가장 나중 목록을 고른다', latest?.seq === 5 && latest.items.length === 3, latest)

check('빈 목록은 null(지움)', latestTodoOf([plan(2, A), plan(4, [])]) === null)

const sub = plan(7, [{ text: '하위', status: 'pending' }], { subtaskOf: 'task-1' })
check('하위 작업 안의 목록은 무시한다', latestTodoOf([plan(3, A), sub])?.seq === 3)

check('옛 서버 모양(글만 있는 plan_update)은 무시하고 더 앞을 찾는다', latestTodoOf([plan(3, A), plan(8, undefined, { text: '1. 확인' })])?.seq === 3)
check('items가 배열이 아니면 깨지지 않고 null', latestTodoOf([plan(8, 'x')]) === null)

check('사용자 입력 뒤 갱신이면 inLatestTurn', latestTodoOf([user(1), plan(2, A)])?.inLatestTurn === true)
check('사용자 입력 앞 목록이면 inLatestTurn 아님', latestTodoOf([plan(2, A), user(3)])?.inLatestTurn === false)
check('낙관적 로컬 입력도 사용자 입력으로 센다', latestTodoOf([plan(2, A), { seq: 3, ts: 3, kind: 'local_user' }])?.inLatestTurn === false)

const dirty = latestTodoOf([plan(2, [{ text: ' ', status: 'pending' }, { text: '값', status: 'weird' }, null])])
check('빈 글 항목은 빠지고 모르는 상태는 대기로 본다', dirty?.items.length === 1 && dirty.items[0].status === 'pending', dirty)

const c = todoCounts(A as never)
check('완료·전체·남은 수', c.done === 1 && c.total === 3 && c.left === 2, c)

const Done = [{ text: '끝', status: 'completed' }]
const viewOf = (items: Ev[]) => todoViewOf({ loadingConvo: {}, convos: { s: items } } as unknown as State, 's')
check('끝난 목록은 그 턴에는 보인다', viewOf([user(1), plan(2, Done)])?.seq === 2)
check('끝난 목록은 다음 입력 뒤 숨는다', viewOf([plan(2, Done), user(3)]) === null)
check('안 끝난 목록은 다음 입력 뒤에도 남는다', viewOf([plan(2, A), user(3)])?.seq === 2)

console.log(`\n${fail === 0 ? '✅' : '❌'} todoList: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
