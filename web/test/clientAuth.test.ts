/**
 * clientAuth — Bearer 헤더 모양. 토큰 없으면 빈 헤더. 질의에 token 없음.
 *   실행: npx tsx web/test/clientAuth.test.ts
 */
import { authHeaders, getClientToken, setClientToken } from '../src/lib/clientAuth'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

setClientToken(undefined)
check('토큰 없으면 getClientToken undefined', getClientToken() === undefined)
check('토큰 없으면 authHeaders 빈 객체', Object.keys(authHeaders()).length === 0)

setClientToken('abc.def.ghi')
check('토큰 있으면 getClientToken', getClientToken() === 'abc.def.ghi')
const h = authHeaders()
check('Authorization Bearer 접두', h.Authorization === 'Bearer abc.def.ghi')
check('헤더 칸은 Authorization 하나', Object.keys(h).length === 1)
check('질의 문자열에 token을 넣지 않는다(헤더만)', !('token' in h) && !String(h.Authorization).includes('?'))

setClientToken('')
check('빈 문자열 setClientToken은 헤더 없음', Object.keys(authHeaders()).length === 0)

setClientToken(undefined)
console.log(`\n${fail === 0 ? '✅' : '❌'} clientAuth: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
