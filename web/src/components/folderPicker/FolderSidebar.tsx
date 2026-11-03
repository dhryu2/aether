// 폴더 탐색기의 위치 목록. 최근 작업, 즐겨찾기, 장치 세 구역을 보여 준다.
// 넓은 화면에서는 왼쪽 사이드바, 폰에서는 첫 화면("위치" 화면)이 이 부품을 같은 구조로 쓴다. 줄 크기만 다르다.
import { Fragment, useId, type KeyboardEvent, type ReactNode } from 'react'
import { C } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { folderName } from '../../lib/sessionGroups'
import type { FsPlaces } from '../../lib/types'
import { Group, GroupTitle } from '../settings/parts'
import { FolderGlyph, FolderLabel, FolderSep, type PlaceKind } from './FolderChoices'
import { sidebarRowStyle } from './rowStyle'

type Row = { key: string; path: string; label: string; kind?: PlaceKind }

export function FolderSidebar({
  quick,
  places,
  failed,
  onRetry,
  current,
  narrow,
  onOpen,
}: {
  /** 최근 작업 폴더(절대 경로, 최근 활동순). */
  quick: string[]
  places: FsPlaces | undefined
  failed: boolean
  onRetry: () => void
  /** 지금 보고 있는 폴더. 같은 줄에 현재 위치 표시를 단다. */
  current: string | null
  narrow: boolean
  onOpen: (path: string) => void
}) {
  const t = useT()
  const uid = useId()

  const sections: { id: string; title: string; rows: Row[] }[] = []
  if (quick.length) {
    sections.push({ id: 'recent', title: t('session.folderPicker.recent'), rows: quick.map((p) => ({ key: p, path: p, label: folderName(p) })) })
  }
  if (places) {
    sections.push({
      id: 'favorites',
      title: t('session.folderPicker.favorites'),
      rows: places.favorites.map((f) => ({
        key: f.path,
        path: f.path,
        kind: f.kind,
        label: f.kind === 'home' ? t('session.folderPicker.home') : t(`session.folderPicker.place.${f.kind}`),
      })),
    })
    if (places.devices.length) {
      sections.push({
        id: 'devices',
        title: t('session.folderPicker.devices'),
        rows: places.devices.map((d) => ({
          key: d.path,
          path: d.path,
          kind: d.kind,
          label: d.kind === 'drive' ? t('session.folderPicker.drive', { name: d.name }) : d.kind === 'root' && d.name === '/' ? t('session.folderPicker.systemDisk') : d.name,
        })),
      })
    }
  }

  // 같은 폴더가 두 구역에 있어도 현재 위치 표시는 처음 나온 줄에만 단다.
  let marked = false
  const flat = sections.flatMap((s) => s.rows)
  const tabStop = Math.max(0, flat.findIndex((r) => r.path === current))

  // 넓은 화면은 Tab 정지점이 하나이고 방향키로 줄을 옮긴다. 줄을 여는 것은 버튼의 Enter다.
  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-folder-place]')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  let index = 0
  const body: ReactNode = sections.map((s) => {
    const titleId = `${uid}-${s.id}`
    const rows = s.rows.map((r, i) => {
      const here = !marked && r.path === current
      if (here) marked = true
      const myIndex = index++
      return (
        <Fragment key={r.key}>
          {narrow && i > 0 && <FolderSep />}
          <button
            type="button"
            data-folder-place={r.path}
            aria-current={here ? 'location' : undefined}
            tabIndex={narrow || myIndex === tabStop ? 0 : -1}
            title={r.path}
            onClick={() => onOpen(r.path)}
            className="press"
            style={sidebarRowStyle(narrow)}
          >
            <FolderGlyph place={r.kind} size={narrow ? 20 : 18} />
            <FolderLabel name={r.label} strong={here} />
          </button>
        </Fragment>
      )
    })
    return (
      <section key={s.id} role="group" aria-labelledby={titleId} style={{ marginBottom: narrow ? 24 : 12 }}>
        <div id={titleId}>
          <GroupTitle>{s.title}</GroupTitle>
        </div>
        {narrow ? <Group>{rows}</Group> : rows}
      </section>
    )
  })

  return (
    <nav aria-label={t('session.folderPicker.root')} onKeyDown={narrow ? undefined : onKey} style={{ minWidth: 0 }}>
      {body}
      {!places && !failed && (
        <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px' }}>
          {[62, 44, 54].map((w) => (
            <span key={w} style={{ display: 'block', height: 10, width: `${w}%`, borderRadius: 5, background: C.fill }} />
          ))}
        </div>
      )}
      {failed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 16px', alignItems: 'flex-start' }}>
          <span role="status" style={{ fontSize: 13, color: C.del, lineHeight: 1.45 }}>{t('session.folderPicker.placesFailed')}</span>
          <button
            type="button"
            className={narrow ? 'hit-44' : undefined}
            onClick={onRetry}
            style={{ minHeight: 28, padding: 0, border: 'none', background: 'transparent', color: C.tint, font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {t('session.folderPicker.retry')}
          </button>
        </div>
      )}
    </nav>
  )
}
