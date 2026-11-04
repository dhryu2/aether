// W1. 상단바 — 재설계 A(2026-09-27): 대화 위에 뜬 유리 섬 두 개.
//   왼쪽 제목 섬 = 작업 이름·서비스·폴더. 오른쪽 도구 섬 = 찾기·모델·생각·권한·ctx·알림.
//   로고·Agent Brain·설정은 목록 기둥(Sidebar)으로 옮겼다. 섬 사이로는 대화가 비쳐 보인다.
//   칸이 둘 이상이면 이 상단바를 그리지 않는다. 포커스 칸의 정보가 다른 칸 위에 떠서 어느 칸 것인지 헷갈리고, 윗줄 칸만 62px을 잃어서다.
//   그때 제목은 칸 머리, 칩·사용량은 입력창 아랫줄, 찾기·내려받기는 칸 메뉴, 종·연결은 Sidebar로 간다.
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Menu, Search } from 'lucide-react'
import { actions, chromeRoomId, chromeSessionId, convoLoading, isSplit, providerName, showProviderTag, useStore } from '../lib/store'
import { sessionWorkTitle } from '../lib/workTitle'
import { inboxLabel, inboxRows } from '../lib/activityInbox'
import { findRoom } from '../lib/workspaceRooms'
import { MOD } from '../lib/format'
import { hiddenPaneIds, visibleCapacity, visibleSessionIds } from '../lib/splitPane'
import { useT } from '../lib/i18n'
import { useDismiss } from '../lib/hooks'
import { WaitAge } from './WaitAge'
import { ConnectionIndicator } from './ConnectionIndicator'
import { UsageHandoff } from './UsageHandoff'
import { TodoChip } from './TodoChip'
import { AutoResumeChip } from './AutoResumeChip'
import { todoViewOf } from '../lib/todoView'
import { ctxOf } from './ctxOf'
import { ModelPicker } from './ModelPicker'
import { EffortPicker } from './EffortPicker'
import { PermissionPicker } from './PermissionPicker'
import { AttentionDot, IconButton, PopoverSurface } from './ui'
import { MenuItem } from './WorkMenu'
import { sessionContextMenu } from './sessionMenu'
import { copyItem, menuOf, onContextMenuFor } from './contextMenuFor'
import { C, R, Z } from '../design/tokens'
import type { WorkspaceRoom } from '../lib/types'

/**
 * 손길 알림 — 종 아이콘과 주황 숫자. 대기·끝남·실패만 센다. 주의 통로가 없거나 0이면 그리지 않는다.
 * 누르면 그 작업들의 목록이 펼쳐진다. 좁은 화면도 대화만 갈아탄다.
 * inSidebar: 칸이 나뉘어 Sidebar에 놓일 때. 띠는 넘치는 것을 잘라 내므로 목록은 body에 그려 기둥 오른쪽에 띄운다.
 */
