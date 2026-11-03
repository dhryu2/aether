// W14. 질문 카드(AskUserQuestion 객관식) — 단일/다중 + 기타 직접입력.
//   바깥 면·머리·결과 줄은 권한·계획 카드와 같아서 `stream/ActionCard`가 함께 갖고 있다.
//   답을 보낸 뒤에도 질문 원문·선택지를 접지 않는다. 권한 카드가 diff를 남기는 것과 같다 —
//   머리만 남기면 "무슨 질문에 이걸 골랐는지"가 사라진다.
//   재설계 4단계(시안 A): 선택지는 따로 떨어진 상자들이 아니라 한 회색 묶음(.choice-group) 안의 줄들이다.
//   고른 줄은 파랑 동그라미(단일)나 파랑 네모(다중)로만 표시한다 — 줄 전체를 칠하지 않는다.
import { useState } from 'react'
import { HelpCircle, Check } from 'lucide-react'
import type { AetherQuestion, QuestionRequest } from '../lib/types'
import { questionBody, questionHeaderTitle, showSecondaryHeader } from '../lib/questionDisplay'
import { actions, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { C } from '../design/tokens'
import { Button } from './ui'
import { Markdown } from './Markdown'
import { AutoGrowInput } from './AutoGrowInput'
import { ActionCard, ActionCardActions, ActionCardFooter, ActionCardHeader, ActionCardTitle } from './stream/ActionCard'

const OTHER = '__other__'

function splitSaved(q: AetherQuestion, saved?: string[]): { sel: Set<string>; other: string } {
  const labels = new Set(q.options.map((o) => o.label))
  const sel = new Set<string>()
  let other = ''
  for (const s of saved ?? []) {
    if (labels.has(s)) sel.add(s)
    else other = s
  }
  return { sel, other }
}

// live = 지금 고를 수 있는 카드. 답이 끝난 카드를 다시 불러올 때는 체크가 튀어나오지 않는다.
export function Mark({ multi, on, live }: { multi: boolean; on: boolean; live: boolean }) {
  // 단일 선택의 켜짐 = 굵은 파랑 테두리 안에 묶음 바탕이 비치는 고리(시안 A). 다중은 파랑 네모에 흰 체크.
  // choice-mark = 켜고 끌 때 테두리·색이 0.12초 동안 바뀐다(index.css).
  if (!multi)
    return (
      <span
        aria-hidden
        className="choice-mark"
        style={{
          width: 22,
          height: 22,
          flexShrink: 0,
          marginTop: 1,
          borderRadius: '50%',
          boxSizing: 'border-box',
          border: on ? `7px solid ${C.tintFill}` : `1.5px solid ${C.label3}`,
        }}
      />
    )
  return (
    <span
      aria-hidden
      className="choice-mark inline-flex items-center justify-center"
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        marginTop: 1,
        borderRadius: 7,
        boxSizing: 'border-box',
        border: `1.5px solid ${on ? C.tintFill : C.label3}`,
        background: on ? C.tintFill : 'transparent',
      }}
    >
      {on && <Check size={14} strokeWidth={3} className={live ? 'choice-check' : undefined} style={{ color: C.onTint }} />}
    </span>
  )
}

function QuestionBlock({
  q,
  qi,
  sel,
  other,
  locked,
  narrow,
  onPick,
  onOther,
  onSubmit,
}: {
  q: AetherQuestion
  qi: number
  sel: Set<string>
  other: string
  locked: boolean
  narrow: boolean
  onPick: (label: string) => void
  onOther: (v: string) => void
  onSubmit: () => void
}) {
  const t = useT()
  const multi = !!q.multiSelect
  const body = questionBody(q)
  const rowStyle = { alignItems: 'flex-start', gap: 12, padding: '12px 16px', minHeight: 48 } as const
  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      {qi > 0 && showSecondaryHeader(q) && <div style={{ fontSize: 12.5, fontWeight: 600, color: C.label2 }}>{q.header}</div>}
      {body ? <div style={{ fontSize: 15.5, fontWeight: 500, lineHeight: 1.5, color: C.label }}>{body}</div> : null}
      <div className="choice-group">
        {q.options.map((o) => {
          const on = sel.has(o.label)
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={on}
              aria-disabled={locked}
              tabIndex={locked ? -1 : undefined}
              onClick={() => onPick(o.label)}
              className={locked ? 'choice-row flex w-full text-left' : 'choice-row press flex w-full text-left'}
              style={{
                ...rowStyle,
                opacity: locked && !on ? 0.72 : 1,
                cursor: locked ? 'default' : undefined,
                pointerEvents: locked ? 'none' : undefined,
              }}
            >
              <Mark multi={multi} on={on} live={!locked} />
              <span className="min-w-0">
                <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: C.label }}>{o.label}</span>
                {o.description && <span style={{ display: 'block', fontSize: 13, color: C.label2, marginTop: 2 }}>{o.description}</span>}
                {o.preview && (!narrow || on) ? (
                  <div
                    className="scroll-area"
                    style={{ marginTop: 8, maxHeight: 120, overflow: 'auto', fontSize: 12.5, lineHeight: 1.45, color: C.label2 }}
                  >
                    <Markdown>{o.preview}</Markdown>
                  </div>
                ) : null}
              </span>
            </button>
          )
        })}
        {/* 기타(직접 입력) — 묶음의 마지막 줄. 답한 뒤에는 실제로 적은 문장이 있을 때만 남긴다. */}
        {(!locked || other.trim()) && (
          <label className="choice-row flex" style={{ ...rowStyle, alignItems: 'center', cursor: locked ? 'default' : 'text' }}>
            <Mark multi={multi} on={!!other.trim()} live={!locked} />
            {locked ? (
              <span style={{ flex: 1, fontSize: 15, color: C.label, overflowWrap: 'anywhere' }}>{other}</span>
            ) : (
              <AutoGrowInput
                value={other}
                onChange={(e) => onOther(e.target.value)}
                // Enter = '답변 보내기' 누른 것과 동일(IME 조합 중·Shift+Enter는 제외 — 한글 잠재버그 방지, task2)
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    onSubmit()
                  }
                }}
                enterKeyHint="send"
                placeholder={t('session.question.otherPlaceholder')}
                className="choice-other"
                style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, color: C.label }}
              />
            )}
          </label>
        )}
      </div>
    </div>
  )
}

