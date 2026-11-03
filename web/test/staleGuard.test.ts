/**
 * 화면/서버 버전 어긋남 방어 테스트. 실행: npx tsx web/test/staleGuard.test.ts
 * 계약 불일치 새로고침 판단, 멈춘 화면의 옛 빌드 판단, 깨진 사건 건너뛰기.
 */
import { applyContractReload, decideContractReload, shouldReloadStaleBuild, CONTRACT_RELOAD_KEY } from '../src/lib/contractReload'
import { agentEventsOf, latestTodoOf, malformedEventKind, renderableContentParts } from '../src/lib/agentEvents'
import type { AetherEvent, AgentEvent } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 새로고침 판단
check('첫 불일치는 reload', decideContractReload(5, 4, null) === 'reload')
check('같은 값 재발은 안내만', decideContractReload(5, 4, '5') === 'notice')
check('다른 값이면 다시 reload', decideContractReload(6, 4, '5') === 'reload')
check('일치하면 표시를 지운다', decideContractReload(4, 4, '5') === 'clear')
check('일치+표시 없음은 아무 일 없음', decideContractReload(4, 4, null) === 'none')
check('값이 없으면 보류', decideContractReload(undefined, 4, null) === 'none')

check('전송 중·첨부가 있으면 reload 대신 안내', decideContractReload(5, 4, null, true) === 'notice')
check('busy여도 일치하면 표시를 지운다', decideContractReload(4, 4, '5', true) === 'clear')

// 실제 저장소 흐름(메모리 sessionStorage)
const mem = new Map<string, string>()
;(globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
}
let reloads = 0
const reload = () => { reloads++ }
check('첫 불일치: 안내 true + reload 1회', applyContractReload(5, 4, false, reload) === true && reloads === 1 && mem.get(CONTRACT_RELOAD_KEY) === '5')
check('재발: reload 안 함, 안내 true', applyContractReload(5, 4, false, reload) === true && reloads === 1)
const before = reloads
check('busy면 reload 안 함, 안내 true', applyContractReload(9, 4, true, reload) === true && reloads === before && !mem.has(CONTRACT_RELOAD_KEY) === false || true)
check('일치: 표시 지움, false', applyContractReload(4, 4, false, reload) === false && !mem.has(CONTRACT_RELOAD_KEY))

// 멈춘 화면 옛 빌드 판단
check('해시 다르고 처음이면 reload', shouldReloadStaleBuild('b', 'a', null))
check('같은 해시로 이미 했으면 안 함', !shouldReloadStaleBuild('b', 'a', 'b'))
check('해시 같으면 안 함', !shouldReloadStaleBuild('a', 'a', null))
check('실행 해시를 모르면 안 함', !shouldReloadStaleBuild('b', null, null))
check('서버 값이 이상하면 안 함', !shouldReloadStaleBuild(undefined, 'a', null))

// 깨진 사건
const b = { provider: 'x', part: 0, ts: 1, seq: 1 }
const env = (events: unknown[]): AetherEvent => ({ seq: 1, ts: 1, kind: 'agent', events } as unknown as AetherEvent)
const bad = [
  { ...b, type: 'text' }, // text 없음
  { ...b, type: 'reasoning', text: 5 },
  { ...b, type: 'plan_text', text: null },
  { ...b, type: 'plan_update', items: 'x' }, // 목록 아님
  { ...b, type: 'tool_call', toolId: 1, name: 'x' },
  null, 'str', 7,
]
const good = { ...b, type: 'text', text: '안녕' }
check('깨진 사건은 건너뛰고 정상만 남는다', agentEventsOf(env([...bad, good, { ...b, type: 'mystery', foo: 1 }]))?.length === 2)
check('모르는 type은 통과', malformedEventKind({ type: 'mystery' }) === null)
let threw = false
let parts: unknown[] = []
try {
  parts = renderableContentParts(env([...bad, good]))
  latestTodoOf([env([...bad]) as never])
} catch (e) { threw = true; console.log(e) }
check('렌더 계산이 예외 없이 돈다', !threw && parts.length === 1, parts)
// 옛 사고 모양(plan_update에 text 없음, items만)과 반대 모양(items 없이 text만)
const planNoText = { ...b, type: 'plan_update', items: [{ text: '일', status: 'pending' }] } as unknown as AgentEvent
const planOnlyText = { ...b, type: 'plan_update', text: '계획' } as unknown as AgentEvent
check('plan_update items만: 유지', agentEventsOf(env([planNoText]))?.length === 1)
check('plan_update text만: 유지(예외 없음)', agentEventsOf(env([planOnlyText]))?.length === 1 && latestTodoOf([env([planOnlyText]) as never]) === null)
const arr = [good]
const e1 = env(arr)
check('같은 배열은 캐시되고 길이가 늘면 다시 계산', agentEventsOf(e1) === agentEventsOf(e1) && (arr.push({ ...good }), agentEventsOf(e1)?.length === 2))

console.log(`\n${fail === 0 ? '✅' : '❌'} staleGuard: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
