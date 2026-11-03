// 할 일 칩 — 에이전트가 만든 할 일 목록의 진행 상황을 칸 머리·상단 도구 섬에 작게 보인다.
//   목록의 정본은 대화 기록의 마지막 plan_update다(서버는 따로 저장하지 않는다). 칩은 읽기만 한다.
//   누르면 칩 아래로 작은 창이 펼쳐지고, 바깥을 누르거나 Esc로 닫힌다. 색만으로 상태를 전하지 않는다(아이콘+글자).
import { useRef, useState } from 'react'
import { Check, Circle, CircleCheck, CircleDot, ListTodo } from 'lucide-react'
import type { TodoItem } from '@shared/agentEvent'
import { sessionTurn, useStore } from '../lib/store'
import { todoCounts } from '../lib/agentEvents'
import { todoViewOf } from '../lib/todoView'
import { useT } from '../lib/i18n'
import { useDismiss } from '../lib/hooks'
import { PopoverSurface } from './ui'
import { C, R } from '../design/tokens'

/** 항목 한 줄: 상태 아이콘 + 글 + 상태 글자. 작은 창과 턴 끝 카드가 같이 쓴다. */
export function TodoRow({ item }: { item: TodoItem }) {
  const t = useT()
  const done = item.status === 'completed'
  const Icon = done ? CircleCheck : item.status === 'in_progress' ? CircleDot : Circle
  return (
    <div className="flex items-start" data-todo-status={item.status} style={{ gap: 8 }}>
      <Icon size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: done ? C.label3 : C.label2 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13.5,
          lineHeight: 1.45,
          fontWeight: item.status === 'in_progress' ? 600 : 400,
          color: done ? C.label3 : C.label,
          overflowWrap: 'anywhere',
        }}
      >
        {item.text}
      </span>
      <span style={{ flexShrink: 0, fontSize: 12, lineHeight: 1.6, color: C.label2 }}>{t(`nav.todo.status.${item.status}`)}</span>
    </div>
  )
}

/**
 * placement: 'pane' = 칸 머리(칸이 둘 이상일 때), 'island' = 상단 도구 섬(칸이 하나일 때).
 * compact: 폰에서는 진행 표시를 "3/5"로 줄인다. "n개 남음"은 줄이지 않는다.
 */
export function TodoChip({ sessionId, placement, compact }: { sessionId: string; placement: 'pane' | 'island'; compact?: boolean }) {
  const s = useStore()
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), open)
  const view = todoViewOf(s, sessionId)
  if (!view) return null

  const { done, total, left } = todoCounts(view.items)
  const turnLive = sessionTurn(s, sessionId) !== 'idle'
  const leftover = !turnLive && left > 0
  const finished = !turnLive && left === 0
  const Icon = finished ? Check : ListTodo
  const progress = t(compact ? 'nav.todo.progressShort' : 'nav.todo.progress', { done, total })
  const text = leftover ? t('nav.todo.left', { n: left }) : progress
  const doing = view.items.filter((i) => i.status === 'in_progress')
  const island = placement === 'island'
  const narrow = s.isNarrow

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        data-todo-chip
        data-todo-left={left}
        className={`press inline-flex items-center${island ? ' icon-ghost' : ' hit-44'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${text}. ${t('nav.todo.aria', { done, total })}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          gap: 5,
          height: island ? (narrow ? 44 : 36) : 24,
          padding: island ? '0 10px' : '0 8px',
          border: 'none',
          borderRadius: R.full,
          background: island ? 'transparent' : C.fill,
          color: leftover ? C.attn : C.label2,
          fontSize: 12.5,
          fontWeight: leftover ? 600 : 500,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}
      >
        <Icon size={14} aria-hidden />
        <span className="tabular-nums">{text}</span>
      </button>
      {open && (
        <PopoverSurface role="dialog" aria-label={t('nav.todo.title')} direction="down" align="right" minWidth={260} style={{ maxHeight: 'min(60vh, 420px)', overflowY: 'auto' }}>
          <div className="flex flex-col" style={{ gap: 10, padding: '12px 14px' }}>
            <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.label }}>{t('nav.todo.title')}</span>
              <span className="tabular-nums" style={{ fontSize: 12.5, color: C.label2 }}>{t('nav.todo.progressShort', { done, total })}</span>
            </div>
            {doing.length > 0 && (
              <section className="flex flex-col" style={{ gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.label2 }}>{t('nav.todo.now')}</span>
                {doing.map((item, i) => <TodoRow key={i} item={item} />)}
              </section>
            )}
            <section className="flex flex-col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.label2 }}>{t('nav.todo.all')}</span>
              {view.items.map((item, i) => <TodoRow key={i} item={item} />)}
            </section>
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}
