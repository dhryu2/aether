import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`)
  if (cond) pass++; else fail++
}

const root = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => fs.readFileSync(path.join(root, '../src', rel), 'utf8')

const store = read('lib/store.ts')
const fallback = Number(/const CAUGHT_UP_FALLBACK_MS = (\d+)/.exec(store)?.[1])
check(fallback >= 20000, '완료 신호 강제 해제는 20초 이상(긴 세션 복원이 6초를 넘겨도 마스크 유지)')

const stream = read('components/stream/Stream.tsx')
check(/showSkeleton \?[\s\S]{0,400}<ChatLoadingMask/.test(stream), '로딩 중에는 항상 마스크(메시지 0개여도 빈 화면 아님)')

const scroll = read('components/stream/useStreamScroll.ts')
check(/phase === 'fetching' && pendingAnchor\.current != null/.test(scroll), '응답 대기 중 스크롤마다 기준점 갱신')
check(/dispatch\(\{ type: 'fetched'/.test(scroll), '응답 뒤 상태기계에 결과 통지(대기 해제)')
check(!/fetchingOlderRef|olderAutoFailRef|emptySearchInFlightRef/.test(scroll), '흩어진 대기·실패 ref는 상태기계로 모였다')
check(scroll.includes('createAnchorFixer(a.top)'), '앵커 보정은 순수 함수 createAnchorFixer를 쓴다(계산은 scrollAnchor.test.ts가 지킨다)')

console.log(`\n${fail === 0 ? '✅' : '❌'} loadingMask: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
