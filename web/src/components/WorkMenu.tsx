import { useId, useRef, useState, type MouseEvent } from 'react'
import { MoreVertical } from 'lucide-react'
import { actions, useStore } from '../lib/store'
import type { SessionListItem } from '../lib/types'
import { useDismiss } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { IconButton, PopoverSurface } from './ui'
import { HandoffMenuItems } from './HandoffMenuItems'
import { C, R } from '../design/tokens'

export function WorkMenu({
  session,
  size,
  onRename,
  onReset,
  onDelete,
  onExport,
  onArchive,
  archiveBlocked,
}: {
  session: SessionListItem
  size: number
  /** 대화를 마크다운 파일로 받기. 실행 id가 없는 줄(아직 안 돈 채널)은 안 준다. */
  onExport?: () => void
  /** 보관/보관 해제 토글 실행. 실행 id가 없는 줄은 안 준다. */
  onArchive?: () => void
  /** 일하는 중·대기·뒤 작업 중이라 지금은 보관할 수 없다. */
  archiveBlocked?: boolean
  onRename: (e: MouseEvent) => void
  onReset: (e: MouseEvent) => void
  onDelete: (e: MouseEvent) => void
}) {
  const t = useT()
  const st = useStore()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const busyNoteId = useId()
  useDismiss(box, () => setOpen(false), open, '[data-session-opt="work-menu"]')

  const run = (e: MouseEvent, fn: (ev: MouseEvent) => void) => {
    e.stopPropagation()
    setOpen(false)
    fn(e)
  }

  return (
    <div ref={box} className="relative" onClick={(e) => e.stopPropagation()}>
      <IconButton
        type="button"
        className="card-action"
        size={size}
        data-session-opt="work-menu"
        aria-expanded={open}
        label={t('nav.session.menu')}
        title={t('nav.session.menu')}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <MoreVertical size={14} />
      </IconButton>
      {open && (
        <PopoverSurface align="right" minWidth={188} role="menu">
          <div className="flex flex-col" style={{ padding: 6 }}>
            {st.isWide && session.id !== st.activeId && session.status !== 'corrupted' && (
              <MenuItem
                data-session-opt="open-beside"
                onClick={(e) => run(e, () => actions.openBeside(session.id))}
              >
                {t('nav.session.openBeside')}
              </MenuItem>
            )}
            <MenuItem onClick={(e) => run(e, onRename)}>{t('nav.session.rename')}</MenuItem>
            {onExport && (
              <MenuItem data-session-opt="export" onClick={(e) => run(e, onExport)}>
                {t('nav.topbar.export')}
              </MenuItem>
            )}
            <HandoffMenuItems id={session.id} close={() => setOpen(false)} />
            {session.isolated && (
              <>
                <MenuItem
                  data-session-opt="workspace-apply"
                  onClick={(e) => run(e, () => void actions.applyWorkspace(session.id))}
                >
                  {t('nav.topbar.workspaceApply')}
                </MenuItem>
                <MenuItem
                  data-session-opt="workspace-discard"
                  danger
                  onClick={(e) => run(e, () => actions.requestDiscard(session))}
                >
                  {t('nav.topbar.workspaceDiscard')}
                </MenuItem>
              </>
            )}
            <MenuItem onClick={(e) => run(e, onReset)}>{t('nav.session.reset')}</MenuItem>
            {onArchive && (session.archivedAt ? (
              <MenuItem data-session-opt="unarchive" onClick={(e) => run(e, onArchive)}>
                {t('nav.session.unarchive')}
              </MenuItem>
            ) : (
              <>
                <MenuItem data-session-opt="archive" disabled={archiveBlocked} aria-describedby={archiveBlocked ? busyNoteId : undefined} onClick={(e) => run(e, onArchive)}>
                  {t('nav.session.archive')}
                </MenuItem>
                {archiveBlocked && (
                  <span id={busyNoteId} style={{ padding: '0 10px 4px', fontSize: 12, color: C.label3 }}>{t('nav.session.archiveBusy')}</span>
                )}
              </>
            ))}
            <div role="separator" style={{ height: 0.5, margin: '5px 4px', background: C.sep }} />
            <MenuItem danger onClick={(e) => run(e, onDelete)}>{t('nav.session.delete')}</MenuItem>
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}

export function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  ...rest
}: {
  children: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  danger?: boolean
  /** 눌러도 아무 일 없고 회색으로 보인다(포커스는 남겨 낭독기가 읽게 한다). */
  disabled?: boolean
  'data-session-opt'?: string
  'aria-describedby'?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={disabled ? (e) => e.stopPropagation() : onClick}
      className={disabled ? 'w-full text-left' : 'lift w-full text-left'}
      style={{
        border: 'none',
        background: 'transparent',
        borderRadius: R.sm,
        padding: '8px 10px',
        fontSize: 13,
        fontWeight: 600,
        color: disabled ? C.label3 : danger ? C.del : C.label,
        cursor: disabled ? 'default' : 'pointer',
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
