/**
 * 잠든 세션은 열기만 해서는 깨우지 않는다(쉬는 세션 잠재우기). 모델·명령 목록은 서버가 기억한 값을 받는다.
 * 모델·강도·권한 변경, 명령 실행, 메시지 전송은 그 앞에 깨운다. 깨우기는 실행 id로 불리고 보이는 칸 목록은 방 id다.
 * 실행: tsx --tsconfig tsconfig.app.json test/wakeOnOpen.test.ts
 */
import { api } from '../src/lib/api'
import { actions, getState } from '../src/lib/store'
import type { SessionListItem } from '../../shared/http'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 실시간 연결은 이 시험의 대상이 아니다. 열기만 하고 아무것도 보내지 않는 가짜로 둔다.
;(globalThis as { EventSource?: unknown }).EventSource = class {
  close() {}
  addEventListener() {}
}
const noEvents = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
Object.assign(globalThis, { document: noEvents, window: noEvents })

const id = 'wake-on-open'
let awake = false
const item = (): SessionListItem => ({
  id,
  cwd: '/tmp/wake-on-open',
  displayName: '잠든 작업',
  provider: 'mock',
  model: 'mock',
  permissionMode: 'full',
  status: awake ? 'active' : 'ended',
  createdAt: 1,
})
const room = () => ({ id: `dm:${id}`, kind: 'dm', title: '잠든 작업', sourceSessionId: id, cwd: '/tmp/wake-on-open', provider: 'mock', status: item().status })

api.listSessions = (async () => ({ rooms: [room()], sessions: [item()] })) as typeof api.listSessions
let wakes = 0
api.wakeSession = async () => {
  // 실제 깨우기는 프로세스를 띄우느라 느리다. 그 사이 다른 요청이 먼저 가면 덜 깬 세션에 닿는다.
  wakes++
  await new Promise((r) => setTimeout(r, 50))
  awake = true
  return { ok: true, alreadyAwake: false }
}
// 잠든 세션도 서버가 기억한 목록으로 답한다. 명령은 공통 명령뿐이어도 오류로 깨지지 않는다.
api.getModels = (async () => ({ models: [{ value: 'mock', displayName: 'Mock', description: '' }] })) as typeof api.getModels
api.getCommands = (async () => ({ commands: [{ name: 'model', description: { text: '모델' } }] })) as unknown as typeof api.getCommands
api.getPermissionPolicy = (async () => { throw Object.assign(new Error('asleep'), { status: 404 }) }) as typeof api.getPermissionPolicy
api.getPermissionModes = (async () => ({ modes: ['manual', 'full'], current: 'full' })) as typeof api.getPermissionModes
const calls: string[] = []
api.setModel = (async (_id: string, model: string) => { calls.push(`setModel:${awake ? 'awake' : 'asleep'}`); return { ok: true, model } }) as typeof api.setModel
api.setEffort = (async (_id: string, effort: string) => { calls.push(`setEffort:${awake ? 'awake' : 'asleep'}`); return { ok: true, effort } }) as typeof api.setEffort
api.setPermissionMode = (async (_id: string, mode: string) => { calls.push(`perm:${awake ? 'awake' : 'asleep'}`); return { ok: true, permissionMode: mode } }) as typeof api.setPermissionMode
api.executeCommand = (async () => { calls.push(`cmd:${awake ? 'awake' : 'asleep'}`); return { ok: true, accepted: true, startsTurn: false } }) as unknown as typeof api.executeCommand
api.sendMessage = (async () => { calls.push(`send:${awake ? 'awake' : 'asleep'}`); return { ok: true } }) as unknown as typeof api.sendMessage

async function main() {
  await actions.refreshSessions()
  actions.setActive(`dm:${id}`)
  for (let i = 0; i < 50 && getState().modelsStatus !== 'ok'; i++) await new Promise((r) => setTimeout(r, 20))
  check('세션을 열기만 해서는 깨우지 않는다', wakes === 0 && !awake, wakes)
  check('잠든 채로도 모델 목록이 와서 칩이 비지 않는다', getState().modelsStatus === 'ok', getState().modelsStatus)
  check('잠든 채로 사이드바 상태는 그대로 잠듦이다', getState().sessions.find((s) => s.id === id)?.status === 'ended')

  await actions.setModel('mock', id)
  check('모델 변경은 먼저 깨운 뒤 보낸다', calls.at(-1) === 'setModel:awake' && wakes === 1, calls)
  awake = false
  await actions.refreshSessions()
  await actions.setEffort('low', id)
  check('강도 변경도 먼저 깨운다', calls.at(-1) === 'setEffort:awake' && wakes === 2, calls)
  awake = false
  await actions.refreshSessions()
  await actions.setPermissionMode('full', id)
  check('권한 변경도 먼저 깨운다', calls.at(-1) === 'perm:awake' && wakes === 3, calls)
  awake = false
  await actions.refreshSessions()
  await actions.executeCommand('model', 'mock', false, `dm:${id}`)
  check('명령 실행도 먼저 깨운다', calls.at(-1) === 'cmd:awake' && wakes === 4, calls)
  awake = false
  await actions.refreshSessions()
  await actions.sendTo(`dm:${id}`, '안녕')
  check('메시지 전송도 먼저 깨운다', calls.at(-1) === 'send:awake' && wakes === 5, calls)
  check('깨운 뒤 사이드바 상태가 활성으로 바뀐다', getState().sessions.find((s) => s.id === id)?.status === 'active', getState().sessions)

  // 두 요청이 겹쳐도 깨우기는 한 번이고, 둘 다 깨어난 뒤에 나간다.
  awake = false
  await actions.refreshSessions()
  calls.length = 0
  await Promise.all([actions.setModel('mock', id), actions.setEffort('low', id)])
  check('겹친 두 변경은 깨우기 한 번을 같이 기다린다', wakes === 6 && calls.length === 2 && calls.every((c) => c.endsWith('awake')), { wakes, calls })

  // 재시작 직후나 처음 쓰는 provider처럼 서버가 목록을 기억하지 못하면, 그때만 열면서 깨워 칩을 채운다.
  const asleep404 = async () => { if (!awake) throw Object.assign(new Error('asleep'), { status: 404 }); return { models: [{ value: 'mock', displayName: 'Mock', description: '' }], commands: [{ name: 'model', description: { text: '모델' } }] } }
  api.getModels = asleep404 as unknown as typeof api.getModels
  api.getCommands = asleep404 as unknown as typeof api.getCommands
  awake = false
  await actions.refreshSessions()
  const beforeOpen = wakes
  void actions.fetchModels(id)
  void actions.fetchCommands(id)
  for (let i = 0; i < 100 && !(awake && getState().modelsStatus === 'ok'); i++) await new Promise((r) => setTimeout(r, 20))
  check('기억이 없으면 열면서 한 번 깨워 칩을 채운다', wakes === beforeOpen + 1 && getState().modelsStatus === 'ok', { wakes, status: getState().modelsStatus })

  // 깨우기가 실패해도 시도를 되풀이하지 않는다(실패 뒤 목록을 다시 받아 404가 또 와도).
  const liveWake = api.wakeSession
  let failedWakes = 0
  api.wakeSession = (async () => { failedWakes++; throw new Error('없음') }) as typeof api.wakeSession
  awake = false
  await actions.refreshSessions()
  void actions.fetchModels(id)
  await new Promise((r) => setTimeout(r, 400))
  check('이미 시도한 세션은 다시 깨우지 않는다', failedWakes === 0, failedWakes)
  api.wakeSession = liveWake

  console.log(`\n${fail === 0 ? '✅' : '❌'} wakeOnOpen: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
