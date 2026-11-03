/**
 * deriveTurn 특성화/회귀 테스트(프레임워크 없는 독립 tsx — 서버 test/ 컨벤션).
 *   실행: npx tsx web/test/deriveTurn.test.ts   (src 밖이라 앱 빌드 tsc -b에 미포함)
 *
 * 버그: running/idle이 클라 로컬 pendingSend에만 의존 → 앱 리로드(창 최소화로 인한 탭 폐기·PWA 축출·
 *   새로고침)로 pendingSend가 소실되면, 서버 턴이 살아있어도(=replay된 대화가 미완 턴으로 끝남) idle로 오인.
 *   수정: pendingSend가 false여도 "대화가 미완 턴으로 끝나면" running으로 파생(서버 tailInfo.turnOpen 규칙 미러).
 */
import { deriveTurn, ignoreStaleCardResolve } from '../src/lib/store'
import type { ConvoItem } from '../src/lib/store'

let pass = 0
let fail = 0
let seq = 1
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) pass++; else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

// ── ConvoItem 빌더 ──
// 화면은 정규화 계약(`events`)만 읽는다. 여기 봉투도 서버가 실제로 내보내는 모양(원본 없음)으로 만든다.
const ev = (o: Record<string, unknown>): ConvoItem => ({ seq: seq++, ts: seq, ...o }) as unknown as ConvoItem
/** 계약만 실은 봉투 — deriveTurn이 원본을 안 본다는 것 자체가 검증 대상이다. */
const wire = (...events: Record<string, unknown>[]): ConvoItem => {
  const e = ev({ kind: 'agent' }) as Extract<ConvoItem, { kind: 'agent' }>
  return { ...e, events: events.map((c, part) => ({ provider: 'claude', seq: e.seq, part, ts: e.ts, ...c })) } as ConvoItem
}
const init = () => wire({ type: 'model_info', model: 'claude-haiku-4-5' })
const userMsg = (text = '안녕') => {
  const e = ev({ kind: 'user_msg', text }) as Extract<ConvoItem, { kind: 'user_msg' }>
  return { ...e, events: [{ provider: 'claude', seq: e.seq, part: 0, ts: e.ts, type: 'user_text', text }] } as ConvoItem
}
const localUser = (text = '안녕') => ev({ kind: 'local_user', text })
const asst = () => wire({ type: 'text', text: '네' }, { type: 'model_info', model: 'claude-haiku-4-5' })
const toolUse = () => wire({ type: 'tool_call', toolId: 'tu-1', name: 'Bash', toolKind: 'bash', target: 'ls' })
const sdkUser = () => wire({ type: 'tool_result', toolId: 'tu-1', output: 'ok' }) // 도구 결과가 되돌아온 봉투
const result = () => wire({ type: 'turn_completed', status: 'ok' })
const agentUser = userMsg
const agentCompleted = result
const ctx = () => ev({ kind: 'ctx', totalTokens: 1000, maxTokens: 200000 })
const partial = () => wire({ type: 'text_delta', text: '토' })
const statusEv = (status: string) => ev({ kind: 'status', status })
const noticeEv = (notice: string) => ev({ kind: 'notice', notice })
const localStop = () => ev({ kind: 'local_notice', variant: 'stop', detail: '중단됨' })
const localModel = () => ev({ kind: 'local_notice', variant: 'model', detail: 'opus' })
const permReq = (id: string) => ev({ kind: 'permission_request', req: { id } })
const permResolved = (id: string) => ev({ kind: 'permission_resolved', id, decision: 'allow' })
const qReq = (id: string) => ev({ kind: 'question_request', req: { id } })
const qResolved = (id: string) => ev({ kind: 'question_resolved', id, answered: true })
const operation = (operationId: string, state: 'started' | 'completed' | 'failed', blocksInput = true) => ev({ kind: 'command_operation', operationId, state, detail: state, blocksInput })
// 모델 변경 시 턴 종료 *뒤에* 딸려오는 슬래시 명령 출력 — 턴 활동이 아니다(턴을 다시 열면 안 된다).
const sdkUserLocalCmd = (text: string) => wire({ type: 'command_output', text })
/** 파생 콘텐츠가 없는 봉투(생각 토큰 등) — 계약이 비어도 턴 판정이 흔들리지 않아야 한다. */
const thinking = () => ev({ kind: 'agent' })

