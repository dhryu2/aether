// 검색 결과. 세션마다 머리 아래 묶음 목록 하나.
import { ChevronRight } from 'lucide-react'
import { C, FONT, R } from '../../design/tokens'
import { fmtDate } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { splitHighlight, type SearchHit } from '../../lib/brain'
import { hitOptionId } from '../../lib/searchPalette'
import { actions } from '../../lib/store'
import { sessionWorkTitle } from '../../lib/workTitle'
import { Group, RowLine } from './Bits'
import { projName } from './helpers'
import { MenuItem } from '../WorkMenu'
import { copyItem, menuOf, onContextMenuFor } from '../contextMenuFor'

/** onOpenDeleted: 지운 세션 결과를 누르면 세션을 여는 대신 읽기 전용 글로 본다. activeId: 위아래 키로 고른 현재 행. */
export function SearchHits({ groups, onOpenDeleted, activeId, listboxId }: { groups: ReadonlyArray<readonly [string, SearchHit[]]>; onOpenDeleted: (hit: SearchHit) => void; activeId?: number; listboxId: string }) {
  const t = useT()
  return (
    <div id={listboxId} role="listbox" aria-label={t('nav.sidebar.searchPast')} style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 4 }}>
      {groups.map(([sid, hits]) => <SessionGroup key={sid} hits={hits} onOpenDeleted={onOpenDeleted} activeId={activeId} />)}
    </div>
  )
}

function SessionGroup({ hits, onOpenDeleted, activeId }: { hits: readonly SearchHit[]; onOpenDeleted: (hit: SearchHit) => void; activeId?: number }) {
  const t = useT()
  const sess = hits[0].session
  const folder = projName(sess.cwd ?? undefined)
  const sub = [folder, sess.model].filter(Boolean).join(' · ')
  const title = sessionWorkTitle(sess, t('nav.session.untitled'))
  return (
    <div role="group" aria-label={title}>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 8 }}>
        <span className="truncate" style={{ fontSize: 15, fontWeight: 600, color: C.label }}>{title}</span>
        {hits[0].deleted && <DeletedBadge />}
        {sub && <span className="truncate" style={{ flex: 1, fontSize: 12.5, color: C.label3 }}>{sub}</span>}
        <span className="tabular-nums" style={{ marginLeft: 'auto', fontSize: 12.5, color: C.label3, flexShrink: 0 }}>{t('brain.search.hitCount', { n: hits.length })}</span>
      </div>
      <Group>
        {hits.map((hit, i) => (
          <div key={hit.id}>
            <RowLine index={i} />
            <HitRow hit={hit} onOpenDeleted={onOpenDeleted} active={hit.id === activeId} />
          </div>
        ))}
      </Group>
    </div>
  )
}

export function DeletedBadge() {
  const t = useT()
  return (
    <span style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 500, color: C.label2, background: C.fill, borderRadius: R.full, padding: '1px 8px' }}>
      {t('brain.search.deletedBadge')}
    </span>
  )
}

function HitRow({ hit, onOpenDeleted, active }: { hit: SearchHit; onOpenDeleted: (hit: SearchHit) => void; active: boolean }) {
  const t = useT()
  const tool = hit.role === 'tool'
  const open = () => (hit.deleted ? onOpenDeleted(hit) : actions.openSessionAt(hit.sessionId, hit.seq, hit))
  const who = t(hit.role === 'user' ? 'brain.role.user' : hit.role === 'tool' ? 'brain.role.tool' : 'brain.role.assistant')
  return (
    <button
      type="button"
      id={hitOptionId(hit.id)}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className="press"
      onClick={open}
      onContextMenu={onContextMenuFor(() => menuOf(
        <MenuItem onClick={open}>{t('menu.openHere')}</MenuItem>,
        copyItem(splitHighlight(hit.snippet).map((seg) => seg.text).join(''), t('menu.copyPreview')),
      ))}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', minHeight: 44, padding: '10px 12px 12px 16px', border: 'none', background: active ? C.fill : 'transparent', cursor: 'pointer', textAlign: 'left' }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.label3, marginBottom: 4 }}>{who} · {fmtDate(hit.ts)}</div>
        <div
          className="line-clamp-3"
          style={tool
            ? { fontFamily: FONT.mono, fontSize: 13, lineHeight: 1.45, color: C.label, background: C.cell2, borderRadius: R.field, padding: '8px 10px' }
            : { fontSize: 15, lineHeight: 1.45, color: C.label }}
        >
          {splitHighlight(hit.snippet).map((seg, i) => seg.mark
            ? <mark key={i} style={{ background: C.tintSoft, color: C.label, borderRadius: 3 }}>{seg.text}</mark>
            : <span key={i}>{seg.text}</span>)}
        </div>
      </div>
      <ChevronRight size={16} style={{ flexShrink: 0, marginTop: 16, color: C.label3 }} />
    </button>
  )
}
