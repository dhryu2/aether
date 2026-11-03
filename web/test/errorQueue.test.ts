import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ErrorQueue, boundErrors, type QueueState, type ErrorQueueStore } from '../src/lib/errorQueue'
import type { ClientErrorInput } from '../../shared/errors'
const now = Date.now()
const event = (id: string): ClientErrorInput => ({ id, occurred_at: new Date(now).toISOString(), component: 'test', operation: 'test.failure', message: 'test' })
class Store implements ErrorQueueStore {
  state: QueueState = { rows: [], lost: 0 }; fail = false
  async change(fn: (s: QueueState) => QueueState) { if(this.fail) throw Error('quota'); this.state=fn(this.state); return this.state }
}
const many = { rows: Array.from({length: 1002}, (_, i) => ({event:event(String(i)),storedAt:now+i})), lost:0 }
assert.equal(boundErrors(many,now).rows.length,1000); assert.equal(boundErrors(many,now).lost,2)
assert.equal(boundErrors(many,now+8*86_400_000).rows.length,0)
const huge = { rows: Array.from({length: 100}, (_,i)=>({event:{...event(String(i)),message:'가'.repeat(50000)},storedAt:now+i})),lost:0 }
assert(boundErrors(huge,now).rows.length < 100)
const store = new Store(); let online=false; const sent = new Set<string>()
const send = async (e:ClientErrorInput) => { if(!online)return false;sent.add(e.id);return true }
const q1=new ErrorQueue(store,send,()=>now),q2=new ErrorQueue(store,send,()=>now)
await Promise.all([q1.add(event('a')),q2.add(event('b'))]); await q1.flush(); assert.equal(store.state.rows.length,2)
online=true; await Promise.all([q1.flush(),q2.flush()]); assert.equal(store.state.rows.length,0);assert.equal(sent.size,2)
store.fail=true;await q1.add(event('c'));assert(q1.status().storageFailed);assert.equal(q1.status().pending,1)
store.fail=false;await q1.flush();assert(sent.has('c'));assert.equal(q1.status().pending,0)
console.log('✅ 웹 대기열 개수·UTF-8 용량·7일·오프라인·같은 ID·동시 탭·저장소 실패 복구')

