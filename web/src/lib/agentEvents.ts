/**
 * 정규화 계약(AgentEvent) 리더.
 *
 * 8c에서는 이 파일이 "정규화본 우선 + Claude 원본 폴백"의 두 갈래 리더였다. 8d-3에서 원본 갈래를 없앴다 —
 * 이제 화면이 읽는 구조·내용은 **전부** `events`(AgentEvent[])에서 온다. 원본(`msg`)은 서버가 events.jsonl에
 * 그대로 저장하지만 화면은 쳐다보지 않는다.
 *
 * 폴백을 지운 이유: 폴백이 있으면 정규화가 조용히 썩어도 아무도 모른다(Claude 화면이 원본으로 계속 그려지니까).
 * 정규화가 유일 경로가 되면 매일의 실사용이 곧 검증이고, "원본 참조 0건"이라는 절대 기준으로 경계를 검사할 수 있다.
 */
import type { TodoItem } from '@shared/agentEvent'
import type { AgentEvent, AetherEvent } from './types'
import { opensWorkTurn } from './brief'
import { reportClientError } from './errorReporting'

export type ToolResultView = { content?: unknown; is_error?: boolean }

export type RenderableContentPart =
  | { type: 'text'; text: string; part: number }
  // 모델이 답하기 전에 스스로 정리한 생각(8h). 답변이 아니라 과정이라 화면에서는 접힌 줄로 그린다.
  | { type: 'reasoning'; text: string; part: number }
  | { type: 'plan_text'; text: string; part: number }
  | { type: 'tool_call'; toolId: string; name: string; input: Record<string, unknown>; part: number; toolKind?: string; displayName?: string }

const isStr = (v: unknown) => typeof v === 'string'
const isNum = (v: unknown) => typeof v === 'number'
/** 알려진 type의 필수 필드 모양. 틀리면 그릴 때 예외가 나므로 건너뛴다. 모르는 type은 여기 없고 그대로 통과(화면이 무시한다). */
const FIELD_SHAPE: Record<string, (e: Record<string, unknown>) => boolean> = {
  user_text: (e) => isStr(e.text),
  text: (e) => isStr(e.text),
  text_delta: (e) => isStr(e.text),
  reasoning: (e) => isStr(e.text),
  plan_text: (e) => isStr(e.text),
  command_output: (e) => isStr(e.text),
  tool_call: (e) => isStr(e.toolId) && isStr(e.name),
  tool_result: (e) => isStr(e.toolId),
  usage_update: (e) => isNum(e.totalTokens) && isNum(e.maxTokens),
  model_info: (e) => isStr(e.model),
  commands_available: (e) => Array.isArray(e.names),
  plan_update: (e) => e.items === undefined || Array.isArray(e.items),
}

/** 이 사건이 그릴 수 있는 모양인가. 아니면 사유(종류별 한 번만 기록하려고 type을 붙인다)를 돌려준다. */
export function malformedEventKind(e: unknown): string | null {
  if (e === null || typeof e !== 'object') return 'not_object'
  const type = (e as { type?: unknown }).type
  if (typeof type !== 'string') return 'no_type'
  const ok = FIELD_SHAPE[type]
  return ok && !ok(e as Record<string, unknown>) ? type : null
}

const reportedKinds = new Set<string>()
const filtered = new WeakMap<object, { len: number; out: readonly AgentEvent[] }>()

/** 이 봉투에 실린 정규화 이벤트들. 파생이 없는 이벤트(제어용)는 빈 배열로 본다. 깨진 사건 하나가 화면 전체를 멈추지 못하게 건너뛴다. */
export function agentEventsOf(ev: { events?: AgentEvent[] }): readonly AgentEvent[] | undefined {
  if (!Array.isArray(ev.events)) return undefined
  const src = ev.events
  const hit = filtered.get(src)
  if (hit && hit.len === src.length) return hit.out
  const good: AgentEvent[] = []
  for (const e of src) {
    const bad = malformedEventKind(e)
    if (bad === null) good.push(e)
    else if (!reportedKinds.has(bad)) {
      reportedKinds.add(bad)
      reportClientError(new Error(`깨진 사건을 건너뜀: ${bad}`), { component: 'ui', operation: 'ui.event.malformed', severity: 'warning' })
    }
  }
  // 하위 작업(보조 에이전트) 안의 발화는 메인 대화에 그리지 않는다. 최종 보고는 메인 모델이 다시 말해 준다.
  const out = good.some((e) => e.subtaskOf) ? good.filter((e) => !e.subtaskOf) : good
  filtered.set(src, { len: src.length, out })
  return out
}

/**
 * 도구 카드가 이해하는 인자 모양. 계약이 인자 전체(`input`)를 실어주면 그대로 쓰고,
 * 못 채우는 provider면 핵심 인자 하나(`target`)만으로 최소 모양을 만들어 카드가 비지 않게 한다.
 */
function toolInputOf(ae: Extract<AgentEvent, { type: 'tool_call' }>): Record<string, unknown> {
  if (ae.input) return ae.input
  if (!ae.target) return {}
  switch (ae.toolKind) {
    case 'bash':
      return { command: ae.target }
    case 'file_read':
    case 'file_change':
      return { file_path: ae.target }
    case 'search':
    case 'web':
      return { query: ae.target }
    default:
      return { target: ae.target }
  }
}

