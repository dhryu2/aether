import { createAnchorFixer, spinnerRemovalShift } from '../src/components/stream/scrollAnchor'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

// 모양: 영역 맨 위 y=100, 앵커는 화면 y=300에 있었다. 이전 기록 500px가 위에 붙어 앵커가 y=800으로 밀렸다.
{
  const fix = createAnchorFixer(300)
  check(fix({ nodeTop: 800, boxTop: 100, scrollTop: 40 }) === 500, '첫 보정: 앞에 붙은 높이만큼 아래로')
}
// 이미 제자리면 0
{
  const fix = createAnchorFixer(300)
  check(fix({ nodeTop: 300, boxTop: 100, scrollTop: 40 }) === 0, '첫 보정: 제자리면 보정 없음')
}
// 1px 이하 흔들림은 무시
{
  const fix = createAnchorFixer(300)
  check(fix({ nodeTop: 301, boxTop: 100, scrollTop: 40 }) === 0, '1px 흔들림 무시')
}
// 재검증: 사용자가 계속 올려 scrollTop이 줄고 nodeTop이 그만큼 내려가도 끌려가지 않는다
{
  const fix = createAnchorFixer(300)
  fix({ nodeTop: 800, boxTop: 100, scrollTop: 40 }) // 첫 보정 500 → 적용 뒤 nodeTop 300, scrollTop 540
  const d = fix({ nodeTop: 340, boxTop: 100, scrollTop: 500 }) // 사용자가 40px 더 올림
  check(d === 0, '재검증: 사용자 스크롤은 보정하지 않는다', d)
}
// 재검증: 위쪽 높이가 늦게 30px 커지면 그만큼만 보정
{
  const fix = createAnchorFixer(300)
  fix({ nodeTop: 800, boxTop: 100, scrollTop: 40 })
  const d = fix({ nodeTop: 330, boxTop: 100, scrollTop: 540 }) // 스크롤은 그대로, 앵커가 30px 밀림
  check(d === 30, '재검증: 위쪽 높이 변화만 보정', d)
}
// 재검증 중 사용자 스크롤과 높이 변화가 겹쳐도 높이 변화분만
{
  const fix = createAnchorFixer(300)
  fix({ nodeTop: 800, boxTop: 100, scrollTop: 40 })
  const d = fix({ nodeTop: 370, boxTop: 100, scrollTop: 510 }) // 사용자 30px 올림 + 높이 변화 40px
  check(d === 40, '재검증: 스크롤과 높이 변화가 겹쳐도 높이 변화분만', d)
}
// 노드 소실
{
  const fix = createAnchorFixer(300)
  check(fix(null) === null, '노드 소실이면 null(폴백 신호)')
}

check(spinnerRemovalShift(true, false, 39, 500, 8) === 39, '줄이 사라지면 그 높이만큼 당긴다')
check(spinnerRemovalShift(true, false, 39, 3, 8) === 0, '바닥에 붙어 있으면 바닥 추적에 맡긴다')
check(spinnerRemovalShift(true, true, 39, 500, 8) === 0, '줄이 그대로면 보정 없음')
check(spinnerRemovalShift(false, false, 39, 500, 8) === 0, '줄이 없었으면 보정 없음')
check(spinnerRemovalShift(true, false, 0, 500, 8) === 0, '높이를 못 쟀으면 보정 없음')

console.log(`\n${fail === 0 ? '✅' : '❌'} scrollAnchor: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
