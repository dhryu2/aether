import { createStorageErrorReporter } from '../lib/errors'
// 목록 — 재설계 A(2026-09-27): 왼쪽에 뜬 유리 기둥. 폰에서는 같은 기둥이 서랍 안에 든다.
//   프로젝트(작업 폴더)별 묶음. 줄 id는 방 id. 한 줄은 세 줄 — 제목, 상태와 시간, 모델.
//   맨 아래에 Agent Brain(참딩)과 설정을 둔다(예전엔 상단바에 있었다).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, Columns2, ChevronRight, CircleAlert, CircleDashed, Archive, CircleHelp, Clock, Hand, Loader, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, X, type LucideIcon } from 'lucide-react'
import { actions, chromeSessionId, getState, isSplit, sessionTurn, useStore } from '../lib/store'
import { inboxRows } from '../lib/activityInbox'
import { ConnectionIndicator } from './ConnectionIndicator'
import { HandChip } from './TopBar'
import type { SessionListItem, TurnState, WorkspaceRoom } from '../lib/types'
import { MOD, relTime, waitAgeText } from '../lib/format'
import { besideVictimIndex, focusedSessionId, paneNumberOf, visibleCapacity, visibleSessionIds } from '../lib/splitPane'
import { cardPreviewLine } from '../lib/attention'
import { autoResumeTimeText } from '../lib/autoResume'
import { useNow } from '../lib/hooks'
import { folderName, groupRoomsByProject, normalizeFolder, splitArchived } from '../lib/sessionGroups'
import { sessionRowModel } from '../lib/modelLabel'
import { t, useT } from '../lib/i18n'
import chamdingUrl from '../assets/chamding-idle.webp'
import { Collapse, EmptyState, IconButton, Skeleton } from './ui'
import { WorkMenu } from './WorkMenu'
import { WaitAge } from './WaitAge'
import { C, R, alpha } from '../design/tokens'

function roomAsListItem(room: WorkspaceRoom): SessionListItem {
  return {
    id: room.id,
    cwd: room.cwd ?? '',
    displayName: room.title,
    provider: room.provider ?? '',
    model: '',
    permissionMode: 'manual',
    status: room.status,
    createdAt: 0,
    lastActivityAt: room.lastActivityAt,
    preview: room.preview,
    attention: room.attention,
    attentionKind: room.attentionKind,
    attentionPreview: room.attentionPreview,
    attentionSince: room.attentionSince,
    backgroundTasks: room.backgroundTasks,
    backgroundCanStop: room.backgroundCanStop,
    lastViewedAt: room.lastViewedAt,
    archivedAt: room.archivedAt,
  }
}

function statusPhrase(room: WorkspaceRoom, live: boolean, turn: TurnState): string {
  if (room.status === 'corrupted') return t('nav.session.status.unreachable')
  if (live && turn === 'requires_action') return t('nav.session.status.waiting')
  if (live && (turn === 'running' || turn === 'operation')) return t('nav.session.status.running')
  if (room.attention === 'waiting') return t('nav.session.status.waiting')
  if (room.attention === 'running') return t('nav.session.status.running')
  if (room.attention === 'background') return t('nav.session.status.background', { n: room.backgroundTasks?.length ?? 0 })
  if (room.attention === 'done') return t('nav.session.status.ended')
  if (room.attention === 'failed') return t('nav.session.status.crashed')
  if (room.status === 'ended') return t('nav.session.status.idle')
  return ''
}

/**
 * 줄 둘째 줄의 색과 아이콘 — statusPhrase와 같은 순서로 판정한다.
 * 뜻이 있는 색만 쓴다(SPEC 1절): 기다림 주황, 끝남 초록, 실패·열 수 없음 빨강, 일하는 중 파랑.
 * 아이콘은 멈춰 있다 — 끝없이 도는 움직임은 참딩 태엽만 쓴다(SPEC 1절 5).
 */
