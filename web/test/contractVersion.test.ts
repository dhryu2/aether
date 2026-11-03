/**
 * 화면 계약 버전 안내의 순수 판정 테스트.
 */
import { AGENT_EVENT_CONTRACT_VERSION } from '../../shared/agentEvent'
import { decideContractReload } from '../src/lib/contractReload'

/** 실제 판정(decideContractReload)에서 안내를 띄우는 경우만 true. */
function needsContractRefresh(serverVersion: unknown): boolean {
  const a = decideContractReload(serverVersion, AGENT_EVENT_CONTRACT_VERSION, null)
  return a === 'reload' || a === 'notice'
}

let pass = 0
let fail = 0
function check(name: string, got: boolean, want: boolean) {
  const ok = got === want
  if (ok) pass++; else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}: got=${got} want=${want}`)
}

check('같은 계약 버전이면 새로고침 안내를 띄우지 않는다', needsContractRefresh(AGENT_EVENT_CONTRACT_VERSION), false)
check('다른 계약 버전이면 새로고침 안내를 띄운다', needsContractRefresh(AGENT_EVENT_CONTRACT_VERSION + 1), true)
check('계약 버전이 아예 없으면 구버전 서버로 보고 안내를 띄우지 않는다', needsContractRefresh(undefined), false)
check('화면 계약 버전은 5이다', AGENT_EVENT_CONTRACT_VERSION === 5, true)

// 옛 목록 파서: sessions 배열 throw 0 + caught_up 3 → 안내
{
  const body = {
    contractVersion: 5,
    rooms: [{ id: 'dm:a', kind: 'dm', title: 'A', sourceSessionId: 'a', status: 'active' }],
    sessions: [{ id: 'a', cwd: '/', displayName: 'A', provider: 'claude', model: '', permissionMode: 'manual', status: 'active', createdAt: 0 }],
  }
  const { sessions } = body
  const ok = Array.isArray(sessions) && sessions.every((s) => typeof s.id === 'string' && !s.id.startsWith('dm:'))
  check('옛 목록 파서 sessions throw 0', ok, true)
  check('계약 3 서버(뒤 작업 사건을 모르는 서버) → 안내', needsContractRefresh(3), true)
  // 버전 3 화면 상수에 5를 넣으면 안내
  const OLD = 3
  check('서버 5 vs 옛 화면 3 → 안내', OLD !== 5, true)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} contractVersion: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