/** 화면에 그릴 콘텐츠 조각(텍스트·생각·도구 호출)을 순서대로. */
export function renderableContentParts(ev: AetherEvent): RenderableContentPart[] {
  const out: RenderableContentPart[] = []
  for (const ae of agentEventsOf(ev) ?? []) {
    if (ae.type === 'text') out.push({ type: 'text', text: ae.text, part: ae.part })
    else if (ae.type === 'reasoning' && ae.text.trim()) out.push({ type: 'reasoning', text: ae.text, part: ae.part })
    else if (ae.type === 'plan_text' && ae.text.trim()) out.push({ type: 'plan_text', text: ae.text, part: ae.part })
    else if (ae.type === 'tool_call' && ae.toolId)
      out.push({ type: 'tool_call', toolId: ae.toolId, name: ae.name, input: toolInputOf(ae), part: ae.part, toolKind: ae.toolKind, ...(ae.displayName ? { displayName: ae.displayName } : {}) })
  }
  return out
}

/** 도구 호출 id → 그 결과. 호출과 결과는 서로 다른 이벤트로 도착하므로 id로 잇는다. */
export function collectToolResults(items: readonly AetherEvent[]): Map<string, ToolResultView> {
  const out = new Map<string, ToolResultView>()
  for (const ev of items) {
    for (const ae of agentEventsOf(ev) ?? []) {
      if (ae.type !== 'tool_result' || !ae.toolId) continue
      out.set(ae.toolId, { content: ae.output, is_error: ae.isError })
    }
  }
  return out
}

/** 이 봉투가 턴을 끝냈다면 그 정보. */
export function turnCompletedOf(ev: AetherEvent): Extract<AgentEvent, { type: 'turn_completed' }> | null {
  return agentEventsOf(ev)?.find((ae): ae is Extract<AgentEvent, { type: 'turn_completed' }> => ae.type === 'turn_completed') ?? null
}

/** 마지막으로 관측된 컨텍스트 사용량. */
export function lastUsageOf(items: readonly AetherEvent[] | undefined): { totalTokens: number; maxTokens: number } | null {
  let usage: { totalTokens: number; maxTokens: number } | null = null
  for (const ev of items ?? []) {
    for (const ae of agentEventsOf(ev) ?? []) {
      if (ae.type === 'usage_update') usage = { totalTokens: ae.totalTokens, maxTokens: ae.maxTokens }
    }
  }
  return usage
}

/** 이 봉투가 알려주는 "지금 쓰는 모델". 여러 개면 마지막 것이 최신이다. */
export function modelInfoOf(ev: AetherEvent): string | null {
  let model: string | null = null
  for (const ae of agentEventsOf(ev) ?? []) {
    if (ae.type === 'model_info' && ae.model) model = ae.model
  }
  return model
}

/** 이 봉투가 알려주는 "쓸 수 있는 슬래시 명령 이름들". 마지막 관측이 유효하다. */
export function commandsAvailableOf(ev: AetherEvent): string[] | null {
  let names: string[] | null = null
  for (const ae of agentEventsOf(ev) ?? []) {
    if (ae.type === 'commands_available') names = ae.names
  }
  return names
}

/** 화면이 보는 할 일 목록 한 장. 서버는 따로 저장하지 않고 대화 기록의 마지막 목록 사건이 정본이다. */
export type TodoView = {
  items: TodoItem[]
  /** 이 목록을 실은 사건 번호. */
  seq: number
  /** 마지막 사용자 입력보다 뒤에 갱신됐는가(이번 턴 안에서 만든·고친 목록인가). */
  inLatestTurn: boolean
}

const TODO_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

/**
 * 가장 최근 plan_update의 목록. 없거나 빈 목록(지움)이면 null.
 * 옛 서버 모양(items 없이 글만 있는 plan_update)은 목록이 아니므로 건너뛰고 더 앞을 찾는다.
 */
export function latestTodoOf(items: readonly { kind: string; events?: AgentEvent[] }[] | undefined): TodoView | null {
  let sawUserInput = false
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const ev = items![i]
    if (opensWorkTurn(ev)) sawUserInput = true
    const aes = agentEventsOf(ev) ?? []
    for (let j = aes.length - 1; j >= 0; j--) {
      const ae = aes[j]
      if (ae.type !== 'plan_update' || !Array.isArray(ae.items)) continue
      const list: TodoItem[] = []
      for (const raw of ae.items) {
        if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) continue
        list.push({ text: raw.text, status: TODO_STATUSES.includes(raw.status) ? raw.status : 'pending' })
      }
      const seq = (ev as { seq?: number }).seq ?? 0
      return list.length ? { items: list, seq, inLatestTurn: !sawUserInput } : null
    }
  }
  return null
}

/** 목록의 완료·전체·남은 수. */
export function todoCounts(items: readonly TodoItem[]): { done: number; total: number; left: number } {
  const done = items.filter((i) => i.status === 'completed').length
  return { done, total: items.length, left: items.length - done }
}
