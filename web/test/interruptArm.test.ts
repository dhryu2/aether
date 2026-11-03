/**
 * Esc 두 번 눌러 중단 — 무장/해제 규칙. 앱을 띄우지 않고 스토어 동작만 본다.
 *
 * 왜 검사하나: Esc는 습관적으로 누르는 키다. 여기가 틀려서 한 번에 중단되면 몇 분짜리 작업이 실수로
 * 날아가고, 반대로 무장이 안 풀리면 멈춤 버튼에 "ESC" 글자가 붙은 채로 굳는다. 둘 다 화면을 열어
 * 봐야만 보이는 종류라 자동 검사로 못 박는다.
 *
 * 검사하는 것:
 *   ① 첫 Esc는 무장만 한다 — 중단하지 않는다
 *   ② 무장된 상태에서 한 번 더 누르면 중단되고 무장이 풀린다
 *   ③ 시간이 지나면 저절로 무장이 풀린다(다음 Esc가 다시 첫 번째가 된다)
 *   ④ 중단을 부르면 무장이 풀린다 — 멈춤 버튼을 손으로 눌렀을 때 "ESC" 글자가 굳지 않게
 *
 * 실행: npx tsx web/test/interruptArm.test.ts
 */
import { actions, getState } from '../src/lib/store'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const eq = <T,>(label: string, actual: T, expected: T) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`)

const armed = () => getState().interruptArmed
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 무장이 저절로 풀리기까지의 시간(store의 INTERRUPT_ARM_MS와 같아야 한다).
 * 스토어가 이 값을 내보내지 않으므로 여기 적어 둔다 — 스토어에서 바꾸면 이 숫자도 같이 고쳐야 한다.
 */
const ARM_MS = 2000

async function main() {
  console.log('──────── ① 첫 Esc는 무장만 한다 ────────')
  eq('처음에는 무장 안 됨', armed(), false)
  actions.armOrInterrupt()
  eq('★ 한 번 누르면 무장된다(아직 중단 아님)', armed(), true)

  console.log('\n──────── ② 무장된 상태에서 한 번 더 누르면 중단 ────────')
  // 활성 세션이 없으므로 실제 서버 호출은 일어나지 않는다. 여기서 보는 것은 무장이 풀리는지다.
  actions.armOrInterrupt()
  await sleep(0) // interrupt()가 async라 한 박자 넘긴다
  eq('★ 두 번째에 무장이 풀린다(중단 경로로 넘어갔다)', armed(), false)

  console.log('\n──────── ③ 시간이 지나면 저절로 풀린다 ────────')
  actions.armOrInterrupt()
  eq('다시 무장', armed(), true)
  await sleep(ARM_MS * 0.4)
  eq('절반도 안 지났으면 아직 무장 상태', armed(), true)
  await sleep(ARM_MS * 0.8)
  eq('★ 시간이 지나면 저절로 풀린다 — 다음 Esc가 다시 첫 번째가 된다', armed(), false)

  console.log('\n──────── ④ 중단하면 무장이 풀린다(버튼을 손으로 눌렀을 때) ────────')
  actions.armOrInterrupt()
  eq('무장', armed(), true)
  await actions.interrupt()
  eq('★ 멈춤 버튼을 눌러 중단해도 "ESC" 글자가 굳지 않는다', armed(), false)

  console.log('\n──────── 무장 중 다시 무장하면 시간이 새로 간다 ────────')
  actions.armOrInterrupt()
  await sleep(ARM_MS * 0.7)
  actions.disarmInterrupt() // 정리(다음 검사에 새지 않게)
  eq('해제하면 꺼진다', armed(), false)
  actions.disarmInterrupt()
  eq('이미 꺼진 것을 또 해제해도 문제없다', armed(), false)

  console.log(`\n${fail === 0 ? '✅' : '❌'} interruptArm: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
