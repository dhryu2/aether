// 화면 시험용 가짜 provider. 프로세스도 네트워크도 없고, 사람이 보낸 글의 접두로만 움직인다.
//   (접두 없음) 글자 몇 개씩 흘려 보낸 뒤 같은 글을 말풍선으로 확정한다.
//   브리프로 보낸 글은 brief:사람글 로 확정한다. 규칙 본문은 모델 입력에만 있고 말풍선에는 넣지 않는다.
//   ASK:     권한 카드를 띄우고, 허락이면 allowed, 거절이면 denied.
//   Q:       질문 카드를 띄우고, 고른 답을 answered:라벨 로 돌려준다.
//   SLOW:    몇 초 기다렸다가 답을 낸다. 그 전에 멈추면 답을 내지 않는다.
//   HISTORY: 첫 화면이 꼬리만 받게 일부러 긴 대화를 만든다. 첫 줄은 old-, 마지막 줄은 new- 이다.
import { buildAgentEvents, type AgentEvent } from '../shared/agentEvent'
import type { PermissionMode } from '../shared/http'
import type { ProviderEventCodec, ProviderPersistFilter, EventShape } from '../server/sessions/codec/types'
import type { ProviderEntry } from '../server/providers/registry'
import type {
  AgentRuntime,
  ContextUsage,
  NormalizedUserInput,
  PermissionPolicy,
  ProviderServices,
  RuntimeCapabilities,
  RuntimeCommand,
  RuntimeCommandInvocation,
  RuntimeCommandResult,
  RuntimeHandshake,
  RuntimeStartOptions,
} from '../server/providers/types'
import type { AetherEvent, RawProviderEventBody, SessionEffort } from '../server/types'

export const E2E_PROVIDER = 'e2e'
/** 멈추기 단추가 보일 만큼 답을 늦춘다. 시험은 중단 안내가 나온 뒤 이 답이 없는지 본다. */
export const SLOW_MS = 4000
/**
 * 한 턴은 말 하나와 끝 하나로 남는다. 첫 화면은 최근 300개만 보내므로,
 * 150턴을 넘어야 맨 앞 말이 잘린다. 160이면 첫 줄이 위로 올려야만 나온다.
 */
const HISTORY_TURNS = 160
const BRIEF_SPLIT = '\n</aether-brief>\n\n'

function briefHuman(text: string): string {
  const at = text.lastIndexOf(BRIEF_SPLIT)
  if (at < 0) return text
  return text.slice(at + BRIEF_SPLIT.length)
}

type E2eRaw = { t: 'say' | 'peek' | 'done'; text?: string }

function rawOf(ev: EventShape): E2eRaw | undefined {
  if (ev.kind !== E2E_PROVIDER || !ev.msg || typeof ev.msg !== 'object') return undefined
  return ev.msg as E2eRaw
}

const codec: ProviderEventCodec = {
  provider: E2E_PROVIDER,
  normalize(ev: AetherEvent): AgentEvent[] {
    const raw = rawOf(ev)
    if (!raw) return []
    if (raw.t === 'say') return buildAgentEvents(ev, E2E_PROVIDER, [{ type: 'text', text: raw.text ?? '' }])
    if (raw.t === 'peek') return buildAgentEvents(ev, E2E_PROVIDER, [{ type: 'text_delta', text: raw.text ?? '' }])
    if (raw.t === 'done') return buildAgentEvents(ev, E2E_PROVIDER, [{ type: 'turn_completed', status: 'ok' }])
    return []
  },
  isLiveOnly: (ev) => rawOf(ev)?.t === 'peek',
  endsTurn: (ev) => rawOf(ev)?.t === 'done',
  isAuthExpired: () => false,
  persistFilter: (): ProviderPersistFilter => ({
    restore() {},
    apply(ev) {
      return rawOf(ev)?.t === 'peek' ? null : ev
    },
  }),
}

const services: ProviderServices = {
  provider: E2E_PROVIDER,
  displayName: 'E2E',
  distill: async () => '',
  availability: async () => ({ available: true }),
}

class E2eRuntime implements AgentRuntime {
  readonly provider = E2E_PROVIDER
  readonly capabilities: RuntimeCapabilities = {
    supportedModels: true,
    usage: false,
    planReview: false,
  }

  private readonly opts: RuntimeStartOptions
  private queue: RawProviderEventBody[] = []
  private wake: (() => void) | null = null
  private closed = false
  private turn = 0
  private cancelWait: (() => void) | null = null
  model?: string
  effort?: SessionEffort
  permissionMode: PermissionMode

  constructor(opts: RuntimeStartOptions) {
    this.opts = opts
    this.model = opts.model
    this.effort = opts.effort
    this.permissionMode = opts.permissionMode ?? 'manual'
    opts.onResumeKey(opts.resumeKey ?? 'e2e-thread-0001')
  }

  private emit(msg: E2eRaw) {
    this.queue.push({ kind: E2E_PROVIDER, msg })
    this.wake?.()
    this.wake = null
  }

  async *events(): AsyncIterable<RawProviderEventBody> {
    for (;;) {
      if (this.queue.length === 0) {
        if (this.closed) return
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        if (this.closed && this.queue.length === 0) return
      }
      yield this.queue.shift()!
    }
  }

