import { createContext, useContext, useId, useRef, useState, type MouseEvent } from 'react'
import { MoreVertical } from 'lucide-react'
import { actions, useStore } from '../lib/store'
import type { SessionListItem } from '../lib/types'
import { useDismiss } from '../lib/hooks'
import { canCopy, copyWithNotice } from '../lib/copyNotice'
import { useT } from '../lib/i18n'
import { IconButton, PopoverSurface } from './ui'
import { HandoffMenuItems } from './HandoffMenuItems'
import { C, R } from '../design/tokens'

type WorkMenuActions = {
  session: SessionListItem
  /** 대화를 마크다운 파일로 받기. 실행 id가 없는 줄(아직 안 돈 채널)은 안 준다. */
  onExport?: () => void
  /** 보관/보관 해제 토글 실행. 실행 id가 없는 줄은 안 준다. */
  onArchive?: () => void
  /** 일하는 중·대기·뒤 작업 중이라 지금은 보관할 수 없다. */
  archiveBlocked?: boolean
  onRename?: (e: MouseEvent) => void
  onReset: (e: MouseEvent) => void
  onDelete: (e: MouseEvent) => void
}

export function WorkMenu({ size, ...items }: WorkMenuActions & { size: number }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, () => setOpen(false), open, '[data-session-opt="work-menu"]')

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
            <WorkMenuItems {...items} close={() => setOpen(false)} />
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}

/** 세션 메뉴의 항목들. 점 메뉴(WorkMenu)와 우클릭 메뉴가 같이 쓴다. close는 항목을 누르면 부르는 닫기 함수. */
export function WorkMenuItems({
  session,
  onRename,
  onReset,
  onDelete,
  onExport,
  onArchive,
  archiveBlocked,
  close,
}: WorkMenuActions & { close: () => void }) {
  const t = useT()
  const st = useStore()
  const busyNoteId = useId()

  const run = (e: MouseEvent, fn: (ev: MouseEvent) => void) => {
    e.stopPropagation()
    close()
    fn(e)
  }

  return (
    <>
      {st.isWide && session.id !== st.activeId && session.status !== 'corrupted' && (
        <MenuItem
          data-session-opt="open-beside"
          onClick={(e) => run(e, () => actions.openBeside(session.id))}
        >
          {t('nav.session.openBeside')}
        </MenuItem>
      )}
      {onRename && <MenuItem onClick={(e) => run(e, onRename)}>{t('nav.session.rename')}</MenuItem>}
      {onExport && (
        <MenuItem data-session-opt="export" onClick={(e) => run(e, onExport)}>
          {t('nav.topbar.export')}
        </MenuItem>
      )}
      {session.cwd && canCopy() && (
        <MenuItem data-session-opt="copy-path" onClick={(e) => run(e, () => void copyWithNotice(session.cwd))}>
          {t('menu.copyFolderPath')}
        </MenuItem>
      )}
      <HandoffMenuItems id={session.id} close={close} />
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
    </>
  )
}

/** 우클릭 메뉴(shell/ContextMenu.tsx)가 넣는 닫기 함수. 항목이 자기 일을 한 뒤에 부른다. 점 메뉴에는 없다. */
export const MenuCloseCtx = createContext<(() => void) | null>(null)

export function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  keepMenu,
  ...rest
}: {
  children: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  danger?: boolean
  /** 눌러도 아무 일 없고 회색으로 보인다(포커스는 남겨 낭독기가 읽게 한다). */
  disabled?: boolean
  /** 우클릭 메뉴에서 눌러도 메뉴를 닫지 않는다(같은 메뉴 안에서 목록을 바꾸는 항목). */
  keepMenu?: boolean
  'data-session-opt'?: string
  'aria-describedby'?: string
}) {
  const closeMenu = useContext(MenuCloseCtx)
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={disabled ? (e) => e.stopPropagation() : (e) => {
        onClick(e)
        if (!keepMenu) closeMenu?.()
      }}
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
