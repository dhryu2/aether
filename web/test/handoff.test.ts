/**
 * 새 세션으로 넘기기 화면 계산 테스트. 실행: npx tsx web/test/handoff.test.ts
 * 메뉴 상태, 앞뒤 모습으로 읽는 결과, 실시간 갱신 받아 들이기(옛 서버 모양 포함), 첫 말 조각.
 */
import { handoffMenuState, handoffTransition } from '../src/lib/handoff'
import { parseAutoResume, parsePresenceSession, patchRoomFromPresence } from '../src/lib/attention'
import { buildStreamSegments } from '../src/lib/streamSegments'
import type { AetherEvent, WorkspaceRoom } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 메뉴 상태
const room = (patch: Partial<WorkspaceRoom> = {}) => ({ id: 'dm:a', kind: 'dm', title: 't', status: 'active', ...patch }) as WorkspaceRoom
check('보관된 세션은 숨긴다', handoffMenuState(room({ archivedAt: 1 })).kind === 'hidden')
check('손상된 세션은 숨긴다', handoffMenuState(room({ status: 'corrupted' })).kind === 'hidden')
check('일하는 중이면 이유와 함께 막는다', JSON.stringify(handoffMenuState(room({ attention: 'running' }))) === '{"kind":"blocked","reason":"busy"}')
check('승인을 기다려도 막는다', handoffMenuState(room({ attention: 'waiting' })).kind === 'blocked')
check('넘기는 중이면 막는다', JSON.stringify(handoffMenuState(room({ handoffState: 'writing' }))) === '{"kind":"blocked","reason":"inProgress"}')
check('질문 대기 중에도 막는다', JSON.stringify(handoffMenuState(room({ handoffState: 'asking' }))) === '{"kind":"blocked","reason":"inProgress"}')
check('한도 대기 중에도 막는다', handoffMenuState(room({ handoffState: 'waiting_limit' })).kind === 'blocked')
check('쉬는 세션은 쓸 수 있다', handoffMenuState(room({ attention: 'idle' })).kind === 'ready')
check('복사 결과가 남아 있어도 새로 넘길 수 있다', handoffMenuState(room({ handoffState: 'copy_ready' })).kind === 'ready')

// 앞뒤 모습으로 읽는 결과
check('새 세션이 연결되면 swap', handoffTransition({ handoffState: 'writing' }, { handoffTo: 'n' }) === 'swap')
check('복사 결과가 생기면 copy', handoffTransition({ handoffState: 'writing' }, { handoffState: 'copy_ready' }) === 'copy')
check('한도 대기로 바뀌면 waiting', handoffTransition({ handoffState: 'writing' }, { handoffState: 'waiting_limit' }) === 'waiting')
check('쓰다가 질문 대기로 바뀌면 asking', handoffTransition({ handoffState: 'writing' }, { handoffState: 'asking' }) === 'asking')
check('질문에 답해 다시 쓰는 중이면 아무 일 없다(stopped로 읽지 않는다)', handoffTransition({ handoffState: 'asking' }, { handoffState: 'writing' }) === null)
check('질문 대기에서 취소돼도 stopped', handoffTransition({ handoffState: 'asking' }, {}) === 'stopped')
check('질문 대기 중 새 세션이 연결되면 swap', handoffTransition({ handoffState: 'asking' }, { handoffTo: 'n' }) === 'swap')
check('새 세션 없이 사라지면 stopped', handoffTransition({ handoffState: 'writing' }, {}) === 'stopped')
check('한도 대기에서 취소돼도 stopped', handoffTransition({ handoffState: 'waiting_limit' }, {}) === 'stopped')
check('한도 대기가 끝나 다시 쓰는 중이면 아무 일 없다', handoffTransition({ handoffState: 'waiting_limit' }, { handoffState: 'writing' }) === null)
check('값이 그대로면 null', handoffTransition({ handoffState: 'writing' }, { handoffState: 'writing' }) === null)
check('작업이 없던 방은 null', handoffTransition({}, { handoffTo: 'n' }) === null && handoffTransition(undefined, { handoffTo: 'n' }) === null)
check('같은 다음 세션 연결은 swap이 아니다', handoffTransition({ handoffState: 'writing', handoffTo: 'n' }, { handoffTo: 'n' }) === 'stopped')

// 실시간 갱신 받아 들이기
const asked = parsePresenceSession({ id: 'dm:a', attention: 'idle', status: 'active', handoffState: 'asking' })
check('질문 대기 상태를 읽는다', asked?.handoffState === 'asking', asked)
const p = parsePresenceSession({ id: 'dm:a', attention: 'idle', status: 'active', handoffFrom: 'x', handoffTo: 'y', handoffState: 'writing', handoffDraftPending: true })
check('넘기기 칸을 읽는다', p?.handoffFrom === 'x' && p?.handoffTo === 'y' && p?.handoffState === 'writing' && p?.handoffDraftPending === true, p)
const old = parsePresenceSession({ id: 'dm:a', attention: 'idle', status: 'active' })
check('옛 서버 모양(새 칸 없음)도 받는다', !!old && old.handoffFrom === undefined && old.handoffState === undefined)
const bad = parsePresenceSession({ id: 'dm:a', attention: 'idle', status: 'active', handoffState: 'nope', handoffFrom: 3, handoffDraftPending: false })
check('모양이 틀린 칸은 그 칸만 버린다', !!bad && bad.handoffState === undefined && bad.handoffFrom === undefined && bad.handoffDraftPending === undefined, bad)
const patched = patchRoomFromPresence(room({ handoffState: 'writing', handoffTo: 'y' }), old!)
check('갱신에 칸이 없으면 지워진 것이다', patched.handoffState === undefined && patched.handoffTo === undefined)
check('자동 재개의 인계서 쓰기 종류를 받는다', parseAutoResume({ action: { type: 'handoff' }, attempts: 1, at: 5 })?.action.type === 'handoff')
check('모르는 실행 종류는 버린다', parseAutoResume({ action: { type: 'other' }, attempts: 1, at: 5 }) === undefined)

// 첫 말 조각에 handoffFrom이 실린다
const t = (key: string) => key
const build = (items: AetherEvent[]) => buildStreamSegments({ items, turn: 'idle', providerName: 'Mock', answers: {}, t }).segs
const first = build([{ seq: 1, ts: 1, kind: 'user_msg', text: '인계서', handoffFrom: 'prev' } as AetherEvent])[0]
check('서버 첫 말 조각에 handoffFrom', first?.kind === 'user' && first.handoffFrom === 'prev', first)
const second = build([{ seq: 1, ts: 1, kind: 'user_msg', text: '둘째' } as AetherEvent])[0]
check('보통 말에는 없다', second?.kind === 'user' && !('handoffFrom' in second), second)
const local = build([{ seq: -1, ts: 1, kind: 'local_user', text: '임시', handoffFrom: 'prev' }])[0]
check('보내는 순간의 임시 말에도 handoffFrom', local?.kind === 'user' && local.handoffFrom === 'prev', local)


console.log(`\n${fail === 0 ? '✅' : '❌'} handoff: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
