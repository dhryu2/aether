// 설정 > 서버의 「오류 기록」 칸.
// 서버가 지문별로 묶어 준 오류를 기간·출처로 거르고, 줄을 누르면 그 자리에서 상세가 펼쳐진다.
import { useEffect, useRef, useState } from 'react'
import type { ErrorGroupDetailResponse, ErrorGroupSummary, ErrorLogPeriod, ErrorLogSource } from '@shared/errors'
import { api } from '../../lib/api'
import { NEXT_PERIOD, componentLabel, errorCopyText } from '../../lib/errorLog'
import { fmtShortDateTime } from '../../lib/format'
import { useCopy } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { actions, useStore } from '../../lib/store'
import { findRoom, roomIdForExecution } from '../../lib/workspaceRooms'
import { C, FONT } from '../../design/tokens'
import { Button, Collapse, EmptyState, Notice, NOTICE_TONE, SegmentedControl, Skeleton } from '../ui'
import { Group, GroupNote, Sep, TextRow, ValueRow } from './parts'
import { rowMin, useNarrow } from './settingsLayout'

const PERIODS: readonly ErrorLogPeriod[] = ['24h', '7d', 'all']
const SOURCES: readonly ErrorLogSource[] = ['all', 'server', 'web']

type Filters = { since: ErrorLogPeriod; source: ErrorLogSource }
type ListState = { phase: 'loading' | 'failed' | 'ready'; groups: ErrorGroupSummary[]; next: string | null }
type DetailState = ErrorGroupDetailResponse | 'loading' | 'failed'

const when = (iso: string) => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : fmtShortDateTime(ms)
}

