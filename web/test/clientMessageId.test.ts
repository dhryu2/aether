/**
 * pickClientMessageId — 실패 fill 재사용 / 성공 후 새 UUID / 다른 text면 새 UUID.
 */
import { pickClientMessageId } from '../src/lib/clientMessageId.ts'

let pass = 0
let fail = 0
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`)
  if (cond) pass++; else fail++
}

{
  const name = '실패 fill 재사용'
  const id = pickClientMessageId({
    sessionId: 's1',
    text: 'hello',
    fill: { id: 's1', text: 'hello', clientMessageId: 'reuse-me' },
  })
  check(id === 'reuse-me', name)
}

{
  const name = '성공 후 새 UUID'
  const id = pickClientMessageId({
    sessionId: 's1',
    text: 'hello',
    fill: null,
  })
  check(typeof id === 'string' && id.length > 10, `${name} · 형태`)
  const id2 = pickClientMessageId({ sessionId: 's1', text: 'hello', fill: null })
  check(id !== id2, `${name} · 매번 다름`)
}

{
  const name = '다른 text면 새 UUID'
  const id = pickClientMessageId({
    sessionId: 's1',
    text: 'other',
    fill: { id: 's1', text: 'hello', clientMessageId: 'reuse-me' },
  })
  check(id !== 'reuse-me', name)
}

console.log(`\nclientMessageId: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