export function HandChip({ inSidebar }: { inSidebar?: boolean }) {
  const s = useStore()
  const t = useT()
  const open = s.handListOpen
  const setOpen = actions.setHandListOpen
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), open, '[data-attention-chip],[data-hand-list]')
  if (!s.presenceLive) return null
  const items = inboxRows(s.rooms)
  if (items.length === 0) return null
  const pick = (row: WorkspaceRoom) => {
    setOpen(false)
    if (row.status === 'corrupted') return
    actions.selectSession(row.id)
  }
  const openBeside = (row: WorkspaceRoom) => {
    setOpen(false)
    // 좁은 화면에서 옆 칸 없음.
    if (s.isNarrow) {
      if (row.status !== 'corrupted') pick(row)
      return
    }
    if (row.status !== 'corrupted') actions.openBeside(row.id)
  }
  const size = s.isNarrow ? 44 : 36
  const sideRight = inSidebar ? (document.querySelector('aside')?.getBoundingClientRect().right ?? 0) : 0
  const list = open && (
    <PopoverSurface
      role="listbox"
      direction="down"
      align={inSidebar ? 'left' : 'right'}
      minWidth={260}
      zIndex={inSidebar ? Z.root.findBar : undefined}
      style={inSidebar ? { position: 'fixed', top: 14, left: sideRight + 8, maxHeight: 'calc(100vh - 28px)', overflowY: 'auto' } : undefined}
    >
      {items.map((row) => (
        <div
          key={row.id}
          className="flex w-full items-start"
          onContextMenu={sessionContextMenu(row, row.attention === 'waiting' || row.attention === 'running' || row.attention === 'background')}
          style={{
            gap: 8,
            padding: '10px 12px',
            background: row.id === chromeRoomId(s) ? C.fill : 'transparent',
          }}
        >
          <button
            type="button"
            role="option"
            data-attention-jump={row.id}
            data-activity-inbox="1"
            data-attention={row.attention}
            data-attention-kind={row.attentionKind || ''}
            onClick={() => pick(row)}
            className="flex min-w-0 flex-1 items-start text-left"
            style={{ gap: 8, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            <span style={{ marginTop: 5 }}><AttentionDot attention={row.attention === 'failed' ? 'failed' : row.attention === 'done' ? 'done' : row.attention === 'running' ? 'running' : 'waiting'} size={8} /></span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline" style={{ gap: 8 }}>
                <span className="truncate" style={{ flex: 1, fontSize: 14, fontWeight: 500, color: C.label }}>
                  {row.title || t('nav.session.untitled')}
                </span>
                {row.attention === 'waiting' && row.attentionSince != null && <WaitAge since={row.attentionSince} />}
              </span>
              {inboxLabel(row.attention, row.attentionKind) ? (
                <span className="truncate" style={{ display: 'block', fontSize: 12.5, color: row.attention === 'waiting' ? C.attn : C.label2, lineHeight: 1.4 }}>
                  {inboxLabel(row.attention, row.attentionKind)}
                </span>
              ) : null}
              {row.attentionPreview ? (
                <span className="truncate" style={{ display: 'block', fontSize: 12.5, color: C.label2, lineHeight: 1.4 }}>
                  {row.attentionPreview}
                </span>
              ) : null}
            </span>
          </button>
          {s.isWide && row.id !== s.activeId && row.status !== 'corrupted' && (
            <button
              type="button"
              data-open-beside={row.id}
              onClick={() => openBeside(row)}
              style={{
                flexShrink: 0,
                marginTop: 1,
                fontSize: 12.5,
                fontWeight: 500,
                color: C.tint,
                padding: '4px 8px',
                border: 'none',
                background: 'transparent',
                borderRadius: R.full,
                cursor: 'pointer',
              }}
            >
              {t('nav.topbar.openBeside')}
            </button>
          )}
        </div>
      ))}
    </PopoverSurface>
  )
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        data-attention-chip
        data-attention-count={items.length}
        className="press icon-ghost inline-flex items-center justify-center"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t('nav.topbar.attentionChipTitle')}
        aria-label={t('nav.topbar.attentionChip', { n: items.length })}
        onClick={() => setOpen(!open)}
        style={{ position: 'relative', width: size, height: size, borderRadius: R.full, color: C.label2 }}
      >
        <Bell size={s.isNarrow ? 20 : 18} />
        <span className="count-badge" style={{ position: 'absolute', top: s.isNarrow ? 5 : 2, right: s.isNarrow ? 4 : 0 }} aria-hidden>
          {items.length}
        </span>
      </button>
      {inSidebar ? list && createPortal(<div data-hand-list>{list}</div>, document.body) : list}
    </div>
  )
}

/** 제목 섬 아래 줄의 작은 표시(격리·반영 필요). 누를 수 없으므로 상자 없이 글자만. */
export function Tag({ opt, color, children }: { opt: string; color: string; children: string }) {
  return (
    <span data-session-opt={opt} style={{ flexShrink: 0, fontSize: 12, fontWeight: 500, color }}>
      {children}
    </span>
  )
}

