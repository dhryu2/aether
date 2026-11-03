import { useEffect, useId, useRef, useState } from 'react'
import { Bot, ChevronDown, CircleDashed, Terminal } from 'lucide-react'
import clsx from 'clsx'
import { C, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { backgroundAnnouncement } from '../../lib/backgroundTasks'
import type { BackgroundTask } from '../../lib/types'
import { Collapse } from '../ui'
import { StatusIcon, statusTone } from '../stream/TeamRun'

// 메인 턴이 끝난 뒤에도 백그라운드 작업을 알리는 띠. 접힌 채 시작하고, 머리를 누르면 작업 목록이 펼쳐진다.
//   "중지"는 이 뒤 작업을 멈추는 것이고, 입력창 옆의 중단(메인 턴 멈추기)과 다르다.
//   색만으로 구분하지 않는다: 종류는 아이콘+이름, 상태는 아이콘+글자로 함께 보인다.

const KIND_ICON = { agent: Bot, command: Terminal, other: CircleDashed } as const
const LEAVE_MS = 150 // 사라짐 페이드 길이(index.css .bg-strip-out과 같다)

type Props = {
  tasks: BackgroundTask[]
  /** 서버가 중지를 받아 줄 수 있을 때만 버튼을 그린다. */
  canStop: boolean
  /** 중지 요청을 보낸 작업 id — 목록이 바뀔 때까지 그 버튼은 비활성이다. */
  stopping: ReadonlySet<string>
  onStop: (taskId: string) => void
  onStopAll: () => void
  isNarrow: boolean
}

export function BackgroundTasksStrip({ tasks, canStop, stopping, onStop, onStopAll, isNarrow }: Props) {
  const t = useT()
  const bodyUid = useId() // 화면 분할로 입력창이 둘이어도 id가 겹치지 않게
  const [open, setOpen] = useState(false)
  // 목록이 비어도 페이드가 끝날 때까지 직전 목록을 붙들고 그린다.
  const [shown, setShown] = useState<{ tasks: BackgroundTask[]; leaving: boolean } | null>(tasks.length ? { tasks, leaving: false } : null)
  useEffect(() => {
    if (tasks.length > 0) {
      setShown({ tasks, leaving: false })
      return
    }
    setShown((cur) => (cur ? { ...cur, leaving: true } : cur))
    const timer = window.setTimeout(() => {
      setShown(null)
      setOpen(false)
    }, LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [tasks])

  if (!shown) return null
  const list = shown.tasks
  const h = 44 // 눌림 영역 44px 이상
  const bodyId = `bg-tasks-${bodyUid}`
  return (
    <div
      className={clsx('glass', shown.leaving ? 'bg-strip-out' : 'bg-strip-in')}
      data-testid="bg-strip"
      style={{ borderRadius: R.card, overflow: 'hidden', minWidth: 0 }}
    >
      <div className="flex items-center" style={{ minWidth: 0 }}>
        <button
          type="button"
          className="press flex items-center"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: h,
            gap: 9,
            padding: '0 8px 0 14px',
            background: 'transparent',
            border: 0,
            color: C.label,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <CircleDashed size={16} style={{ color: C.tint, flexShrink: 0 }} aria-hidden />
          <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
            {t('composer.background.summary', { n: list.length })}
          </span>
          <ChevronDown
            size={16}
            aria-hidden
            style={{ color: C.label2, flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-press) var(--ease-state)' }}
          />
        </button>
        {canStop && (
          <button
            type="button"
            className="press"
            aria-label={t('composer.background.stopAllLabel')}
            disabled={list.every((x) => stopping.has(x.id))}
            onClick={onStopAll}
            style={{
              flexShrink: 0,
              minHeight: h,
              minWidth: h,
              padding: '0 14px',
              marginRight: 4,
              background: 'transparent',
              border: 0,
              color: C.del,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              opacity: list.every((x) => stopping.has(x.id)) ? 0.5 : 1,
            }}
          >
            {t('composer.background.stopAll')}
          </button>
        )}
      </div>
      <Collapse open={open} id={bodyId}>
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 6px', borderTop: `1px solid ${C.sep}` }}>
          {list.map((task) => {
            const KindIcon = KIND_ICON[task.kind]
            const tone = statusTone('running')
            const desc = task.description || t(`composer.background.kind.${task.kind}`)
            return (
              <li key={task.id} className="flex items-center" style={{ minHeight: h, gap: 9, padding: isNarrow ? '0 6px 0 14px' : '0 8px 0 14px', minWidth: 0 }}>
                <KindIcon size={15} style={{ color: C.label2, flexShrink: 0 }} aria-label={t(`composer.background.kind.${task.kind}`)} />
                <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.label }} title={desc}>
                  {desc}
                </span>
                <span className="flex items-center" style={{ gap: 4, flexShrink: 0, fontSize: 12, color: tone.color }}>
                  <span className="spin flex" aria-hidden>
                    <StatusIcon status="running" />
                  </span>
                  {t('composer.background.running')}
                </span>
                {canStop && (
                  <button
                    type="button"
                    className="press"
                    aria-label={t('composer.background.stopOneLabel', { desc })}
                    disabled={stopping.has(task.id)}
                    onClick={() => onStop(task.id)}
                    style={{
                      flexShrink: 0,
                      minHeight: h,
                      minWidth: h,
                      padding: '0 10px',
                      background: 'transparent',
                      border: 0,
                      color: C.del,
                      fontSize: 12.5,
                      cursor: 'pointer',
                      opacity: stopping.has(task.id) ? 0.5 : 1,
                    }}
                  >
                    {t('composer.background.stopOne')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </Collapse>
    </div>
  )
}

/**
 * 뒤 작업 개수가 바뀔 때 낭독기에 알린다. 화면에는 안 보이고(sr-only) 포커스를 옮기지 않는다.
 * 처음 그릴 때의 개수는 "바뀐 것"이 아니므로 알리지 않는다.
 */
export function BackgroundAnnouncer({ count }: { count: number }) {
  const t = useT()
  const prev = useRef(count)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (prev.current === count) return
    setMessage(backgroundAnnouncement(prev.current, count, t))
    prev.current = count
  }, [count, t])
  return (
    <div role="status" aria-live="polite" className="sr-only" data-testid="bg-announcer">
      {message}
    </div>
  )
}