type Tone = 'attn' | 'run' | 'bg' | 'ok' | 'del' | 'idle' | null
function rowTone(room: WorkspaceRoom, live: boolean, turn: TurnState): Tone {
  if (room.status === 'corrupted') return 'del'
  if (live && turn === 'requires_action') return 'attn'
  if (live && (turn === 'running' || turn === 'operation')) return 'run'
  if (room.attention === 'waiting') return 'attn'
  if (room.attention === 'running') return 'run'
  if (room.attention === 'background') return 'bg'
  if (room.attention === 'done') return 'ok'
  if (room.attention === 'failed') return 'del'
  if (room.status === 'ended') return 'idle'
  return null
}
const TONE_COLOR: Record<Exclude<Tone, null>, string> = {
  attn: C.attn,
  run: C.tint,
  bg: C.tint,
  ok: C.ok,
  del: C.del,
  idle: C.label2,
}
function toneIcon(tone: Tone, kind: WorkspaceRoom['attentionKind']): LucideIcon | null {
  if (tone === 'attn') return kind === 'question' ? CircleHelp : Hand
  if (tone === 'run') return Loader
  if (tone === 'bg') return CircleDashed // 멈춘 점선 원 — 도는 움직임은 참딩 태엽만 쓴다
  if (tone === 'ok') return Check
  if (tone === 'del') return CircleAlert
  if (tone === 'idle') return Clock
  return null
}

const PROJECT_COLLAPSE_KEY = 'aether.projectCollapsed.v1'
const readFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.project_collapse.read' })
const writeFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.project_collapse.write' })

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PROJECT_COLLAPSE_KEY)
    readFailure.reset()
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, boolean> = {}
    for (const [key, val] of Object.entries(v)) if (val === true) out[key] = true
    return out
  } catch (error) {
    readFailure.report(error)
    return {}
  }
}

const ARCHIVE_OPEN_KEY = 'aether.archiveOpen.v1'
const archiveReadFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.archive_open.read' })
const archiveWriteFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.archive_open.write' })

function loadArchiveOpen(): boolean {
  try {
    const raw = localStorage.getItem(ARCHIVE_OPEN_KEY)
    archiveReadFailure.reset()
    return raw === '1'
  } catch (error) {
    archiveReadFailure.report(error)
    return false
  }
}