// 실제 API 실패가 화면 catch를 다시 지나도 대기열에 들어가지 않는다.
const { api, RequestTimeoutError } = await import('../src/lib/api')
const { installErrorReporting, reportClientError, clientErrorStatus, isExpectedClientError, flushClientErrors } = await import('../src/lib/errorReporting')
Object.defineProperty(globalThis, 'window', {value:{addEventListener(){}}, configurable:true})
// 탭이 숨겨진 동안 재전송 주기가 멈추는지 보려고 문서의 보임 상태와 이벤트 등록을 흉내 낸다.
const documentStub = { visibilityState: 'visible', listeners: [] as (() => void)[], addEventListener(_t: string, fn: () => void) { this.listeners.push(fn) } }
Object.defineProperty(globalThis, 'document', {value:documentStub, configurable:true})
Object.defineProperty(globalThis, 'navigator', {value:{onLine:false}, configurable:true})
const interval = globalThis.setInterval
const originalFetch = globalThis.fetch
const timers = { started: 0, cleared: 0 }
globalThis.setInterval = (() => ++timers.started) as unknown as typeof setInterval
const clearInterval0 = globalThis.clearInterval
globalThis.clearInterval = (() => { timers.cleared++ }) as unknown as typeof clearInterval
try {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  installErrorReporting()
  // 보이는 동안 주기가 돌고, 숨기면 멈추고, 다시 보이면 재개한다.
  assert.equal(timers.started,1)
  documentStub.visibilityState='hidden'; documentStub.listeners.forEach(fn=>fn())
  assert.equal(timers.cleared,1)
  documentStub.visibilityState='visible'; documentStub.listeners.forEach(fn=>fn())
  assert.equal(timers.started,2)
  documentStub.listeners.forEach(fn=>fn())
  assert.equal(timers.started,2,'이미 도는 중이면 주기를 겹쳐 만들지 않는다')
  for (let i=0;i<3;i++) {
    try { await api.health() } catch(e) { reportClientError(e) }
  }
  Object.defineProperty(globalThis, 'navigator', {value:{onLine:true}, configurable:true})
  for (const error of [new TypeError('Load failed'), new DOMException('연결 실패','NetworkError'), new DOMException('시간 초과','AbortError')]) {
    globalThis.fetch = async () => { throw error }
    try { await api.health() } catch(e) { reportClientError(e) }
  }
  reportClientError(new RequestTimeoutError())
  await new Promise(r=>setTimeout(r,20))
  assert.equal(clientErrorStatus().pending,0)
  assert(isExpectedClientError(new RequestTimeoutError()))
  assert(!isExpectedClientError(Object.assign(new Error('구성 결함'), {status:400})))
  Object.defineProperty(globalThis, 'navigator', {value:{onLine:true}, configurable:true})
  globalThis.fetch = async () => { throw new TypeError('잘못 만든 요청 헤더') }
  try { await api.health() } catch(e) { reportClientError(e) }
  await new Promise(r=>setTimeout(r,20))
  assert.equal(clientErrorStatus().pending,1)
  reportClientError(new Error('해석 실패'))
  await new Promise(r=>setTimeout(r,20))
  assert.equal(clientErrorStatus().pending,2)
  globalThis.fetch = async () => new Response('{"error":"서비스 장애"}', {status:503, headers:{'X-Aether-Error-Origin':'external_environment'}})
  try { await api.health() } catch(e) { reportClientError(e) }
  globalThis.fetch = async () => new Response('{"error":"정상 기능 거절"}', {status:501, headers:{'X-Aether-Error-Origin':'user_action'}})
  try { await api.health() } catch(e) { reportClientError(e) }
  await new Promise(r=>setTimeout(r,20))
  assert.equal(clientErrorStatus().pending,2)
  globalThis.fetch = async () => new Response('{"error":"서버 결함"}', {status:500, headers:{'X-Aether-Error-Origin':'aether_defect'}})
  try { await api.health() } catch(e) { reportClientError(e) }
  await new Promise(r=>setTimeout(r,20))
  assert.equal(clientErrorStatus().pending,3,'결함 원인 표시는 수집 제외 표시가 아니다')

  // 실제 HTTP 전송기의 응답 판정까지 통과시킨다. 수집 경로는 raw fetch만 쓴다.
  globalThis.fetch = async (_url, init) => new Response(JSON.stringify({id:JSON.parse(String(init?.body)).id,durable:true}))
  await flushClientErrors()
  assert.equal(clientErrorStatus().pending,0)
  for (const status of [400,413]) {
    await test(`HTTP ${status} 머리 건을 제거하고 다음 정상 건을 전달한다`, async () => {
      const sent: unknown[] = []
      const before = clientErrorStatus().rejected
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)); sent.push(body)
        return sent.length === 1 ? new Response('{}',{status}) : new Response(JSON.stringify({id:body.id,durable:true}))
      }
      reportClientError(new Error(`영구 거절 ${status}`))
      reportClientError(new Error(`뒤 정상 ${status}`))
      await new Promise(r=>setTimeout(r,30))
      await flushClientErrors()
      assert.equal(clientErrorStatus().pending,0,'영구 거절 머리 건이 뒤를 막지 않는다')
      assert.equal(sent.length,2)
      assert.equal(clientErrorStatus().rejected,before+1)
      await flushClientErrors()
      assert.equal(sent.length,2,'영구 거절을 다시 수집하거나 전송하지 않는다')
    })
  }
  for (const failure of [500,503,429,'network','unconfirmed'] as const) {
    await test(`HTTP 일시 실패 ${failure}에서는 머리 건에서 멈춘다`, async () => {
      const ids: string[] = []
      const before = clientErrorStatus().rejected
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)); ids.push(body.id)
        if (failure==='network') throw new TypeError('Failed to fetch')
        if (failure==='unconfirmed') return new Response(JSON.stringify({id:body.id,durable:false}))
        return new Response('{}',{status:failure})
      }
      reportClientError(new Error(`첫 실패 ${failure}`))
      reportClientError(new Error(`뒤 정상 ${failure}`))
      await new Promise(r=>setTimeout(r,30))
      await flushClientErrors()
      assert.equal(clientErrorStatus().pending,2)
      assert.equal(new Set(ids).size,1,'뒤 행은 아직 보내지 않는다')
      assert.equal(clientErrorStatus().rejected,before)
      globalThis.fetch = async (_url, init) => new Response(JSON.stringify({id:JSON.parse(String(init?.body)).id,durable:true}))
      await flushClientErrors(); assert.equal(clientErrorStatus().pending,0)
    })
  }
  await test('문자열이 아닌 message도 문자열로 정규화해 보낸다', async () => {
    const messages: unknown[] = []
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); messages.push(body.message)
      return new Response(JSON.stringify({id:body.id,durable:true}))
    }
    reportClientError({message:42})
    await new Promise(r=>setTimeout(r,30))
    assert.deepEqual(messages,['42'])
  })
} finally { globalThis.setInterval=interval; globalThis.clearInterval=clearInterval0; globalThis.fetch=originalFetch }

