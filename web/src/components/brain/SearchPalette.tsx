// 검색 팝업. 지난 대화와 명령, 실행 결과를 세션 묶음으로 보여 준다.
//   입력이 비면 최근 세션, 입력하면 검색 결과. 위아래 키로 행을 옮기고 Enter로 연다.
//   세션 목록 머리의 검색 아이콘과 Cmd/Ctrl+K로 연다.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKey, type RefObject } from 'react'
import { ChevronDown, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react'
import { C, R, Z } from '../../design/tokens'
import { relTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { startOfLocalDay, type SearchHit } from '../../lib/brain'
import { swallowEnter } from '../../lib/questionnaire'
import { hitOptionId, recentRooms, stepActive } from '../../lib/searchPalette'
import { actions, useStore } from '../../lib/store'
import type { WorkspaceRoom } from '../../lib/types'
import { IconButton, ModalCard, ModalShell, SegmentedControl, Skeleton } from '../ui'
import { useModalFrame } from '../ui/useModalFrame'
import { DeletedSessionView } from './DeletedSessionView'
import { SearchHits } from './SearchHits'
import { projName } from './helpers'

type Sort = 'relevance' | 'recent' | 'oldest'
type Period = 'all' | 'today' | 'd7' | 'd30'

const DAY = 86_400_000

// 이 화면이 고른 기간 이름. 시각으로 되돌리면 날짜가 바뀐 뒤 메뉴만 전체로 바뀐다.
let chosenPeriod: Period = 'all'

const SORTS: { value: Sort; key: string }[] = [
  { value: 'relevance', key: 'brain.search.sort.relevance' },
  { value: 'recent', key: 'brain.search.sort.recent' },
  { value: 'oldest', key: 'brain.search.sort.oldest' },
]

const PERIODS: { value: Period; key: string }[] = [
  { value: 'all', key: 'brain.search.period.all' },
  { value: 'today', key: 'brain.search.period.today' },
  { value: 'd7', key: 'brain.search.period.d7' },
  { value: 'd30', key: 'brain.search.period.d30' },
]

function rangeFor(period: Period): { fromTs: string; toTs: string } {
  const now = Date.now()
  if (period === 'today') return { fromTs: String(startOfLocalDay(now)), toTs: '' }
  if (period === 'd7') return { fromTs: String(now - 7 * DAY), toTs: '' }
  if (period === 'd30') return { fromTs: String(now - 30 * DAY), toTs: '' }
  return { fromTs: '', toTs: '' }
}

function applyPeriod(period: Period) {
  chosenPeriod = period
  const range = rangeFor(period)
  actions.setSearchFilters({ fromTs: range.fromTs, toTs: range.toTs })
}

const LISTBOX_ID = 'search-palette-list'
const recentOptionId = (roomId: string) => `search-opt-recent-${roomId}`

export function SearchPalette() {
  const open = useStore().searchOpen
  return open ? <PaletteWindow /> : null
}

function PaletteWindow() {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <ModalShell onClose={actions.closeSearch} zIndex={Z.root.search} initialFocusRef={inputRef}>
      <ModalCard variant="palette" maxWidth={640} data-window="search">
        <PaletteBody inputRef={inputRef} />
      </ModalCard>
    </ModalShell>
  )
}

function PaletteBody({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const s = useStore()
  const t = useT()
  const { titleId } = useModalFrame()
  const narrow = s.isNarrow
  const { query, sort, results, status } = s.kSearch
  const [period, setPeriod] = useState<Period>(chosenPeriod)
  const [filterOpen, setFilterOpen] = useState(false)
  const [visibleNonce, setVisibleNonce] = useState(-1)
  const [active, setActive] = useState(0)
  const listId = useId()
  // 지운 세션 결과를 누르면 목록 대신 그 세션의 남은 글을 보인다. 새 검색을 하면 목록으로 돌아간다.
  const [deletedHit, setDeletedHit] = useState<SearchHit | null>(null)
  useEffect(() => setDeletedHit(null), [s.kSearchNonce])
  // 읽기 전용 글에서 돌아오면 입력칸이 새로 그려지므로 커서를 다시 둔다. 처음 열 때는 창 틀이 초점을 준다(여기서 먼저 주면 열기 전 초점을 잃는다).
  // 읽기 전용 글이 열리면 뒤로 버튼(그 화면의 첫 버튼)으로 초점을 옮긴다.
  const sawDeleted = useRef(false)
  const deletedRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (deletedHit) {
      sawDeleted.current = true
      deletedRef.current?.querySelector('button')?.focus()
    } else if (sawDeleted.current) inputRef.current?.focus()
  }, [deletedHit, inputRef])

  // 열릴 때 기억한 기간으로 시작 시각을 다시 계산한다. 전체면 비운다.
  useEffect(() => { applyPeriod(chosenPeriod) }, [])

  // 빠른 검색은 뼈대를 그리지 않는다. 180ms보다 짧으면 깜빡임만 남기 때문이다.
  useEffect(() => {
    if (status !== 'loading') return
    const nonce = s.kSearchNonce
    const timer = setTimeout(() => setVisibleNonce(nonce), 180)
    return () => clearTimeout(timer)
  }, [s.kSearchNonce, status])
  const showSkeleton = status === 'loading' && visibleNonce === s.kSearchNonce

  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>()
    for (const hit of results) {
      const list = map.get(hit.sessionId)
      if (list) list.push(hit)
      else map.set(hit.sessionId, [hit])
    }
    return [...map.entries()]
  }, [results])
  // 화면에 그려지는 순서(세션 묶음 순)대로 편 목록. 위아래 키가 이 순서를 따른다.
  const flat = useMemo(() => groups.flatMap(([, hits]) => hits), [groups])
  const showRecent = query.trim() === ''
  const recent = useMemo(() => (showRecent ? recentRooms(s.rooms) : []), [showRecent, s.rooms])
  const count = showRecent ? recent.length : status === 'ok' ? flat.length : 0
  const activeIdx = count ? Math.min(active, count - 1) : -1
  const activeDomId = activeIdx < 0 ? undefined : showRecent ? recentOptionId(recent[activeIdx].id) : hitOptionId(flat[activeIdx].id)

  useEffect(() => setActive(0), [results, showRecent])
  useEffect(() => {
    if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView({ block: 'nearest' })
  }, [activeDomId])

  function openHit(hit: SearchHit) {
    if (hit.deleted) setDeletedHit(hit)
    else actions.openSessionAt(hit.sessionId, hit.seq, hit)
  }
  function openRoom(room: WorkspaceRoom) {
    actions.closeSearch()
    actions.selectSession(room.id)
  }

  function onKeyDown(e: ReactKey<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(stepActive(activeIdx, e.key === 'ArrowDown' ? 1 : -1, count))
    } else if (swallowEnter({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) && activeIdx >= 0) {
      e.preventDefault()
      if (showRecent) openRoom(recent[activeIdx])
      else openHit(flat[activeIdx])
    }
  }

  function onPeriod(next: Period) {
    setPeriod(next)
    applyPeriod(next)
  }

  const filtered = sort !== 'relevance' || period !== 'all'
  const periodMenu = (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <select
        data-search-period=""
        aria-label={t('brain.search.periodLabel')}
        value={period}
        onChange={(e) => onPeriod(e.target.value as Period)}
        style={{ height: narrow ? 44 : 32, padding: '0 28px 0 12px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 13, fontWeight: 500, appearance: 'none' }}
      >
        {PERIODS.map((it) => <option key={it.value} value={it.value}>{t('brain.search.periodLabel')}: {t(it.key)}</option>)}
      </select>
      <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: C.label3 }} />
    </span>
  )
  const summary = status === 'ok' && !showRecent ? (
    <span className="tabular-nums" style={{ marginLeft: 'auto', fontSize: 12.5, color: C.label3 }}>
      {t('brain.search.resultsSummary', { count: results.length, sessions: groups.length })}
    </span>
  ) : null

  return (
    <>
      <h2 id={titleId} className="brain-sr">{t('nav.sidebar.searchPast')}</h2>
      {deletedHit ? (
        <div ref={deletedRef} className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: narrow ? 'calc(env(safe-area-inset-top) + 12px) 16px calc(16px + env(safe-area-inset-bottom))' : '16px 20px 20px' }}>
          <DeletedSessionView hit={deletedHit} onBack={() => setDeletedHit(null)} />
        </div>
      ) : (
        <>
          <div style={{ flexShrink: 0, padding: narrow ? 'calc(env(safe-area-inset-top) + 8px) 12px 8px' : '12px 16px 8px' }}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: C.label3 }} />
                <input
                  ref={inputRef}
                  className="brain-input"
                  type="text"
                  role="combobox"
                  aria-expanded={count > 0}
                  aria-controls={count ? (showRecent ? listId : LISTBOX_ID) : undefined}
                  aria-autocomplete="list"
                  aria-activedescendant={activeDomId}
                  aria-label={t('nav.sidebar.searchPast')}
                  value={query}
                  placeholder={t('brain.search.placeholder')}
                  onChange={(e) => actions.runSearch(e.target.value)}
                  onKeyDown={onKeyDown}
                  style={{ width: '100%', height: narrow ? 44 : 40, border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 15, padding: '0 44px 0 40px' }}
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t('brain.search.clear')}
                    className="press icon-ghost"
                    onClick={() => { actions.runSearch(''); inputRef.current?.focus() }}
                    style={{ position: 'absolute', right: 0, top: 0, width: narrow ? 44 : 32, height: '100%', border: 'none', background: 'transparent', color: C.label3, cursor: 'pointer' }}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              {narrow && (
                <IconButton type="button" label={t('common.close')} size={36} color={C.label2} lift={false} className="press icon-ghost hit-44" onClick={() => actions.closeSearch()}>
                  <X size={20} />
                </IconButton>
              )}
            </div>
            <div className="flex items-center" style={{ gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="press"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((v) => !v)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: narrow ? 44 : 32, padding: '0 12px', border: 'none', borderRadius: R.full, background: filterOpen || filtered ? C.tintSoft : C.fill, color: C.label, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
              >
                <SlidersHorizontal size={14} />
                {t('brain.search.filter')}
              </button>
              {summary}
            </div>
            {filterOpen && (
              <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'stretch' : 'center', gap: 8, marginTop: 8 }}>
                <SegmentedControl
                  size="compact"
                  fullWidth={narrow}
                  itemHeight={narrow ? 44 : 28}
                  items={SORTS.map((it) => ({ value: it.value, label: t(it.key) }))}
                  value={sort}
                  onChange={(next) => actions.setSearchSort(next)}
                  style={narrow ? { width: '100%' } : undefined}
                />
                {periodMenu}
              </div>
            )}
          </div>

          <div className="scroll-area" aria-busy={status === 'loading'} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: narrow ? '0 12px calc(16px + env(safe-area-inset-bottom))' : '0 16px 16px' }}>
            {showRecent && (
              recent.length > 0 ? (
                <>
                  <div style={{ padding: '8px 4px', fontSize: 12.5, fontWeight: 600, color: C.label3 }}>{t('brain.search.recent')}</div>
                  <div id={listId} role="listbox" aria-label={t('brain.search.recent')}>
                    {recent.map((room, i) => (
                      <RecentRow key={room.id} room={room} active={i === activeIdx} onOpen={() => openRoom(room)} />
                    ))}
                  </div>
                </>
              ) : (
                <Idle title={t('brain.search.recentEmpty')} desc="" />
              )
            )}
            {showSkeleton && (
              <>
                <span className="brain-sr">{t('brain.search.loading')}</span>
                {[0, 1].map((g) => (
                  <div key={g} aria-hidden style={{ marginTop: g === 0 ? 12 : 18 }}>
                    <Skeleton width={g === 0 ? 180 : 140} height={15} />
                    <div style={{ background: C.cell, borderRadius: R.card, padding: '4px 16px', marginTop: 8 }}>
                      {[0.94, 0.7].map((w, i) => (
                        <div key={i} style={{ padding: '12px 0' }}>
                          <Skeleton width={`${w * 100}%`} height={13} />
                          <Skeleton width={90} height={11} style={{ marginTop: 8 }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
            {!showRecent && status === 'empty' && <Idle title={t('brain.search.emptyTitle', { query })} desc={t('brain.search.emptyDesc')} />}
            {!showRecent && status === 'ok' && <SearchHits groups={groups} onOpenDeleted={setDeletedHit} activeId={flat[activeIdx]?.id} listboxId={LISTBOX_ID} />}
          </div>
        </>
      )}
    </>
  )
}

function RecentRow({ room, active, onOpen }: { room: WorkspaceRoom; active: boolean; onOpen: () => void }) {
  const t = useT()
  const sub = [projName(room.cwd), relTime(room.lastInputAt ?? room.lastActivityAt ?? 0)].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      id={recentOptionId(room.id)}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className="press"
      onClick={onOpen}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44, padding: '8px 12px', border: 'none', borderRadius: R.field, background: active ? C.fill : 'transparent', cursor: 'pointer', textAlign: 'left' }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="truncate" style={{ fontSize: 15, fontWeight: 500, color: C.label }}>{room.title || t('nav.session.untitled')}</div>
        {sub && <div className="truncate" style={{ fontSize: 12.5, color: C.label3, marginTop: 2 }}>{sub}</div>}
      </div>
      <ChevronRight size={16} style={{ flexShrink: 0, color: C.label3 }} />
    </button>
  )
}

function Idle({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '40px 12px', gap: 8 }}>
      <Search size={40} style={{ color: C.label3 }} />
      <div style={{ fontSize: 17, fontWeight: 600, color: C.label }}>{title}</div>
      {desc && <div style={{ fontSize: 14, color: C.label2, lineHeight: 1.5, maxWidth: 420 }}>{desc}</div>}
    </div>
  )
}
