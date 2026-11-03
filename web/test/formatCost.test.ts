import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatCostUsd } from '../src/lib/formatCost'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

check(formatCostUsd(undefined) === null, 'undefined → null')
check(formatCostUsd(null) === null, 'null → null')
check(formatCostUsd(Number.NaN) === null, 'NaN → null')
check(formatCostUsd('1') === null, '문자열 → null')
check(formatCostUsd(0) === '$0.00', '0은 값')
check(formatCostUsd(1.5) === '$1.50', '1.5')

const root = path.dirname(fileURLToPath(import.meta.url))
const status = fs.readFileSync(path.join(root, '../src/components/SessionStatus.tsx'), 'utf8')
check(status.includes('chromeSessionId'), 'SessionStatus chromeSessionId')
check(status.includes('formatCostUsd('), 'SessionStatus formatCostUsd(')
check(!/const id = s\.activeId/.test(status), 'getUsage에 activeId 직접 금지')
const costBlock = status.slice(status.indexOf('formatCostUsd'))
const costLine = costBlock.split('\n').slice(0, 8).join('\n')
check(!/costUsd\s*\?\?\s*0/.test(costLine), '비용 줄 ?? 0 금지', costLine)

console.log(`\n${fail === 0 ? '✅' : '❌'} formatCost: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