console.log('── A. 기존 동작 보존(수정 전후 동일해야 함) ──')
check('undefined + pendingSend=false → idle', deriveTurn(undefined, false), 'idle')
check('undefined + pendingSend=true → running', deriveTurn(undefined, true), 'running')
check('빈 배열 + false → idle', deriveTurn([], false), 'idle')
check('턴 완료(…result) + false → idle', deriveTurn([init(), userMsg(), asst(), result()], false), 'idle')
check('턴 완료(…result) + pendingSend=true → running(pendingSend 우선 보존)', deriveTurn([init(), userMsg(), asst(), result()], true), 'running')
check('앱 열린 채 전송 직후(local_user) + pendingSend=true → running', deriveTurn([init(), localUser()], true), 'running')
check('미해결 권한 → requires_action(pendingSend 무관)', deriveTurn([init(), userMsg(), permReq('p1')], false), 'requires_action')
check('미해결 질문 → requires_action', deriveTurn([init(), userMsg(), qReq('q1')], false), 'requires_action')
const planReq = (id: string) => ev({ kind: 'plan_request', req: { id } })
const planResolved = (id: string) => ev({ kind: 'plan_resolved', id, decision: 'approve' })
check('미해결 계획 → requires_action', deriveTurn([init(), userMsg(), planReq('pl1')], false), 'requires_action')
check('해결된 계획 후 result → idle', deriveTurn([init(), userMsg(), planReq('pl1'), planResolved('pl1'), asst(), result()], false), 'idle')
check('해결된 권한 후 턴 진행중 → running', deriveTurn([init(), userMsg(), permReq('p1'), permResolved('p1'), asst()], false), 'running')
check('해결된 권한 후 result → idle', deriveTurn([init(), userMsg(), permReq('p1'), permResolved('p1'), asst(), result()], false), 'idle')
check('user_text + turn_completed → idle', deriveTurn([agentUser(), asst(), agentCompleted()], false), 'idle')
check('user_text + 미완 턴 → running', deriveTurn([agentUser(), asst()], false), 'running')
check('입력을 점유하는 명령 작업 시작 → operation', deriveTurn([init(), operation('op-1', 'started')], false), 'operation')
check('명령 작업 완료 → idle', deriveTurn([init(), operation('op-1', 'started'), operation('op-1', 'completed')], false), 'idle')
check('입력을 점유하지 않는 명령 작업 시작 → idle', deriveTurn([init(), operation('op-2', 'started', false)], false), 'idle')

console.log('\n── B. [BUG] 리로드 중 라이브 턴(pendingSend 소실) → running 이어야 함 ──')
check('[BUG] 리로드: user_msg만 도착 + false → running', deriveTurn([init(), userMsg()], false), 'running')
check('[BUG] 리로드: assistant 스트리밍 중 + false → running', deriveTurn([init(), userMsg(), asst()], false), 'running')
check('[BUG] 리로드: 도구 실행 중 + false → running', deriveTurn([init(), userMsg(), toolUse()], false), 'running')
check('[BUG] 리로드: 도구 결과(sdk user) 후 + false → running', deriveTurn([init(), userMsg(), toolUse(), sdkUser()], false), 'running')
check('[BUG] 리로드: 꼬리 partial 토큰 + false → running(partial 투명)', deriveTurn([init(), userMsg(), asst(), partial()], false), 'running')
check('[BUG] 리로드: 미완 턴 중 모델변경 notice 꼬리 + false → running(설정 notice 투명)', deriveTurn([init(), userMsg(), asst(), localModel()], false), 'running')

