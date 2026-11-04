/**
 * 브리프 질문지 — 화면이 쓰는 순수 계산 모음.
 *
 * 서버가 질문지를 읽어 `questionnaire` 사건으로 남긴다(server/agent-brief/questionnaire.ts). 화면은 그 사건과
 * 사람 입력(`user_msg`)만 보고 카드를 그린다. 이 파일은 React도 저장소도 모른다 — 그래서 사건 목록만 넣으면
 * 시험에서 그대로 부를 수 있다. 저장소(store.ts)는 여기서 `pendingQuestionnaire`만 가져다 쓴다.
 *
 * 닫힘 규칙(서버 2.3절과 같다): 질문지 사건 뒤에 처음 들어온 `user_msg`가 그 질문지를 닫는다. 그 글에
 * `questionnaireAnswer`가 있으면 카드로 답한 것, 없으면 채팅으로 이어간 것이다. 숨긴 사건(되돌리기)은
 * 저장소가 목록에 넣지 않으므로 여기서는 따로 빼지 않는다.
 */
import { turnCompletedOf } from './agentEvents'
import type { ConvoItem } from './store'
import type { AetherEvent, QuestionnaireAnswerValue, QuestionnaireQuestion } from './types'

export type QuestionnaireEvent = Extract<AetherEvent, { kind: 'questionnaire' }>
/** 카드로 그릴 수 있는 질문지(실패 사건이 아니고 질문이 있다). */
export type CardQuestionnaire = QuestionnaireEvent & { questions: QuestionnaireQuestion[] }
export type QuestionnaireAnswers = Record<string, QuestionnaireAnswerValue>

export type QuestionnaireState =
  | { status: 'open' }
  | { status: 'answered'; answers: QuestionnaireAnswers }
  | { status: 'continued' }

const FENCE = '```aether-questions'

export function isCardQuestionnaire(it: ConvoItem): it is CardQuestionnaire {
  return it.kind === 'questionnaire' && !it.invalid && Array.isArray(it.questions) && it.questions.length > 0
}

// ── 상태 ──

/** 질문지마다 열림·카드로 답함·채팅으로 이어감. 목록은 순번 순서라고 본다. */
export function questionnaireStates(items: readonly ConvoItem[]): Map<string, QuestionnaireState> {
  const out = new Map<string, QuestionnaireState>()
  let pending: CardQuestionnaire[] = []
  for (const it of items) {
    if (isCardQuestionnaire(it)) {
      pending.push(it)
    } else if (it.kind === 'user_msg') {
      for (const q of pending) {
        const answer = it.questionnaireAnswer
        out.set(q.id, answer && answer.id === q.id ? { status: 'answered', answers: answer.answers } : { status: 'continued' })
      }
      pending = []
    }
  }
  for (const q of pending) out.set(q.id, { status: 'open' })
  return out
}

/**
 * 지금 열려 있는 질문지. 최신부터 거꾸로 읽어 `user_msg`를 먼저 만나면 없고, 질문지 사건을 먼저 만나면 그것이다
 * (실패 사건이면 없다). 서버의 「열린 질문지」 계산과 같은 규칙이다.
 */
export function pendingQuestionnaire(items: readonly ConvoItem[] | undefined): CardQuestionnaire | null {
  if (!items) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user_msg') return null
    if (it.kind === 'questionnaire') return isCardQuestionnaire(it) ? it : null
  }
  return null
}

// ── 모델 글의 질문지 상자 ──

/** 상자 줄바꿈. 서버 `findQuestionnaireBlock`과 같이 한 줄 전체(앞뒤 공백 제외)가 여는 줄·닫는 줄이어야 한다. */
function boxLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** 글의 마지막 닫힌 상자를 지운다. 상자가 없으면 원문 그대로. */
export function removeLastBox(text: string): string {
  const lines = boxLines(text)
  let from = -1
  let to = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== FENCE) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '```') j++
    if (j >= lines.length) continue
    from = i
    to = j
    i = j
  }
  if (from < 0) return text
  return [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n').replace(/\s+$/, '')
}

/** 만드는 중인 글 — 닫힌 상자도 닫히지 않은 상자(끝까지)도 모두 지운다. `had`는 상자가 있었는지. */
export function hideBoxes(text: string): { text: string; had: boolean } {
  const lines = boxLines(text)
  const kept: string[] = []
  let had = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== FENCE) {
      kept.push(lines[i])
      continue
    }
    had = true
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '```') j++
    i = j // 닫는 줄까지 건너뛴다. 닫는 줄이 없으면 j가 끝이라 나머지를 모두 버린다.
  }
  return had ? { text: kept.join('\n').replace(/\s+$/, ''), had } : { text, had }
}

