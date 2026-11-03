/** SSE 전송 — 토큰 있으면 fetch+스트림, 없으면 EventSource. 질의에 token 금지. */
import { authHeaders, getClientToken } from './clientAuth'
import { classifyTransportError } from './api'
import { isExpectedClientError } from './errorReporting'
import { createClientErrorReporter } from './errors'

// 재연결 때도 같은 통로의 실패 억제를 유지하며, 사건을 정상 처리하면 해제한다.
const streamFailures = new Map<string, ReturnType<typeof createClientErrorReporter>>()

export type SseHandle = { close: () => void }

export type OpenSseOpts = {
  url: string
  sessionId?: string
  headers?: Record<string, string>
  onOpen?: () => void
  onMessage?: (data: string) => void
  onNamed?: (event: string, data?: unknown) => void
  onError?: () => void
  /** 스트림이 정상 종료(done)되면 호출. 재연결은 호출부 책임. */
  onDone?: () => void
}

function parseFrames(
  buffer: string,
  onMessage?: (data: string) => void,
  onNamed?: (event: string, data?: unknown) => void,
): string {
  let rest = buffer
  for (;;) {
    const sep = rest.indexOf('\n\n')
    if (sep < 0) break
    const raw = rest.slice(0, sep)
    rest = rest.slice(sep + 2)
    if (!raw.trim()) continue
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    const dataStr = dataLines.join('\n')
    if (eventName === 'message') {
      onMessage?.(dataStr)
    } else {
      let parsed: unknown = undefined
      if (dataStr.length) {
        try {
          parsed = JSON.parse(dataStr)
        } catch {
          // 이름 있는 사건의 data는 JSON 또는 일반 문자열일 수 있다.
          parsed = dataStr
        }
      }
      onNamed?.(eventName, parsed)
    }
  }
  return rest
}

function openEventSource(opts: OpenSseOpts): SseHandle {
  const es = new EventSource(opts.url)
  let closed = false
  es.onopen = () => opts.onOpen?.()
  es.onmessage = (e) => opts.onMessage?.(e.data)
  es.onerror = () => {
    if (closed) return
    opts.onError?.()
  }
  // named 이벤트는 addEventListener로 — 호출부가 onNamed만 쓰면 공통 훅이 없다.
  // openStream 등이 EventSource 분기를 쓸 때는 자체 리스너를 붙이므로,
  // 여기서는 message/error/open만 연결한다. named는 fetch 분기에서만 파싱한다.
  // 다만 EventSource에서도 ping 등을 받으려면 범용 훅이 필요하다.
  // 토큰 없는 경로에서는 기존처럼 호출부가 EventSource API를 쓰지 않고
  // 이 transport만 쓰므로, named를 위해 알려진 이름을 구독하지 않고
  // fetch와 동일한 onNamed를 쓰려면 polyfill이 필요하다.
  // → EventSource는 표준상 임의 named를 나열할 수 없어, 호출부가
  //   openSse의 onNamed를 쓰려면 fetch 분기(토큰 있음)이거나
  //   아래 공통 named 목록을 구독한다.
  const namedHook = (name: string) => (e: Event) => {
    const me = e as MessageEvent
    let parsed: unknown = undefined
    if (typeof me.data === 'string' && me.data.length) {
      try {
        parsed = JSON.parse(me.data)
      } catch {
        // 이름 있는 사건의 data는 JSON 또는 일반 문자열일 수 있다.
        parsed = me.data
      }
    }
    opts.onNamed?.(name, parsed)
  }
  for (const name of ['ping', 'caught_up', 'backlog_info', 'snapshot', 'board', 'generation']) {
    es.addEventListener(name, namedHook(name))
  }
  return {
    close() {
      closed = true
      es.close()
    },
  }
}

function openFetchStream(opts: OpenSseOpts): SseHandle {
  const resource = opts.url.split('?')[0]
  const ctrl = new AbortController()
  let closed = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const run = async () => {
    try {
      const headers: Record<string, string> = {
        ...authHeaders(),
        ...(opts.headers ?? {}),
        Accept: 'text/event-stream',
      }
      const res = await fetch(opts.url, {
        headers,
        credentials: 'same-origin',
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        if (!closed) opts.onError?.()
        return
      }
      opts.onOpen?.()
      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (closed) return
        if (done) {
          opts.onDone?.()
          if (!closed) opts.onError?.()
          return
        }
        buf += decoder.decode(value, { stream: true })
        const hasFrame = buf.includes('\n\n')
        buf = parseFrames(buf, opts.onMessage, opts.onNamed)
        if (hasFrame) streamFailures.delete(resource)
      }
    } catch (error) {
      const failure = classifyTransportError(error)
      if (!isExpectedClientError(failure)) {
        let reporter = streamFailures.get(resource)
        if (!reporter) {
          reporter = createClientErrorReporter({ component: 'stream', operation: 'web.stream.receive', session_id: opts.sessionId })
          if (streamFailures.size >= 1000) streamFailures.delete(streamFailures.keys().next().value!)
          streamFailures.set(resource, reporter)
        }
        reporter.report(failure)
      }
      if (!closed) opts.onError?.()
    }
  }
  void run()

  return {
    close() {
      closed = true
      ctrl.abort()
      void reader?.cancel().catch(() => { /* 이미 닫힌 스트림의 취소 실패는 정리에 무해하다. */ })
    },
  }
}

/**
 * 토큰이 있으면 fetch SSE, 없으면 EventSource(쿠키).
 * URL에 token 질의 금지.
 */
export function openSse(opts: OpenSseOpts): SseHandle {
  if (/[?&]token=/.test(opts.url)) {
    throw new Error('SSE URL에 token 질의를 붙이면 안 된다')
  }
  if (getClientToken()) return openFetchStream(opts)
  return openEventSource(opts)
}
