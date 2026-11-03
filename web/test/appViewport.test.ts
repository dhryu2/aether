/**
 * iOS PWA 앱 뷰포트 판정 회귀 테스트(프레임워크 없는 독립 tsx).
 *   실행: server/node_modules/.bin/tsx web/test/appViewport.test.ts
 */
import { resolveAppViewport, shouldReleaseFocus, USER_INPUT_GRACE_MS } from '../src/lib/appViewport'

let pass = 0
let fail = 0

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

console.log('── 앱 뷰포트 판정 ──')
check(
  '[회귀] 키보드가 없으면 stale 축소 높이를 무시하고 100dvh 폴백',
  resolveAppViewport(false, { height: 829, offsetTop: 0 }),
  { height: null, top: null },
)
check(
  'textarea 포커스 중에는 실제 visualViewport 높이·패닝량 사용',
  resolveAppViewport(true, { height: 514.5, offsetTop: 72 }),
  { height: '514.5px', top: '72px' },
)
check(
  'visualViewport 미지원이면 포커스 중에도 CSS 폴백',
  resolveAppViewport(true, null),
  { height: null, top: null },
)
check(
  'WebKit 전환 중 비정상 높이(0)는 CSS 폴백',
  resolveAppViewport(true, { height: 0, offsetTop: 30 }),
  { height: null, top: null },
)
check(
  '잘못된 음수 offsetTop은 0으로 보정',
  resolveAppViewport(true, { height: 500, offsetTop: -20 }),
  { height: '500px', top: '0px' },
)
check(
  'NaN offsetTop은 0으로 보정',
  resolveAppViewport(true, { height: 500, offsetTop: Number.NaN }),
  { height: '500px', top: '0px' },
)

console.log('── 복귀 복구의 포커스 해제 판정 ──')
check(
  '[회귀] 탭 직후 늦게 온 창 focus 신호는 방금 연 입력칸 포커스를 풀지 않는다',
  shouldReleaseFocus(10_000, 10_000 - 150),
  false,
)
check(
  '사용자 입력 없이 복귀(알림 탭 등)하면 남은 포커스를 푼다',
  shouldReleaseFocus(10_000, -Infinity),
  true,
)
check(
  '유예 시간이 지난 오래된 입력은 복구를 막지 않는다',
  shouldReleaseFocus(10_000, 10_000 - USER_INPUT_GRACE_MS),
  true,
)

console.log(`\n${fail === 0 ? '🟢' : '🔴'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