function RoomRow({ room, archived }: { room: WorkspaceRoom; archived?: boolean }) {
  const st = useStore()
  const t = useT()
  const cap = visibleCapacity(st.isWide, st.paneW, st.paneH)
  const isOnScreen = visibleSessionIds(st.activeId, st.sideIds, cap).includes(room.id)
  const isCurrent = focusedSessionId(st.focusedId, st.activeId, st.sideIds, cap) === room.id
  const live = isOnScreen
  // 칸이 둘 이상일 때 떠 있는 줄의 칸 번호, 그리고 옆에 열 수 있는지(넓은 창에서 칸이 둘 이상 들어갈 때, 아직 안 떠 있는 줄).
  const paneNo = paneNumberOf(room.id, st.activeId, st.sideIds, cap)
  const canBeside = st.isWide && cap >= 2 && !archived && !isOnScreen && room.status !== 'corrupted'
  const victim = canBeside ? besideVictimIndex(room.id, st.activeId, st.sideIds, st.focusedId, cap, st.focusOrder) : null
  const besideLabel = victim != null ? t('nav.sidebar.openBesideReplace', { n: victim + 1 }) : t('nav.sidebar.openBeside')
  const exec = room.sourceSessionId
  const turn = live && exec ? sessionTurn(st, exec) : 'idle'
  const title = room.title || t('nav.session.untitled')
  const phrase = statusPhrase(room, live, turn)
  const tone = rowTone(room, live, turn)
  const Icon = toneIcon(tone, room.attentionKind)
  const attention = room.attention ?? 'idle'
  // 기다림·실패는 무엇을 기다리는지(권한·질문 문구)가 더 쓸모 있다. 일함·끝남은 짧은 상태말.
  //   나머지는 마지막 말(미리보기)을 보여 주고, 그것도 없으면 상태말.
  const meta =
    tone === 'attn' || tone === 'del'
      ? room.attentionPreview || phrase
      : tone === 'run' || tone === 'bg' || tone === 'ok'
        ? phrase
        : cardPreviewLine(room, '') || phrase
  const metaColor = tone ? TONE_COLOR[tone] : C.label2
  // 보관된 줄은 상태 표시 없이 「폴더 · 보관 N일 전」 한 줄만 둔다.
  const archivedMeta = archived
    ? t('nav.sidebar.archivedMeta', { folder: folderName(normalizeFolder(room.cwd)), when: relTime(room.archivedAt ?? 0) })
    : ''
  const sess = room.sourceSessionId ? st.sessions.find((x) => x.id === room.sourceSessionId) : undefined
  const catalog = sess && chromeSessionId(st) === sess.id ? st.availableModels : null
  const model = sessionRowModel(sess, catalog)

  return (
    <button
      type="button"
      className={clsx(
        // hit-44-in = 줄 안의 작업 메뉴 버튼(WorkMenu)을 폰에서 44까지 넓힌다(index.css).
        // group = 마우스 기기에서는 줄에 올렸을 때만 작업 메뉴(.card-action)가 보인다.
        'session-row group hit-44-in flex w-full items-center text-left',
        isCurrent && 'session-row-current',
        isOnScreen && 'session-row-on',
      )}
      title={st.isWide && cap >= 2 && !archived ? t('nav.sidebar.rowTitle', { mod: MOD }) : undefined}
      data-session-id={room.id}
      data-room-id={room.id}
      data-room-kind={room.kind}
      data-attention={attention}
      // 오른쪽 8 = 작업 메뉴(28)의 폰 누름 범위(44)가 줄 밖으로 새지 않는 여백((44-28)/2).
      style={{ gap: 4, minHeight: archived ? 56 : 68, padding: '8px 8px 8px 10px', borderRadius: R.field }}
      onKeyDown={(e) => {
        // 키보드로 옆에 열기. 버튼의 기본 Enter(클릭)가 같은 일을 두 번 하지 않게 막는다.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.target === e.currentTarget) {
          e.preventDefault()
          actions.selectSession(room.id, { beside: true })
          if (getState().drawerOpen) actions.toggleDrawer(false)
        }
      }}
      onClick={(e) => {
        actions.selectSession(room.id, { beside: e.metaKey || e.ctrlKey })
        // 폰 서랍에서 지금 보는 작업을 다시 누르면 selectSession이 아무것도 안 바꾸고 끝나 서랍이 그대로 남았다.
        //   고른 뒤에는 늘 서랍을 닫는다(store.ts는 다른 작업이 고치는 중이라 여기서 처리한다 — 재설계 3단계 남김).
        if (getState().drawerOpen) actions.toggleDrawer(false)
      }}
    >
      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <span className="truncate" style={{ fontSize: 15, fontWeight: 500, color: archived ? C.label2 : C.label, lineHeight: 1.35 }}>
          {title}
        </span>
        {archived ? (
          <span className="truncate" style={{ fontSize: 13, color: C.label3, lineHeight: 1.35 }}>{archivedMeta}</span>
        ) : (
        <span className="flex min-w-0 items-center" style={{ gap: 8, fontSize: 13, lineHeight: 1.35 }}>
          <span className="flex min-w-0 items-center" style={{ gap: 4, color: metaColor, fontWeight: tone === 'attn' ? 500 : 400 }}>
            {Icon && <Icon size={13} className={tone === 'run' ? 'spin' : undefined} style={{ flexShrink: 0 }} aria-hidden />}
            <span className="truncate">{meta}</span>
          </span>
          {tone === 'attn' && room.attentionSince != null && <WaitAge since={room.attentionSince} prefix="· " />}
          {room.lastActivityAt != null && (
            <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 12.5, color: C.label3 }}>{relTime(room.lastActivityAt)}</span>
          )}
        </span>
        )}
        {model && !archived && (
          <span className="truncate" data-session-model={model} style={{ fontSize: 12.5, color: C.label3, lineHeight: 1.35 }}>
            {model}
          </span>
        )}
      </span>
      {paneNo > 0 && (
        <span
          data-pane-no={paneNo}
          aria-label={t('nav.sidebar.paneNo', { n: paneNo })}
          title={t('nav.sidebar.paneNo', { n: paneNo })}
          className="inline-flex items-center justify-center"
          style={{ flexShrink: 0, minWidth: 18, height: 18, padding: '0 5px', borderRadius: R.full, background: C.fill, color: C.label2, fontSize: 11.5, fontWeight: 600 }}
        >
          {paneNo}
        </span>
      )}
      {canBeside && (
        <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
          <IconButton
            type="button"
            className="card-action"
            data-session-opt="open-beside-btn"
            label={besideLabel}
            title={besideLabel}
            size={st.coarsePointer ? 36 : 28}
            color={C.label2}
            onClick={(e) => {
              e.stopPropagation()
              actions.openBeside(room.id)
            }}
          >
            <Columns2 size={14} />
          </IconButton>
        </span>
      )}
      <WorkMenu
        session={roomAsListItem(room)}
        size={st.coarsePointer ? 36 : 28}
        onExport={exec ? () => void actions.exportTranscript(exec) : undefined}
        onArchive={exec && room.status !== 'corrupted' ? () => void (room.archivedAt ? actions.unarchiveSession(exec) : actions.archiveSession(exec)) : undefined}
        archiveBlocked={tone === 'attn' || tone === 'run' || tone === 'bg'}
        onRename={(e) => {
          e.stopPropagation()
        }}
        onReset={(e) => {
          e.stopPropagation()
          const sid = room.sourceSessionId
          if (sid) {
            const sess = st.sessions.find((x) => x.id === sid)
            if (sess) actions.requestReset(sess)
          }
        }}
        onDelete={(e) => {
          e.stopPropagation()
          const sid = room.sourceSessionId
          if (sid) {
            const sess = st.sessions.find((x) => x.id === sid)
            if (sess) actions.requestDelete(sess)
          }
        }}
      />
    </button>
  )
}

