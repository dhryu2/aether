import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

const pane = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/shell/ConversationPane.tsx'),
  'utf8',
)
check(!pane.includes('data-copy-policy'), '대화 칸에 복사본 배지가 없다')
check(!pane.includes("kind === 'channel'"), '대화 칸에 채널 가지가 없다')
check(!/patchBot\([^)]*isolate/.test(pane), '채널 입장 isolate PATCH 0')

console.log(`\n${fail === 0 ? '✅' : '❌'} isolateDisplay: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