console.log('\n── C. 과잉트리거 방지(수정 후에도 idle 유지해야 함) ──')
check('신규 세션 init만 + false → idle(턴 시작 안 함)', deriveTurn([init()], false), 'idle')
check('턴 사이 ctx 꼬리(result 후) + false → idle(ctx 투명)', deriveTurn([init(), userMsg(), asst(), result(), ctx()], false), 'idle')
check('서버 재시작 interrupted + false → idle', deriveTurn([init(), userMsg(), asst(), statusEv('interrupted')], false), 'idle')
check('정상 완료 status + false → idle', deriveTurn([init(), userMsg(), asst(), result(), statusEv('completed')], false), 'idle')
check('사용자 Stop(local_notice) + false → idle', deriveTurn([init(), userMsg(), asst(), localStop()], false), 'idle')
check('resume notice 꼬리 + false → idle', deriveTurn([init(), noticeEv('resumed')], false), 'idle')
check('턴 완료 후 질문 resolved 꼬리 + false → idle', deriveTurn([init(), userMsg(), asst(), qReq('q1'), qResolved('q1'), result()], false), 'idle')

console.log('\n── D. [회귀] 완료 후 모델/effort 변경(SDK local-command-stdout + local_notice) → idle 유지 ──')
check('[회귀·스크린샷] result+ctx + sdk-user(모델변경)×2 + notice×3 + false → idle', deriveTurn([userMsg(), asst(), result(), ctx(), sdkUserLocalCmd('Set model to sonnet'), sdkUserLocalCmd('Set model to opus[1m]'), localModel(), localModel(), ev({ kind: 'local_notice', variant: 'effort', detail: 'high' })], false), 'idle')
check('완료 후 sdk-user(local-cmd) 단독 꼬리 + false → idle', deriveTurn([userMsg(), asst(), result(), sdkUserLocalCmd('Set model to sonnet')], false), 'idle')
check('완료 후 sdk-user + notice 꼬리 + false → idle', deriveTurn([userMsg(), asst(), result(), ctx(), sdkUserLocalCmd('x'), localModel()], false), 'idle')

console.log('\n── E. 라이브 턴 꼬리가 thinking/system일 때(pendingSend 소실) → running(리로드 복원) ──')
check('user_msg 후 thinking_tokens 스트리밍 중 + false → running', deriveTurn([init(), userMsg(), thinking(), thinking()], false), 'running')
check('user_msg 후 assistant→thinking 꼬리 + false → running', deriveTurn([init(), userMsg(), asst(), thinking()], false), 'running')

console.log('\n── F. 죽은 카드 404 ──')
check('이미 닫힌 카드의 404는 숨긴다', ignoreStaleCardResolve(404, true), true)
check('아직 열린 카드의 404는 드러낸다', ignoreStaleCardResolve(404, false), false)
check('500은 닫혔어도 드러낸다', ignoreStaleCardResolve(500, true), false)

console.log('── 사용자 입력 없이 provider가 스스로 시작한 턴 ──')
const turnStart = () => wire({ type: 'turn_started' })
check('턴 완료 뒤 시작 신호 → running', deriveTurn([userMsg(), asst(), result(), turnStart()], false), 'running')
check('시작 신호 뒤 작업 내용 → running', deriveTurn([userMsg(), result(), turnStart(), asst(), ctx()], false), 'running')
check('스스로 시작한 턴이 끝나면 → idle', deriveTurn([userMsg(), result(), turnStart(), asst(), result()], false), 'idle')
check('사용자 메시지 없는 세션의 시작 신호 → running', deriveTurn([turnStart()], false), 'running')
check('시작 신호 뒤 사용자 Stop → idle', deriveTurn([userMsg(), result(), turnStart(), localStop()], false), 'idle')
check('시작 신호 뒤 비정상 종료 → idle', deriveTurn([userMsg(), result(), turnStart(), statusEv('crashed')], false), 'idle')
check('완료 뒤 잡음만 있으면 → idle', deriveTurn([userMsg(), result(), sdkUserLocalCmd('ok'), ctx(), init()], false), 'idle')

console.log(`\n${fail === 0 ? '🟢' : '🔴'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
