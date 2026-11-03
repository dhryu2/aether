// 브리프 질문지 카드 — 추천이 미리 채워진 검토지.
//   접힌 줄(번호·질문 전체 문장·지금 답·「추천」/「바꿈」/「답 필요」 글자)을 훑어보고 바꿀 줄만 펼친다. 한 번에 한 줄만 펼친다.
//   아래 줄은 카드가 화면보다 길면 화면 아래에 붙는다(sticky). 글 입력 칸의 Enter는 카드를 보내지 않는다.
//   보낸 뒤나 채팅으로 이어간 뒤에는 모든 줄이 접힌 읽기 전용이다.
//   바깥 면은 `stream/ActionCard`, 선택지 묶음은 지금 `QuestionCard`의 `choice-group`·`choice-row`·`Mark`를 같이 쓴다.
import { useEffect, useRef, useState, type Ref, type TextareaHTMLAttributes } from 'react'
import { ChevronDown, ClipboardList } from 'lucide-react'
import type { QuestionnaireQuestion } from '../lib/types'
import {
  answerMessageId,
  buildAnswers,
  cardView,
  clearAnswer,
  draftFromAnswer,
  initialDrafts,
  pickOption,
  setCustom,
  swallowEnter,
  type Draft,
  type Drafts,
  type QuestionnaireState,
  type RowStatus,
} from '../lib/questionnaire'
import { actions, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { C } from '../design/tokens'
import { Button } from './ui'
import { Mark } from './QuestionCard'
import { AutoGrowInput } from './AutoGrowInput'
import { ActionCard, ActionCardFooter, ActionCardHeader, ActionCardTitle } from './stream/ActionCard'

/**
 * 질문지 id별로 고른 답과 마지막으로 보낸 식별자를 기억한다. 대화 창이 보이는 구간만 그리므로 카드가 화면 밖으로 나가면
 * 컴포넌트가 사라지는데, 그때 사람이 바꾼 답이 날아가면 안 된다. 식별자는 보내기 실패 뒤 같은 답을 다시 보낼 때 쓴다.
 */
const memory = new Map<string, { drafts: Drafts; sent: { id: string; key: string } | null }>()

const NO_DRAFT: Draft = { chosen: [], custom: '', note: '' }
const MAX_TEXT = 1000

const TAG_KEY: Record<RowStatus, string> = {
  recommended: 'session.questionnaire.tagRecommended',
  changed: 'session.questionnaire.tagChanged',
  needed: 'session.questionnaire.tagNeeded',
}
// 글자가 뜻을 나르고 색은 거든다(색만으로 추천을 나타내지 않는다).
const TAG_COLOR: Record<RowStatus, string> = { recommended: C.label2, changed: C.tint, needed: C.attn }

function EnterSwallowInput(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'>) {
  return (
    <AutoGrowInput
      {...props}
      maxLength={MAX_TEXT}
      // Enter는 아무것도 보내지 않는다. 한글 조합 중 Enter는 조합을 확정하는 키라 건드리지 않는다.
      onKeyDown={(e) => {
        if (swallowEnter({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) e.preventDefault()
      }}
    />
  )
}

function Options({
  q,
  draft,
  narrow,
  groupRef,
  onChange,
}: {
  q: QuestionnaireQuestion
  draft: Draft
  narrow: boolean
  groupRef: Ref<HTMLDivElement>
  onChange: (d: Draft) => void
}) {
  const t = useT()
  const multi = q.kind === 'multi'
  const rowStyle = { alignItems: 'flex-start', gap: 12, padding: '12px 16px', minHeight: narrow ? 48 : 44 } as const
  const inputStyle = { flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, color: C.label } as const
  return (
    <div
      ref={groupRef}
      tabIndex={-1}
      role={q.kind === 'single' ? 'radiogroup' : 'group'}
      aria-label={q.text}
      className="choice-group"
      style={{ outline: 'none' }}
    >
      {q.kind === 'text' ? (
        <div className="choice-row" style={{ padding: '12px 16px' }}>
          <textarea
            value={draft.custom}
            onChange={(e) => onChange(setCustom(q, draft, e.target.value))}
            maxLength={MAX_TEXT}
            rows={3}
            aria-label={q.text}
            placeholder={t('session.questionnaire.textPlaceholder')}
            className="choice-other"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
          />
        </div>
      ) : (
        <>
          {(q.options ?? []).map((o) => {
            const on = draft.chosen.includes(o.label)
            return (
              <button
                key={o.label}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                onClick={() => onChange(pickOption(q, draft, o.label))}
                className="choice-row press flex w-full text-left"
                style={rowStyle}
              >
                <Mark multi={multi} on={on} live />
                <span className="min-w-0">
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: C.label, overflowWrap: 'anywhere' }}>{o.label}</span>
                  {o.description && <span style={{ display: 'block', fontSize: 13, color: C.label2, marginTop: 2 }}>{o.description}</span>}
                </span>
              </button>
            )
          })}
          {/* 직접 입력 — 묶음의 마지막 선택 줄. */}
          <label className="choice-row flex" style={{ ...rowStyle, alignItems: 'center', cursor: 'text' }}>
            <Mark multi={multi} on={!!draft.custom.trim()} live />
            <EnterSwallowInput
              value={draft.custom}
              onChange={(e) => onChange(setCustom(q, draft, e.target.value))}
              placeholder={t('session.questionnaire.customPlaceholder')}
              aria-label={`${q.text} — ${t('session.questionnaire.customPlaceholder')}`}
              className="choice-other"
              style={inputStyle}
            />
          </label>
        </>
      )}
      <label className="choice-row flex" style={{ ...rowStyle, alignItems: 'center', cursor: 'text' }}>
        <span style={{ fontSize: 13, color: C.label2, flexShrink: 0 }}>{t('session.questionnaire.note')}</span>
        <EnterSwallowInput
          value={draft.note}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
          aria-label={`${q.text} — ${t('session.questionnaire.note')}`}
          className="choice-other"
          style={inputStyle}
        />
      </label>
    </div>
  )
}

export function QuestionnaireCard({
  sessionId,
  id,
  questions,
  state,
}: {
  sessionId: string
  id: string
  questions: QuestionnaireQuestion[]
  state: QuestionnaireState
}) {
  const t = useT()
  const narrow = useStore().isNarrow
  const [drafts, setDrafts] = useState<Drafts>(() => memory.get(id)?.drafts ?? initialDrafts(questions))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // 서버 사건이 오기 전에 보내기가 성공했으면 읽기 전용으로 먼저 바꾼다. 되돌리기로 다시 열리면 푼다.
  const [sentOk, setSentOk] = useState(false)
  const [prevStatus, setPrevStatus] = useState(state.status)
  if (prevStatus !== state.status) {
    setPrevStatus(state.status)
    if (state.status === 'open') setSentOk(false)
  }
  const groupRef = useRef<HTMLDivElement>(null)
  const focusOnOpen = useRef(false)
  // 줄을 펼치면 초점이 선택지 묶음으로 간다(키보드만으로 답할 수 있게).
  useEffect(() => {
    if (!expanded || !focusOnOpen.current) return
    focusOnOpen.current = false
    groupRef.current?.focus()
  }, [expanded])

  const readOnly = state.status !== 'open' || sentOk
  const shown: Drafts =
    state.status === 'answered'
      ? Object.fromEntries(questions.map((q) => [q.id, draftFromAnswer(state.answers[q.id])]))
      : drafts
  const view = cardView(questions, shown)
  const continued = state.status === 'continued'

  function change(qid: string, next: Draft) {
    const all = { ...drafts, [qid]: next }
    setDrafts(all)
    setFailed(false)
    memory.set(id, { drafts: all, sent: memory.get(id)?.sent ?? null })
  }
  function toggle(qid: string) {
    focusOnOpen.current = expanded !== qid
    setExpanded(expanded === qid ? null : qid)
  }
  async function submit() {
    if (busy || readOnly) return
    const answers = buildAnswers(questions, drafts)
    const sent = answerMessageId(memory.get(id)?.sent, answers, () => crypto.randomUUID())
    memory.set(id, { drafts, sent })
    setBusy(true)
    setFailed(false)
    const ok = await actions.sendQuestionnaireAnswer(sessionId, id, answers, sent.id)
    setBusy(false)
    if (ok) setSentOk(true)
    else setFailed(true)
  }

  const statusText =
    view.changed === 0 && view.unanswered === 0
      ? t('session.questionnaire.allRecommended')
      : [
          view.changed > 0 ? t('session.questionnaire.changedCount', { n: view.changed }) : '',
          view.unanswered > 0 ? t('session.questionnaire.unansweredCount', { n: view.unanswered }) : '',
        ]
          .filter(Boolean)
          .join(' · ')

  return (
    <ActionCard pending={!readOnly} result="answer" className="action-card-sticky">
      <ActionCardHeader pending={!readOnly} icon={<ClipboardList size={16} />}>
        <ActionCardTitle title={t('session.questionnaire.title', { n: view.total })} />
        {!continued && (
          <span style={{ fontSize: 13, color: C.label2, flexShrink: 0 }}>
            {t('session.questionnaire.progress', { done: view.answered, total: view.total })}
          </span>
        )}
      </ActionCardHeader>

      <div className="flex flex-col">
        {view.rows.map((row, i) => {
          const open = !readOnly && expanded === row.q.id
          const panelId = `qn-${id}-${row.q.id}`
          const answerText = continued ? '' : row.shown || t('session.questionnaire.skipped')
          const showTag = !continued && !(readOnly && row.status === 'needed')
          const head = (
            <>
              <span aria-hidden style={{ width: 22, flexShrink: 0, fontSize: 13.5, fontWeight: 600, color: C.label3, marginTop: 1 }}>
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span style={{ display: 'block', fontSize: 15, fontWeight: 500, lineHeight: 1.45, color: C.label, overflowWrap: 'anywhere' }}>
                  {row.q.text}
                </span>
                {!continued && (
                  <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, marginTop: 2 }}>
                    <span style={{ fontSize: 14, color: row.status === 'needed' ? C.label3 : C.label2, overflowWrap: 'anywhere' }}>
                      {row.status === 'needed' && !readOnly ? '' : answerText}
                    </span>
                    {showTag && (
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: TAG_COLOR[row.status] }}>{t(TAG_KEY[row.status])}</span>
                    )}
                  </span>
                )}
              </span>
            </>
          )
          const headStyle = { gap: 12, alignItems: 'flex-start', minHeight: narrow ? 48 : 44, padding: '10px 0' } as const
          return (
            <div key={row.q.id} style={i > 0 ? { borderTop: `0.5px solid ${C.sepSoft}` } : undefined}>
              {readOnly ? (
                <div className="flex w-full" style={headStyle}>
                  {head}
                </div>
              ) : (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => toggle(row.q.id)}
                  className="flex w-full text-left"
                  style={{ ...headStyle, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  {head}
                  <ChevronDown
                    size={18}
                    aria-hidden
                    style={{ flexShrink: 0, marginTop: 2, color: C.label3, transform: open ? 'rotate(180deg)' : undefined }}
                  />
                </button>
              )}
              {open && (
                <div id={panelId} className="flex flex-col" style={{ gap: 8, paddingBottom: 12 }}>
                  <Options
                    q={row.q}
                    draft={drafts[row.q.id] ?? NO_DRAFT}
                    narrow={narrow}
                    groupRef={groupRef}
                    onChange={(next) => change(row.q.id, next)}
                  />
                  {row.status !== 'needed' && (
                    <button
                      type="button"
                      onClick={() => change(row.q.id, clearAnswer(drafts[row.q.id] ?? NO_DRAFT))}
                      style={{
                        alignSelf: 'flex-end',
                        minHeight: narrow ? 44 : 36,
                        padding: '0 12px',
                        fontSize: 13,
                        color: C.label2,
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {t('session.questionnaire.skip')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {readOnly ? (
        <ActionCardFooter color={continued ? C.label3 : C.tint}>
          {continued ? t('session.questionnaire.continued') : t('session.questionnaire.sent')}
        </ActionCardFooter>
      ) : (
        // 아래 줄 — 카드가 화면보다 길면 화면 아래(떠 있는 입력창 위)에 붙는다.
        //   붙는 기준선은 대화 칸의 아래 여백 안쪽에서 센다. 그 여백이 이미 입력창 높이(--composer-h)를
        //   비워 두므로 여기서 다시 빼면 입력창 높이만큼 위로 들려 앞 줄을 덮는다(폰 폭 실측).
        <div
          style={{
            position: 'sticky',
            bottom: 8,
            zIndex: 1,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            paddingTop: 12,
            background: C.cell,
            borderTop: `0.5px solid ${C.sepSoft}`,
          }}
        >
          {failed && (
            <div role="alert" style={{ width: '100%', fontSize: 13, color: C.del }}>
              {t('session.questionnaire.sendFailed')}
            </div>
          )}
          <span style={{ fontSize: 13, color: C.label2 }}>{statusText}</span>
          <Button
            tone="primary"
            height={narrow ? 48 : 44}
            paddingX={20}
            fontSize={15}
            grow={narrow}
            disabled={busy}
            aria-busy={busy}
            onClick={submit}
          >
            {busy
              ? t('session.questionnaire.sending')
              : view.asIs
                ? t('session.questionnaire.sendAsIs')
                : t('session.questionnaire.sendRecommended')}
          </Button>
        </div>
      )}
    </ActionCard>
  )
}

/** 모델이 질문지 상자를 쓰는 동안 그 자리에 놓는 빈 카드. 움직임이 없다. */
export function QuestionnairePendingCard() {
  const t = useT()
  const bar = (width: string) => <div style={{ height: 12, width, borderRadius: 6, background: C.fill }} />
  return (
    <ActionCard pending result="answer">
      <div role="status" aria-busy="true" className="flex flex-col" style={{ gap: 14 }}>
        <ActionCardHeader pending icon={<ClipboardList size={16} />}>
          <ActionCardTitle title={t('session.questionnaire.pending')} />
        </ActionCardHeader>
        <div className="flex flex-col" style={{ gap: 10 }} aria-hidden>
          {bar('78%')}
          {bar('52%')}
        </div>
      </div>
    </ActionCard>
  )
}