  push(input: NormalizedUserInput): void {
    const ticket = ++this.turn
    const text = input.text
    const brief = text.includes(BRIEF_SPLIT)
    void this.handle(text, ticket, brief).catch((err) => {
      console.error('[e2e] 입력 처리 실패:', err instanceof Error ? err.message : err)
      if (this.turn === ticket && !this.closed) this.emit({ t: 'done' })
    })
  }

  private async pause(ms: number, ticket: number): Promise<boolean> {
    if (this.turn !== ticket || this.closed) return false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.cancelWait = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.cancelWait = null
    return this.turn === ticket && !this.closed
  }

  private async handle(text: string, ticket: number, brief: boolean) {
    if (text.startsWith('HISTORY:')) {
      const token = text.slice('HISTORY:'.length).trim() || 'e2e'
      for (let i = 0; i < HISTORY_TURNS; i++) {
        if (this.turn !== ticket || this.closed) return
        const label = i === 0 ? `old-${token}` : i === HISTORY_TURNS - 1 ? `new-${token}` : `pad-${token}-${i}`
        this.emit({ t: 'say', text: label })
        this.emit({ t: 'done' })
      }
      return
    }
    if (text.startsWith('ASK:')) {
      const outcome = await this.opts.onPermission({
        toolName: 'mock_write',
        displayName: '시험 권한',
        input: { command: text.slice(4) || 'e2e-write-demo' },
        toolUseID: 'e2e-tool-1',
        signal: new AbortController().signal,
      })
      if (this.turn !== ticket || this.closed) return
      this.emit({ t: 'say', text: outcome.allow ? 'allowed' : 'denied' })
      this.emit({ t: 'done' })
      return
    }
    if (text.startsWith('Q:')) {
      const outcome = await this.opts.onQuestion({
        toolUseID: 'e2e-question-1',
        signal: new AbortController().signal,
        questions: [
          {
            question: '어떤 색을 고를까요?',
            header: '시험 질문',
            options: [
              { label: '파랑', description: '파란색' },
              { label: '빨강', description: '빨간색' },
            ],
          },
        ],
      })
      if (this.turn !== ticket || this.closed) return
      const label = outcome.answered ? (outcome.answers[0]?.chosen[0] ?? outcome.answers[0]?.custom ?? '') : ''
      this.emit({ t: 'say', text: outcome.answered ? `answered:${label}` : 'unanswered' })
      this.emit({ t: 'done' })
      return
    }
    if (text.startsWith('SLOW:')) {
      const body = text.slice(5)
      const ok = await this.pause(SLOW_MS, ticket)
      if (!ok) return
      this.emit({ t: 'say', text: body })
      this.emit({ t: 'done' })
      return
    }
    const body = brief ? `brief:${briefHuman(text)}` : text
    for (let i = 0; i < body.length && i < 12; i += 4) {
      if (this.turn !== ticket || this.closed) return
      this.emit({ t: 'peek', text: body.slice(i, i + 4) })
    }
    if (this.turn !== ticket || this.closed) return
    this.emit({ t: 'say', text: body })
    this.emit({ t: 'done' })
  }

  async interrupt(): Promise<void> {
    this.turn += 1
    this.cancelWait?.()
    this.cancelWait = null
    this.emit({ t: 'done' })
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.turn += 1
    this.cancelWait?.()
    this.cancelWait = null
    this.wake?.()
    this.wake = null
  }

  async setModel(model: string): Promise<void> {
    if (model !== 'e2e-small') throw new Error(`e2e: "${model}"은(는) 아는 모델 이름이 아니다`)
    this.model = model
  }

  async setEffort(effort: SessionEffort): Promise<void> {
    throw new Error(`e2e: 지원하지 않는 effort ${effort}`)
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode
  }

  async permissionModes(): Promise<{ modes: readonly PermissionMode[]; current: PermissionMode }> {
    return { modes: ['manual', 'edits', 'auto', 'full'], current: this.permissionMode }
  }

  async contextUsage(): Promise<ContextUsage> {
    return { totalTokens: 10, maxTokens: 1000 }
  }

  async effectivePermissionPolicy(): Promise<PermissionPolicy> {
    return { bypassAll: this.permissionMode === 'full', autoApproveRules: 0, sources: [] }
  }

  async handshake(): Promise<RuntimeHandshake> {
    return {
      models: [{ value: 'e2e-small', displayName: 'E2E Small', isDefault: true, supportsEffort: false }],
    }
  }

  async usage() {
    throw new Error('e2e: 지원하지 않는 조회')
  }

  async listCommands(): Promise<RuntimeCommand[]> {
    return []
  }

  async executeCommand(command: RuntimeCommandInvocation): Promise<RuntimeCommandResult> {
    return { accepted: false, error: `e2e: unsupported command /${command.name}` }
  }

  async compactContext(): Promise<void> {}
}

export const e2eEntry: ProviderEntry = {
  id: E2E_PROVIDER,
  services,
  codec,
  isValidResumeKey: (key) => /^e2e-[a-z0-9-]+$/i.test(key),
  createRuntime: (opts) => new E2eRuntime(opts),
}