for (const result of ['rejected',false,'network'] as const) {
  await test(`웹 대기열 전송 결과 ${result}: 뒤 행 처리와 집계를 구분한다`, async () => {
    const store = new Store(), attempts: string[] = []
    const queue = new ErrorQueue(store, async e => {
      attempts.push(e.id)
      if (e.id === 'bad') { if (result === 'network') throw new TypeError('Failed to fetch'); return result }
      return true
    },()=>now)
    await queue.add(event('bad')); await queue.add(event('good'))
    await queue.flush()
    assert.deepEqual(attempts,result==='rejected'?['bad','good']:['bad'])
    assert.equal(queue.status().pending,result==='rejected'?0:2)
    assert.equal(queue.status().rejected,result==='rejected'?1:0)
    assert.equal(queue.status().lost,0)
    if (result==='rejected') {
      await queue.flush()
      assert.equal(queue.status().rejected,1)
      const restored = new ErrorQueue(store,async()=>true,()=>now)
      await restored.flush(); assert.equal(restored.status().rejected,1,'저장소를 다시 읽어도 집계를 유지한다')
    }
  })
}


await test('여러 탭이 같은 영구 거절을 받아도 한 번만 집계한다', async () => {
  const store = new Store()
  const first = new ErrorQueue(store,async()=>'rejected',()=>now)
  const second = new ErrorQueue(store,async()=>'rejected',()=>now)
  await first.add(event('shared'))
  await Promise.all([first.flush(),second.flush()])
  assert.equal(store.state.rejected,1)
  assert.equal(store.state.rows.length,0)
})

await test('저장소 장애 중 영구 거절 집계를 복구 시 합친다', async () => {
  const store = new Store(); store.fail=true
  const queue = new ErrorQueue(store,async()=>'rejected',()=>now)
  await queue.add(event('fallback'))
  await queue.flush()
  assert.equal(queue.status().rejected,1)
  assert.equal(queue.status().pending,0)
  store.fail=false
  await queue.flush()
  assert.equal(queue.status().rejected,1)
  assert.equal(queue.status().lost,0)
  assert.equal(store.state.rejected,1)
})