export function TopBar() {
  const s = useStore()
  const t = useT()
  const chromeId = chromeSessionId(s)
  const roomId = chromeRoomId(s)
  const activeRoom = findRoom(s.rooms, roomId)
  const active = chromeId ? s.sessions.find((x) => x.id === chromeId) : undefined
  const a = active
  const narrow = s.isNarrow
  const hiddenPanes = s.isWide ? hiddenPaneIds(s.activeId, s.sideIds, visibleCapacity(s.isWide, s.paneW, s.paneH)) : []
  const hasTitle = !!(activeRoom || a)
  const title = activeRoom?.title || sessionWorkTitle(active ?? { displayName: '' }, t('nav.session.untitled'))
  const cwd = a?.cwd ?? activeRoom?.cwd ?? ''
  const hand = s.presenceLive && inboxRows(s.rooms).length > 0
  const convo = chromeId ? s.convos[chromeId] : undefined
  const loading = convoLoading(s)
  // 폰의 ctx는 값이 생길 때까지 자리를 비운다(UsageChip compact). 도구 섬에 들 것이 없으면 빈 알약을 띄우지 않는다.
  const showUsage = hasTitle && (!narrow || loading || ctxOf(convo) != null)
  // 연결 표시는 보통 제목 섬 아래 줄에 있다. 제목이 없을 때(대화를 안 골랐을 때)는 도구 섬에 둔다 — 끊김을 놓치지 않게.
  const connOutside = !hasTitle && s.conn !== 'connected'
  // 할 일 칩: 칸이 하나일 때만 여기 둔다. 칸이 둘 이상이면 각 칸 머리에 있어 같은 칩이 두 번 보이지 않게 한다.
  const single = visibleSessionIds(s.activeId, s.sideIds, visibleCapacity(s.isWide, s.paneW, s.paneH)).length < 2
  const showTodo = single && !!chromeId && todoViewOf(s, chromeId) != null
  const showResume = single && !!(activeRoom?.autoResume?.at !== undefined || activeRoom?.autoResume?.gaveUp)
  const hasTools = hand || showUsage || connOutside || showTodo || showResume
  if (isSplit(s)) return null
  return (
    <header
      className="top-bar"
      data-chrome-session={chromeId ?? ''}
      style={{ zIndex: Z.inApp.topBar }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <div className="flex min-w-0 flex-1 items-center" style={{ gap: 8 }}>
          {/* IconButton이 아니라 맨 button인 이유: IconButton은 바탕을 인라인 transparent로 칠해 .glass의 유리 바탕을 지운다. */}
          {narrow && (
            <button
              type="button"
              aria-label={t('nav.topbar.openSessionList')}
              onClick={() => actions.toggleDrawer(true)}
              className="glass press inline-flex items-center justify-center"
              style={{ width: 48, height: 48, flexShrink: 0, borderRadius: R.full, color: C.label, cursor: 'pointer' }}
            >
              <Menu size={20} />
            </button>
          )}

          {hasTitle && (
            <div
              className="glass top-island min-w-0"
              style={{
                height: narrow ? 48 : 52,
                padding: narrow ? '0 16px 0 14px' : '0 20px 0 18px',
                maxWidth: narrow ? undefined : 520,
              }}
              onContextMenu={onContextMenuFor(() => menuOf(
                copyItem(title, t('menu.copyTitle')),
                copyItem(cwd, t('menu.copyFolderPath')),
                <MenuItem onClick={() => actions.toggleFind()}>{t('nav.topbar.findInSession')}</MenuItem>,
                chromeId && <MenuItem onClick={() => void actions.exportTranscript(chromeId)}>{t('nav.topbar.export')}</MenuItem>,
              ))}
            >
              <div className="truncate" style={{ fontSize: narrow ? 14.5 : 15, fontWeight: 600, letterSpacing: '-0.01em', color: C.label, lineHeight: 1.3 }}>
                {title}
              </div>
              <div className="flex min-w-0 items-center" style={{ gap: 8, fontSize: 12, color: C.label2, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                <ConnectionIndicator state={s.conn} compact={narrow} />
                {/* 어느 서비스로 도는 세션인지(8h). 고를 서비스가 하나뿐이면 안 그린다 — 정보를 더하지 않는다. */}
                {showProviderTag(s) && (
                  <span data-provider-id={a?.provider ?? ''} style={{ flexShrink: 0 }}>
                    {providerName(s, a?.provider ?? '')}
                  </span>
                )}
                {a?.isolated && <Tag opt="isolated" color={C.label2}>{t('nav.session.isolated')}</Tag>}
                {a?.needsApply && <Tag opt="needs-apply" color={C.attn}>{t('nav.session.needsApply')}</Tag>}
                {a?.applyBlocked && <Tag opt="apply-blocked" color={C.attn}>{t('nav.session.applyBlocked')}</Tag>}
                {/* 폰은 경로를 빼고 좁은 폭을 남긴다(감사 F4). 모델·생각·권한 칩은 입력창 위에 있다. */}
                {!narrow && (
                  <span className="truncate font-mono" style={{ fontSize: 11.5, color: C.label3 }} title={a?.cwd ?? activeRoom?.cwd ?? ''}>
                    {a?.cwd ?? activeRoom?.cwd ?? ''}
                  </span>
                )}
              </div>
            </div>
          )}
          {hiddenPanes.length > 0 && (
            // 창이 좁아 칸 수 상한을 넘은 칸. 누르면 가장 앞의 숨은 칸과 포커스 칸의 자리를 맞바꾼다.
            <button
              type="button"
              data-hidden-panes={hiddenPanes.length}
              className="glass press inline-flex items-center"
              title={t('nav.split.hiddenChipTitle')}
              onClick={() => {
                const focus = chromeRoomId(s)
                if (focus) actions.replacePaneSession(focus, hiddenPanes[0])
              }}
              style={{ height: 36, flexShrink: 0, padding: '0 14px', borderRadius: R.full, border: 'none', color: C.label2, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              {t('nav.split.hiddenChip', { n: hiddenPanes.length })}
            </button>
          )}
        </div>

        {hasTools && (
          <div className="glass top-island top-tools" style={{ height: narrow ? 48 : 52, padding: narrow ? '0 2px 0 12px' : '0 8px', gap: narrow ? 2 : 4 }}>
            {showResume && <AutoResumeChip plan={activeRoom?.autoResume} placement="island" compact={narrow} />}
            {showTodo && chromeId && <TodoChip sessionId={chromeId} placement="island" compact={narrow} />}
            {connOutside && (
              <span style={{ display: 'inline-flex', padding: '0 8px' }}>
                <ConnectionIndicator state={s.conn} compact={narrow} />
              </span>
            )}
            {!narrow && hasTitle && (
              <IconButton
                label={t('nav.topbar.findInSession')}
                title={t('nav.topbar.findInSessionTitle', { mod: MOD })}
                // 찾기 바가 '바깥 클릭'으로 오해하지 않게 표시해 둔다(FindBar의 useDismiss가 이 표시를 보고 넘어간다).
                data-find-toggle
                onClick={() => actions.toggleFind()}
                size={36}
                color={C.label2}
                lift={false}
                className="press icon-ghost"
              >
                <Search size={18} />
              </IconButton>
            )}
            {/* 모델·생각·권한 칩은 폭 1100 이상에서만 여기 둔다. 그보다 좁으면 입력창 위에 있다(Composer) —
                폰은 엄지 영역이라서, 좁은 컴퓨터 폭은 목록 기둥을 뺀 대화 칸에 도구 섬이 다 안 들어가서다(800px 실측). */}
            {s.isWide && active && <ModelPicker />}
            {s.isWide && active && <EffortPicker />}
            {s.isWide && active && <PermissionPicker />}
            {showUsage && (
              <span style={{ padding: narrow ? '0 6px 0 0' : '0 8px', display: 'inline-flex' }}>
                <UsageHandoff roomId={roomId} items={convo} loading={loading} compact={narrow} />
              </span>
            )}
            <HandChip />
          </div>
        )}
      </div>
    </header>
  )
}
