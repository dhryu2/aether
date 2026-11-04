/**
 * 대화 세그먼트 빌더 (Phase 8d-3 ⑤) — 이벤트 목록 → 화면에 그릴 조각들.
 *
 * 8d-3 이전엔 이 로직이 `Stream.tsx` 컴포넌트 본문 안에 있었다. 그러면 "두 번째 provider의 봉투로도 화면
 * 요소가 전부 그려지는가"를 기계로 확인할 방법이 없다(React를 띄우지 않고는 함수를 부를 수 없으니까).
 * 그래서 **동작을 바꾸지 않고** 순수 함수로 뺐다. 컴포넌트는 여기가 돌려준 조각을 그리기만 한다.
 *
 * 이 파일은 provider 원본(`kind:"sdk"`·`msg`)을 절대 읽지 않는다. 모델이 만든 내용은 전부 정규화 계약
 * (`AgentEvent`)에서만 읽고, 권한·질문·상태 같은 Aether 자체 이벤트만 `kind`로 분기한다. 그래서 어떤
 * provider의 세션이든 같은 코드가 같은 화면을 만든다.
 *
 * 번역 함수 `t`를 인자로 받는 이유: 문구까지 여기서 확정해야 조각 하나하나를 테스트에서 문자열로 대조할 수
 * 있다. 컴포넌트가 나중에 번역하면 조각은 반쪽짜리 서술이 된다.
 */
import { isBlankAssistantText } from '../../../shared/blankAssistantText'
import type { AetherEvent, ChamdingPhase, DocAttachment, ImageAttachment, PermissionRequest, PlanRequest, QuestionnaireQuestion, QuestionRequest, TurnCompleted, TurnState } from './types'
import type { TranscriptView } from './transcriptView'
import type { ConvoItem } from './store'
import { agentEventsOf, collectToolResults, renderableContentParts, turnCompletedOf } from './agentEvents'
import { isCardQuestionnaire, questionnaireView, type QuestionnaireState } from './questionnaire'
// 도구 런 한 줄의 모양은 그리는 쪽(도구 칩)이 정의한다 — lib이 components를 의존하는 방향 역전이 여기 남아 있다.
import type { ToolEntry } from '../components/stream/ToolRun'
// 한도 창 이름 라벨은 설정의 사용량 패널과 공유한다(8d-3 ④ — 표가 두 벌로 갈라지지 않게).
import { rateLimitLabel } from './usageLabels'

/** 질문 카드가 따로 있어서 명령 줄에 안 그린다. Claude·Grok 이름 모두 이 패턴이다. */
export function isHiddenQuestionTool(name: string | undefined): boolean {
  return /ask[_ ]?user[_ ]?question/i.test(String(name ?? ''))
}

/** NoticeBanner가 아는 색 변형. */
export type BannerVariant = 'resumed' | 'no_context' | 'stop' | 'model' | 'warn' | 'distill_model' | 'permission_lowered'

/**
 * 화면 조각 하나. `convo`는 "이게 대화 내용인가"(빈 세션 안내를 띄울지 판정) — 배너류는 false다.
 * `seq`는 검색 결과에서 이 위치로 점프할 때 쓰는 좌표다.
 */
export type StreamSeg = { key: string; seq: number; convo: boolean } & (
  | { kind: 'text'; text: string }
  /**
   * 모델이 답하기 전에 스스로 정리한 생각(8h). 답이 아니라 과정이라 기본은 접어 두고 눌러야 펼친다.
   *
   * 조각마다 줄을 만들지 않고 **굳는 구간마다 하나로** 합친다(구간 = 턴 종료·질문 카드·중단).
   * 그래서 한 턴 안에 질문 카드가 끼면 그 앞뒤로 생각 줄이 하나씩, 둘이 된다 — 사람이 끼어든 지점이
   * 경계이므로 그게 맞는 배치다. 말·도구 묶음도 같은 규칙으로 끊긴다.
   */
  | { kind: 'reasoning'; text: string }
  /**
   * 작업 중 알림 — 모델이 일하는 도중에 하는 말. 최종 답변과 같은 글꼴·크기로 전부 그리되 말풍선은 없다.
   * 같은 `key`(자리 이름)로 새 말이 오면 그 자리에서 갈아끼운다.
   */
  | { kind: 'live'; text: string }
  | { kind: 'tools'; tools: ToolEntry[] }
  /** 자식 작업(ToolKind task). 사건이 있는 세션만 나온다. */
  | { kind: 'team'; tasks: ToolEntry[] }
  | { kind: 'user'; text: string; images?: ImageAttachment[]; documents?: DocAttachment[]; autoSent?: true; handoffFrom?: string }
  | { kind: 'banner'; variant: BannerVariant; text: string }
  | { kind: 'authExpired'; text: string }
  | { kind: 'permission'; req: PermissionRequest; resolved?: 'allow' | 'deny' }
  | { kind: 'question'; req: QuestionRequest; resolved: boolean; skipped?: boolean; savedAnswers?: string[][] }
  /** 질문에 답한 뒤 오른쪽에 남는 선택 기록. events.jsonl의 user_msg가 아니다. */
  | { kind: 'choice'; labels: string[] }
  | { kind: 'plan'; text: string }
  /** 브리프 질문지 카드. 질문지 상자가 있던 모델 글 바로 뒤에 놓인다. */
  | { kind: 'questionnaire'; id: string; questions: QuestionnaireQuestion[]; state: QuestionnaireState }
  /** 모델이 질문지 상자를 쓰는 중이다. 턴이 끝나면 카드로 바뀐다(못 바꾸면 원문이 보인다). */
  | { kind: 'questionnairePending' }
  | { kind: 'planCard'; req: PlanRequest; resolved?: 'approve' | 'revise' | 'cancel' }
  | { kind: 'result'; turn: TurnCompleted; ts: number }
  | { kind: 'commandOutput'; text: string }
  | { kind: 'operation'; state: 'started' | 'completed' | 'failed'; text: string }
)

