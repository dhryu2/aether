/**
 * 뒤 작업 띠 안내문.
 *   실행: npx tsx web/test/backgroundTasks.test.ts
 */
import { backgroundAnnouncement } from '../src/lib/backgroundTasks'

let pass = 0
let fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`)
}

// 키 끝과 n을 이어 붙이는 가짜 번역 — 어떤 문장을 골랐는지 본다.
const tr = (k: string, p?: Record<string, string | number>) => `${k.replace('composer.background.announce.', '')}:${p?.n ?? ''}`

check('늘면 진행 중 개수를 알린다', backgroundAnnouncement(0, 2, tr), 'more:2')
check('1에서 3으로 늘어도 같은 문장', backgroundAnnouncement(1, 3, tr), 'more:3')
check('줄면 남은 개수를 알린다', backgroundAnnouncement(3, 2, tr), 'less:2')
check('0이 되면 모두 끝남', backgroundAnnouncement(2, 0, tr), 'none:')
check('같으면 빈 글', backgroundAnnouncement(2, 2, tr), '')
check('0에서 0도 빈 글', backgroundAnnouncement(0, 0, tr), '')

console.log(`\n${fail === 0 ? '✅' : '❌'} backgroundTasks: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
