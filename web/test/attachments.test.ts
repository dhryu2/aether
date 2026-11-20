/**
 * 글 파일 첨부 규칙 — 형식 정보 없는 .log 분류, UTF-8 해독, NUL·비UTF-8 거절.
 *   실행: npx tsx web/test/attachments.test.ts
 */
import { ACCEPT_ALL, classify, parseFiles } from '../src/lib/attachments'

let pass = 0
let fail = 0
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`)
  if (cond) pass++; else fail++
}

check(classify(new File(['x'], 'a.log')) === 'text', '형식 정보 없는 a.log는 글')
check(classify(new File(['x'], 'a.jsonl')) === 'text', 'jsonl은 글')
check(ACCEPT_ALL.split(',').includes('.log'), 'ACCEPT_ALL에 .log')

const ko = await parseFiles([new File(['안녕 세계\n'], 'a.txt')])
check(!ko.rejected && ko.parsed[0]?.data === '안녕 세계\n', '한국어 UTF-8 원문 그대로')

const nul = await parseFiles([new File([new Uint8Array([0x61, 0, 0x62])], 'a.txt')])
check(nul.rejected && nul.parsed.length === 0, 'NUL 파일 거절')

const bad = await parseFiles([new File([new Uint8Array([0xff, 0xfe])], 'a.txt')])
check(bad.rejected && bad.parsed.length === 0, '0xff 0xfe 파일 거절')

console.log(`\n${fail === 0 ? '✅' : '❌'} attachments: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
