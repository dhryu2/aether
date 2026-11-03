import { reportClientError } from './errorReporting'
// 같은 일을 여러 장으로 시작 — 화면이 있는 만들기·보내기 문을 순서대로 여러 번 부른다.
// 새 묶음 REST는 없다. 한 장이 실패해도 이미 만든 장은 지우지 않는다.

export type FanoutCreateInput = {
  provider: string
  cwd?: string
  model?: string
  isolateWorkspace?: boolean
  name?: string
}

export type FanoutCreated = { provider: string; id: string }
export type FanoutFailed = { provider: string; error: string; phase: 'create' | 'send' }

export type FanoutResult = {
  created: FanoutCreated[]
  failed: FanoutFailed[]
  firstId: string | null
}

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e)
}

/**
 * 고른 서비스마다 세션 한 장을 만들고, 만들기에 성공한 장에만 같은 글을 보낸다.
 * 순서는 호출자가 준 providers 그대로다. 삭제는 없다.
 */
export async function startSameWorkFanout(opts: {
  providers: readonly string[]
  prompt: string
  base: Omit<FanoutCreateInput, 'provider'>
  create: (input: FanoutCreateInput) => Promise<{ id: string }>
  send?: (id: string, text: string) => Promise<void>
}): Promise<FanoutResult> {
  const created: FanoutCreated[] = []
  const failed: FanoutFailed[] = []
  const text = opts.prompt.trim()
  for (const provider of opts.providers) {
    if (!provider) continue
    let id: string
    try {
      const r = await opts.create({ ...opts.base, provider })
      id = r.id
    } catch (e) {
      reportClientError(e, { component: 'session', operation: 'web.fanout.create' })
      failed.push({ provider, error: errText(e), phase: 'create' })
      continue
    }
    if (!id) {
      failed.push({ provider, error: 'empty id', phase: 'create' })
      continue
    }
    created.push({ provider, id })
    if (!text || !opts.send) continue
    try {
      await opts.send(id, text)
    } catch (e) {
      failed.push({ provider, error: errText(e), phase: 'send' })
    }
  }
  return { created, failed, firstId: created[0]?.id ?? null }
}
