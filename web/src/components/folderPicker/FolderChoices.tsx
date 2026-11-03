// 새 작업 창의 작업 폴더 묶음. 최근 폴더 몇 개를 바로 고르게 하고, 나머지는 탐색 화면으로 보낸다.
// 대부분은 늘 쓰던 폴더에서 시작하므로, 깊이 탐색하는 트리보다 한 번 누르는 목록이 빠르다.
import { useRef, type KeyboardEvent, type RefObject } from 'react'
import { Check, ChevronRight, Download, FileText, Folder, FolderOpen, HardDrive, House, Monitor } from 'lucide-react'
import { C } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { Group } from '../settings/parts'
import { useNarrow } from '../settings/settingsLayout'
import { folderRowStyle } from './rowStyle'
import { folderName } from '../../lib/sessionGroups'
import { parentPath, tildeHome } from './explorerModel'
import { MenuItem } from '../WorkMenu'
import { copyItem, menuOf, onContextMenuFor } from '../contextMenuFor'

/** 위치 종류별 그림. 폴더가 아니라 위치라서 폴더 그림과 모양·색이 다르다. */
const PLACE_ICON = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  drive: HardDrive,
  root: HardDrive,
  volume: HardDrive,
} as const
export type PlaceKind = keyof typeof PLACE_ICON

/**
 * 폴더 그림. 파인더처럼 파랑 선에 옅은 파랑을 채운다. 이 창에서 폴더를 뜻하는 유일한 색이다.
 * 위치(홈, 데스크탑, 드라이브 등)는 모양이 다른 회색 그림이라 폴더와 한눈에 구분된다.
 */
export function FolderGlyph({ open, place, size = 20 }: { open?: boolean; place?: PlaceKind; size?: number }) {
  if (place) {
    const PlaceIcon = PLACE_ICON[place]
    return (
      <span aria-hidden style={{ color: C.label2, display: 'inline-flex', flexShrink: 0 }}>
        <PlaceIcon size={size} strokeWidth={1.75} />
      </span>
    )
  }
  const Icon = open ? FolderOpen : Folder
  return (
    <span aria-hidden style={{ color: C.tint, display: 'inline-flex', flexShrink: 0 }}>
      <Icon size={size} strokeWidth={1.75} fill={open ? 'none' : 'currentColor'} fillOpacity={0.16} />
    </span>
  )
}

/** 글이 시작하는 자리(여백 16 + 그림 20 + 간격 12)부터 긋는 구분선. */
export function FolderSep() {
  return <div aria-hidden style={{ height: 1, marginLeft: 48, background: C.sepSoft }} />
}

/** 폴더 이름과, 있으면 그 위 경로를 한 줄에. 위 경로는 흐리게 두고 먼저 줄어든다. */
export function FolderLabel({ name, parent, strong, dim }: { name: string; parent?: string; strong?: boolean; dim?: boolean }) {
  return (
    <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ flexShrink: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15, fontWeight: strong ? 600 : 400, color: dim ? C.label2 : C.label }}>
        {name}
      </span>
      {parent && (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: C.label3 }}>
          {parent}
        </span>
      )}
    </span>
  )
}

export function FolderChoices({
  home,
  rows,
  picked,
  ready,
  failed,
  disabled,
  onPick,
  onBrowse,
  onRetry,
  pickedRef,
}: {
  /** 서버 컴퓨터의 홈 경로. 흐린 상위 경로를 `~`로 줄이는 데 쓴다. */
  home: string
  /** 보여 줄 폴더(절대 경로). */
  rows: string[]
  picked: string
  ready: boolean
  failed: boolean
  disabled: boolean
  onPick: (path: string) => void
  /** 없으면 「다른 폴더 찾기」 줄을 그리지 않는다(최근 폴더만 고르는 자리). */
  onBrowse?: () => void
  onRetry: () => void
  /** 고른 줄. 탐색 화면에서 돌아올 때 초점을 여기로 돌려준다. */
  pickedRef?: RefObject<HTMLButtonElement | null>
}) {
  const t = useT()
  const narrow = useNarrow()
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  // 라디오 묶음이다. 고른 줄만 Tab에 두고, 방향키는 초점과 선택을 함께 옮긴다.
  function onKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || rows.length === 0) return
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
    if (!forward && !back) return
    e.preventDefault()
    const path = rows[(index + (forward ? 1 : -1) + rows.length) % rows.length]
    if (path == null) return
    onPick(path)
    rowRefs.current.get(path)?.focus()
  }

  return (
    <Group>
      {!ready && !failed && (
        <div aria-hidden style={{ ...folderRowStyle(narrow), cursor: 'default' }}>
          <FolderGlyph />
          <span style={{ display: 'block', height: 10, width: '38%', borderRadius: 5, background: C.cell2 }} />
        </div>
      )}
      {failed && (
        <div style={{ ...folderRowStyle(narrow), cursor: 'default' }}>
          <span style={{ flex: 1, fontSize: 13, color: C.del, lineHeight: 1.45 }}>{t('session.folderPicker.error')}</span>
          <button
            type="button"
            className={narrow ? 'hit-44' : undefined}
            onClick={onRetry}
            style={{ flexShrink: 0, minHeight: 28, padding: 0, border: 'none', background: 'transparent', color: C.tint, font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {t('session.folderPicker.retry')}
          </button>
        </div>
      )}
      {ready && (
        <div role="radiogroup" aria-label={t('session.folderPicker.tree')} data-folder-choices="">
          {rows.map((path, i) => {
            const on = path === picked
            const isHome = path === home
            const name = isHome ? t('session.folderPicker.home') : folderName(path)
            const parent = !isHome && parentPath(path) !== path ? tildeHome(parentPath(path), home) : undefined
            return (
              <div key={path}>
                {i > 0 && <FolderSep />}
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on || (!rows.includes(picked) && i === 0) ? 0 : -1}
                  disabled={disabled}
                  data-folder-rel={path}
                  ref={(el) => {
                    if (el) rowRefs.current.set(path, el)
                    else rowRefs.current.delete(path)
                    if (on && pickedRef) pickedRef.current = el
                  }}
                  onClick={() => onPick(path)}
                  onContextMenu={onContextMenuFor(() => menuOf(
                    <MenuItem onClick={() => onPick(path)}>{t('session.folderPicker.choose')}</MenuItem>,
                    copyItem(path, t('menu.copyPath')),
                  ))}
                  onKeyDown={(e) => onKey(e, i)}
                  className="press"
                  style={folderRowStyle(narrow, disabled)}
                >
                  <FolderGlyph />
                  <FolderLabel name={name} parent={parent} />
                  {on && (
                    <span aria-hidden className="choice-check" style={{ color: C.tint, display: 'inline-flex', flexShrink: 0 }}>
                      <Check size={17} strokeWidth={2.25} />
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
      {onBrowse && (ready || failed) && rows.length > 0 && <FolderSep />}
      {onBrowse && <button
        type="button"
        disabled={disabled || failed}
        data-folder-browse=""
        onClick={onBrowse}
        className="press"
        style={folderRowStyle(narrow, disabled || failed)}
      >
        <FolderGlyph open />
        <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: failed ? C.label3 : C.tint }}>{t('session.folderPicker.other')}</span>
        <span aria-hidden style={{ color: C.label3, display: 'inline-flex', flexShrink: 0 }}>
          <ChevronRight size={17} />
        </span>
      </button>}
    </Group>
  )
}