/**
 * 진행 중인 턴의 경계 — 이 번호보다 큰 목록 위치의 글이 「진행 중」이다.
 * 마지막 사람 말 뒤의 마지막 턴 완료까지는 끝난 글이다. 그 뒤의 글은 사람 말 없이 이어진 턴이다.
 * 오류·중단·사용자 Stop이 있으면 진행 중인 턴이 없다.
 */
function progressBoundary(items: readonly ConvoItem[]): number {
  let lastUser = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'user_msg' || items[i].kind === 'local_user') lastUser = i
  }
  let boundary = lastUser
  for (let i = lastUser + 1; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'status' && (it.status === 'crashed' || it.status === 'interrupted')) return Infinity
    if (it.kind === 'local_notice' && it.variant === 'stop') return Infinity
    if (it.kind !== 'local_user' && it.kind !== 'local_notice' && turnCompletedOf(it)) boundary = i
  }
  return boundary
}

export type ShapedText = { text: string; box: boolean }

export type QuestionnaireView = {
  states: Map<string, QuestionnaireState>
  /** 모델 글 한 조각을 규칙대로 바꾼다. `box`가 참이면 그 자리에 「질문지 만드는 중…」을 둔다. */
  shapeText: (index: number, seq: number, part: number, text: string) => ShapedText
  /** 흘러오는 부분 글(아직 조각 번호가 없다). 진행 중인 턴이면 상자를 가린다. */
  shapeDelta: (index: number, text: string) => ShapedText
}

/**
 * 모델 글 처리 규칙.
 *  - 성공 질문지의 `(sourceSeq, sourcePart)` 글: 마지막 상자를 지운다(카드는 그 글 뒤에 둔다).
 *  - 실패 질문지의 원문 글: 그대로 보인다.
 *  - 그 밖에 진행 중인 턴(마지막 사람 말 뒤, 턴 끝 전)의 글: 상자를 자리 표시로 바꾼다.
 *  - 나머지(끝난 턴의 글, 일반 세션의 상자): 원문 그대로.
 */
export function questionnaireView(items: readonly ConvoItem[]): QuestionnaireView {
  const sources = new Map<string, boolean>()
  for (const it of items) {
    if (it.kind === 'questionnaire') sources.set(`${it.sourceSeq}:${it.sourcePart}`, isCardQuestionnaire(it))
  }
  const boundary = progressBoundary(items)
  const inProgress = (index: number, text: string): ShapedText => {
    if (index <= boundary) return { text, box: false }
    const hidden = hideBoxes(text)
    return { text: hidden.text, box: hidden.had }
  }
  return {
    states: questionnaireStates(items),
    shapeText(index, seq, part, text) {
      const source = sources.get(`${seq}:${part}`)
      if (source === true) return { text: removeLastBox(text), box: false }
      if (source === false) return { text, box: false }
      return inProgress(index, text)
    },
    shapeDelta: inProgress,
  }
}

// ── 카드 상태 ──

/** 질문 하나에 대한 지금 답. 고른 선택지, 직접 쓴 글, 덧붙일 말. */
export type Draft = { chosen: string[]; custom: string; note: string }
export type Drafts = Record<string, Draft>
export type RowStatus = 'recommended' | 'changed' | 'needed'

/** 처음 상태 — 추천을 미리 고른다. 추천이 없으면 비워 둔다(「답 필요」). */
export function initialDrafts(questions: readonly QuestionnaireQuestion[]): Drafts {
  const out: Drafts = {}
  for (const q of questions) {
    const rec = q.recommended
    if (q.kind === 'text') out[q.id] = { chosen: [], custom: typeof rec === 'string' ? rec : '', note: '' }
    else if (q.kind === 'single') out[q.id] = { chosen: typeof rec === 'string' ? [rec] : [], custom: '', note: '' }
    else out[q.id] = { chosen: Array.isArray(rec) ? [...rec] : [], custom: '', note: '' }
  }
  return out
}

/** 보낸 답에서 거꾸로 만든 상태(읽기 전용 카드). 답 안 함은 빈 상태다. */
export function draftFromAnswer(value: QuestionnaireAnswerValue | undefined): Draft {
  if (!value || value.skipped) return { chosen: [], custom: '', note: '' }
  return { chosen: [...(value.chosen ?? [])], custom: value.custom ?? '', note: value.note ?? '' }
}

export function hasAnswer(draft: Draft): boolean {
  return draft.chosen.length > 0 || draft.custom.trim().length > 0
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((x) => right.includes(x))
}