export function ErrorLogView() {
  const t = useT()
  const narrow = useNarrow()
  const [filters, setFilters] = useState<Filters>({ since: '24h', source: 'all' })
  const [list, setList] = useState<ListState>({ phase: 'loading', groups: [], next: null })
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [open, setOpen] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  // 늦게 도착한 응답을 버리기 위한 번호. 거르기가 바뀌거나 다시 불러올 때마다 올린다(req()는 취소 신호를 받지 않는다).
  const seq = useRef(0)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const mine = ++seq.current
    // 거르기를 바꿀 때는 기존 목록을 흐리게 두었다가 새 목록으로 바꾼다(빈 화면 → 자리표시 깜빡임 방지).
    setList((l) => ({ phase: 'loading', groups: l.groups, next: null }))
    setMore('idle')
    setOpen(null)
    setDetails({})
    api.errorGroups(filters).then(
      (r) => { if (mine === seq.current) setList({ phase: 'ready', groups: r.groups, next: r.nextCursor }) },
      () => { if (mine === seq.current) setList({ phase: 'failed', groups: [], next: null }) },
    )
  }, [filters, attempt])

  const loadMore = () => {
    if (!list.next) return
    const mine = seq.current
    setMore('loading')
    api.errorGroups({ ...filters, cursor: list.next }).then(
      (r) => {
        if (mine !== seq.current) return
        setList((l) => ({ phase: 'ready', groups: [...l.groups, ...r.groups], next: r.nextCursor }))
        setMore('idle')
      },
      () => { if (mine === seq.current) setMore('failed') },
    )
  }

  const loadDetail = (fp: string) => {
    const mine = seq.current
    setDetails((d) => ({ ...d, [fp]: 'loading' }))
    api.errorGroup(fp, filters).then(
      (r) => { if (mine === seq.current) setDetails((d) => ({ ...d, [fp]: r })) },
      () => { if (mine === seq.current) setDetails((d) => ({ ...d, [fp]: 'failed' })) },
    )
  }

  const toggle = (fp: string) => {
    if (open === fp) { setOpen(null); return }
    setOpen(fp)
    if (!(fp in details) || details[fp] === 'failed') loadDetail(fp)
  }

  const itemHeight = narrow ? 44 : 28
  const filterRow = <V extends string>(label: string, items: readonly V[], value: V, onChange: (v: V) => void, name: (v: V) => string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px' }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{label}</span>
      <SegmentedControl
        size="compact"
        items={items.map((v) => ({ value: v, label: name(v) }))}
        value={value}
        onChange={onChange}
        itemPadding={narrow ? '0 12px' : '0 10px'}
        itemHeight={itemHeight}
        itemMinWidth={narrow ? 44 : undefined}
        style={{ flexShrink: 0 }}
      />
    </div>
  )

  const empty = list.phase === 'ready' && list.groups.length === 0
  const nextPeriod = NEXT_PERIOD[filters.since]
  // 낭독기에는 상태가 바뀔 때만 한 번 알린다.
  const announce = list.phase === 'failed' ? t('settings.errorLog.failed') : empty ? t(`settings.errorLog.empty.${filters.since}`) : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div>
        <Group>
          {filterRow(t('settings.errorLog.period.label'), PERIODS, filters.since, (since) => setFilters((f) => ({ ...f, since })), (v) => t(`settings.errorLog.period.${v}`))}
          <Sep />
          {filterRow(t('settings.errorLog.source.label'), SOURCES, filters.source, (source) => setFilters((f) => ({ ...f, source })), (v) => t(`settings.errorLog.source.${v}`))}
        </Group>
        <GroupNote>{t('settings.errorLog.note')}</GroupNote>
      </div>
      <div role="status" className="sr-only">{announce}</div>

      {list.phase === 'loading' && list.groups.length === 0 && (
        <div aria-busy="true">
          <Group>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                {i > 0 && <Sep />}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px' }}>
                  <Skeleton width="80%" height={14} />
                  <Skeleton width="40%" height={12} />
                </div>
              </div>
            ))}
          </Group>
        </div>
      )}

      {list.phase === 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Notice {...NOTICE_TONE.warn} fontSize={13} style={{ alignSelf: 'stretch' }}>{t('settings.errorLog.failed')}</Notice>
          <Button onClick={() => setAttempt((n) => n + 1)}>{t('settings.errorLog.retry')}</Button>
        </div>
      )}

      {empty && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <EmptyState title={t(`settings.errorLog.empty.${filters.since}`)} color={C.label2} padding="24px 0 8px" />
          {nextPeriod && <Button onClick={() => setFilters((f) => ({ ...f, since: nextPeriod }))}>{t(`settings.errorLog.widen.${nextPeriod}`)}</Button>}
        </div>
      )}

      {(list.phase === 'ready' || list.phase === 'loading') && list.groups.length > 0 && (
        <div aria-busy={list.phase === 'loading'} inert={list.phase === 'loading'} style={{ opacity: list.phase === 'loading' ? 0.5 : 1, transition: 'opacity var(--dur-press) var(--ease-state)' }}>
          <Group>
            {list.groups.map((g, i) => (
              <div key={g.fingerprint}>
                {i > 0 && <Sep />}
                <ErrorRow group={g} expanded={open === g.fingerprint} onToggle={() => toggle(g.fingerprint)} narrow={narrow} />
                <Collapse open={open === g.fingerprint}>
                  <ErrorDetail group={g} state={details[g.fingerprint] ?? 'loading'} onRetry={() => loadDetail(g.fingerprint)} />
                </Collapse>
              </div>
            ))}
          </Group>
        </div>
      )}

      {list.phase === 'ready' && list.next && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          {more === 'failed' && <Notice {...NOTICE_TONE.warn} fontSize={13} style={{ alignSelf: 'stretch' }}>{t('settings.errorLog.failed')}</Notice>}
          <Button disabled={more === 'loading'} onClick={loadMore}>
            {more === 'loading' ? t('settings.errorLog.loadingMore') : more === 'failed' ? t('settings.errorLog.retry') : t('settings.errorLog.more')}
          </Button>
        </div>
      )}
    </div>
  )
}