/** 자동 재시도 진행 표시(꼬리에만 뜨는 라이브 인디케이터 — 히스토리에 쌓지 않는다). */
export type RetryInfo = { attempt?: number; max?: number; error?: string }

/** 자리 하나가 담고 있는 모델의 말. `seq`는 이 말이 온 이벤트의 번호(검색 점프 좌표). */
type Held = {
  text: string
  seq: number
  /** 질문지 상자를 가리고 남긴 글이다 — 그 자리에 「질문지 만드는 중…」을 둔다. */
  box?: boolean
  /** 부분 토큰은 가리기 전의 원문을 들고 있다가 토큰이 올 때마다 다시 가린다. */
  raw?: string
} | null

export type BuildInput = {
  items: readonly ConvoItem[]
  turn: TurnState
  /** 이 세션을 실행하는 서비스의 표시 이름 — "무엇의 인증이 만료됐는지" 같은 문구에 들어간다(8d-3 ④). */
  providerName: string
  /** 제출한 질문 답(서버는 라벨을 안 돌려주므로 클라가 기억한다). */
  answers: Record<string, string[][]>
  /** 화면이 진행 보고를 얼마나 남기는지. 기본은 지금 규칙(보통). */
  view?: TranscriptView
  t: (key: string, params?: Record<string, string | number>) => string
}

export type BuildResult = {
  segs: StreamSeg[]
  /** 대화 내용이 하나라도 있는가 — false면 빈 세션 안내를 띄운다. */
  hasConvo: boolean
  /**
   * 진행 줄이 있을 만한 순간 — 턴이 살아 있거나, 방금 끝난 사건(성공·실패·당황·놀람)이 있다.
   * 도구 줄·재시도와 겹친다고 빼지 않는다. 실제로 붙잡고 있을지는 보이기 관리자가 정한다.
   */
  showOrb: boolean
  /** 참딩이 보여줘야 할 국면. 화면에 바로 그리지 않고, 보이기 관리자가 너무 빠른 교체를 누른 뒤 그린다. */
  chamdingPhase: ChamdingPhase
  /**
   * 마지막 결과 조각의 자리 이름. 아직 결과가 없으면 null.
   * 임시 글이 서버 글로 바뀌거나 예전 대화를 앞에 붙여도 이 값은 그대로다.
   * 턴이 끝나 결과가 생기면 바뀌므로, 다음 글이 같은 갱신에 붙어도 새 턴을 구분할 수 있다.
   */
  turnKey: string | null
  /** 진행 중 재시도 표시. null이면 안 띄운다. */
  retry: RetryInfo | null
  /**
   * 세션 내 찾기가 뒤질 목록 — 사람이 쓴 말, 화면에 남는 모델의 말, 질문 카드 원문.
   *
   * 화면 조각에서 그대로 뽑는 것이 핵심이다. 찾기는 결과를 누르면 그 자리로 스크롤하므로, 화면에 없는 것이
   * 결과에 섞이면 갈 곳이 없어진다. 조각에서 뽑으면 그런 어긋남이 생길 수 없다.
   *
   * 작업 중 알림(`live`)도 넣는다. 예전엔 뺐는데, 그때는 턴이 끝나면 알림이 화면에서 사라졌기 때문이다.
   * 지금은 턴이 끝나도 알림이 남으므로 눌렀을 때 갈 자리가 있다.
   */
  searchable: { seq: number; text: string }[]
}

// resetsAt(실데이터는 epoch 초, 일부 provider는 ms — 1e12 미만이면 초로 보고 ×1000) → 사람이 읽는 리셋 시각
function formatReset(resetsAt: number | undefined, t: BuildInput['t'], now: number): string {
  if (!resetsAt) return ''
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt
  const diff = ms - now
  if (diff <= 0) return ''
  const min = Math.round(diff / 60000)
  if (min < 60) return t('stream.reset.minutes', { min })
  const d = new Date(ms)
  const date = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return t('stream.reset.at', { date })
}

/** 이 이벤트가 와이어 봉투(정규화 계약을 실을 수 있는 것)인가 — 로컬 낙관 이벤트는 아니다. */
function isWire(it: ConvoItem): it is AetherEvent {
  return it.kind !== 'local_user' && it.kind !== 'local_notice'
}