/** 접힌 띠의 대기 세션 칩. 제목 머리글자 한 글자와 오른쪽 아래 상태 아이콘. 색은 기다림 주황 하나. */
function RailChip({ room }: { room: WorkspaceRoom }) {
  const t = useT()
  const st = useStore()
  const paneNo = paneNumberOf(room.id, st.activeId, st.sideIds, visibleCapacity(st.isWide, st.paneW, st.paneH))
  const now = useNow()
  const waiting = room.attention === 'waiting'
  const resume = room.autoResume
  // 대기 중이 아니면 자동 재개 예약 때문에 띠에 오른 칩이다 — 시계 아이콘과 예약 시각을 이름에 싣는다.
  const Icon = waiting ? toneIcon('attn', room.attentionKind) : resume?.gaveUp ? CircleAlert : Clock
  const title = room.title || t('nav.session.untitled')
  const age = room.attentionSince != null ? waitAgeText(room.attentionSince, now) : ''
  const resumeText = resume ? (resume.gaveUp ? t('nav.autoResume.gaveUp') : t('nav.autoResume.at', { time: autoResumeTimeText(resume.at ?? now, now) })) : ''
  const label = [waiting ? t('nav.sidebar.railItem', { title, status: t('nav.session.status.waiting'), age }).trim() : title, resumeText].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      data-rail-chip={room.id}
      title={label}
      aria-label={label}
      onClick={(e) => actions.selectSession(room.id, { beside: e.metaKey || e.ctrlKey })}
      className="press hit-44 relative inline-flex items-center justify-center"
      style={{ width: 36, height: 36, flexShrink: 0, border: 'none', borderRadius: R.full, background: waiting ? alpha.attn(0.16) : C.fill, color: waiting ? C.attn : C.label2, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
    >
      <span aria-hidden>{Array.from(title)[0]?.toUpperCase()}</span>
      {paneNo > 0 && (
        <span
          data-pane-no={paneNo}
          aria-hidden
          style={{ position: 'absolute', right: -2, top: -2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: R.full, background: C.bg2, color: C.label2, fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {paneNo}
        </span>
      )}
      {Icon && (
        <span aria-hidden style={{ position: 'absolute', right: -2, bottom: -2, width: 16, height: 16, borderRadius: R.full, background: C.bg2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={11} />
        </span>
      )}
    </button>
  )
}

export function Sidebar() {
  const s = useStore()
  const t = useT()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  const [archiveOpen, setArchiveOpen] = useState(loadArchiveOpen)
  const { active: activeRooms, archived: archivedRooms } = useMemo(() => splitArchived(s.rooms), [s.rooms])
  const groups = useMemo(() => groupRoomsByProject(activeRooms, s.sessions), [activeRooms, s.sessions])
  const narrow = s.isNarrow
  const rail = s.sidebarCollapsed && !narrow
  // 접고 펼친 뒤 포커스는 토글 버튼에 둔다(처음 그릴 때는 건드리지 않는다).
  const toggleRef = useRef<HTMLButtonElement>(null)
  const railMounted = useRef(false)
  useEffect(() => {
    if (railMounted.current) toggleRef.current?.focus()
    railMounted.current = true
  }, [rail])
  // 띠에는 대기 세션과 자동 재개 예약이 걸린 세션만. 대기가 위(오래 기다린 쪽이 먼저), 예약은 그 아래. 높이를 넘으면 맨 아래에 「+N」.
  const waitingRooms = useMemo(
    () =>
      activeRooms
        .filter((r) => r.attention === 'waiting' || r.autoResume)
        .sort((a, b) => {
          const wa = a.attention === 'waiting'
          const wb = b.attention === 'waiting'
          if (wa !== wb) return wa ? -1 : 1
          return (a.attentionSince ?? Infinity) - (b.attentionSince ?? Infinity)
        }),
    [activeRooms],
  )
  const split = isSplit(s)
  // 종은 알릴 것이 있을 때만 자리를 차지한다(HandChip이 같은 조건으로 그린다).
  const railBell = split && s.presenceLive && inboxRows(s.rooms).length > 0 ? 46 : 0
  const railFit = Math.max(1, Math.floor((s.paneH - 20 - 28 - 38 - 82 - 10 - 44 + 8 - railBell) / 44))
  const railShown = waitingRooms.length > railFit + 1 ? waitingRooms.slice(0, railFit) : waitingRooms
  const railMore = waitingRooms.length - railShown.length

  const toggleProject = (key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = true
      try {
        localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify(next))
        writeFailure.reset()
      } catch (error) {
        writeFailure.report(error)
        /* 저장 불가 */
      }
      return next
    })
  }

  const toggleArchive = () => {
    setArchiveOpen((prev) => {
      try {
        localStorage.setItem(ARCHIVE_OPEN_KEY, prev ? '0' : '1')
        archiveWriteFailure.reset()
      } catch (error) {
        archiveWriteFailure.report(error)
        /* 저장 불가 */
      }
      return !prev
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return groups
      .map((g) => {
        const folderHit = !!q && (
          g.title.toLowerCase().includes(q) ||
          g.label.toLowerCase().includes(q) ||
          g.key.toLowerCase().includes(q)
        )
        return {
          ...g,
          rooms: g.rooms.filter((r) => {
            if (!q || folderHit) return true
            return (
              r.title.toLowerCase().includes(q) ||
              (r.preview ?? '').toLowerCase().includes(q) ||
              (r.attentionPreview ?? '').toLowerCase().includes(q)
            )
          }),
        }
      })
      .filter((g) => g.rooms.length > 0)
  }, [groups, query])

  // 보관됨도 같은 검색 규칙(제목·미리보기)으로 거른다.
  const archivedShown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return archivedRooms
    return archivedRooms.filter((r) => r.title.toLowerCase().includes(q) || (r.preview ?? '').toLowerCase().includes(q))
  }, [archivedRooms, query])
  const total = groups.reduce((n, g) => n + g.rooms.length, 0) + archivedRooms.length
  // 검색에 걸린 보관 줄이 있으면 저장값과 관계없이 펼쳐 보여 준다.
  const archiveExpanded = archiveOpen || (query.trim() !== '' && archivedShown.length > 0)
  // 폰 서랍에서 Brain·설정을 열면 서랍은 닫는다 — 안 닫으면 창을 닫은 뒤 서랍이 다시 보인다.
  const leaveDrawer = () => {
    if (narrow) actions.toggleDrawer(false)
  }

  return (
    <aside
      className="glass side-anim flex min-h-0 flex-col"
      style={{
        // 폭은 양쪽 다 직접 준다. 이 칸을 감싸 폭을 정해 주는 틀이 어디에도 없어서 100%를 주면
        //   폰 서랍에서는 가장 긴 미리보기 글만큼, 데스크톱에서는 창 전체로 늘어나 대화 칸이 0이 된다(실측).
        width: narrow ? 'min(320px, calc(100vw - 16px))' : rail ? 56 : 288,
        overflow: rail ? 'hidden' : undefined,
        height: narrow ? '100%' : undefined,
        // 가로로 눕힌 노치 폰(폭 760 이상)에서는 왼쪽 안전 영역을 비운다.
        margin: narrow ? 0 : '10px 0 10px max(10px, env(safe-area-inset-left))',
        flexShrink: 0,
        gap: 10,
        padding: '14px 10px 10px',
        borderRadius: R.modal,
      }}
    >
      {rail ? (
        <div className="side-fade flex min-h-0 flex-1 flex-col items-center" style={{ gap: 10 }}>
          {/* 펼쳤을 때의 「Aether」 글자를 대신한다. */}
          <img src={chamdingUrl} width={28} height={28} alt="Aether" style={{ display: 'block', objectFit: 'contain', flexShrink: 0 }} />
          {split && <ConnectionIndicator state={s.conn} compact />}
          <IconButton
            type="button"
            ref={toggleRef}
            label={t('nav.sidebar.expand')}
            aria-expanded={false}
            onClick={() => actions.toggleSidebarCollapsed()}
            className="hit-44 press icon-ghost"
            size={36}
            color={C.label2}
            lift={false}
          >
            <PanelLeftOpen size={19} />
          </IconButton>
          <IconButton
            type="button"
            label={t('nav.session.new')}
            onClick={() => actions.openModal()}
            className="hit-44 press icon-ghost"
            size={36}
            color={C.label2}
            lift={false}
          >
            <Plus size={20} />
          </IconButton>
          {split && <HandChip inSidebar />}
          {waitingRooms.length > 0 && (
            <nav aria-label={t('nav.sidebar.waitingRail')} className="flex min-h-0 flex-col items-center" style={{ gap: 8, paddingTop: 4 }}>
              {railShown.map((room) => (
                <RailChip key={room.id} room={room} />
              ))}
              {railMore > 0 && (
                <button
                  type="button"
                  aria-label={t('nav.sidebar.railMore', { n: railMore })}
                  title={t('nav.sidebar.railMore', { n: railMore })}
                  onClick={() => actions.setHandListOpen(true)}
                  className="press hit-44 inline-flex items-center justify-center"
                  style={{ width: 36, height: 36, flexShrink: 0, border: 'none', borderRadius: R.full, background: C.fill, color: C.attn, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  +{railMore}
                </button>
              )}
            </nav>
          )}
        </div>
      ) : (
      <div className="side-fade flex min-h-0 flex-1 flex-col" style={{ gap: 10 }}>
      {/* 머리 버튼은 36, 사이 8 — 폰에서 누름 범위(index.css .hit-44)를 44로 넓혀도 이웃과 겹치지 않는다. */}
      <div className="flex items-center" style={{ flexShrink: 0, gap: 8, paddingLeft: 10, '--hit-w': '44px' } as CSSProperties}>
        <span className="inline-flex items-center" style={{ flex: 1, gap: 8, fontSize: 19, fontWeight: 700, letterSpacing: '-0.025em', color: C.label }}>
          Aether
          {split && <ConnectionIndicator state={s.conn} compact />}
        </span>
        {split && <HandChip inSidebar />}
        {!narrow && (
          <IconButton
            type="button"
            ref={toggleRef}
            label={t('nav.sidebar.collapse')}
            aria-expanded
            onClick={() => actions.toggleSidebarCollapsed()}
            className="hit-44 press icon-ghost"
            size={36}
            color={C.label2}
            lift={false}
          >
            <PanelLeftClose size={19} />
          </IconButton>
        )}
        <IconButton
          type="button"
          label={t('nav.session.new')}
          data-session-opt="new-work"
          onClick={() => actions.openModal()}
          className="hit-44 press icon-ghost"
          size={36}
          color={C.label2}
          lift={false}
        >
          <Plus size={20} />
        </IconButton>
        {/* 폰의 "이 세션에서 찾기"는 상단바에서 여기로 옮겼다 — 상단바는 세션 이름 자리를 먼저 준다(감사 F4).
            data-find-toggle: 찾기 바가 이 버튼 누름을 '바깥 누름'으로 보고 먼저 닫아 버리지 않게 한다(FindBar.tsx). */}
        {narrow && chromeSessionId(s) && (
          <IconButton
            type="button"
            label={t('nav.topbar.findInSession')}
            data-find-toggle
            onClick={() => { actions.toggleDrawer(false); actions.toggleFind() }}
            className="hit-44 press icon-ghost"
            size={36}
            color={C.label2}
            lift={false}
          >
            <Search size={18} />
          </IconButton>
        )}
        {narrow && (
          <IconButton
            type="button"
            label={t('nav.sidebar.closeList')}
            onClick={() => actions.toggleDrawer(false)}
            className="hit-44 press icon-ghost"
            size={36}
            color={C.label2}
            lift={false}
          >
            <X size={18} />
          </IconButton>
        )}
      </div>

      {/* label인 이유: 검색칸 둘레를 눌러도 검색칸이 켜진다. 폰에서는 hit-44로 세로 44까지 넓힌다. */}
      <label
        className="side-search hit-44 hit-44-under flex items-center"
        style={{ flexShrink: 0, gap: 8, height: 36, padding: '0 12px', borderRadius: R.chip, background: C.fill, color: C.label3 }}
      >
        <Search size={16} style={{ flexShrink: 0 }} aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('nav.sidebar.search')}
          aria-label={t('nav.sidebar.search')}
          data-sidebar-search
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: C.label, fontSize: 15 }}
        />
      </label>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto" style={{ overflowX: 'hidden' }}>
        {s.loadingSessions && total === 0 ? (
          // 세션 줄 모양의 자리표시. 글자 "불러오는 중"은 낭독기용으로만 남긴다.
          <div role="status" aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 10px' }}>
            <span className="sr-only">{t('nav.sidebar.loading')}</span>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <Skeleton width={i % 2 ? '58%' : '72%'} height={14} />
                <Skeleton width="42%" height={12} />
              </div>
            ))}
          </div>
        ) : total === 0 ? (
          <EmptyState title={t('nav.sidebar.emptyTitle')} desc={t('nav.sidebar.emptyHint')} />
        ) : filtered.length === 0 && archivedShown.length === 0 && query.trim() !== '' ? (
          <div style={{ padding: '8px 10px', fontSize: 13, color: C.label3 }}>
            {t('nav.sidebar.searchEmpty')}
          </div>
        ) : (
          filtered.map((group, i) => {
            const open = !collapsed[group.key]
            const name = group.title || t('nav.sidebar.unknownProject')
            const panelId = `project-panel-${i}`
            return (
              <section key={group.key || 'unknown'} data-project-key={group.key}>
                <button
                  type="button"
                  data-project-head
                  aria-expanded={open}
                  aria-controls={panelId}
                  title={group.key || t('nav.sidebar.unknownProject')}
                  onClick={() => toggleProject(group.key)}
                  className="flex w-full items-center text-left"
                  style={{
                    gap: 6,
                    height: narrow ? 44 : 32,
                    padding: '0 8px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  {open ? (
                    <ChevronDown size={14} style={{ color: C.label3, flexShrink: 0 }} aria-hidden />
                  ) : (
                    <ChevronRight size={14} style={{ color: C.label3, flexShrink: 0 }} aria-hidden />
                  )}
                  <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: C.label2 }}>
                    {name}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 12.5, color: C.label3 }}>
                    {t('nav.sidebar.sessionCount', { n: group.rooms.length })}
                  </span>
                </button>
                {open && (
                  <div id={panelId} className="flex flex-col" style={{ gap: 2 }}>
                    {group.rooms.map((room) => (
                      <RoomRow key={room.id} room={room} />
                    ))}
                  </div>
                )}
              </section>
            )
          })
        )}
        {/* 보관됨 — 맨 아래에 접어 둔다. 보관한 작업이 없으면(또는 검색에 안 걸리면) 통째로 숨긴다. */}
        {!(s.loadingSessions && total === 0) && archivedShown.length > 0 && (
          <section data-archive-group style={{ marginTop: 6, paddingTop: 4, borderTop: `0.5px solid ${C.sep}` }}>
            <button
              type="button"
              data-project-head
              aria-expanded={archiveExpanded}
              aria-controls="archive-panel"
              aria-label={t('nav.sidebar.archivedAria', { n: archivedShown.length })}
              onClick={toggleArchive}
              className="flex w-full items-center text-left"
              style={{ gap: 6, height: narrow ? 44 : 32, padding: '0 8px', border: 'none', background: 'transparent', cursor: 'pointer' }}
            >
              {archiveExpanded ? (
                <ChevronDown size={14} style={{ color: C.label3, flexShrink: 0 }} aria-hidden />
              ) : (
                <ChevronRight size={14} style={{ color: C.label3, flexShrink: 0 }} aria-hidden />
              )}
              <Archive size={14} style={{ color: C.label2, flexShrink: 0 }} aria-hidden />
              <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: C.label2 }}>{t('nav.sidebar.archived')}</span>
              <span style={{ flexShrink: 0, fontSize: 12.5, color: C.label3 }}>
                {t('nav.sidebar.sessionCount', { n: archivedShown.length })}
              </span>
            </button>
            <Collapse open={archiveExpanded} id="archive-panel">
              <div className="flex flex-col" style={{ gap: 2 }}>
                {archivedShown.map((room) => (
                  <RoomRow key={room.id} room={room} archived />
                ))}
              </div>
            </Collapse>
          </section>
        )}
      </div>

      {/* 참딩이 앉는 자리(SPEC 8절). 확인하지 않은 학습 기록이 있으면 주황 숫자를 붙인다. */}
      <div className="flex items-center" style={{ flexShrink: 0, gap: 8, paddingTop: 10, borderTop: `0.5px solid ${C.sep}` }}>
        <button
          type="button"
          aria-label={t('nav.topbar.brain')}
          title={t('nav.topbar.brainTitle')}
          onClick={() => { leaveDrawer(); actions.openBrain() }}
          className="brain-orb press icon-ghost hit-44 inline-flex min-w-0 items-center"
          style={{ gap: 10, height: 40, padding: '0 14px 0 6px', borderRadius: R.full, fontSize: 14, fontWeight: 500, color: C.label }}
        >
          <img src={chamdingUrl} width={28} height={28} alt="" aria-hidden style={{ display: 'block', objectFit: 'contain', flexShrink: 0 }} />
          <span className="truncate">{t('nav.topbar.brain')}</span>
        </button>
        <span style={{ flex: 1 }} />
        <IconButton
          type="button"
          label={t('nav.topbar.settings')}
          title={t('nav.topbar.settings')}
          onClick={() => { leaveDrawer(); actions.openSettings() }}
          className="hit-44 press icon-ghost"
          size={36}
          color={C.label2}
          lift={false}
        >
          <Settings size={19} />
        </IconButton>
      </div>
      </div>
      )}
    </aside>
  )
}