function ErrorRow({ group, expanded, onToggle, narrow }: { group: ErrorGroupSummary; expanded: boolean; onToggle: () => void; narrow: boolean }) {
  const t = useT()
  const time = when(group.lastAt)
  const count = t('settings.errorLog.count', { n: group.count.toLocaleString() })
  return (
    <button
      type="button"
      className="press"
      aria-expanded={expanded}
      aria-controls={`error-detail-${group.fingerprint}`}
      aria-label={t('settings.errorLog.rowLabel', { message: group.message, count: group.count.toLocaleString(), time })}
      onClick={onToggle}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        minHeight: rowMin(narrow),
        padding: '10px 16px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit',
        color: C.label,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 15,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {group.message}
        </span>
        <span className="tabular-nums" style={{ flexShrink: 0, fontSize: 15, color: C.label2 }}>{count}</span>
      </span>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: C.label2 }}>
        <span style={{ minWidth: 0 }}>{componentLabel(group.component, t)}</span>
        <span className="tabular-nums" style={{ flexShrink: 0 }}>{time}</span>
      </span>
    </button>
  )
}

function ErrorDetail({ group, state, onRetry }: { group: ErrorGroupSummary; state: DetailState; onRetry: () => void }) {
  const t = useT()
  const rooms = useStore().rooms
  const narrow = useNarrow()
  const { copied, copy } = useCopy()
  const [stackOpen, setStackOpen] = useState(false)
  const id = `error-detail-${group.fingerprint}`

  if (state === 'loading') {
    return (
      <div id={id} aria-busy="true" style={{ padding: '4px 16px 14px' }}>
        <Skeleton width="100%" height={14} />
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', padding: '4px 16px 14px' }}>
        <span style={{ fontSize: 13, color: C.label2 }}>{t('settings.errorLog.detail.failed')}</span>
        <Button onClick={onRetry}>{t('settings.errorLog.retry')}</Button>
      </div>
    )
  }
  const e = state.latest
  return (
    <div id={id}>
      <Sep />
      <div style={{ padding: '12px 16px', fontSize: 14, lineHeight: 1.5, color: C.label, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>{e.message}</div>
      <Sep />
      <ValueRow label={t('settings.errorLog.detail.count')} value={t('settings.errorLog.count', { n: state.count.toLocaleString() })} />
      <Sep />
      <ValueRow label={t('settings.errorLog.detail.first')} value={when(state.firstAt)} />
      <Sep />
      <ValueRow label={t('settings.errorLog.detail.last')} value={when(state.lastAt)} />
      <Sep />
      <ValueRow label={t('settings.errorLog.detail.where')} value={`${e.component} / ${e.operation}`} />
      {state.sessionIds.length > 0 && (
        <>
          <Sep />
          <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, color: C.label2 }}>{t('settings.errorLog.detail.sessions')}</span>
            {state.sessionIds.map((sid) => {
              const room = findRoom(rooms, roomIdForExecution(rooms, sid))
              return room ? (
                <button
                  key={sid}
                  type="button"
                  className="press"
                  onClick={() => { actions.closeSettings(); actions.selectSession(room.id) }}
                  style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'left', font: 'inherit', fontSize: 15, color: C.tint, cursor: 'pointer', minHeight: rowMin(narrow) }}
                >
                  {room.title}
                </button>
              ) : (
                <span key={sid} style={{ fontSize: 14, color: C.label2 }}>{t('settings.errorLog.detail.sessionGone', { id: sid.slice(0, 8) })}</span>
              )
            })}
          </div>
        </>
      )}
      {e.stack && (
        <>
          <Sep />
          <TextRow color={C.tint} expanded={stackOpen} onClick={() => setStackOpen((v) => !v)}>
            <span style={{ flex: 1, minWidth: 0 }}>{stackOpen ? t('settings.errorLog.detail.stackHide') : t('settings.errorLog.detail.stackShow')}</span>
          </TextRow>
          <Collapse open={stackOpen}>
            <pre style={{ margin: 0, padding: '0 16px 12px', fontFamily: FONT.mono, fontSize: 12, color: C.label2, overflowX: 'auto', whiteSpace: 'pre', userSelect: 'text' }}>{e.stack}</pre>
          </Collapse>
        </>
      )}
      <Sep />
      <div style={{ padding: '10px 16px' }}>
        <Button height={34} onClick={() => copy(errorCopyText(group, state))}>
          {copied ? t('settings.errorLog.detail.copied') : t('settings.errorLog.detail.copy')}
        </Button>
      </div>
    </div>
  )
}
