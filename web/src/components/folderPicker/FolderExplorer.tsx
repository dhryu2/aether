// 새 작업 창 안의 폴더 탐색기. 서버 컴퓨터의 폴더를 그 컴퓨터의 탐색기에서 보던 순서대로 찾아 고른다.
// 넓은 화면은 왼쪽 위치 목록 + 오른쪽 폴더 목록, 폰은 "위치" 화면에서 시작해 폴더 목록으로 들어간다.
// 창 아래 줄에는 지금 고를 폴더의 전체 경로가 늘 보인다. 줄을 고르면 그 폴더, 안 골랐으면 지금 보는 폴더다.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { C, FONT, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { Group } from '../settings/parts'
import { rowMin } from '../settings/settingsLayout'
import { Switch } from '../ui'
import { MenuItem } from '../WorkMenu'
import { copyItem, menuOf, onContextMenuFor, onCopyMenu } from '../contextMenuFor'
import { FolderGlyph, FolderLabel, FolderSep } from './FolderChoices'
import { FolderPathBar } from './FolderPathBar'
import { FolderSidebar } from './FolderSidebar'
import { filterEntries, moveSelection, parentPath, pickTarget, type SelectionKey } from './explorerModel'
import { folderRowStyle } from './rowStyle'
import type { FolderBrowser } from './useFolderBrowser'

/** 보는 폴더. null은 폰의 "위치" 화면이고, 넓은 화면에서는 처음 폴더를 정하는 동안만 null이다. */
type At = string | null

