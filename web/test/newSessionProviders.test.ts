/**
 * 새 작업 창의 서비스 선택 규칙.
 *   실행: npx tsx web/test/newSessionProviders.test.ts
 */
import { newSessionProviderView } from '../src/lib/newSessionProviders'
import type { ProviderInfo } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const mk = (id: string): ProviderInfo => ({ id, displayName: id.toUpperCase(), authSupported: true })
const list = [mk('a'), mk('b'), mk('c')]
const down = { available: false, reason: 'logged_out' } as const

{
  const v = newSessionProviderView(list, 'failed', 'b')
  check('확인 실패: checkFailed이고 원하는 서비스가 골라진다', v.notice === 'checkFailed' && v.chosen?.id === 'b' && v.usable.length === 3, v)
}
{
  const v = newSessionProviderView(list, { a: down, b: down, c: down }, 'b')
  check('모두 불가: noProvider이고 chosen 없음', v.notice === 'noProvider' && v.chosen === undefined && v.usable.length === 0, v)
}
{
  const v = newSessionProviderView(list, { a: down, b: down, c: { available: true } }, 'b')
  check('하나만 가능하고 원하는 것은 불가: 그 하나가 골라진다', v.chosen?.id === 'c' && v.notice === 'none', v)
}
{
  const v = newSessionProviderView(list, { a: { available: true }, b: { available: true }, c: { available: true } }, 'b')
  check('원하는 것이 가능하면 그것이 골라진다', v.chosen?.id === 'b' && v.notice === 'none', v)
}
{
  const v = newSessionProviderView([], {}, 'a', 'loading')
  check('목록을 받는 중이면 listLoading이고 chosen 없음(시작 막힘)', v.notice === 'listLoading' && v.chosen === undefined, v)
  check('목록 받기 실패면 noList', newSessionProviderView([], {}, 'a', 'failed').notice === 'noList')
  check('목록이 있으면 받는 중 상태는 무시된다', newSessionProviderView(list, null, 'a', 'loading').notice === 'none')
}
{
  check('목록이 null이면 noList', newSessionProviderView(null, {}, 'a').notice === 'noList')
  const v = newSessionProviderView([], {}, 'a')
  check('목록이 빈 배열이면 noList이고 chosen 없음', v.notice === 'noList' && v.chosen === undefined, v)
}
{
  const v = newSessionProviderView(list, null, 'b')
  check('가용성 받는 중: none이고 원하는 것이 골라진다', v.notice === 'none' && v.chosen?.id === 'b' && v.usable.length === 3, v)
}
{
  const v = newSessionProviderView(list, { a: { available: false, reason: 'not_installed', requires: 'X' }, b: down }, 'a')
  check('requires가 사유에 실려 온다', v.unavailableOf('a')?.requires === 'X' && v.unavailableOf('a')?.reason === 'not_installed', v.unavailableOf('a'))
  check('requires 없는 사유는 requires가 비어 있다', v.unavailableOf('b')?.requires === undefined)
  check('기록에 없는 id는 쓸 수 있는 것으로 본다', v.unavailableOf('c') === undefined && v.chosen?.id === 'c', v)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} newSessionProviders: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