/** 지금 답이 모델의 추천과 같은가. 추천이 없으면 늘 아니다. */
export function matchesRecommendation(q: QuestionnaireQuestion, draft: Draft): boolean {
  const rec = q.recommended
  if (rec === undefined || !hasAnswer(draft)) return false
  if (q.kind === 'text') return typeof rec === 'string' && draft.custom.trim() === rec.trim()
  if (draft.custom.trim()) return false
  if (q.kind === 'single') return typeof rec === 'string' && draft.chosen.length === 1 && draft.chosen[0] === rec
  return Array.isArray(rec) && sameSet(draft.chosen, rec)
}

export function rowStatus(q: QuestionnaireQuestion, draft: Draft): RowStatus {
  if (!hasAnswer(draft)) return 'needed'
  return matchesRecommendation(q, draft) ? 'recommended' : 'changed'
}

/** 접힌 줄에 보일 지금 답. */
export function shownAnswer(draft: Draft): string {
  return [...draft.chosen, ...(draft.custom.trim() ? [draft.custom.trim()] : [])].join(', ')
}

export type CardView = {
  total: number
  answered: number
  changed: number
  unanswered: number
  /** 바꾼 것이나 답 안 한 것이 하나라도 있으면 「이대로 보내기」, 아니면 「추천대로 보내기」. */
  asIs: boolean
  rows: { q: QuestionnaireQuestion; draft: Draft; status: RowStatus; shown: string }[]
}

export function cardView(questions: readonly QuestionnaireQuestion[], drafts: Drafts): CardView {
  const rows = questions.map((q) => {
    const draft = drafts[q.id] ?? { chosen: [], custom: '', note: '' }
    return { q, draft, status: rowStatus(q, draft), shown: shownAnswer(draft) }
  })
  const changed = rows.filter((r) => r.status === 'changed').length
  const unanswered = rows.filter((r) => r.status === 'needed').length
  return { total: rows.length, answered: rows.length - unanswered, changed, unanswered, asIs: changed > 0 || unanswered > 0, rows }
}

// ── 답 고르기 ──

/** 선택지를 누른다. single은 하나만(직접 입력은 비운다), multi는 켜고 끈다(선택지 순서로 둔다). */
export function pickOption(q: QuestionnaireQuestion, draft: Draft, label: string): Draft {
  if (q.kind === 'single') return { ...draft, chosen: [label], custom: '' }
  const on = draft.chosen.includes(label) ? draft.chosen.filter((x) => x !== label) : [...draft.chosen, label]
  const order = (q.options ?? []).map((o) => o.label)
  return { ...draft, chosen: [...on].sort((a, b) => order.indexOf(a) - order.indexOf(b)) }
}

/** 직접 입력. single은 글이 있으면 고른 선택지를 푼다. */
export function setCustom(q: QuestionnaireQuestion, draft: Draft, text: string): Draft {
  if (q.kind === 'single' && text.trim()) return { ...draft, chosen: [], custom: text }
  return { ...draft, custom: text }
}

export function clearAnswer(draft: Draft): Draft {
  return { ...draft, chosen: [], custom: '' }
}

// ── 보내는 몸통 ──

/** 서버 2.3절의 answers 모양. 답 안 한 질문은 `{ skipped: true }`, 덧붙일 말이 비면 뺀다. */
export function buildAnswers(questions: readonly QuestionnaireQuestion[], drafts: Drafts): QuestionnaireAnswers {
  const out: QuestionnaireAnswers = {}
  for (const q of questions) {
    const d = drafts[q.id] ?? { chosen: [], custom: '', note: '' }
    if (!hasAnswer(d)) {
      out[q.id] = { skipped: true }
      continue
    }
    const custom = d.custom.trim()
    const note = d.note.trim()
    const value: QuestionnaireAnswerValue = {}
    if (q.kind === 'text') {
      value.custom = custom
    } else if (q.kind === 'single') {
      if (custom) value.custom = custom
      else value.chosen = [d.chosen[0]]
    } else {
      value.chosen = [...d.chosen]
      if (custom) value.custom = custom
    }
    if (note) value.note = note
    out[q.id] = value
  }
  return out
}

/**
 * 같은 답이면 같은 `clientMessageId`를 다시 쓴다(보내기 실패 뒤 다시 보내기). 답을 바꿨으면 새 값이다 —
 * 서버는 같은 식별자에 다른 답이 오면 409로 막는다.
 */
export function answerMessageId(
  prev: { id: string; key: string } | null | undefined,
  answers: QuestionnaireAnswers,
  make: () => string,
): { id: string; key: string } {
  const key = JSON.stringify(answers)
  return prev && prev.key === key ? prev : { id: make(), key }
}

/** 카드의 한 줄짜리 글 입력 칸에서 Enter를 삼킬지(기본 동작을 막는다). 한글 조합 중 Enter는 조합 확정 키라 건드리지 않는다. 어느 쪽이든 카드는 보내지 않는다 — 보내기는 아래 줄 단추만 한다. */
export function swallowEnter(e: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229
}