// 웹 기능 경계의 실패 주입. 실제 수집 대기열을 거쳐 전송된 원래 오류를 확인한다.
{
  const { drafts } = await import('../src/lib/drafts')
  const { rememberPrompt } = await import('../src/lib/promptHistory')
  const rows: ClientErrorInput[] = []
  const previousFetch = globalThis.fetch
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const localDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let failure: unknown
  const storage = {
    getItem: () => '{}',
    setItem: () => { if (failure) throw failure },
  }
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  const delivered = async () => {
    await new Promise(r => setTimeout(r, 20))
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
    await flushClientErrors()
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
  }
  globalThis.fetch = async (_url, init) => {
    const row = JSON.parse(String(init?.body)); rows.push(row)
    return new Response(JSON.stringify({ id: row.id, durable: true }))
  }
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
  try {
    for (const [name, write] of [
      ['drafts', () => drafts.set('session-test', '초안')],
      ['history', () => rememberPrompt('session-test', '문장')],
    ] as const) {
      await test(`웹 ${name}: 소유 저장 실패는 첫 건만 error, 성공 뒤 다시 수집한다`, async () => {
        rows.length = 0
        failure = new Error(`${name} 저장 실패`)
        write(); write(); failure = new Error(`${name} 저장 실패 반복`); write()
        await delivered()
        assert.equal(rows.length, 1)
        assert.match(rows[0].message, /저장 실패$/)
        assert.match(rows[0].stack!, /Error: .*저장 실패/)
        assert.match(rows[0].operation, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/)
        failure = undefined; write()
        failure = new Error(`${name} 복구 뒤 실패`); write()
        await delivered()
        assert.equal(rows.length, 2)
        failure = undefined; write()
      })
    }
    await test('웹 저장소 지원 제한과 선택적 저장값 부재·JSON 대안은 미수집이다', async () => {
      rows.length = 0
      for (const name of ['SecurityError', 'QuotaExceededError']) {
        failure = new DOMException('브라우저 저장 제한', name)
        drafts.set('session-test', '초안'); rememberPrompt('session-test', '문장')
      }
      failure = undefined
      await delivered()
      assert.equal(rows.length, 0)
    })
    await test('성공 응답 JSON 손상도 화면이 삼키기 전에 수집한다', async () => {
      rows.length = 0
      const send = globalThis.fetch
      globalThis.fetch = async (url, init) => String(url) === '/api/errors' ? send(url, init) : new Response('{broken')
      for (let i = 0; i < 3; i++) {
        try { await api.health() } catch { /* 화면이 별도 수집 없이 실패 상태만 표시한다. */ }
      }
      await delivered()
      assert.equal(rows.length, 1)
      assert.match(rows[0].message, /JSON|property/i)
      globalThis.fetch = async (url, init) => String(url) === '/api/errors' ? send(url, init) : new Response('{}')
      await api.health()
      globalThis.fetch = async (url, init) => String(url) === '/api/errors' ? send(url, init) : new Response('{broken')
      try { await api.health() } catch { /* 복구 뒤 재발도 화면 흐름은 같다. */ }
      await delivered()
      assert.equal(rows.length, 2)
      globalThis.fetch = send
    })
  } finally {
    globalThis.fetch = previousFetch
    if (sessionDescriptor) Object.defineProperty(globalThis, 'sessionStorage', sessionDescriptor)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
    if (localDescriptor) Object.defineProperty(globalThis, 'localStorage', localDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

await test('fetch 스트림의 연결 실패·취소는 제외하고 내부 콜백 예외는 수집한다', async () => {
  const { openSse } = await import('../src/lib/sseTransport')
  const { setClientToken } = await import('../src/lib/clientAuth')
  const rows: ClientErrorInput[] = []
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  setClientToken('test-token')
  let failure: unknown
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/errors') {
      const row = JSON.parse(String(init?.body)); rows.push(row)
      return new Response(JSON.stringify({ id: row.id, durable: true }))
    }
    if (failure) throw failure
    return new Response('data: {}\n\n')
  }
  try {
    for (const error of [new TypeError('Failed to fetch'), new DOMException('취소', 'AbortError')]) {
      failure = error
      const handle = openSse({ url: '/api/test/stream' })
      await new Promise(r => setTimeout(r, 20)); handle.close()
    }
    assert.equal(rows.length, 0)
    failure = undefined
    const defect = new TypeError('스트림 화면 상태 갱신 결함')
    for (let i = 0; i < 3; i++) {
      const handle = openSse({ url: '/api/test/stream', sessionId: 'stream-session', onMessage: () => { throw i ? new TypeError(defect.message) : defect } })
      await new Promise(r => setTimeout(r, 20)); handle.close()
    }
    await flushClientErrors()
    assert.equal(rows.length, 1, '재연결해도 같은 통로의 실패를 억제한다')
    assert.equal(rows[0].session_id, 'stream-session')
    assert.equal(rows[0].message, defect.message)
    assert.equal(rows[0].stack, defect.stack)
    const success = openSse({ url: '/api/test/stream' })
    await new Promise(r => setTimeout(r, 20)); success.close()
    const again = openSse({ url: '/api/test/stream', onMessage: () => { throw new Error('복구 뒤 실패') } })
    await new Promise(r => setTimeout(r, 20)); again.close()
    await flushClientErrors()
    assert.equal(rows.length, 2)
  } finally { setClientToken(undefined); globalThis.fetch = previousFetch }
})

// 기능을 줄여 계속하는 지점은 warning 등급으로 큐에 들어가고, 반복은 억제하며, 외부 원인은 제외한다.
await test('기능 축소 지점의 실패는 severity warning으로 수집한다', async () => {
  const { openStream, openPresenceStream } = await import('../src/lib/sse')
  const { showDesktopNotification } = await import('../src/lib/desktopShell')
  const { setClientToken } = await import('../src/lib/clientAuth')
  const rows: ClientErrorInput[] = []
  const previousFetch = globalThis.fetch
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }, configurable: true })
  Object.defineProperty(globalThis, 'window', { value: { addEventListener() {}, removeEventListener() {} }, configurable: true })
  setClientToken('test-token')
  let frames = ''
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/errors') {
      const row = JSON.parse(String(init?.body)); rows.push(row)
      return new Response(JSON.stringify({ id: row.id, durable: true }))
    }
    return new Response(frames)
  }
  const settle = async () => { await new Promise(r => setTimeout(r, 30)); await flushClientErrors() }
  try {
    // 손상된 주의 사건 프레임: 반복돼도 첫 건만, 정상 프레임 뒤 재발은 다시 수집한다.
    frames = 'data: {broken\n\ndata: {broken again\n\n'
    const presence = openPresenceStream(() => {}, () => {})
    await settle(); presence.close()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].severity, 'warning')
    assert.equal(rows[0].operation, 'web.presence.update')
    assert.match(rows[0].stack!, /SyntaxError/)

    // 대화 스트림: 이벤트 적용 실패는 세션 번호와 함께 warning이다.
    rows.length = 0
    frames = 'data: {broken\n\n'
    const stream = openStream('warn-session', () => 0, () => {}, () => {}, () => {}, () => {})
    await settle(); stream.close()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].severity, 'warning')
    assert.equal(rows[0].session_id, 'warn-session')

    // 데스크톱 껍데기 알림 실패: 외부 원인 표시가 있으면 제외한다.
    rows.length = 0
    Object.defineProperty(globalThis, 'window', { value: { __TAURI__: { core: { invoke: async () => { throw new Error('알림 호출 결함') } } } }, configurable: true })
    showDesktopNotification({ title: 't', body: 'b' })
    await settle()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].severity, 'warning')
    assert.equal(rows[0].message, '알림 호출 결함')
    rows.length = 0
    Object.defineProperty(globalThis, 'window', { value: { __TAURI__: { core: { invoke: async () => { throw Object.assign(new Error('OS 알림 거부'), { errorOrigin: 'external_environment' }) } } } }, configurable: true })
    showDesktopNotification({ title: 't', body: 'b' })
    await settle()
    assert.equal(rows.length, 0)

    // 등급을 지정하지 않은 일반 수집은 등급 필드가 없다(서버가 error로 저장한다).
    reportClientError(new Error('일반 실패'))
    await settle()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].severity, undefined)
  } finally {
    setClientToken(undefined); globalThis.fetch = previousFetch
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
