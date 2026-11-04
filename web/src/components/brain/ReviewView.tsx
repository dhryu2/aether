// 검토함. 끝난 세션의 변경·실패·할 일을 기록에서 모아 목록과 상세로 보이고, 사람이 "검토 완료"로 처리한다.
//   넓은 화면은 목록 옆에 상세, 폰은 목록과 상세가 번갈아 전체 화면이다(뒤로 가기는 창 껍데기가 그린다).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKey } from 'react'
import { CircleAlert, ClipboardCheck } from 'lucide-react'
import type { ReviewRow } from '@shared/brain'
import { C, R } from '../../design/tokens'
import { api } from '../../lib/api'
import { relTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { flatReview, groupReview, nextAfterDone, rowSubtitle, stepReview } from '../../lib/review'
import { actions, useStore } from '../../lib/store'
import { Button, EmptyState, Skeleton } from '../ui'
import { ReviewDetail } from './ReviewDetail'
import { useBrainChrome } from './useBrainChrome'

const optionId = (id: string) => `review-opt-${id}`
// previous는 처리 전 위치, saved는 이번 완료가 저장한 위치(되돌릴 때 서버가 아직 그대로인지 확인한다).
type Done = { id: string; previous: number | null; saved: number | null }

export function ReviewView() {
  const s = useStore()
  const t = useT()
  const narrow = s.isNarrow
  const { setBack } = useBrainChrome()
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false) // 폰에서 상세 화면인지
  const [busyId, setBusyId] = useState<string | null>(null)
  const [skeleton, setSkeleton] = useState(false)
  const [live, setLive] = useState('')
  const lastDone = useRef<Done | null>(null)
  const loadN = useRef(0)

  const load = useCallback(async () => {
    const n = ++loadN.current
    try {
      const r = await api.reviewList()
      if (n !== loadN.current) return
      setRows(r.rows)
      setLoadError(false)
    } catch {
      if (n === loadN.current) setLoadError(true)
    }
  }, [])

  // 창을 열 때 한 번, 그 뒤로는 세션의 상태·보관이 바뀔 때(presence) 조용히 다시 읽는다.
  useEffect(() => { void load() }, [load])
  const presenceKey = s.sessions.map((x) => `${x.id}:${x.attention ?? ''}:${x.archivedAt ?? 0}`).join('|')
  const firstKey = useRef(true)
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return }
    const timer = setTimeout(() => void load(), 800)
    return () => clearTimeout(timer)
  }, [presenceKey, load])

  // 빠른 응답은 뼈대를 그리지 않는다. 180ms보다 짧으면 깜빡임만 남기 때문이다.
  useEffect(() => {
    if (rows !== null) { setSkeleton(false); return }
    const timer = setTimeout(() => setSkeleton(true), 180)
    return () => clearTimeout(timer)
  }, [rows])

  // 넓은 화면에서 목록이 처음 뜨면 선택된 행에 초점을 둔다(E·Z·위아래가 바로 되게). 사람이 이미 다른 곳으로 옮겼으면 건드리지 않는다.
  const focused = useRef(false)
  useEffect(() => {
    if (narrow || focused.current || !rows?.length) return
    // 창 껍데기가 열린 직후 닫기 버튼에 초점을 두므로 그보다 늦게(두 프레임 뒤) 옮긴다.
    let inner = 0
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => {
      focused.current = true
      const active = document.activeElement
      if (active instanceof HTMLElement && (active.getAttribute('aria-label') === t('common.close') || active === document.body)) {
        document.querySelector<HTMLElement>('[data-review-list]')?.focus()
      }
    }) })
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, narrow])

  const groups = useMemo(() => groupReview(rows ?? []), [rows])
  const flat = useMemo(() => flatReview(groups), [groups])
  const selected = flat.find((r) => r.id === selectedId) ?? (narrow ? null : flat[0] ?? null)
  const showDetail = !!selected && (!narrow || detailOpen)
  // 폰에서 상세를 보던 행이 목록에서 사라지면(다른 곳에서 처리됨) 목록 화면으로 돌아간다.
  // 같은 id가 되살아나도 상세가 저절로 다시 열리지 않게 상태도 끈다.
  useEffect(() => {
    if (detailOpen && !selected) setDetailOpen(false)
  }, [detailOpen, selected])

  // 폰 상세 화면의 뒤로 가기는 창 껍데기의 뒤로 버튼이 맡는다(시트를 또 띄우지 않는다).
  useEffect(() => {
    if (narrow && showDetail) setBack({ label: t('brain.tabs.review'), onBack: () => setDetailOpen(false) })
    else setBack(null)
    return () => setBack(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, showDetail, s.locale, setBack])

  useEffect(() => {
    if (selected) document.getElementById(optionId(selected.id))?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function openSession(row: ReviewRow, seq?: number) {
    actions.closeBrain()
    if (seq === undefined) actions.selectSession(row.id)
    else actions.openSessionAt(row.id, seq)
  }

  async function undo(entry: Done) {
    try {
      await api.reviewUndo(entry.id, entry.previous ?? undefined, entry.saved)
      if (lastDone.current?.id === entry.id) lastDone.current = null
      setSelectedId(entry.id)
      setDetailOpen(false)
      setLive(t('brain.review.undone'))
      await load()
    } catch (e) {
      // 409: 다른 기기에서 이미 바꿨다. 목록을 다시 읽어 실제 상태를 보인다.
      if ((e as { status?: number }).status === 409) {
        if (lastDone.current?.id === entry.id) lastDone.current = null
        actions.showError(t('brain.review.undoConflict'))
        void load()
      } else actions.showError(t('brain.review.actionFailed'))
    }
  }

  async function markDone(row: ReviewRow) {
    if (busyId) return
    setBusyId(row.id)
    try {
      const r = await api.reviewDone(row.id, row.lastSeq)
      const entry = { id: row.id, previous: r.previous, saved: r.reviewedSeq }
      lastDone.current = entry
      setSelectedId(nextAfterDone(flat, row.id))
      setDetailOpen(false)
      setRows((prev) => prev && prev.filter((x) => x.id !== row.id))
      void load() // 이 사이에 늦게 도착한 옛 목록 응답이 행을 되살리지 못하게 다시 읽는다
      setLive(t('brain.review.doneNotice'))
      actions.showNotice({ title: t('brain.review.doneNotice'), action: { label: t('brain.review.undo'), onClick: () => void undo(entry) } })
    } catch {
      actions.showError(t('brain.review.actionFailed'))
    } finally {
      setBusyId(null)
    }
  }

  // 목록에 초점이 있을 때만 받는다. 입력칸이나 다른 창 위의 키는 이 자리에 오지 않는다.
  function onKeyDown(e: ReactKey<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
    // 글자는 물리 키(e.code)로 본다. 한글 입력 상태에서는 e.key가 ㄷ·ㅋ로 온다.
    const k = e.code === 'KeyE' ? 'e' : e.code === 'KeyZ' ? 'z' : ''
    if (k && e.repeat) return // 글자 키는 누르고 있어도 한 번만 처리한다
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedId(stepReview(flat, selected?.id ?? null, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault()
      openSession(selected)
    } else if (k === 'e' && selected) {
      e.preventDefault()
      void markDone(selected)
    } else if (k === 'z' && lastDone.current) {
      e.preventDefault()
      void undo(lastDone.current)
    }
  }

  if (rows === null && loadError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '48px 0' }}>
        <EmptyState icon={<CircleAlert size={28} aria-hidden style={{ color: C.label4 }} />} title={t('brain.review.loadFailed')} padding="0" />
        <Button tone="gray" height={narrow ? 44 : 36} onClick={() => { setLoadError(false); void load() }}>{t('brain.review.retry')}</Button>
      </div>
    )
  }
  if (rows !== null && rows.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardCheck size={28} aria-hidden style={{ color: C.label4 }} />}
        title={t('brain.review.emptyTitle')}
        desc={t('brain.review.emptyDesc')}
        padding="64px 0"
        fontSize={15}
      />
    )
  }

  const listPane = (
    <div className="scroll-area" style={narrow ? { flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', margin: '0 -12px' } : { width: 300, flexShrink: 0, minHeight: 0, overflowY: 'auto', paddingRight: 8 }}>
      {rows === null ? (
        skeleton ? (
          <div role="status" aria-label={t('brain.loading')} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 4px' }}>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} width="100%" height={52} radius={R.field} />)}
          </div>
        ) : null
      ) : (
        <div
          role="listbox"
          aria-label={t('brain.review.listLabel')}
          aria-activedescendant={selected ? optionId(selected.id) : undefined}
          tabIndex={0}
          data-review-list=""
          onKeyDown={onKeyDown}
        >
          {([['attention', 'brain.review.groupAttention'], ['changes', 'brain.review.groupChanges']] as const).map(([key, label]) =>
            groups[key].length === 0 ? null : (
              <div key={key} role="group" aria-labelledby={`review-group-${key}`}>
                <div id={`review-group-${key}`} style={{ padding: '12px 12px 4px', fontSize: 12.5, fontWeight: 600, color: C.label3 }}>{t(label)}</div>
                {groups[key].map((row) => (
                  <ReviewRowItem
                    key={row.id}
                    row={row}
                    active={row.id === selected?.id}
                    onPick={() => { setSelectedId(row.id); if (narrow) setDetailOpen(true) }}
                  />
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )

  return (
    <div data-review="" style={{ display: 'flex', flex: 1, minHeight: 0, height: '100%', gap: narrow ? 0 : 20 }}>
      <div className="brain-sr" role="status" aria-live="polite">{live}</div>
      {(!narrow || !showDetail) && listPane}
      {showDetail && selected && (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, maxWidth: 760 }}>
          <ReviewDetail
            row={selected}
            narrow={narrow}
            busy={busyId === selected.id}
            onOpen={(seq) => openSession(selected, seq)}
            onDone={() => void markDone(selected)}
          />
        </div>
      )}
    </div>
  )
}

function ReviewRowItem({ row, active, onPick }: { row: ReviewRow; active: boolean; onPick: () => void }) {
  const t = useT()
  const title = row.title || t('brain.review.untitled')
  const subtitle = rowSubtitle(row, t)
  return (
    <div
      id={optionId(row.id)}
      role="option"
      aria-selected={active}
      data-review-opt=""
      className="press"
      onClick={onPick}
      style={{ minHeight: 56, padding: '9px 12px', borderRadius: R.field, cursor: 'pointer', background: active ? C.fill : 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div className="truncate" title={title} style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.label }}>{title}</div>
        <div className="tabular-nums" style={{ flexShrink: 0, fontSize: 12.5, color: C.label3 }}>{relTime(row.lastActivityAt)}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2, fontSize: 13, color: C.label2 }}>
        {row.failureCount > 0 && <CircleAlert size={13} aria-hidden style={{ flexShrink: 0, color: C.del }} />}
        <span className="truncate tabular-nums" title={subtitle}>{subtitle}</span>
      </div>
    </div>
  )
}
