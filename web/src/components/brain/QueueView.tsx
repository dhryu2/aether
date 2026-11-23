// 작업 대기열 탭. 맡겨 둔 작업의 줄을 보고, 시작·멈추기·빼기·세션 열기를 한다.
//   QueueView는 저장소와 5초 다시 읽기만 맡고, 화면은 props만 받는 QueueBody가 그린다(서버 렌더 시험용).
import { useEffect, useId, useState, type CSSProperties } from 'react'
import type { TaskQueueResponse } from '@shared/http'
import { C, R } from '../../design/tokens'
import { nextOccurrence, timeInputValue } from '../../lib/autoResume'
import { fmtShortDateTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { queueFull, queueItemStatus, type QueueItemStatus } from '../../lib/taskQueue'
import { actions, useStore } from '../../lib/store'
import type { SessionListItem } from '../../lib/types'
import { sessionWorkTitle } from '../../lib/workTitle'
import { roomIdForExecution } from '../../lib/workspaceRooms'
import { Button, EmptyState, SegmentedControl, Skeleton } from '../ui'

const POLL_MS = 5000
const HOUR_MS = 3_600_000

const STATUS_COLOR: Record<QueueItemStatus, string> = {
  waiting: C.label2,
  running: C.tint,
  approval: C.attn,
  limit: C.attn,
  done: C.ok,
  failed: C.del,
  cut: C.del,
}

const field: CSSProperties = {
  height: 40,
  minWidth: 0,
  padding: '0 10px',
  border: 'none',
  borderRadius: R.field,
  background: C.fill,
  color: C.label,
  fontSize: 14,
  fontFamily: 'inherit',
}

const smallBtn: CSSProperties = {
  minHeight: 36,
  padding: '0 14px',
  border: 'none',
  borderRadius: R.full,
  background: C.fill,
  color: C.label,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

export function QueueView() {
  const s = useStore()
  const [failed, setFailed] = useState(false)

  // 탭이 보이는 동안만 5초마다 다시 읽는다. 이 부품은 탭이 켜져 있을 때만 그려지므로 사라지면 멈춘다.
  useEffect(() => {
    let alive = true
    const load = async () => {
      if (document.hidden) return // 숨은 탭에서는 읽지 않는다
      const ok = await actions.refreshTaskQueue()
      if (alive) setFailed(!ok)
    }
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  return (
    <QueueBody
      q={s.taskQueue}
      failed={failed}
      narrow={s.isNarrow}
      sessions={s.sessions}
      onRetry={() => void actions.refreshTaskQueue().then((ok) => setFailed(!ok))}
      onStart={(body) => void actions.startTaskQueue(body)}
      onStop={() => void actions.stopTaskQueue()}
      onRemove={(id) => void actions.removeFromTaskQueue(id)}
      onOpen={(sessionId) => {
        actions.closeBrain()
        actions.selectSession(roomIdForExecution(s.rooms, sessionId))
      }}
    />
  )
}

export function QueueBody({ q, failed, narrow, sessions, onRetry, onStart, onStop, onRemove, onOpen }: {
  q: TaskQueueResponse | null
  failed: boolean
  narrow: boolean
  sessions: readonly SessionListItem[]
  onRetry: () => void
  onStart: (body: { startAt?: number; limitHours: number }) => void
  onStop: () => void
  onRemove: (itemId: string) => void
  onOpen: (sessionId: string) => void
}) {
  const t = useT()
  const h = narrow ? 44 : 40
  if (!q) {
    return (
      <div className="scroll-area" style={{ height: '100%', overflow: 'auto' }}>
        {failed ? (
          <div className="flex flex-col items-start" style={{ gap: 12 }}>
            <div style={{ fontSize: 14, color: C.label2 }}>{t('brain.queue.loadFailed')}</div>
            <Button tone="gray" height={h} onClick={onRetry}>{t('brain.queue.retry')}</Button>
          </div>
        ) : (
          <div role="status" aria-label={t('brain.loading')} className="flex flex-col" style={{ gap: 10 }}>
            <Skeleton width="60%" height={20} />
            <Skeleton width="100%" height={72} radius={R.field} />
            <Skeleton width="100%" height={72} radius={R.field} />
          </div>
        )}
      </div>
    )
  }

  const idle = q.run === 'stopped'
  const hasWaiting = q.items.some((x) => x.state === 'waiting')
  const statusText = q.run === 'scheduled' && q.startAt !== undefined
    ? t('brain.queue.scheduled', { time: fmtShortDateTime(q.startAt) })
    : q.run === 'running' && q.deadlineAt !== undefined
      ? t('brain.queue.running', { time: fmtShortDateTime(q.deadlineAt) })
      : t('brain.queue.stopped')
  // 사람이 멈춘 경우(manual)는 이유를 보이지 않는다.
  const reason = idle && q.stopReason && q.stopReason !== 'manual' ? t(`brain.queue.stopReason.${q.stopReason}`) : null

  return (
    <div className="scroll-area" style={{ height: '100%', overflow: 'auto' }}>
      <div className="flex flex-col" style={{ gap: 16, maxWidth: 720 }}>
        <div role="status">
          <div style={{ fontSize: 16, fontWeight: 600, color: C.label }}>{statusText}</div>
          {reason && <div style={{ marginTop: 2, fontSize: 13, color: C.attn }}>{reason}</div>}
        </div>

        {idle && hasWaiting && <StartForm q={q} h={h} onStart={onStart} />}
        {!idle && (
          <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
            <Button tone="gray" height={h} onClick={onStop}>{t('brain.queue.stop')}</Button>
            <span style={{ fontSize: 12.5, color: C.label3 }}>{t('brain.queue.stopHint')}</span>
          </div>
        )}

        {queueFull(q) && <div style={{ fontSize: 12.5, color: C.label3 }}>{t('brain.queue.full', { n: q.maxItems })}</div>}

        {q.items.length === 0 ? (
          <EmptyState title={t('brain.queue.emptyTitle')} desc={t('brain.queue.emptyDesc')} />
        ) : (
          <ol aria-label={t('brain.queue.listLabel')} className="flex flex-col" style={{ gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
            {q.items.map((it, i) => {
              const session = sessions.find((x) => x.id === it.sessionId)
              const status = queueItemStatus(it.state, session)
              return (
                <li key={it.id} className="flex flex-col" style={{ gap: 6, padding: '10px 12px', borderRadius: R.field, background: C.cell, border: `0.5px solid ${C.sep}` }}>
                  <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, color: C.label3, minWidth: 18 }}>{i + 1}</span>
                    <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: C.label }}>
                      {session ? sessionWorkTitle(session, t('brain.review.untitled')) : t('brain.queue.deleted')}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: STATUS_COLOR[status] }}>{t(`brain.queue.status.${status}`)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: C.label2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{it.text}</div>
                  <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                    {session && <span style={{ fontSize: 12, color: C.label3, flex: 1, minWidth: 0 }}>{t(`session.permission.mode.${session.permissionMode}`)}</span>}
                    {!session && <span style={{ flex: 1 }} />}
                    {session && <button type="button" className="press hit-44" style={smallBtn} onClick={() => onOpen(it.sessionId)}>{t('brain.queue.open')}</button>}
                    {it.state !== 'running' && <button type="button" className="press hit-44" style={smallBtn} onClick={() => onRemove(it.id)}>{t('brain.queue.remove')}</button>}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

function StartForm({ q, h, onStart }: { q: TaskQueueResponse; h: number; onStart: (body: { startAt?: number; limitHours: number }) => void }) {
  const t = useT()
  const uid = useId()
  const [mode, setMode] = useState<'now' | 'at'>('now')
  const [time, setTime] = useState(() => timeInputValue(Date.now() + HOUR_MS))
  const [limit, setLimit] = useState(q.limitHours)
  const at = mode === 'at' ? nextOccurrence(time) : null
  const label: CSSProperties = { fontSize: 12.5, color: C.label2 }
  return (
    <form
      className="flex flex-col items-start"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault()
        if (mode === 'at' && at === null) return
        onStart({ ...(at !== null ? { startAt: at } : {}), limitHours: limit })
      }}
    >
      <div className="flex flex-col" style={{ gap: 4 }}>
        <span id={`${uid}-start`} style={label}>{t('brain.queue.startLabel')}</span>
        <div role="group" aria-labelledby={`${uid}-start`} className="flex flex-wrap items-center" style={{ gap: 10 }}>
          <SegmentedControl
            items={[{ value: 'now', label: t('brain.queue.startNow') }, { value: 'at', label: t('brain.queue.startAt') }]}
            value={mode}
            onChange={setMode}
            itemHeight={h - 8}
          />
          {mode === 'at' && (
            <>
              <label className="flex flex-col" style={{ gap: 3, ...label }}>
                {t('brain.queue.timeLabel')}
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={field} />
              </label>
              {at !== null && <span style={{ fontSize: 13, color: C.label2 }}>{t('brain.queue.scheduled', { time: fmtShortDateTime(at) })}</span>}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col" style={{ gap: 4 }}>
        <span id={`${uid}-limit`} style={label}>{t('brain.queue.limitLabel')}</span>
        <div role="group" aria-labelledby={`${uid}-limit`}>
          <SegmentedControl
            items={q.limitChoices.map((n) => ({ value: String(n), label: t('brain.queue.limitHours', { h: n }) }))}
            value={String(limit)}
            onChange={(v) => setLimit(Number(v))}
            itemHeight={h - 8}
            itemMinWidth={44}
          />
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: C.label3, lineHeight: 1.5 }}>{t('brain.queue.notice')}</div>
      <Button type="submit" tone="primary" height={h} disabled={mode === 'at' && at === null}>{t('brain.queue.start')}</Button>
    </form>
  )
}
