/**
 * sseTransport — 잘린 청크·named·복수 data·close 취소·재연결 since·Bearer.
 *   실행: npx tsx web/test/sseTransport.test.ts
 */
import { setClientToken } from '../src/lib/clientAuth'
import { openSse } from '../src/lib/sseTransport'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function streamFromChunks(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      controller.enqueue(chunks[i++]!)
    },
  })
}

const enc = new TextEncoder()

// 1) 한 프레임을 두 청크로 자름
{
  setClientToken('tok')
  const full = 'data: {"seq":1}\n\n'
  const mid = Math.floor(full.length / 2)
  const chunks = [enc.encode(full.slice(0, mid)), enc.encode(full.slice(mid))]
  const messages: string[] = []
  let opened = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(streamFromChunks(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
  const h = openSse({
    url: '/api/x?since=0',
    onOpen: () => {
      opened++
    },
    onMessage: (d) => messages.push(d),
  })
  await new Promise((r) => setTimeout(r, 50))
  h.close()
  globalThis.fetch = origFetch
  check('잘린 청크도 onMessage 1회', messages.length === 1 && messages[0] === '{"seq":1}')
  check('JSON 복원', JSON.parse(messages[0]!).seq === 1)
  check('onOpen 1', opened === 1)
}

// 2) named ping / caught_up
{
  setClientToken('tok')
  const body = 'event: ping\ndata:\n\nevent: caught_up\ndata: {"ok":true}\n\n'
  const named: Array<{ n: string; d: unknown }> = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(streamFromChunks([enc.encode(body)]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
  const h = openSse({
    url: '/api/x?since=0',
    onNamed: (n, d) => named.push({ n, d }),
  })
  await new Promise((r) => setTimeout(r, 50))
  h.close()
  globalThis.fetch = origFetch
  check('named ping', named.some((x) => x.n === 'ping'))
  check(
    'named caught_up + JSON',
    named.some((x) => x.n === 'caught_up' && x.d && typeof x.d === 'object' && (x.d as { ok: boolean }).ok === true),
  )
}

// 3) 같은 이벤트에 data: 두 줄 → \n join
{
  setClientToken('tok')
  // 깨진 예(실행하지 않음): data: {"a":1\ndata: ,"b":2}\n\n
  // 스펙대로 두 data 줄을 join:
  const body2 = 'data: hello\ndata: world\n\n'
  let msg = ''
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(streamFromChunks([enc.encode(body2)]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
  const h = openSse({
    url: '/api/x?since=0',
    onMessage: (d) => {
      msg = d
    },
  })
  await new Promise((r) => setTimeout(r, 50))
  h.close()
  globalThis.fetch = origFetch
  check('복수 data 줄은 \\n join', msg === 'hello\nworld')
}

// 4+5) close 후 청크가 onMessage를 부르면 실패 / done 후 재 openSse
{
  setClientToken('tok')
  let messages = 0
  let pulls = 0
  const slow = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(enc.encode('data: {"seq":1}\n\n'))
        return
      }
      await new Promise((r) => setTimeout(r, 80))
      try {
        controller.enqueue(enc.encode('data: {"seq":2}\n\n'))
        controller.close()
      } catch {
        /* cancelled */
      }
    },
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(slow, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch
  const h = openSse({
    url: '/api/x?since=0',
    onMessage: () => {
      messages++
    },
  })
  await new Promise((r) => setTimeout(r, 30))
  h.close()
  await new Promise((r) => setTimeout(r, 120))
  globalThis.fetch = origFetch
  check('close 뒤 추가 청크는 onMessage 안 함', messages === 1)
}

// 6) 재연결 since= getSince() 현재값
{
  setClientToken('tok')
  const sinceSeen: string[] = []
  const authSeen: string[] = []
  let seq = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const m = /since=(\d+)/.exec(url)
    if (m) sinceSeen.push(m[1]!)
    const ah = new Headers(init?.headers).get('Authorization')
    if (ah) authSeen.push(ah)
    check('URL에 token= 없음', !/[?&]token=/.test(url))
    const body =
      seq === 0
        ? 'data: {"seq":4}\n\n'
        : 'data: {"seq":5}\n\n'
    seq++
    return new Response(streamFromChunks([enc.encode(body)]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch

  let lastSeq = 0
  const getSince = () => lastSeq
  const connect = () =>
    openSse({
      url: `/api/sessions/x/stream?since=${getSince()}`,
      onMessage: (d) => {
        try {
          lastSeq = JSON.parse(d).seq
        } catch {
          /* */
        }
      },
      onError: () => {
        /* done → 재연결은 아래에서 */
      },
    })

  const h1 = connect()
  await new Promise((r) => setTimeout(r, 40))
  h1.close()
  check('첫 연결 since=0', sinceSeen[0] === '0')
  check('메시지 seq 4 수신', lastSeq === 4)
  const h2 = connect()
  await new Promise((r) => setTimeout(r, 40))
  h2.close()
  globalThis.fetch = origFetch
  check('재연결 since=4', sinceSeen[1] === '4')
  check('매 연결 Authorization Bearer', authSeen.length >= 2 && authSeen.every((a) => a === 'Bearer tok'))
}

setClientToken(undefined)
console.log(`\n${fail === 0 ? '✅' : '❌'} sseTransport: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