export function FolderExplorer({
  browser,
  quick,
  initialAt,
  narrow,
  onTargetChange,
}: {
  browser: FolderBrowser
  /** 최근 작업 폴더(절대 경로). */
  quick: string[]
  /** 지금 고른 폴더. 넓은 화면은 그 폴더의 부모를 열고 이 폴더 줄을 선택한 채 시작한다. */
  initialAt: string
  narrow: boolean
  /** 아래 "이 폴더 선택"이 고를 폴더. "위치" 화면이면 null이다. */
  onTargetChange: (path: string | null) => void
}) {
  const t = useT()
  const [at, setAt] = useState<At>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 이 창에서 지나온 폴더. 앞으로 가기는 없다.
  const [history, setHistory] = useState<At[]>([])
  const [dir, setDir] = useState<'in' | 'out'>('in')
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState(false)
  const [inputOpen, setInputOpen] = useState(false)
  const [pathText, setPathText] = useState('')
  const [pathError, setPathError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 터치는 한 번에 들어가고, 마우스는 한 번 선택·두 번 들어간다. 폭이 아니라 입력 종류로 가른다.
  const pointerType = useRef('')
  // 사람이 직접 폴더를 옮겼는지. 처음 폴더를 정하는 비동기 작업이 늦게 끝나도 옮겨 둔 위치를 덮어쓰지 않게 한다.
  const moved = useRef(false)
  // 경로 직접 입력 요청의 번호. 마지막 요청의 응답만 반영한다.
  const submitSeq = useRef(0)

  const { load, places } = browser
  const listing = at ? browser.get(at, hidden) : undefined
  const status = at ? browser.failedOf(at, hidden) : undefined
  const placesScreen = narrow && at === null

  // 처음 폴더를 정한다. 고른 폴더를 한 번 불러 그 부모를 열고 고른 폴더 줄을 선택한다. 실패하면 홈이다. 폰은 "위치" 화면에서 시작한다.
  const homePath = places?.home ?? ''
  useEffect(() => {
    if (narrow) return
    let alive = true
    void (async () => {
      const picked = initialAt ? await load(initialAt) : null
      if (!alive || moved.current) return
      if (picked) {
        if (picked.parent) {
          // 고른 폴더가 숨김이면 숨김 끈 부모 목록에 없다. 숨김 보기를 켜서 그 줄이 선택되게 한다.
          const parent = await load(picked.parent)
          if (!alive || moved.current) return
          if (parent && !parent.entries.some((e) => e.path === picked.path)) setHidden(true)
          setAt(picked.parent)
          setSelected(picked.path)
        } else setAt(picked.path)
        return
      }
      const home = await load(homePath)
      if (alive && !moved.current) setAt(home?.path ?? homePath)
    })()
    return () => {
      alive = false
    }
    // 창을 열 때 한 번만 정한다. 이후 값이 바뀌어도 사람이 옮겨 둔 위치를 되돌리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 지금 폴더와 숨김 여부에 맞는 목록을 불러온다. 이미 있으면 그대로 쓴다.
  useEffect(() => {
    if (at) void load(at, hidden)
  }, [at, hidden, load])

  // 목록이 바뀌어도 선택 줄은 걸러진 목록 안에 있을 때만 유효하다.
  const rows = useMemo(() => filterEntries(listing?.entries ?? [], query), [listing, query])
  const selIndex = selected ? rows.findIndex((e) => e.path === selected) : -1
  const effSelected = selIndex >= 0 ? selected : null
  const target = pickTarget(effSelected, at, !!listing)

  useEffect(() => {
    onTargetChange(target)
  }, [target, onTargetChange])

  // 폴더를 옮기면 목록 맨 위에서 시작한다. 위로 나온 경우는 아래 효과가 선택 줄을 화면에 보이게 한다.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [at])
  useEffect(() => {
    if (selIndex >= 0) document.getElementById(`folder-opt-${selIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [selIndex, listing])

  // 넓은 화면은 열자마자 목록이 키를 받는다. 누른 버튼은 이미 사라졌다.
  useEffect(() => {
    if (!narrow) listRef.current?.focus({ preventScroll: true })
  }, [narrow])

  useEffect(() => {
    if (inputOpen) inputRef.current?.select()
  }, [inputOpen])

  function go(next: At, opts: { select?: string; direction?: 'in' | 'out'; push?: boolean } = {}) {
    moved.current = true
    if (opts.push !== false && (at !== null || narrow)) setHistory((h) => [...h, at])
    setDir(opts.direction ?? 'in')
    setAt(next)
    setSelected(opts.select ?? null)
    setQuery('')
    setInputOpen(false)
    setPathError(null)
  }

  const upTarget = at === null ? null : (listing ? listing.parent : parentPath(at) !== at ? parentPath(at) : null)
  const canUp = narrow ? at !== null : upTarget !== null
  const canBack = history.length > 0

  function up() {
    if (at === null) return
    if (upTarget) go(upTarget, { select: at, direction: 'out' })
    else if (narrow) go(null, { direction: 'out' })
  }

  function back() {
    if (!canBack) return
    moved.current = true
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setDir('out')
    setAt(prev)
    setSelected(null)
    setQuery('')
    setInputOpen(false)
  }

  function openEntry(path: string) {
    go(path)
  }

  function toggleInput() {
    if (inputOpen) {
      setInputOpen(false)
      setPathError(null)
      return
    }
    setPathText(at ?? places?.home ?? '')
    setPathError(null)
    setInputOpen(true)
  }

  function messageOf(code: number | undefined): string {
    if (code === 403) return t('session.folderPicker.denied')
    if (code === 404) return t('session.folderPicker.notFound')
    if (code === 400) return t('session.folderPicker.invalidPath')
    return t('session.folderPicker.error')
  }

  async function submitPath() {
    const text = pathText.trim()
    if (!text) return
    const seq = ++submitSeq.current
    const result = await browser.load(text, hidden)
    if (seq !== submitSeq.current) return
    if (result) go(result.path)
    else setPathError(messageOf(browser.failedOf(text, hidden)))
  }

  function onSearch(value: string) {
    setQuery(value)
    // 걸러져 사라질 줄을 선택해 둔 채로 두지 않는다.
    if (selected && !filterEntries(listing?.entries ?? [], value).some((e) => e.path === selected)) setSelected(null)
  }

  function toggleHidden() {
    const next = !hidden
    setHidden(next)
    if (!next && selected && listing?.entries.find((e) => e.path === selected)?.hidden) setSelected(null)
  }

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      back()
    } else if ((e.altKey && e.key === 'ArrowUp') || (!e.altKey && (e.key === 'Backspace' || e.key === 'ArrowLeft'))) {
      e.preventDefault()
      up()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const i = moveSelection(rows, selIndex, e.key as SelectionKey)
      if (i >= 0) setSelected(rows[i].path)
    } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && effSelected) {
      e.preventDefault()
      openEntry(effSelected)
    }
  }

  // 목록 밖에서도 먹는 단축키. Cmd와 Ctrl을 모두 받아 운영체제를 따로 가릴 필요가 없다.
  function onRootKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!(e.metaKey || e.ctrlKey)) return
    if (!e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      if (!inputOpen) toggleInput()
      else inputRef.current?.select()
    } else if (e.shiftKey && (e.key === '.' || e.key === '>' || e.code === 'Period')) {
      e.preventDefault()
      toggleHidden()
    }
  }

  function onRowClick(e: MouseEvent, path: string) {
    e.stopPropagation()
    if (pointerType.current === 'touch') openEntry(path)
    else setSelected(path)
  }

  const crumbs = listing?.crumbs ?? []
  const loading = at !== null && !listing && status === undefined
  const busyInit = !narrow && at === null
  const heading = listing?.name ?? ''

  const searchBox = (
    <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: narrow ? 1 : undefined, width: narrow ? undefined : 156, minWidth: 0 }}>
      <span aria-hidden style={{ position: 'absolute', left: 10, display: 'inline-flex', color: C.label3, pointerEvents: 'none' }}>
        <Search size={14} />
      </span>
      <input
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            // 글자가 있으면 글자만 지운다. 창의 Esc(새 작업으로 돌아가기)까지 올라가지 않게 한다.
            e.stopPropagation()
            onSearch('')
          }
        }}
        aria-label={t('session.folderPicker.search')}
        placeholder={t('session.folderPicker.searchPlaceholder')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-folder-search=""
        style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', height: narrow ? 44 : 32, padding: '0 10px 0 30px', border: 'none', borderRadius: R.chip, background: C.fill, color: C.label, fontFamily: 'inherit', fontSize: 14 }}
      />
    </label>
  )
  const hiddenSwitch = (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0, cursor: 'pointer' }}>
      <span aria-hidden style={{ fontSize: 13, color: C.label2, whiteSpace: 'nowrap' }}>{t('session.folderPicker.showHidden')}</span>
      <Switch on={hidden} onChange={toggleHidden} label={t('session.folderPicker.showHidden')} width={38} height={24} knob={20} className={narrow ? 'hit-44' : undefined} />
    </label>
  )

  const pathBar = (
    <FolderPathBar
      crumbs={crumbs}
      narrow={narrow}
      onPlaces={narrow ? () => go(null, { direction: 'out' }) : undefined}
      canBack={canBack}
      canUp={canUp}
      onBack={back}
      onUp={up}
      onCrumb={(p) => go(p, { direction: 'out' })}
      inputOpen={inputOpen}
      onToggleInput={toggleInput}
      pathText={pathText}
      onPathText={(v) => {
        setPathText(v)
        setPathError(null)
      }}
      onSubmit={() => void submitPath()}
      onCloseInput={() => {
        setInputOpen(false)
        setPathError(null)
        listRef.current?.focus({ preventScroll: true })
      }}
      pathError={pathError}
      inputRef={inputRef}
    />
  )

  const sidebar = (
    <FolderSidebar
      quick={quick}
      places={places}
      failed={browser.placesFailed}
      onRetry={() => void browser.loadPlaces()}
      current={at}
      narrow={narrow}
      onOpen={(p) => go(p)}
    />
  )

  const parentOfAt = at !== null && parentPath(at) !== at ? parentPath(at) : null
  const message = (text: string, opts: { action?: { label: string; run: () => void }; error?: boolean } = {}) => (
    <div role="presentation" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', flexWrap: 'wrap' }}>
      <span style={{ flex: 1, minWidth: 160, fontSize: 13, lineHeight: 1.45, color: opts.error ? C.del : C.label2 }}>{text}</span>
      {opts.action && (
        <button
          type="button"
          className={narrow ? 'hit-44' : undefined}
          onClick={opts.action.run}
          style={{ flexShrink: 0, minHeight: 28, padding: 0, border: 'none', background: 'transparent', color: C.tint, font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          {opts.action.label}
        </button>
      )}
    </div>
  )

  let listBody
  if (busyInit || loading) {
    listBody = (
      <div aria-hidden>
        {[46, 30, 38].map((w, i) => (
          <Fragment key={w}>
            {narrow && i > 0 && <FolderSep />}
            <div style={{ ...folderRowStyle(narrow), cursor: 'default' }}>
              <FolderGlyph />
              <span style={{ display: 'block', height: 10, width: `${w}%`, borderRadius: 5, background: C.fill }} />
            </div>
          </Fragment>
        ))}
      </div>
    )
  } else if (status !== undefined) {
    const goUp = (status === 403 || status === 404) && parentOfAt ? { label: t('session.folderPicker.up'), run: () => go(parentOfAt, { direction: 'out' }) } : undefined
    listBody =
      status === 403 || status === 404 || status === 400
        ? message(messageOf(status), { action: goUp, error: true })
        : message(t('session.folderPicker.error'), { action: { label: t('session.folderPicker.retry'), run: () => at && void load(at, hidden, true) }, error: true })
  } else if (listing && listing.entries.length === 0) {
    listBody = message(t('session.folderPicker.empty'))
  } else if (listing && rows.length === 0) {
    listBody = message(t('session.folderPicker.noMatch'))
  } else if (listing) {
    listBody = (
      <div key={at} className={dir === 'in' ? 'tab-in-r' : 'tab-in-l'}>
        {rows.map((e, i) => {
          const on = i === selIndex
          return (
            <Fragment key={e.path}>
              {narrow && i > 0 && <FolderSep />}
              <div
                role="option"
                id={`folder-opt-${i}`}
                aria-selected={on}
                data-folder-opt={e.path}
                className="folder-row"
                onPointerDown={(ev) => {
                  pointerType.current = ev.pointerType
                }}
                onClick={(ev) => onRowClick(ev, e.path)}
                onDoubleClick={() => openEntry(e.path)}
                // 우클릭하면 그 행을 고른다. 메뉴가 뜰 때만 고른다(터치의 길게 누르기는 건드리지 않는다).
                onContextMenu={onContextMenuFor(() => {
                  setSelected(e.path)
                  return menuOf(
                    <MenuItem onClick={() => openEntry(e.path)}>{t('menu.open')}</MenuItem>,
                    copyItem(e.path, t('menu.copyPath')),
                  )
                })}
                style={{ ...folderRowStyle(narrow), minHeight: narrow ? rowMin(true) : 36, gap: 10, userSelect: 'none' }}
              >
                <FolderGlyph size={narrow ? 20 : 18} />
                <FolderLabel name={e.name} dim={e.hidden} strong={on} />
                {narrow && (
                  <span aria-hidden style={{ color: C.label3, display: 'inline-flex', flexShrink: 0 }}>
                    <ChevronRight size={17} />
                  </span>
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
    )
  }

  const listbox = (
    <div
      ref={listRef}
      role="listbox"
      tabIndex={0}
      data-folder-list=""
      aria-label={t('session.folderPicker.inside', { name: heading })}
      aria-busy={loading || busyInit}
      aria-activedescendant={selIndex >= 0 ? `folder-opt-${selIndex}` : undefined}
      onKeyDown={onListKey}
      onClick={() => setSelected(null)}
      style={{ minHeight: '100%', boxSizing: 'border-box' }}
    >
      {listBody}
      {listing?.truncated && (
        <p role="presentation" style={{ margin: 0, padding: '10px 16px 14px', fontSize: 13, lineHeight: 1.45, color: C.label2 }}>
          {t('session.folderPicker.truncated')}
        </p>
      )}
    </div>
  )

  const area = placesScreen ? (
    <div ref={scrollRef} style={{ height: 'min(64vh, 560px)', overflowY: 'auto' }}>{sidebar}</div>
  ) : narrow ? (
    <div ref={scrollRef} style={{ height: 'min(64vh, 560px)', overflowY: 'auto' }}>
      <Group>{listbox}</Group>
    </div>
  ) : (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '200px minmax(0, 1fr)',
        height: 'min(440px, 56vh)',
        background: C.cell,
        borderRadius: R.field,
        overflow: 'hidden',
      }}
    >
      <div style={{ background: C.cell2, borderRight: `1px solid ${C.sepSoft}`, overflowY: 'auto', padding: '12px 0 0' }}>{sidebar}</div>
      <div ref={scrollRef} style={{ overflowY: 'auto', minWidth: 0 }}>{listbox}</div>
    </div>
  )

  return (
    <div onKeyDown={onRootKey} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {narrow ? (
        <>
          {pathBar}
          {!placesScreen && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {searchBox}
              {hiddenSwitch}
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {pathBar}
          {searchBox}
          <div style={{ height: 32, display: 'flex', alignItems: 'center' }}>{hiddenSwitch}</div>
        </div>
      )}
      {area}
      <div role="status" className="sr-only">
        {listing && !loading ? t('session.folderPicker.count', { name: listing.name, n: listing.entries.length }) : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, padding: '0 4px' }}>
        <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: C.label2 }}>{t('session.folderPicker.target')}</span>
        <span data-folder-target="" title={target ?? undefined} onContextMenu={onCopyMenu(target, t('menu.copyPath'))} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT.mono, fontSize: 13, color: C.label2 }}>
          {target ?? '—'}
        </span>
      </div>
    </div>
  )
}
