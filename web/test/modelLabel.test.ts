/**
 * 모델 칩 이름 시험. 실행: npx tsx web/test/modelLabel.test.ts
 * 계정 기본 줄은 실제로 도는 모델 이름으로 보인다.
 */
import { modelRowLabel } from '../src/lib/modelLabel'

let fail = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) fail++
}

const aliased = [
  { value: 'default', displayName: 'Default (recommended)', isDefault: true, resolvedModel: 'model-a-5' },
  { value: 'a', displayName: 'Model A 5', resolvedModel: 'MODEL-A-5' },
  { value: 'b', displayName: 'Model B 5', resolvedModel: 'model-b-5' },
]
check('별칭 기본 줄은 같은 모델을 직접 가리키는 줄의 이름을 쓴다', modelRowLabel(aliased[0], aliased) === 'Model A 5')
check('기본이 아닌 줄은 자기 이름을 쓴다', modelRowLabel(aliased[2], aliased) === 'Model B 5')

const direct = [
  { value: 'x', displayName: 'Model X', isDefault: true, resolvedModel: 'x' },
  { value: 'y', displayName: 'Model Y', resolvedModel: 'y' },
]
check('기본 줄이 곧 실제 모델이면 그 이름을 쓴다', modelRowLabel(direct[0], direct) === 'Model X')

const noResolved = [
  { value: 'local:1', displayName: 'local:1', isDefault: true },
  { value: 'local:2', displayName: 'local:2' },
]
check('정식 id가 없는 공급처도 자기 이름을 쓴다', modelRowLabel(noResolved[0], noResolved) === 'local:1')

process.exit(fail ? 1 : 0)
