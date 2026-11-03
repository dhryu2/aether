/**
 * 화면 작업 제목 폴백.
 * 실행: npx tsx web/test/workTitle.test.ts
 */
import { previewFromConvo, sessionWorkTitle } from '../src/lib/workTitle'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

check('displayName을 그대로 쓴다', sessionWorkTitle({ displayName: '로그인 수정' }, '새 작업') === '로그인 수정')
check('빈 이름은 새 작업', sessionWorkTitle({ displayName: '' }, '새 작업') === '새 작업')
check('공백도 새 작업', sessionWorkTitle({ displayName: '  ' }, '새 작업') === '새 작업')
check('대화 마지막 사용자 말', previewFromConvo([{ kind: 'user_msg', text: '로그인 고쳐줘' }]) === '로그인 고쳐줘')
check('모델 본문이 있으면 그걸 쓴다', previewFromConvo([
  { kind: 'user_msg', text: '질문' },
  { kind: 'agent', events: [{ type: 'text', text: '고쳤습니다' }] },
]) === '고쳤습니다')
check('빈 대화는 미리보기 없음', previewFromConvo([]) === '')

console.log('─'.repeat(50))
console.log(`workTitle: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
