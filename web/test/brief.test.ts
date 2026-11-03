/**
 * 브리프 전송 쪽 화면 계약: 임시 말풍선 위치(optimisticUserIndex)와 진행 중 판정(opensWorkTurn).
 * 실행: npx tsx web/test/brief.test.ts
 */
import { opensWorkTurn, optimisticUserIndex } from '../src/lib/brief'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++; else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const items = [
  { kind: 'local_user', text: '같은 글', clientMessageId: 'a' },
  { kind: 'local_user', text: '같은 글', clientMessageId: 'b' },
  { kind: 'local_user', text: '식별자 없음' },
]

// 식별자 불일치: 사건에 식별자가 있으면 그 값만 맞춘다. 글자가 같아도 다른 식별자의 말풍선은 지우지 않는다.
check('식별자가 맞으면 그 말풍선', optimisticUserIndex(items, { kind: 'user_msg', text: '같은 글', clientMessageId: 'b' }) === 1)
check('식별자가 어느 것과도 다르면 글자가 같아도 -1', optimisticUserIndex(items, { kind: 'user_msg', text: '같은 글', clientMessageId: 'zzz' }) === -1)

// 옛 사건 글자 대조: 식별자가 없는 옛 사건은 글자가 같은 첫 임시 말풍선을 지운다.
check('식별자 없는 옛 사건은 글자가 같은 첫 말풍선', optimisticUserIndex(items, { kind: 'user_msg', text: '같은 글' }) === 0)
check('식별자가 빈 문자열이면 글자 대조로 간다', optimisticUserIndex(items, { kind: 'user_msg', text: '식별자 없음', clientMessageId: '' }) === 2)
check('글자가 다르면 -1', optimisticUserIndex(items, { kind: 'user_msg', text: '다른 글' }) === -1)
check('임시 말풍선이 아닌 항목은 대조하지 않는다', optimisticUserIndex([{ kind: 'user_msg', text: '같은 글' }], { kind: 'user_msg', text: '같은 글' }) === -1)
check('옛 brief_opened 사건도 글자로 대조한다', optimisticUserIndex(items, { kind: 'brief_opened', text: '식별자 없음' }) === 2)

// briefId 분기: briefId가 있는 user_msg는 전달 식별자라 임시 말을 지우지 않는다. 다른 종류는 아예 건드리지 않는다.
check('briefId가 있는 user_msg는 -1', optimisticUserIndex(items, { kind: 'user_msg', text: '같은 글', briefId: 'brf1' }) === -1)
check('briefId가 있어도 식별자가 맞는 user_msg는 -1', optimisticUserIndex(items, { kind: 'user_msg', text: '같은 글', clientMessageId: 'a', briefId: 'brf1' }) === -1)
check('briefId가 없는 user_msg는 지운다', optimisticUserIndex(items, { kind: 'user_msg', text: '같은 글', clientMessageId: 'a' }) === 0)
check('브리프 갱신 같은 다른 종류는 -1', optimisticUserIndex(items, { kind: 'brief_updated', text: '같은 글' }) === -1)

// 진행 중 판정
check('임시 말풍선은 턴을 연다', opensWorkTurn({ kind: 'local_user' }))
check('user_msg는 턴을 연다', opensWorkTurn({ kind: 'user_msg' }))
check('알림·옛 브리프 사건은 턴을 열지 않는다', !opensWorkTurn({ kind: 'local_notice' }) && !opensWorkTurn({ kind: 'brief_opened' }) && !opensWorkTurn({ kind: 'brief_updated' }))
check('정리된 사건에 user_text가 있으면 턴을 연다', opensWorkTurn({ kind: 'sdk', events: [{ type: 'text' }, { type: 'user_text' }] }))
check('user_text가 없거나 events가 없으면 열지 않는다', !opensWorkTurn({ kind: 'sdk', events: [{ type: 'text' }] }) && !opensWorkTurn({ kind: 'sdk', events: null }) && !opensWorkTurn({ kind: 'sdk' }))

console.log(`\n${fail === 0 ? '✅' : '❌'} brief: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
