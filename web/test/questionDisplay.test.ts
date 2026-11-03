/**
 * 질문 카드 제목/본문 승격. 실행: npx tsx web/test/questionDisplay.test.ts
 */
import { questionBody, questionHeaderTitle, showSecondaryHeader } from '../src/lib/questionDisplay'
import type { AetherQuestion } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++; else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const q = (partial: Partial<AetherQuestion> & Pick<AetherQuestion, 'question'>): AetherQuestion => ({
  options: [],
  ...partial,
})

check('본문이 있으면 본문을 쓴다', questionBody(q({ question: '어떤 방식으로 할까요?', header: '진행 방식' })) === '어떤 방식으로 할까요?')
check('본문이 비면 헤더를 승격한다', questionBody(q({ question: '  ', header: '진행 방식' })) === '진행 방식')
check('둘 다 비면 빈 문자열', questionBody(q({ question: '' })) === '')
check('헤더가 본문과 다르면 제목은 헤더', questionHeaderTitle(q({ question: '어떤 방식으로 할까요?', header: '진행 방식' }), '질문') === '진행 방식')
check('헤더가 본문과 같으면 제목은 폴백', questionHeaderTitle(q({ question: '진행 방식', header: '진행 방식' }), '질문') === '질문')
check('헤더가 없으면 제목은 폴백', questionHeaderTitle(q({ question: '골라 주세요' }), '질문') === '질문')
check('두 번째 질문 헤더는 본문과 다를 때만', showSecondaryHeader(q({ question: '색?', header: '색상' })) === true)
check('두 번째 질문 헤더가 본문과 같으면 숨긴다', showSecondaryHeader(q({ question: '색상', header: '색상' })) === false)

console.log(`\n${fail === 0 ? '✅' : '❌'} questionDisplay: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
