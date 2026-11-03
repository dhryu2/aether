// 대화 칸 하나. 채널 화면(원탁·루틴·게시판)은 걷어냈다. 항상 대화 스트림 하나다.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { Archive, Maximize2, Minimize2, X } from 'lucide-react'
import { actions, providerName, showProviderTag, useStore } from '../../lib/store'
import { focusedSessionId, hiddenPaneIds, otherWaitingPanes, visibleCapacity, visibleSessionIds, type PanePlace } from '../../lib/splitPane'
import { findRoom, executionId as roomExecutionId } from '../../lib/workspaceRooms'
import { useT } from '../../lib/i18n'
import { useNow } from '../../lib/hooks'
import { waitAgeText } from '../../lib/format'
import { Stream } from '../stream/Stream'
import { Composer } from '../composer/Composer'
import { AttentionDot, Button, IconButton } from '../ui'
import { WaitAge } from '../WaitAge'
import { FindBar } from '../FindBar'
import { Tag } from '../TopBar'
import { TodoChip } from '../TodoChip'
import { AutoResumeChip } from '../AutoResumeChip'
import { PaneMenu, PaneMenuItems } from './PaneMenu'
import { onContextMenuFor } from '../contextMenuFor'
import { C, R } from '../../design/tokens'

export function ConversationPane({
  sessionId,
  index,
  top,
  place,
  showHead,
  onClose,
  zoomed,
  hidden,
}: {
  /** 방 id. */
  sessionId: string
  index: number
  /** 위쪽 줄. 상단 섬이 떠 있으므로 여백이 필요하다. */
  top: boolean
  place?: PanePlace
  /** 칸이 둘 이상일 때만 머리(상태 점·제목·대기·확대·메뉴·닫기)를 그린다. */
  showHead: boolean
  onClose?: () => void
  /** 이 칸이 임시 확대 중이다. */
  zoomed?: boolean
  /** 다른 칸이 확대돼 이 칸은 숨긴다. 언마운트하지 않아 쓰던 글과 스크롤이 남는다. */
  hidden?: boolean
}) {
  const s = useStore()
  const t = useT()
  const room = findRoom(s.rooms, sessionId)
  const title = room?.title || t('nav.session.untitled')
  const cap = visibleCapacity(s.isWide, s.paneW, s.paneH)
  const multi = visibleSessionIds(s.activeId, s.sideIds, cap).length >= 2
  const visibleIds = visibleSessionIds(s.activeId, s.sideIds, cap)
  const othersWaiting = zoomed ? otherWaitingPanes(visibleIds, sessionId, s.rooms) : []
  const focused = focusedSessionId(s.focusedId, s.activeId, s.sideIds, cap) === sessionId
  const exec = roomExecutionId(room)
  const sess = room?.sourceSessionId ? s.sessions.find((x) => x.id === room.sourceSessionId) : undefined
  // 상단 제목 섬에 있던 서비스·폴더는 제목에 마우스를 올리면 보인다.
  const headTitle = [title, sess && showProviderTag(s) ? providerName(s, sess.provider) : '', sess?.cwd ?? room?.cwd ?? ''].filter(Boolean).join(' · ')
  const hiddenPanes = multi && focused ? hiddenPaneIds(s.activeId, s.sideIds, cap) : []
  const waiting = room?.attention === 'waiting'
  const since = waiting ? room?.attentionSince : undefined
  const now = useNow()
  const paneNo = visibleIds.indexOf(sessionId) + 1
  // 칸 영역 이름: 「칸 2, 제목, 12분째 대기」. 칸이 하나일 때는 이름을 붙이지 않는다.
  const paneLabel = !multi
    ? undefined
    : since != null
      ? t('nav.split.paneLabelWaiting', { n: paneNo, title, age: waitAgeText(since, now) })
      : t('nav.split.paneLabel', { n: paneNo, title })

  // 칸이 나뉘면 포커스 밖 칸의 칩도 자기 값을 그리므로 받아 둔다.
  useEffect(() => {
    if (multi && exec) actions.ensurePaneFacets(exec)
  }, [multi, exec])

  // 칸 높이를 이 요소의 --pane-h로 알린다. 입력창 팝오버가 칸 밖으로 자라지 않게 상한을 정할 때 쓴다.
  //   붙일 때 재고, 크기가 바뀌면 다시 재고, 떼이면 지운다(--composer-h와 같은 방식).
  const paneRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const apply = () => pane.style.setProperty('--pane-h', `${Math.ceil(pane.getBoundingClientRect().height)}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(pane)
    return () => {
      ro.disconnect()
      pane.style.removeProperty('--pane-h')
    }
  }, [])

  return (
    <section
      ref={paneRef}
      data-split-pane={String(index)}
      data-split-session={sessionId}
      data-split-focused={focused ? '1' : '0'}
      data-pane-multi={multi ? '1' : '0'}
      data-pane-top={top ? '1' : '0'}
      data-pane-head={showHead ? '1' : '0'}
      data-pane-zoomed={zoomed ? '1' : '0'}
      aria-label={paneLabel}
      aria-current={multi && focused ? 'true' : undefined}
      hidden={hidden}
      className="session-pane pane-in relative flex min-h-0 min-w-0 flex-col"
      onPointerDown={() => actions.focusPane(sessionId)}
      // 키보드로 이 칸 안의 입력창·버튼에 와도 포커스 칸이 따라온다.
      onFocusCapture={() => actions.focusPane(sessionId)}
      style={{ gridColumn: place?.column, gridRow: place?.row }}
    >
      {showHead && (
        <div
          className="flex min-w-0 items-center"
          // 칸 머리에만 건다(본문 전체가 아니다). 칸 메뉴와 같은 항목이다.
          onContextMenu={onContextMenuFor(() => (
            <PaneMenuItems sessionId={sessionId} visibleIds={visibleIds} zoomed={zoomed} onClose={onClose} close={actions.closeContextMenu} />
          ))}
          style={{
            flexShrink: 0,
            gap: 8,
            height: 36,
            // 위쪽 줄만 상단 섬 높이만큼 내린다. 아래 줄은 섬이 가리지 않는다.
            marginTop: top ? 'var(--bar-h, 0px)' : 0,
            padding: '0 8px 0 14px',
          }}
        >
          <div className="flex min-w-0 items-center" style={{ flex: 1, gap: 8 }}>
            {waiting && <AttentionDot attention="waiting" size={8} />}
            <span
              className="truncate"
              title={headTitle}
              style={{
                minWidth: 0,
                fontSize: 14,
                fontWeight: focused ? 600 : 500,
                color: C.label,
              }}
            >
              {title}
            </span>
            {since != null && (
              <span className="inline-flex" style={{ flexShrink: 0, gap: 4 }}>
                <WaitAge since={since} />
                <span style={{ fontSize: 12.5, color: C.label3 }}>{t('nav.split.waitingSuffix')}</span>
              </span>
            )}
            {sess?.isolated && <Tag opt="isolated" color={C.label2}>{t('nav.session.isolated')}</Tag>}
            {sess?.needsApply && <Tag opt="needs-apply" color={C.attn}>{t('nav.session.needsApply')}</Tag>}
            {sess?.applyBlocked && <Tag opt="apply-blocked" color={C.attn}>{t('nav.session.applyBlocked')}</Tag>}
          </div>
          {hiddenPanes.length > 0 && (
            // 창이 좁아 칸 수 상한을 넘은 칸. 누르면 가장 앞의 숨은 칸과 이 칸의 자리를 맞바꾼다.
            <button
              type="button"
              data-hidden-panes={hiddenPanes.length}
              title={t('nav.split.hiddenChipTitle')}
              onClick={() => actions.replacePaneSession(sessionId, hiddenPanes[0])}
              className="press"
              style={{ flexShrink: 0, height: 24, padding: '0 10px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label2, fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}
            >
              {t('nav.split.hiddenChip', { n: hiddenPanes.length })}
            </button>
          )}
          <AutoResumeChip plan={room?.autoResume} placement="pane" compact={s.isNarrow} />
          {exec && <TodoChip sessionId={exec} placement="pane" compact={s.isNarrow} />}
          {othersWaiting.length > 0 && (
            // 확대 중에도 다른 칸의 대기를 놓치지 않게. 누르면 확대를 풀고 가장 오래 기다린 칸으로 간다(포커스 이동이 확대를 푼다).
            <button
              type="button"
              data-zoom-others-waiting
              onClick={() => actions.focusPane(othersWaiting[0])}
              className="press"
              style={{ flexShrink: 0, height: 24, padding: '0 10px', border: 'none', borderRadius: R.full, background: C.fill, color: C.attn, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              {t('nav.split.othersWaiting', { n: othersWaiting.length })}
            </button>
          )}
          {multi && (
            <IconButton
              type="button"
              data-split-zoom
              aria-pressed={!!zoomed}
              label={zoomed ? t('nav.split.unzoom') : t('nav.split.zoom')}
              title={zoomed ? t('nav.split.unzoom') : t('nav.split.zoom')}
              onClick={() => actions.toggleZoom(sessionId)}
              size={28}
              color={C.label2}
            >
              {zoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
          )}
          <PaneMenu sessionId={sessionId} visibleIds={visibleIds} zoomed={zoomed} onClose={onClose} />
          {onClose && (
            <IconButton
              type="button"
              data-split-close
              label={t('nav.split.close')}
              title={t('nav.split.close')}
              onClick={onClose}
              size={28}
              color={C.label2}
            >
              <X size={14} />
            </IconButton>
          )}
        </div>
      )}
      {exec && <Stream key={exec} sessionId={exec} />}
      {multi && focused && <FindBar pane />}
      {room?.archivedAt && exec ? (
        // 보관된 작업은 읽기 전용이다. 입력창 대신 안내와 해제 버튼을 둔다(바깥 여백은 Composer와 같은 규칙).
        //   떠 있는 입력창과 달리 대화 칸 맨 아래에 흐름대로 앉는다(높이를 따로 알릴 필요가 없다).
        <div
          style={{
            flexShrink: 0,
            paddingLeft: `max(${s.isNarrow ? 10 : 16}px, env(safe-area-inset-left))`,
            paddingRight: `max(${s.isNarrow ? 10 : 16}px, env(safe-area-inset-right))`,
            paddingBottom: `max(${s.isNarrow ? 10 : 14}px, env(safe-area-inset-bottom))`,
          }}
        >
          <div
            className="mx-auto flex flex-wrap items-center"
            data-archived-banner
            style={{
              maxWidth: 760,
              gap: 10,
              padding: '10px 14px',
              background: C.fill,
              border: `0.5px solid ${C.sep}`,
              borderRadius: 16,
            }}
          >
            <Archive size={16} style={{ color: C.label2, flexShrink: 0 }} aria-hidden />
            <span style={{ flex: 1, minWidth: 160, fontSize: 14, lineHeight: 1.4, color: C.label2 }}>{t('nav.session.archivedBanner')}</span>
            <Button tone="primary" height={s.coarsePointer ? 44 : 36} paddingX={16} onClick={() => void actions.unarchiveSession(exec)}>
              {t('nav.session.unarchive')}
            </Button>
          </div>
        </div>
      ) : (
        <Composer key={`composer-${sessionId}`} sessionId={sessionId} />
      )}
    </section>
  )
}
