// 검색. 지난 대화와 명령, 실행 결과를 세션 묶음으로 보여 준다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { startOfLocalDay, type SearchHit } from '../../lib/brain'
import { actions, useStore } from '../../lib/store'
import { SegmentedControl, Skeleton } from '../ui'
import { DeletedSessionView } from './DeletedSessionView'
import { SearchHits } from './SearchHits'

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

export function SearchView() {
  const s = useStore()
  const t = useT()
  const narrow = s.isNarrow
  const { query, sort, results, status } = s.kSearch
  const inputRef = useRef<HTMLInputElement>(null)
  const [period, setPeriod] = useState<Period>(chosenPeriod)
  const [visibleNonce, setVisibleNonce] = useState(-1)
  const brainOpen = s.brainOpen
  // 지운 세션 결과를 누르면 목록 대신 그 세션의 남은 글을 보인다. 새 검색을 하면 목록으로 돌아간다.
  const [deletedHit, setDeletedHit] = useState<SearchHit | null>(null)
  useEffect(() => setDeletedHit(null), [s.kSearchNonce])

  // 화면이 다시 열릴 때 기억한 기간으로 시작 시각을 다시 계산한다. 전체면 비운다.
  useEffect(() => {
    if (!brainOpen) return
    applyPeriod(chosenPeriod)
  }, [brainOpen])

  // 컴퓨터만 칸을 연 직후 커서를 둔다. 폰은 키보드가 갑자기 올라오지 않게 둔다.
  useEffect(() => {
    if (narrow) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [narrow])

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

  function onPeriod(next: Period) {
    setPeriod(next)
    applyPeriod(next)
  }

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
  const summary = status === 'ok' ? (
    <span className="tabular-nums" style={{ marginLeft: 'auto', fontSize: 12.5, color: C.label3 }}>
      {t('brain.search.resultsSummary', { count: results.length, sessions: groups.length })}
    </span>
  ) : null

  if (deletedHit) return <DeletedSessionView hit={deletedHit} onBack={() => setDeletedHit(null)} />

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: C.label3 }} />
        <input
          ref={inputRef}
          className="brain-input"
          type="text"
          value={query}
          placeholder={t('brain.search.placeholder')}
          onChange={(e) => actions.runSearch(e.target.value)}
          style={{ width: '100%', height: narrow ? 44 : 40, border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 15, padding: '0 44px 0 40px' }}
        />
        {query && (
          <button
            type="button"
            aria-label={t('brain.search.clear')}
            className="press icon-ghost"
            onClick={() => actions.runSearch('')}
            style={{ position: 'absolute', right: 0, top: 0, width: narrow ? 44 : 32, height: '100%', border: 'none', background: 'transparent', color: C.label3, cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'stretch' : 'center', gap: 8, marginTop: 12, flexWrap: narrow ? 'nowrap' : 'wrap' }}>
        <SegmentedControl
          size="compact"
          fullWidth={narrow}
          itemHeight={narrow ? 44 : 28}
          items={SORTS.map((it) => ({ value: it.value, label: t(it.key) }))}
          value={sort}
          onChange={(next) => actions.setSearchSort(next)}
          style={narrow ? { width: '100%' } : undefined}
        />
        {narrow ? (
          <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
            {periodMenu}
            {summary}
          </div>
        ) : (
          <>
            {periodMenu}
            {summary}
          </>
        )}
      </div>

      <div aria-busy={status === 'loading'} style={{ marginTop: 8 }}>
        {showSkeleton && (
          <>
            <span className="brain-sr">{t('brain.search.loading')}</span>
            {[0, 1].map((g) => (
              <div key={g} aria-hidden style={{ marginTop: g === 0 ? 16 : 18 }}>
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
        {status === 'idle' && <Idle title={t('brain.search.idleTitle')} desc={t('brain.search.idleDesc', { n: s.sessions.length })} />}
        {status === 'empty' && <Idle title={t('brain.search.emptyTitle', { query })} desc={t('brain.search.emptyDesc')} />}
        {status === 'ok' && <SearchHits groups={groups} onOpenDeleted={setDeletedHit} />}
      </div>
    </div>
  )
}

function Idle({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '48px 12px', gap: 8 }}>
      <Search size={48} style={{ color: C.label3 }} />
      <div style={{ fontSize: 17, fontWeight: 600, color: C.label }}>{title}</div>
      <div style={{ fontSize: 14, color: C.label2, lineHeight: 1.5, maxWidth: 420 }}>{desc}</div>
    </div>
  )
}
