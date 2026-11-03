/**
 * 칸별 칩이 보는 상태 시험. 실행: npx tsx web/test/paneView.test.ts
 * 칩의 선택자는 포커스 칸을 보므로, paneView가 그 칸을 포커스로 놓아 칸별 값을 얻는다.
 */
import { currentEffort, effectiveEffort, isSplit, paneView, type State } from '../src/lib/store'

let fail = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) fail++
}

const room = (id: string) => ({ id, sourceSessionId: `exec-${id}`, status: 'active' })
const base = {
  rooms: [room('a'), room('b')],
  sessions: [
    { id: 'exec-a', effort: 'low' },
    { id: 'exec-b', effort: 'high' },
  ],
  convos: {},
  activeId: 'a',
  sideIds: ['b'],
  focusedId: 'a',
  isWide: true,
  paneW: 1600,
  paneH: 900,
  availableModels: [],
  modelsStatus: 'ok',
  permissionPolicy: null,
  pinnedControlRun: {},
} as unknown as State

check('칸이 둘이면 나뉜 화면이다', isSplit(base))
check('좁으면 칸이 하나라 나뉜 화면이 아니다', !isSplit({ ...base, isWide: false }))
check('포커스 칸은 상태를 그대로 쓴다', paneView(base, 'a') === base)
check('포커스 칸의 값을 읽는다', currentEffort(paneView(base, 'a')) === 'low')
const side = paneView(base, 'b')
check('옆 칸은 자기 세션 값을 읽는다', currentEffort(side) === 'high')
check('옆 칸은 포커스 칸의 모델 목록을 빌려 쓰지 않는다', side.availableModels === null && side.modelsStatus === 'loading')
check('원래 상태는 바뀌지 않는다', base.focusedId === 'a')

// 칩에 보이는 강도: 실제 값, 고른 값, 모델 목록의 기본값, 모름 순이다.
const shown = (session: object, row: object = {}) =>
  effectiveEffort({
    ...base,
    sessions: [{ id: 'exec-a', ...session }],
    availableModels: [{ value: 'm', displayName: 'M', isDefault: true, ...row }],
  } as unknown as State)
check('실제 강도가 고른 강도보다 먼저다', shown({ observedEffort: 'medium', effort: 'high' }, { defaultEffort: 'low' }) === 'medium')
check('실제 강도가 없으면 고른 강도', shown({ effort: 'high' }, { defaultEffort: 'low' }) === 'high')
check('고른 강도도 없으면 모델 목록의 기본값', shown({}, { defaultEffort: 'low' }) === 'low')
check('provider가 알려 주지 않으면 빈 값', shown({}) === '')

process.exit(fail ? 1 : 0)