export function buildStreamSegments({ items, turn, providerName, answers, t, view = 'normal' }: BuildInput): BuildResult {
  const now = Date.now()
  const summary = view === 'summary'
  const verbose = view === 'verbose'
  const segs: StreamSeg[] = []
  const wireItems = items.filter(isWire)
  const toolResults = collectToolResults(wireItems)

  const permResolved = new Map<string, 'allow' | 'deny'>()
  const qResolved = new Set<string>()
  const qSkipped = new Set<string>()
  const qAnswers = new Map<string, string[][]>()
  const planResolved = new Map<string, 'approve' | 'revise' | 'cancel'>()
  const operationFinal = new Map<string, { state: 'started' | 'completed' | 'failed'; text: string }>()
  const operationStarts = new Set<string>()
  for (const it of items) {
    if (it.kind === 'permission_resolved') permResolved.set(it.id, it.decision)
    else if (it.kind === 'question_resolved') {
      qResolved.add(it.id)
      if (it.answered === false) qSkipped.add(it.id)
      if (it.answers?.length) qAnswers.set(it.id, it.answers)
    }
    else if (it.kind === 'plan_resolved') planResolved.set(it.id, it.decision)
    else if (it.kind === 'command_operation') {
      operationFinal.set(it.operationId, { state: it.state, text: it.detail })
      if (it.state === 'started') operationStarts.add(it.operationId)
    }
  }

  // 막힘 배너는 *마지막 1건만* 렌더. 사전 스캔으로 마지막 seq를 구해 그 이벤트에서만 push.
  //   한도 임박 경고는 대화에 넣지 않는다. 사용률은 입력창의 LimitChip이 계속 보여 준다.
  let lastBlockedSeq = -1
  // 참딩 "놀람" 몸짓의 트리거 — provider가 모델을 강제로 바꾼 사건의 마지막 seq.
  let lastModelFallbackSeq = -1
  for (const it of wireItems) {
    for (const ae of agentEventsOf(it) ?? []) {
      if (ae.type === 'provider_notice' && ae.kind === 'model_fallback') lastModelFallbackSeq = it.seq
      if (ae.type !== 'provider_notice' || ae.kind !== 'rate_limit') continue
      if (ae.severity === 'blocked') lastBlockedSeq = it.seq
    }
  }

  // ── 턴 단위 누적 ──
  //   턴 = 사람이 메시지를 보낸 시점부터 그 요청 처리가 끝날 때(turn_completed)까지.
  //
  //   한 턴 안에서 모델이 하는 말을 전부 쌓지는 않는다. 대신 말 하나를 담는 자리 두 개만 유지한다.
  //   - 알림 자리: 뒤에 도구 호출이 따라붙어서 "이건 최종 답변이 아니다"가 확정된 말. 새 말이 확정될 때마다
  //     이 자리를 갈아끼우므로 언제나 가장 최근 것 하나만 남는다.
  //   - 말하는 자리: 아직 뒤에 도구가 안 붙은 말. 턴이 여기서 끝나면 이게 최종 답변이다.
  //
  //   최종 답변인지 아닌지를 길이나 줄바꿈으로 짐작하지 않고 이 구조로 가린다. 모델이 뭔가 말한 다음 도구를
  //   또 부르면 그 말은 진행 보고였다는 뜻이고, 말한 뒤 도구 없이 턴이 끝나면 그게 답이다.
  //
  //   도구는 중간에 말이 끼어도 끊지 않고 턴 전체를 하나의 요약 줄로 합친다. 예외는 질문 카드뿐이다.
  let turnTools: ToolEntry[] = []
  let turnTeam: ToolEntry[] = []
  let toolKey = ''
  let toolSeq = 0
  let teamKey = ''
  let teamSeq = 0
  /** 생각 자리 — 이 턴에 모델이 정리한 생각을 전부 이어 붙인 것(8h). 턴이 닫힐 때 접힌 줄 하나로 나간다. */
  let think: Held = null
  /** 계획문 자리 — 이 턴에 온 계획 본문을 이어 붙인다. 승인 카드와 따로 그린다. */
  let plan: Held = null
  /** 알림 자리 — 뒤에 도구 호출이 붙어 최종 답변이 아님이 확정된 말(가장 최근 하나). 보통 모드. */
  let note: Held = null
  /** 자세히 모드에서만 — 확정된 진행 보고를 갈아끼우지 않고 쌓는다. */
  const notes: NonNullable<Held>[] = []
  /** 말하는 자리 — 아직 뒤에 도구가 안 붙은 말. 턴이 여기서 끝나면 최종 답변이 된다. */
  let pend: Held = null
  /** 완성본이 오기 전에 흘러오는 부분 토큰. 완성본이나 턴 종료가 오면 버린다. */
  let delta: Held = null
  let retry: RetryInfo | null = null
  // 두 자리의 key로 쓸 자리 번호 = 이 자리가 열린 지점의 이벤트 seq(맨 처음엔 0).
  //   담는 말이 바뀔 때마다 key까지 바뀌면 React가 그 자리를 새로 만들어 갈아끼우는 애니메이션이 돌 기회를
  //   잃는다. 그렇다고 "몇 번째 턴인가"로 세면 과거 묶음을 앞에 붙일 때 번호가 통째로 밀려 같은 문제가 난다.
  //   이벤트 seq는 앞에 뭘 붙이든 안 변하므로 두 경우 모두 자리가 유지된다.
  let turnKeySeq = 0

  /** 지금 "말하는 자리"에 보이는 말 — 토큰이 흐르는 중이면 미리보기, 아니면 완성본. */
  const showing = (): Held => {
    if (delta && !isBlankAssistantText(delta.text)) return delta
    if (pend && !isBlankAssistantText(pend.text)) return pend
    return null
  }
  const pushTools = () => {
    if (turnTeam.length) segs.push({ kind: 'team', key: teamKey, seq: teamSeq, convo: true, tasks: turnTeam })
    if (turnTools.length) segs.push({ kind: 'tools', key: toolKey, seq: toolSeq, convo: true, tools: turnTools })
    turnTools = []
    turnTeam = []
  }
  /**
   * 지금 화면에 보이던 배치(작업 중 알림 → 명령 요약 줄 → 지금 하던 말)를 그 자리에 그대로 굳힌다.
   * 턴이 끝났을 때, 질문 카드가 뜰 때, 턴이 끊겼을 때가 전부 같은 규칙이다 — 그래서 굳는 순간에 화면이 안 튄다.
   *
   * `finalAnswer`가 참이면 마지막 말을 답변 말풍선으로 올린다(턴이 정상으로 끝난 경우뿐).
   * `atSeq` = 이 자리를 닫은 이벤트의 seq. 다음 자리의 이름이 된다(seq는 계속 커지므로 이름이 안 겹친다).
   */
  const settle = (atSeq: number, finalAnswer: boolean) => {
    // 이 묶음 안에서는 생각이 맨 앞이다 — 모델은 생각한 다음에 말하고 도구를 부른다.
    //   (묶음 밖에서 곧바로 쌓이는 조각(권한 카드·배너·슬래시 출력)은 이 묶음보다 위에 남는다.
    //    말·도구 묶음도 원래 그렇게 동작하므로 생각만 다르게 두지 않는다.)
    if (!summary && think) segs.push({ kind: 'reasoning', key: `th-${turnKeySeq}`, seq: think.seq, convo: true, text: think.text })
    if (!summary && plan) segs.push({ kind: 'plan', key: `pl-${turnKeySeq}`, seq: plan.seq, convo: true, text: plan.text })
    if (!summary) {
      if (verbose) {
        for (const n of notes) segs.push({ kind: 'live', key: `nt-${n.seq}`, seq: n.seq, convo: true, text: n.text })
      } else if (note) {
        segs.push({ kind: 'live', key: `nt-${turnKeySeq}`, seq: note.seq, convo: true, text: note.text })
      }
    }
    notes.length = 0
    pushTools()
    const cur = showing()
    if (cur) {
      const base = { key: `lv-${turnKeySeq}`, seq: cur.seq, convo: true, text: cur.text }
      if (finalAnswer) segs.push({ kind: 'text', ...base })
      else if (!summary) segs.push({ kind: 'live', ...base })
    }
    const writing = delta ?? pend
    if (!summary && writing?.box) segs.push({ kind: 'questionnairePending', key: `qp-${turnKeySeq}`, seq: writing.seq, convo: true })
    think = null
    plan = null
    note = null
    pend = null
    delta = null
    turnKeySeq = atSeq
  }
  /** 턴이 정상으로 끝났다 — 알림, 명령 요약 줄, 최종 답변, 결과 푸터 순서로 남긴다. */
  const closeCompleted = (result: StreamSeg, atSeq: number) => {
    settle(atSeq, true)
    segs.push(result)
  }
  /**
   * 턴이 끝나지 못하고 끊겼다(오류·중단·한도 소진, 또는 다음 질문이 먼저 옴).
   * 최종 답변이 없으므로 마지막에 하던 말을 답변 말풍선으로 올리지 않고 알림 그대로 남긴다 — 무엇을 하다 멈췄는지 알 수 있게.
   */
  const closeInterrupted = (atSeq: number) => settle(atSeq, false)

  const qv = questionnaireView(items)

  for (const [idx, it] of items.entries()) {
    const wire = isWire(it) ? it : null
    const aes = wire ? agentEventsOf(wire) : undefined
    const contentParts = wire ? renderableContentParts(wire) : []

    // 휘발성 미리보기(부분 토큰). 뒤에 완성 텍스트나 턴 종료가 오면 버리고 최종본으로 치환한다.
    if (aes) {
      for (const ae of aes) {
        if (ae.type !== 'text_delta') continue
        const prev = delta as Held
        const raw: string = (prev?.raw ?? '') + ae.text
        const shaped = qv.shapeDelta(idx, raw)
        delta = { text: shaped.text, seq: prev?.seq ?? it.seq, raw, box: shaped.box }
      }
    }
    if (wire && turnCompletedOf(wire)) delta = null

    if (it.kind === 'local_user') {
      closeInterrupted(it.seq)
      segs.push({ kind: 'user', key: `u-${it.seq}`, seq: it.seq, convo: true, text: it.text, images: it.images, documents: it.documents, ...(it.handoffFrom ? { handoffFrom: it.handoffFrom } : {}) })
      continue
    }
    if (it.kind === 'user_msg') {
      // 다음 질문이 먼저 왔다 = 앞 턴이 답을 못 내고 끊긴 것. 앞 턴을 닫아 작업 줄을 고정하고 새 턴을 연다.
      closeInterrupted(it.seq)
      segs.push({ kind: 'user', key: `u-${it.seq}`, seq: it.seq, convo: true, text: it.text, images: it.images, documents: it.documents, ...(it.sentBy === 'aether' ? { autoSent: true as const } : {}), ...(it.handoffFrom ? { handoffFrom: it.handoffFrom } : {}) })
      continue
    }
    if (it.kind === 'local_notice') {
      const text =
        it.variant === 'model'
          ? t('stream.notice.modelChanged', { detail: it.detail ?? '' })
          : it.variant === 'effort'
            ? t('stream.notice.effortChanged', { detail: it.detail ?? '' })
            : it.variant === 'permission_deferred'
              ? t('stream.notice.permissionDeferred', { mode: t(`session.permission.mode.${it.detail || 'manual'}`) })
              : it.variant === 'permission'
                ? // 옛 기록에 남은 'ask'는 수동으로 읽는다.
                  t('stream.notice.permissionChanged', { mode: t(`session.permission.mode.${!it.detail || it.detail === 'ask' ? 'manual' : it.detail}`) })
                : t('stream.notice.stopped')
      // 사용자가 직접 멈춘 것도 끊긴 턴이다 — 배너보다 먼저 닫아야 "무엇을 하다 멈췄나"가 배너 위에 남는다.
      if (it.variant === 'stop') closeInterrupted(it.seq)
      segs.push({ kind: 'banner', key: `n-${it.seq}`, seq: it.seq, convo: true, variant: it.variant === 'stop' ? 'stop' : 'model', text })
      continue
    }
    if (it.kind === 'command_operation') {
      // 시작 자리에 같은 key를 고정한다. 완료 이벤트가 오면 React가 실행 중 카드 자체를 완료 카드로 바꾼다.
      // 오래된 이벤트 페이지만 읽어 시작이 없을 때는 terminal 사건도 독립 카드로 보존한다.
      if (it.state !== 'started' && operationStarts.has(it.operationId)) continue
      const final = operationFinal.get(it.operationId) ?? { state: it.state, text: it.detail }
      segs.push({ kind: 'operation', key: `op-${it.operationId}`, seq: it.seq, convo: false, state: final.state, text: final.text })
      continue
    }
    if (it.kind === 'notice') {
      if (it.notice === 'auth_expired') {
        segs.push({ kind: 'authExpired', key: `n-${it.seq}`, seq: it.seq, convo: false, text: it.detail || t('stream.notice.authExpired', { provider: providerName }) })
      } else if ((it.notice as string) === 'memory_learned' || (it.notice as string) === 'skill_learned') {
        // 자동 기억·스킬 학습을 걷어내기 전에 저장된 옛 알림. 그릴 곳이 없어 건너뛴다.
        continue
      } else {
        segs.push({
          kind: 'banner',
          key: `n-${it.seq}`,
          seq: it.seq,
          convo: false,
          variant: it.notice,
          text: it.detail || (it.notice === 'resumed' ? t('stream.notice.resumed') : t('stream.notice.newSession')),
        })
      }
      continue
    }
    if (it.kind === 'status') {
      // 오류·중단으로 턴이 죽었다(D5) — 배너를 놓기 전에 닫아 명령 요약 줄과 작업 줄을 배너 위에 남긴다.
      if (it.status === 'crashed' || it.status === 'interrupted') closeInterrupted(it.seq)
      if (it.status === 'crashed') segs.push({ kind: 'banner', key: `s-${it.seq}`, seq: it.seq, convo: false, variant: 'stop', text: t('stream.notice.crashed') })
      else if (it.status === 'interrupted')
        segs.push({ kind: 'banner', key: `s-${it.seq}`, seq: it.seq, convo: false, variant: 'stop', text: t('stream.notice.interrupted') })
      continue
    }
    if (it.kind === 'permission_request') {
      segs.push({ kind: 'permission', key: `p-${it.seq}`, seq: it.seq, convo: true, req: it.req, resolved: permResolved.get(it.req.id) })
      continue
    }
    if (it.kind === 'question_request') {
      // 질문 바로 앞에 한 말은 답을 고르는 근거다 — 카드가 뜬 순간 화면에 보이던 것을 그 자리에 굳혀
      //   카드 위에 남긴다. 굳히지 않으면 그 말은 다음 말에 갈아끼워져 사라지고, 카드만 덩그러니 남는다.
      //   명령 요약 줄도 여기서 한 번 끊는다 — 사람이 끼어든 지점이 자연스러운 경계라서 시간 순서가 맞는다.
      // lead가 있을 때만 그 글을 말풍선으로 올린다. 없는 질문은 오늘과 같다.
      const before = segs.length
      settle(it.seq, false)
      const lead = typeof it.req.lead === 'string' ? it.req.lead.trim() : ''
      if (lead && !isBlankAssistantText(lead)) {
        for (let i = segs.length - 1; i >= before; i--) {
          const seg = segs[i]
          if (seg?.kind === 'live' && seg.text.trim() === lead) segs.splice(i, 1)
        }
        segs.push({ kind: 'text', key: `ld-${it.seq}`, seq: it.seq, convo: true, text: lead })
      }
      const saved = answers[it.req.id] ?? qAnswers.get(it.req.id)
      const resolved = qResolved.has(it.req.id)
      const skipped = qSkipped.has(it.req.id)
      segs.push({
        kind: 'question',
        key: `q-${it.seq}`,
        seq: it.seq,
        convo: true,
        req: it.req,
        resolved,
        skipped,
        savedAnswers: saved,
      })
      const labels = saved?.flat().map((x) => x.trim()).filter(Boolean) ?? []
      if (resolved && !skipped && labels.length) {
        segs.push({ kind: 'choice', key: `ch-${it.seq}`, seq: it.seq, convo: true, labels })
      }
      continue
    }
    if (it.kind === 'questionnaire') {
      // 성공 질문지만 카드가 된다. 원문 글은 상자를 지운 채 답변 말풍선으로 굳히고 그 바로 뒤에 카드를 둔다.
      //   실패 사건은 그릴 것이 없다 — 원문 글이 상자째 그대로 보인다.
      if (isCardQuestionnaire(it)) {
        settle(it.seq, true)
        segs.push({
          kind: 'questionnaire',
          key: `qn-${it.id}`,
          seq: it.seq,
          convo: true,
          id: it.id,
          questions: it.questions,
          state: qv.states.get(it.id) ?? { status: 'open' },
        })
      }
      continue
    }
    if (it.kind === 'plan_request') {
      settle(it.seq, false)
      segs.push({ kind: 'planCard', key: `pc-${it.seq}`, seq: it.seq, convo: true, req: it.req, resolved: planResolved.get(it.req.id) })
      continue
    }

    // ── 여기부터는 provider가 만든 내용 = 전부 정규화 계약에서 읽는다 ──
    if (contentParts.length) {
      delta = null
      retry = null
      for (const part of contentParts) {
        if (part.type === 'text') {
          // 질문지 상자는 조각 단위로 가린다 — 서버가 상자를 읽은 좌표가 (순번, 조각 번호)라서 이어 붙이기 전에 처리한다.
          const shaped = qv.shapeText(idx, it.seq, part.part, part.text)
          if (isBlankAssistantText(shaped.text) && !shaped.box) continue
          // 한 메시지 안의 여러 텍스트 조각은 이어 붙이고, 새 메시지가 오면 앞의 말은 버린다 — 말하는 자리는 하나다.
          if (pend && pend.seq === it.seq) {
            const text: string = isBlankAssistantText(shaped.text) ? pend.text : isBlankAssistantText(pend.text) ? shaped.text : `${pend.text}\n\n${shaped.text}`
            pend = { text, seq: it.seq, box: pend.box || shaped.box }
          } else {
            pend = { text: shaped.text, seq: it.seq, box: shaped.box }
          }
        } else if (part.type === 'reasoning') {
          // 생각은 말과 달리 갈아끼우지 않고 턴 내내 이어 붙인다 — 나중 생각이 앞 생각을 대신하는 게 아니다.
          think = think ? { text: `${think.text}\n\n${part.text}`, seq: think.seq } : { text: part.text, seq: it.seq }
        } else if (part.type === 'plan_text') {
          plan = plan ? { text: `${plan.text}\n\n${part.text}`, seq: plan.seq } : { text: part.text, seq: it.seq }
        } else if (!isHiddenQuestionTool(part.name)) {
          // 도구 호출이 뒤따랐다 = 방금 한 말은 최종 답변이 아니라 진행 보고였다.
          //   보통은 알림 자리를 그 말로 갈아끼우고, 자세히 모드는 쌓는다.
          if (pend) {
            if (verbose) notes.push(pend)
            else note = pend
            pend = null
          }
          const entry = { name: part.displayName ?? part.name, input: part.input, result: toolResults.get(part.toolId), key: `tk-${it.seq}-${part.part}` }
          if (part.toolKind === 'task') {
            if (!turnTeam.length) {
              teamKey = `team-${it.seq}-${part.part}`
              teamSeq = it.seq
            }
            turnTeam.push(entry)
          } else {
            // 말이 끼어도 도구 묶음을 끊지 않는다 — 턴 하나가 명령 요약 줄 하나다.
            if (!turnTools.length) {
              toolKey = `c-${it.seq}-${part.part}`
              toolSeq = it.seq
            }
            turnTools.push(entry)
          }
        }
      }
    }

    for (const ae of aes ?? []) {
      if (ae.type === 'turn_completed') {
        // 턴이 끝났다 → 재시도 인디케이터 해제 + 미리보기 폐기.
        delta = null
        retry = null
        closeCompleted({ kind: 'result', key: `r-${it.seq}`, seq: it.seq, convo: true, turn: ae, ts: it.ts }, it.seq)
      } else if (ae.type === 'command_output') {
        if (ae.text.trim()) segs.push({ kind: 'commandOutput', key: `lc-${it.seq}-${ae.part}`, seq: it.seq, convo: true, text: ae.text.trim() })
      } else if (ae.type === 'text' || ae.type === 'tool_call' || ae.type === 'reasoning' || ae.type === 'model_info') {
        // 모델이 다시 말을 시작했다는 신호 — 미리보기를 버리고 재시도 표시를 끈다.
        //   `model_info`까지 포함하는 이유: 내용 없이 생각만 하거나 모델만 바뀐 메시지도 생성 재개이기 때문이다.
        delta = null
        retry = null
      } else if (ae.type === 'provider_notice') {
        if (ae.kind === 'rate_limit') {
          if (ae.severity !== 'blocked' || it.seq !== lastBlockedSeq) continue
          const pct = ae.utilization != null ? ` ${Math.round(ae.utilization * 100)}%` : ''
          const meta = [`${rateLimitLabel(ae.limitType, t)}${pct}`, formatReset(ae.resetsAt, t, now)].filter(Boolean).join(' · ')
          segs.push({ kind: 'banner', key: `rl-${it.seq}-${ae.part}`, seq: it.seq, convo: true, variant: 'stop', text: t('stream.rateLimit.rejected', { meta }) })
        } else if (ae.kind === 'retry') {
          // segs.push 아님 = 히스토리에 안 쌓인다. 진행 중일 때만 꼬리에 표시.
          retry = { attempt: ae.attempt, max: ae.max, error: ae.detail }
        } else if (ae.kind === 'compact') {
          // severity가 없으면 사용자가 직접 비운 것(`/clear`) — 알려줄 게 없으니 배너를 띄우지 않는다.
          if (ae.severity) segs.push({ kind: 'banner', key: `cb-${it.seq}-${ae.part}`, seq: it.seq, convo: false, variant: 'resumed', text: t('stream.notice.compacted') })
        } else if (ae.kind === 'model_fallback') {
          // 모델 안전장치가 답을 거부하면 세션이 대체 모델로 영구 전환된다. 침묵하면 "설정이 몰래 되돌아간"
          //   것처럼 보이므로 반드시 표면화하고 복귀 방법도 함께 안내한다.
          const cat = ae.category ? t('stream.notice.modelFallbackCategory', { cat: ae.category }) : ''
          segs.push({
            kind: 'banner',
            key: `mf-${it.seq}-${ae.part}`,
            seq: it.seq,
            convo: true,
            variant: 'warn',
            // 모델 이름은 온 그대로 넣는다 — 짧게 줄이려면 이름의 생김새를 알아야 하는데 그 지식을 프론트에 두지 않는다.
            text: t('stream.notice.modelFallback', { original: ae.originalModel ?? '', fallback: ae.detail ?? '', cat }),
          })
        }
      }
    }
  }

  // 목록 끝인데 턴이 아직 안 닫혔다. 돌고 있든(진행 화면) 답을 못 내고 끊겼든(D5) 화면 배치는 같다 —
  //   최종 답변이 확정되지 않았으니 마지막 말은 답변 말풍선이 아니라 작업 중 알림으로 남는다.
  //   말풍선은 턴이 정상으로 끝나는 순간에만 생긴다. 그래서 그 순간이 "다 됐다"는 신호가 된다.
  //   (목록 끝이라 뒤에 올 이벤트가 없으니 자리 번호는 아무 값이나 무방하다.)
  settle(0, false)

  const hasConvo = segs.some((seg) => seg.convo)
  const showRetry = turn === 'running' && retry != null

  // 턴이 왜 끝났는지는 목록 끝이 아니라, 마지막 사람 말 *뒤*의 종료 사건으로 본다.
  //   자리 번호(seq)로 비교하면 안 된다. 아직 서버에 안 올라간 임시 글의 seq는 음수라, 그 뒤에 온
  //   결과보다 작아 보여 "결과 다음의 말"로 오인한다. 그래서 목록에 놓인 순서로만 비교한다.
  //   학습 알림·모델 정보·배너 같은 부가 사건은 여기 적지 않는다 — 끝나 가는 몸짓을 지우면 안 된다.
  let lastUserIdx = -1
  let lastEndIdx = -1
  let lastEndKind: 'success' | 'error' | 'idle' | null = null
  let lastBlockedIdx = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'user_msg' || it.kind === 'local_user') lastUserIdx = i
    if (it.kind === 'status' && it.status === 'crashed') {
      lastEndIdx = i
      lastEndKind = 'error'
    } else if (it.kind === 'status' && it.status === 'interrupted') {
      lastEndIdx = i
      lastEndKind = 'idle'
    }
    if (!isWire(it)) continue
    const done = turnCompletedOf(it)
    if (done) {
      lastEndIdx = i
      // 결과의 interrupted는 사용자가 멈춘 것과 같다 — 성공/실패 몸짓을 걸지 않는다.
      lastEndKind = done.status === 'ok' ? 'success' : done.status === 'failed' ? 'error' : 'idle'
    }
    for (const ae of agentEventsOf(it) ?? []) {
      if (ae.type === 'provider_notice' && ae.kind === 'rate_limit' && ae.severity === 'blocked') lastBlockedIdx = i
    }
  }

  const lastItemSeq = items.length ? items[items.length - 1].seq : -1
  const tail = segs.length ? segs[segs.length - 1] : undefined
  // 실패는 꼬리 묶음의 마지막 도구만 본다. 그 뒤에 새 도구가 돌면 실패는 끝난 일이다.
  const tailTool = tail?.kind === 'tools' ? tail.tools[tail.tools.length - 1] : undefined
  const lastToolFailed = !!tailTool?.result?.is_error
  const live = turn === 'running' || turn === 'requires_action'
  // 돌고 있거나 답을 기다리는 동안만 "목록 끝 사건"으로 당황·놀람을 가른다.
  //   턴이 이미 끝났으면 아래 종료 원인을 쓴다. 결과 뒤에 알림이 붙어도 성공/실패가 지워지지 않게.
  const chamdingPhase: ChamdingPhase = live
    ? lastBlockedSeq >= 0 && lastBlockedSeq === lastItemSeq
      ? 'confused'
      : lastModelFallbackSeq >= 0 && lastModelFallbackSeq === lastItemSeq
        ? 'surprise'
        : turn === 'requires_action'
          ? 'waiting'
          : lastToolFailed
            ? 'error'
            : tail?.kind === 'tools' || tail?.kind === 'team'
              ? 'working'
              : 'thinking'
    : lastBlockedIdx > lastUserIdx
      ? 'confused'
      : lastEndIdx > lastUserIdx && lastEndKind
        ? lastEndKind
        : 'idle'

  // 마지막 결과 조각의 자리 이름. 임시 글 교체나 예전 대화 붙이기로는 안 바뀐다.
  let turnKey: string | null = null
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind === 'result') {
      turnKey = segs[i].key
      break
    }
  }
  collapseRestartBanners(segs)
  const searchable = segs.flatMap((seg) => {
    if (seg.kind === 'user' || seg.kind === 'text' || seg.kind === 'live' || seg.kind === 'plan') return [{ seq: seg.seq, text: seg.text }]
    if (seg.kind === 'choice') return [{ seq: seg.seq, text: seg.labels.join('\n') }]
    if (seg.kind === 'questionnaire') {
      const bits = seg.questions.flatMap((q) => [q.text, ...(q.options ?? []).map((o) => o.label)])
      return [{ seq: seg.seq, text: bits.join('\n') }]
    }
    if (seg.kind === 'question') {
      const bits = seg.req.questions.flatMap((q) => [q.header, q.question, ...q.options.map((o) => o.label)])
      if (seg.savedAnswers) bits.push(...seg.savedAnswers.flat())
      const text = bits.filter((x): x is string => !!x && x.trim().length > 0).join('\n')
      return text ? [{ seq: seg.seq, text }] : []
    }
    return []
  })
  // 도구가 도는 중·재시도 중에도 자리는 남긴다. 참딩을 그 때마다 숨기면 도구마다 사라졌다 나타난다.
  //   실제로 마운트해 둘지는 보이기 관리자가 정하고, 여기는 "살아 있거나 방금 끝난 사건이 있다"만 말한다.
  //   권한 카드 대기(requires_action)도 참딩이 곁에 있는다.
  const showOrb =
    turn === 'running' ||
    turn === 'requires_action' ||
    chamdingPhase === 'success' ||
    chamdingPhase === 'error' ||
    chamdingPhase === 'confused' ||
    chamdingPhase === 'surprise'
  return { segs, hasConvo, showOrb, chamdingPhase, turnKey, retry: showRetry ? retry : null, searchable }
}

