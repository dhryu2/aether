/**
 * 대화 보기 모드 파싱. 실행: npx tsx web/test/transcriptView.test.ts
 */
import { nextTranscriptView, parseTranscriptView } from '../src/lib/transcriptView'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++; else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

check('없는 값은 보통', parseTranscriptView(null) === 'normal')
check('이상한 값은 보통', parseTranscriptView('debug') === 'normal')
check('자세히를 보존', parseTranscriptView('verbose') === 'verbose')
check('요약을 보존', parseTranscriptView('summary') === 'summary')
check('순환 보통→자세히', nextTranscriptView('normal') === 'verbose')
check('순환 자세히→요약', nextTranscriptView('verbose') === 'summary')
check('순환 요약→보통', nextTranscriptView('summary') === 'normal')

console.log(`\n${fail === 0 ? '✅' : '❌'} transcriptView: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
