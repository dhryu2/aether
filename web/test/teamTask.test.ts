/**
 * 자식 작업 카드 요약. 실행: npx tsx web/test/teamTask.test.ts
 */
import { failReasonPreview, teamTaskView } from '../src/lib/teamTask'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++; else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

{
  const view = teamTaskView(
    {
      name: 'Explore question answer UX',
      input: { subagent_type: 'explore', description: 'Explore question answer UX' },
      result: {
        content: 'Rejected: file edits are not allowed in plan mode - the only editable file is the plan file (`/tmp/plan.md`).',
        is_error: true,
      },
      key: 't1',
    },
    false,
  )
  check('거절은 실패다', view.status === 'failed', view.status)
  check('접힌 줄에 거절 문장이 있다', view.reason.includes('Rejected: file edits are not allowed in plan mode'), view.reason)
  check('접힌 줄에서 경로 괄호를 접는다', !view.reason.includes('/tmp/plan.md'), view.reason)
}

{
  const view = teamTaskView(
    {
      name: 'Explore',
      input: { subagent_type: 'explore', prompt: '코드를 읽어라' },
      result: { content: 'Rejected: file edits are not allowed in plan mode.' },
      key: 't2',
    },
    false,
  )
  check('is_error가 없어도 Rejected는 실패다', view.status === 'failed', view.status)
}

{
  const s = failReasonPreview('Rejected: no. (/Users/me/very/long/path/plan.md).')
  check('미리보기는 한 줄이다', !s.includes('\n') && s.startsWith('Rejected:'), s)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} teamTask: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
