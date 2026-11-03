import { createClientErrorReporter } from '../../lib/errors'
// 지운 세션의 대화 글. 세션은 열 수 없으니 검색 색인에 남은 글을 읽기 전용으로 차례대로 보인다.
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { C, FONT, R } from '../../design/tokens'
import { api } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { useT } from '../../lib/i18n'
import type { DeletedSessionRow, SearchHit } from '../../lib/brain'
import { sessionWorkTitle } from '../../lib/workTitle'
import { Group, RowLine } from './Bits'
import { DeletedBadge } from './SearchHits'

const PAGE = 100
// 누른 글까지 앞에서부터 쪽을 넘겨 읽는다. 끝없이 읽지 않게 한도를 둔다.
const MAX_PAGES_TO_HIT = 30

export function DeletedSessionView({ hit, onBack }: { hit: SearchHit; onBack: () => void }) {
  const t = useT()
  const [rows, setRows] = useState<DeletedSessionRow[]>([])
  const [more, setMore] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const hitRef = useRef<HTMLDivElement>(null)
  // 화면 인스턴스마다 하나를 만들어 같은 읽기 실패의 반복을 첫 건만 남긴다(렌더 중 ref 접근을 피하려 state 초기값으로 둔다).
  const [failure] = useState(() => createClientErrorReporter({ component: 'search', operation: 'web.deleted_session.read' }))

  useEffect(() => {
    let alive = true
    ;(async () => {
      const got: DeletedSessionRow[] = []
      let after = 0
      let full = false
      for (let i = 0; i < MAX_PAGES_TO_HIT; i++) {
        const page = (await api.deletedSessionPage(hit.sessionId, after)).rows
        got.push(...page)
        full = page.length >= PAGE
        if (!full || page.some((r) => r.seq >= hit.seq)) break
        after = page[page.length - 1].id
      }
      if (!alive) return
      setRows(got)
      setMore(full)
      setStatus('ok')
      failure.reset()
    })().catch(error => {
      failure.report(error, { session_id: hit.sessionId })
      if (alive) setStatus('error')
    })
    return () => {
      alive = false
    }
  }, [hit.sessionId, hit.seq, failure])

  useEffect(() => {
    if (status === 'ok') hitRef.current?.scrollIntoView({ block: 'center' })
  }, [status])

  async function loadMore() {
    const last = rows[rows.length - 1]
    if (!last) return
    try {
      const page = (await api.deletedSessionPage(hit.sessionId, last.id)).rows
      setRows((prev) => [...prev, ...page])
      setMore(page.length >= PAGE)
      failure.reset()
    } catch (error) {
      failure.report(error, { session_id: hit.sessionId })
      setStatus('error')
    }
  }

  const anchor = rows.find((r) => r.seq === hit.seq && r.part === hit.part) ?? rows.find((r) => r.seq >= hit.seq)

  return (
    <div>
      <button
        type="button"
        className="press"
        onClick={onBack}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 32, padding: '0 10px 0 4px', border: 'none', borderRadius: R.full, background: 'transparent', color: C.tint, fontSize: 14, cursor: 'pointer' }}
      >
        <ChevronLeft size={18} />
        {t('brain.search.deletedBack')}
      </button>
      <div className="flex items-baseline" style={{ gap: 8, margin: '12px 0 4px' }}>
        <span className="truncate" style={{ fontSize: 15, fontWeight: 600, color: C.label }}>{sessionWorkTitle(hit.session, t('nav.session.untitled'))}</span>
        <DeletedBadge />
      </div>
      <div style={{ fontSize: 13, color: C.label2, marginBottom: 12 }}>{t('brain.search.deletedNotice')}</div>

      {status === 'loading' && <div style={{ fontSize: 13, color: C.label3 }}>{t('brain.loading')}</div>}
      {status === 'error' && <div style={{ fontSize: 13, color: C.del }}>{t('brain.search.deletedFailed')}</div>}
      {status === 'ok' && (
        <Group>
          {rows.map((row, i) => {
            const tool = row.role === 'tool'
            const isHit = row === anchor
            return (
              <div key={row.id} ref={isHit ? hitRef : undefined} style={isHit ? { background: C.tintSoft } : undefined}>
                <RowLine index={i} />
                <div style={{ padding: '10px 12px 12px 16px' }}>
                  <div style={{ fontSize: 12.5, color: C.label3, marginBottom: 4 }}>
                    {t(row.role === 'user' ? 'brain.role.user' : tool ? 'brain.role.tool' : 'brain.role.assistant')} · {fmtDate(row.ts)}
                  </div>
                  <div
                    style={tool
                      ? { fontFamily: FONT.mono, fontSize: 13, lineHeight: 1.45, color: C.label, background: C.cell2, borderRadius: R.field, padding: '8px 10px', maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                      : { fontSize: 15, lineHeight: 1.45, color: C.label, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {row.content}
                  </div>
                </div>
              </div>
            )
          })}
        </Group>
      )}
      {status === 'ok' && more && (
        <button
          type="button"
          className="press"
          onClick={() => void loadMore()}
          style={{ display: 'block', margin: '12px auto 0', minHeight: 32, padding: '0 16px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 13, cursor: 'pointer' }}
        >
          {t('brain.search.deletedMore')}
        </button>
      )}
    </div>
  )
}
