/**
 * 같은 일 여러 장 시작 — 만들기·보내기 순서와 부분 실패.
 *   실행: npx tsx web/test/fanoutStart.test.ts
 */
import { startSameWorkFanout } from '../src/lib/fanoutStart'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

{
  const creates: { provider: string; isolate?: boolean }[] = []
  const sends: { id: string; text: string }[] = []
  const r = await startSameWorkFanout({
    providers: ['claude', 'grok'],
    prompt: '같은 글',
    base: { cwd: '/work', isolateWorkspace: true },
    create: async (input) => {
      creates.push({ provider: input.provider, isolate: input.isolateWorkspace })
      return { id: `id-${input.provider}` }
    },
    send: async (id, text) => { sends.push({ id, text }) },
  })
  check('서비스 둘이면 세션 두 장', r.created.length === 2 && r.firstId === 'id-claude', r)
  check('같은 글이 두 장에 간다', sends.length === 2 && sends.every((s) => s.text === '같은 글'), sends)
  check('카탈로그 순서대로 만든다', creates.map((c) => c.provider).join(',') === 'claude,grok', creates)
  check('복사본 켜짐을 각 장에 넘긴다', creates.every((c) => c.isolate === true), creates)
}

{
  const sends: string[] = []
  const r = await startSameWorkFanout({
    providers: ['claude', 'grok', 'codex'],
    prompt: '같은 글',
    base: { isolateWorkspace: true },
    create: async (input) => {
      if (input.provider === 'grok') throw new Error('거절')
      return { id: `id-${input.provider}` }
    },
    send: async (id) => { sends.push(id) },
  })
  check('한 장 실패해도 나머지는 남긴다', r.created.map((c) => c.id).join(',') === 'id-claude,id-codex', r.created)
  check('실패한 장에는 글을 안 보낸다', sends.join(',') === 'id-claude,id-codex', sends)
  check('실패는 만들기 단계로 남긴다', r.failed.length === 1 && r.failed[0]?.phase === 'create' && r.failed[0]?.provider === 'grok', r.failed)
  check('첫 장은 성공한 첫 id', r.firstId === 'id-claude', r)
}

{
  const sends: string[] = []
  const r = await startSameWorkFanout({
    providers: ['claude', 'grok'],
    prompt: '   ',
    base: {},
    create: async (input) => ({ id: `id-${input.provider}` }),
    send: async (id) => { sends.push(id) },
  })
  check('빈 글이면 만들기만 한다', r.created.length === 2 && sends.length === 0, { created: r.created, sends })
}

{
  const creates: string[] = []
  const r = await startSameWorkFanout({
    providers: ['claude', 'grok'],
    prompt: '글',
    base: {},
    create: async () => { throw new Error('전부 실패') },
    send: async () => { creates.push('send') },
  })
  check('전부 실패면 만든 장이 없다', r.created.length === 0 && r.firstId === null, r)
  check('글을 보내지 않는다', creates.length === 0, creates)
  check('실패 두 건', r.failed.length === 2 && r.failed.every((f) => f.phase === 'create'), r.failed)
}

{
  const sends: string[] = []
  const r = await startSameWorkFanout({
    providers: ['claude', 'grok'],
    prompt: '글',
    base: {},
    create: async (input) => ({ id: `id-${input.provider}` }),
    send: async (id) => {
      sends.push(id)
      if (id === 'id-claude') throw new Error('전송 실패')
    },
  })
  check('보내기 실패도 장을 지우지 않는다', r.created.length === 2 && r.firstId === 'id-claude', r.created)
  check('다음 장에는 글을 계속 보낸다', sends.join(',') === 'id-claude,id-grok', sends)
  check('보내기 실패는 send로 남긴다', r.failed.length === 1 && r.failed[0]?.phase === 'send', r.failed)
}

{
  const order: string[] = []
  await startSameWorkFanout({
    providers: ['a', 'b'],
    prompt: '글',
    base: {},
    create: async (input) => {
      order.push(`c:${input.provider}`)
      return { id: input.provider }
    },
    send: async (id) => { order.push(`s:${id}`) },
  })
  check('한 장을 끝낸 뒤에 다음 장을 만든다', order.join(',') === 'c:a,s:a,c:b,s:b', order)
}

{
  let called = 0
  const r = await startSameWorkFanout({
    providers: [],
    prompt: '글',
    base: {},
    create: async () => { called += 1; return { id: 'x' } },
  })
  check('서비스가 없으면 호출이 없다', called === 0 && r.created.length === 0, r)
}

{
  const inputs: unknown[] = []
  await startSameWorkFanout({
    providers: ['claude'],
    prompt: '',
    base: { cwd: '/w', model: 'haiku', isolateWorkspace: true, name: '배포' },
    create: async (input) => { inputs.push(input); return { id: '1' } },
  })
  check(
    '공통 칸을 그대로 넘긴다',
    JSON.stringify(inputs[0]) === JSON.stringify({
      cwd: '/w',
      model: 'haiku',
      isolateWorkspace: true,
      name: '배포',
      provider: 'claude',
    }),
    inputs[0],
  )
}

console.log(`\n${fail === 0 ? '✅' : '❌'} fanoutStart: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