/**
 * 사이에 대화 없이 재시작 알림(복원됨·중단됨)만 이어진 구간을 알림 종류마다 한 줄로 합친다.
 * 이미 쌓인 기록도 화면에서는 정리해 보이게 하려는 것이다. 합친 줄에는 횟수를 붙인다.
 */
export function collapseRestartBanners(segs: StreamSeg[]): void {
  const isRestart = (seg: StreamSeg) => seg.kind === 'banner' && !seg.convo && (seg.variant === 'resumed' || seg.variant === 'stop')
  let i = 0
  while (i < segs.length) {
    if (!isRestart(segs[i])) {
      i++
      continue
    }
    let end = i
    while (end < segs.length && isRestart(segs[end])) end++
    const first = new Map<string, { index: number; count: number }>()
    for (let k = i; k < end; k++) {
      const seg = segs[k] as Extract<StreamSeg, { kind: 'banner' }>
      const id = `${seg.variant}|${seg.text}`
      const hit = first.get(id)
      if (hit) hit.count++
      else first.set(id, { index: k, count: 1 })
    }
    const keep = new Set<number>()
    for (const { index, count } of first.values()) {
      keep.add(index)
      if (count > 1) {
        const seg = segs[index] as Extract<StreamSeg, { kind: 'banner' }>
        segs[index] = { ...seg, text: `${seg.text} (×${count})` }
      }
    }
    const run = segs.slice(i, end).filter((_, k) => keep.has(i + k))
    segs.splice(i, end - i, ...run)
    i += run.length
  }
}
