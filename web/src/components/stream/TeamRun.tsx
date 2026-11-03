/**
 * 자식 작업 묶음 카드. 일반 도구 줄에 묻히지 않는다.
 * 접힌 줄: 짧은 이름 · 역할 · 상태. 실패면 사유 한 줄도 접힌 채 보인다.
 * 펼치면 전체 요약과 손댄 파일. 원본 JSON은 그리지 않는다.
 */
import { useState } from 'react'
import { Check, ChevronDown, Loader2, Pause, X } from 'lucide-react'
import type { ToolEntry } from './ToolRun'
import { teamTaskView, type TeamTaskStatus, type TeamTaskView } from '../../lib/teamTask'
import { useT } from '../../lib/i18n'
import { C } from '../../design/tokens'
import { Collapse } from '../ui'

export function statusTone(status: TeamTaskStatus): { color: string; bg: string } {
  if (status === 'done') return { color: C.ok, bg: C.okSoft }
  if (status === 'failed') return { color: C.del, bg: C.delSoft }
  if (status === 'waiting') return { color: C.tint, bg: C.tintSoft }
  return { color: C.tint, bg: C.tintSoft }
}

export function StatusIcon({ status }: { status: TeamTaskStatus }) {
  if (status === 'done') return <Check size={12} />
  if (status === 'failed') return <X size={12} />
  if (status === 'waiting') return <Pause size={12} />
  return <Loader2 size={12} />
}

function TaskCard({ task, t }: { task: TeamTaskView; t: (k: string) => string }) {
  const [open, setOpen] = useState(false)
  const tone = statusTone(task.status)
  return (
    <div
      className="self-stretch"
      style={{
        border: `1px solid ${C.sep}`,
        background: C.cell2,
        borderRadius: 12,
        padding: '10px 12px',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center"
        style={{ gap: 8, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: C.label }}
        aria-expanded={open}
      >
        <span className="truncate" style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>
          {task.title}
        </span>
        <span
          className="font-mono"
          style={{ fontSize: 10, fontWeight: 600, color: C.label2, background: C.sepSoft, borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}
        >
          {t(`stream.team.role.${task.roleKey}`)}
        </span>
        <span
          className="inline-flex items-center font-mono"
          style={{ fontSize: 10, fontWeight: 600, gap: 4, color: tone.color, background: tone.bg, borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}
        >
          <StatusIcon status={task.status} />
          {t(`stream.team.status.${task.status}`)}
        </span>
        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined, color: C.label3, flexShrink: 0 }} />
      </button>
      {!open && task.status === 'failed' && task.reason ? (
        <div style={{ marginTop: 8, fontSize: 12, color: C.del, lineHeight: 1.4 }}>{task.reason}</div>
      ) : null}
      <Collapse open={open}>
        <div style={{ marginTop: 10, fontSize: 12, color: C.label2, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {task.summary ? <div>{task.summary}</div> : <div style={{ color: C.label4 }}>{t('stream.team.noSummary')}</div>}
          {task.files.length > 0 && (
            <div className="flex flex-col" style={{ gap: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.label3 }}>{t('stream.team.files')}</div>
              {task.files.map((f) => (
                <div key={f} className="font-mono truncate" style={{ fontSize: 11 }} title={f}>
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  )
}

export function TeamRun({ tasks, waiting }: { tasks: ToolEntry[]; waiting?: boolean }) {
  const t = useT()
  if (!tasks.length) return null
  const views = tasks.map((entry) => teamTaskView(entry, !!waiting && !entry.result))
  return (
    <div className="flex flex-col self-stretch" style={{ gap: 8 }} data-team-run="">
      {views.map((task) => (
        <TaskCard key={task.key} task={task} t={t} />
      ))}
    </div>
  )
}
