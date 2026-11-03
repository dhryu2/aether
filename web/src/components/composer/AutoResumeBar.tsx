import { useId, useState, type CSSProperties } from 'react'
import { Clock, CircleAlert } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { actions } from '../../lib/store'
import { api } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import { useT } from '../../lib/i18n'
import { autoResumeTimeText, nextOccurrence, timeInputValue } from '../../lib/autoResume'
import type { AutoResumePlan } from '../../lib/types'

// 입력창 위 한 줄 막대 — 한도가 풀리면 이어 가기 예약을 보이고, 지금 보내기·바꾸기·취소를 한다.
//   바꾸기를 누르면 같은 자리에서 시각 입력과 문장 입력으로 펼쳐진다(모달 없음).
//   시각 입력은 브라우저 기본 time 입력(5분 단위), 폰에서는 시스템 선택기가 뜬다. 모든 단추는 44px 눌림 범위를 가진다.

const STEP_SECONDS = 300

/** 지금부터 30분 뒤를 5분 단위로 올린 "HH:MM". 포기한 예약을 다시 걸 때의 첫 값이다. */
function defaultRetryTime(now = Date.now()): string {
  const step = STEP_SECONDS * 1000
  return timeInputValue(Math.ceil((now + 30 * 60_000) / step) * step)
}

const btn: CSSProperties = {
  minHeight: 36,
  padding: '0 12px',
  border: 'none',
  borderRadius: R.full,
  background: C.fill,
  color: C.label,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const field: CSSProperties = {
  height: 36,
  minWidth: 0,
  padding: '0 10px',
  border: 'none',
  borderRadius: R.field,
  background: C.fill,
  color: C.label,
  fontSize: 14,
  fontFamily: 'inherit',
}

export function AutoResumeBar({ plan, sessionId, execId }: { plan: AutoResumePlan; sessionId: string; execId: string }) {
  const t = useT()
  const uid = useId()
  const gaveUp = plan.gaveUp === true
  // 인계서 쓰기 예약에는 보낼 문장이 없다. 문장 편집과 지금 보내기는 문장 예약에만 있다.
  const sentence = plan.action.type === 'send' ? plan.action.text : null
  const [editing, setEditing] = useState(false)
  const [time, setTime] = useState('')
  const [timeDirty, setTimeDirty] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const open = () => {
    setTime(plan.at !== undefined ? timeInputValue(plan.at) : defaultRetryTime())
    setTimeDirty(false)
    setText(sentence ?? '')
    setEditing(true)
  }
  const fail = (e: unknown) => actions.showError(`${t('composer.autoResume.failed')}: ${errMsg(e)}`)

  const save = async () => {
    const body: { at?: number; text?: string } = {}
    // 포기한 예약은 시각을 다시 정해야 살아난다. 그 밖에는 시각 칸을 건드렸을 때만 보낸다.
    if (gaveUp || timeDirty) {
      const at = nextOccurrence(time)
      if (at == null) return
      body.at = at
    }
    if (sentence !== null && text.trim() && text.trim() !== sentence) body.text = text.trim()
    if (body.at === undefined && body.text === undefined) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await api.editAutoResume(execId, body)
      setEditing(false)
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  const summary = gaveUp ? t('composer.autoResume.gaveUp') : t('composer.autoResume.next', { time: autoResumeTimeText(plan.at ?? 0) })
  const Icon = gaveUp ? CircleAlert : Clock

  return (
    <div
      className="glass"
      data-testid="auto-resume-bar"
      style={{ borderRadius: R.card, minWidth: 0, padding: '6px 10px 6px 14px' }}
    >
      <div className="flex flex-wrap items-center" style={{ gap: 6, minWidth: 0 }}>
        <Icon size={16} aria-hidden style={{ flexShrink: 0, color: gaveUp ? C.attn : C.tint }} />
        <span className="truncate" style={{ flex: '1 1 160px', minWidth: 0, fontSize: 13, fontWeight: 600, color: gaveUp ? C.attn : C.label }}>
          {summary}
          <span style={{ fontWeight: 400, color: C.label2 }}> · {sentence !== null ? `「${sentence}」` : t('composer.autoResume.handoffAction')}</span>
        </span>
        {!editing && (
          <span className="flex flex-wrap items-center" style={{ gap: 6 }}>
            {sentence !== null && (
              <button type="button" className="press hit-44" style={btn} onClick={() => void actions.send(sentence, undefined, undefined, sessionId)}>
                {t('composer.autoResume.sendNow')}
              </button>
            )}
            <button type="button" className="press hit-44" style={btn} aria-expanded={false} onClick={open}>
              {sentence !== null ? t('composer.autoResume.edit') : t('composer.autoResume.editTime')}
            </button>
            <button type="button" className="press hit-44" style={btn} onClick={() => void api.cancelAutoResume(execId).catch(fail)}>
              {t('composer.autoResume.cancel')}
            </button>
          </span>
        )}
      </div>
      {editing && (
        <form
          className="flex flex-wrap items-end"
          style={{ gap: 8, padding: '8px 0 6px' }}
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            }
          }}
        >
          <label className="flex flex-col" style={{ gap: 3, fontSize: 12, color: C.label2 }}>
            {t('composer.autoResume.timeLabel')}
            <input
              id={`${uid}-time`}
              type="time"
              step={STEP_SECONDS}
              autoFocus
              value={time}
              onChange={(e) => {
                setTime(e.target.value)
                setTimeDirty(true)
              }}
              style={field}
            />
          </label>
          {sentence !== null && (
            <label className="flex flex-col" style={{ gap: 3, flex: '1 1 200px', minWidth: 0, fontSize: 12, color: C.label2 }}>
              {t('composer.autoResume.textLabel')}
              <input id={`${uid}-text`} type="text" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} style={field} />
            </label>
          )}
          <span className="flex items-center" style={{ gap: 6 }}>
            <button type="submit" className="press hit-44" disabled={saving} style={{ ...btn, background: C.tintFill, color: C.onTint, fontWeight: 600 }}>
              {t('composer.autoResume.save')}
            </button>
            <button type="button" className="press hit-44" style={btn} onClick={() => setEditing(false)}>
              {t('composer.autoResume.close')}
            </button>
          </span>
        </form>
      )}
    </div>
  )
}
