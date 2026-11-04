/**
 * sw.js 문자열 시험 — 실행 없이 소스만.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js'),
  'utf8',
)

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`)
  if (cond) pass++; else fail++
}

check('클릭 이동은 roomId 우선', /roomId\s*\|\|\s*data\.sessionId/.test(src) || /const roomId = data\.roomId \|\| data\.sessionId/.test(src))
check('알림에 승인·거부 버튼이 없다', !/actions/.test(src) && !/permissionId/.test(src) && !/api\/sessions/.test(src))
check('아이콘 경로 변경 없음(기존 icon)', src.includes('/icon-192.png'))

console.log(`\n${fail === 0 ? '✅' : '❌'} swNotify: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
