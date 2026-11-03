import type { ConvoItem } from '../lib/store'
import { ctxPctFromTokens } from '../lib/format'
import { lastUsageOf } from '../lib/agentEvents'
import type { AetherEvent } from '../lib/types'

export function ctxOf(items: ConvoItem[] | undefined): number | null {
  const wire = items?.filter((e): e is AetherEvent => e.kind !== 'local_user' && e.kind !== 'local_notice')
  const usage = lastUsageOf(wire)
  return usage ? ctxPctFromTokens(usage.totalTokens, usage.maxTokens) : null
}