export function QuestionCard({
  req,
  resolved,
  skipped,
  savedAnswers,
}: {
  req: QuestionRequest
  resolved?: boolean
  skipped?: boolean
  savedAnswers?: string[][]
}) {
  const t = useT()
  const narrow = useStore().isNarrow
  const [sel, setSel] = useState<Record<number, Set<string>>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const first = req.questions[0]
  const multiFirst = !!first?.multiSelect
  const locked = !!resolved

  function pick(qi: number, label: string) {
    if (locked) return
    const q = req.questions[qi]
    setSel((prev) => {
      const cur = new Set(prev[qi] ?? [])
      if (q.multiSelect) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else {
        cur.clear()
        cur.add(label)
      }
      return { ...prev, [qi]: cur }
    })
    if (!q.multiSelect) setOther((p) => ({ ...p, [qi]: '' })) // 단일선택: 옵션 고르면 기타 비움
  }
  function setOtherText(qi: number, v: string) {
    if (locked) return
    const q = req.questions[qi]
    setOther((p) => ({ ...p, [qi]: v }))
    if (!q.multiSelect && v.trim()) setSel((p) => ({ ...p, [qi]: new Set([OTHER]) })) // 단일: 기타 입력 시 옵션 해제
    if (!q.multiSelect && !v.trim()) setSel((p) => ({ ...p, [qi]: new Set() }))
  }

  // 고른 선택지와 직접 입력을 **분리해서** 낸다(8d-3 ⑥ⓒ). 서버는 앞쪽만 제시된 선택지와 대조하고,
  //   뒤쪽은 자유 입력으로 표시해 모델에 전달한다. 합쳐 보내면 서버가 둘을 구분할 수 없다.
  const chosenOf = (): string[][] => req.questions.map((_q, qi) => [...(sel[qi] ?? new Set<string>())].filter((l) => l !== OTHER))
  const customOf = (): (string | null)[] => req.questions.map((_q, qi) => (other[qi] ?? '').trim() || null)

  const complete = req.questions.every((_q, qi) => (sel[qi]?.size ?? 0) > 0 || (other[qi] ?? '').trim())

  function submit() {
    if (resolved || !complete) return // 미완성이면 무시(버튼 disabled와 동일 게이트)
    actions.resolveQuestion(req.id, chosenOf(), customOf())
  }

  return (
    <ActionCard pending={!resolved} result="answer">
      <ActionCardHeader pending={!resolved} icon={<HelpCircle size={16} />}>
        <ActionCardTitle
          title={questionHeaderTitle(first, t('session.question.fallbackHeader'))}
          sub={multiFirst ? t('session.question.multiTag') : t('session.question.singleTag')}
        />
      </ActionCardHeader>

      {req.questions.map((q, qi) => {
        const shown = locked ? splitSaved(q, savedAnswers?.[qi]) : { sel: sel[qi] ?? new Set<string>(), other: other[qi] ?? '' }
        return (
          <QuestionBlock
            key={qi}
            q={q}
            qi={qi}
            sel={shown.sel}
            other={shown.other}
            locked={locked}
            narrow={narrow}
            onPick={(l) => pick(qi, l)}
            onOther={(v) => setOtherText(qi, v)}
            onSubmit={submit}
          />
        )
      })}

      {!resolved && (
        <ActionCardActions narrow={false}>
          <span style={{ fontSize: 12.5, color: C.label3, marginRight: 'auto' }}>
            {multiFirst ? t('session.question.multiHint') : t('session.question.singleHint')}
          </span>
          <Button
            tone="primary"
            disabled={!complete}
            onClick={submit}
            height={44}
            paddingX={20}
            fontSize={15}
            // 고를 것을 다 고르기 전: 회색 면에 흐린 글자(꺼진 버튼은 명암 기준에서 뺀다).
            style={!complete ? { background: C.fill, color: C.label4 } : undefined}
          >
            {t('session.question.submit')}
          </Button>
        </ActionCardActions>
      )}

      {resolved && skipped && <ActionCardFooter color={C.label3}>{t('session.question.skipped')}</ActionCardFooter>}
      {resolved && !skipped && (
        <ActionCardFooter color={C.tint}>
          {t('session.question.answered')}
          {savedAnswers && savedAnswers.flat().length > 0 ? ` · ${savedAnswers.flat().join(' · ')}` : ''}
        </ActionCardFooter>
      )}
    </ActionCard>
  )
}
