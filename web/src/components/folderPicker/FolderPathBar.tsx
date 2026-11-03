// 폴더 탐색기 위 도구 줄의 왼쪽: 뒤로·위로 버튼, 경로 막대(서버가 쪼갠 구간), 경로 직접 입력.
// 경로 막대의 각 구간을 누르면 그 폴더로 간다. 경로 직접 입력을 열면 막대 자리에 입력칸이 들어선다.
import { Fragment, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { C, FONT, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'

function ToolButton({ label, disabled, onClick, narrow, children, pressed, nav }: { label: string; disabled?: boolean; onClick: () => void; narrow: boolean; children: ReactNode; pressed?: boolean; nav: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={narrow ? 'press hit-44' : 'press crumb-btn'}
      style={{
        flexShrink: 0,
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: R.chip,
        background: 'transparent',
        color: C.label2,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      aria-pressed={pressed}
      data-folder-nav={nav}
    >
      {children}
    </button>
  )
}

export function FolderPathBar({
  crumbs,
  narrow,
  onPlaces,
  canBack,
  canUp,
  onBack,
  onUp,
  onCrumb,
  inputOpen,
  onToggleInput,
  pathText,
  onPathText,
  onSubmit,
  onCloseInput,
  pathError,
  inputRef,
}: {
  /** 루트부터 지금 폴더까지. "위치" 화면이면 빈 배열이다. */
  crumbs: { name: string; path: string }[]
  narrow: boolean
  /** 폰에서 "위치" 화면으로 돌아가는 동작. 넓은 화면은 undefined다(사이드바가 늘 보인다). */
  onPlaces?: () => void
  canBack: boolean
  canUp: boolean
  onBack: () => void
  onUp: () => void
  onCrumb: (path: string) => void
  inputOpen: boolean
  onToggleInput: () => void
  pathText: string
  onPathText: (v: string) => void
  onSubmit: () => void
  onCloseInput: () => void
  pathError: string | null
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const t = useT()
  const navRef = useRef<HTMLElement>(null)
  const tail = crumbs[crumbs.length - 1]?.path

  // 경로가 길면 지금 위치(맨 끝)가 보이게 막대를 끝까지 민다.
  useLayoutEffect(() => {
    const nav = navRef.current
    if (nav) nav.scrollLeft = nav.scrollWidth
  }, [tail, inputOpen])

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSubmit()
    } else if (e.key === 'Escape') {
      // 창의 Esc(새 작업으로 돌아가기)까지 올라가지 않게 입력만 닫는다.
      e.stopPropagation()
      onCloseInput()
    }
  }

  const crumbBtn = (key: string, name: string, onClick: () => void, current: boolean) =>
    current ? (
      <span key={key} aria-current="location" style={{ flexShrink: 0, padding: '0 6px', fontSize: 15, fontWeight: 600, color: C.label }}>
        {name}
      </span>
    ) : (
      <button
        key={key}
        type="button"
        data-folder-crumb={key}
        className={narrow ? 'press hit-44' : 'press crumb-btn'}
        onClick={onClick}
        style={{ flexShrink: 0, height: 28, padding: '0 6px', border: 'none', borderRadius: 8, background: 'transparent', color: C.tint, font: 'inherit', fontSize: 15, cursor: 'pointer' }}
      >
        {name}
      </button>
    )
  const chevron = (key: string) => (
    <span key={key} aria-hidden style={{ color: C.label3, display: 'inline-flex', flexShrink: 0 }}>
      <ChevronRight size={14} />
    </span>
  )

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: narrow ? 8 : 4, minWidth: 0 }}>
        <ToolButton label={t('session.folderPicker.navBack')} disabled={!canBack} onClick={onBack} narrow={narrow} nav="back">
          <ChevronLeft size={18} />
        </ToolButton>
        <ToolButton label={t('session.folderPicker.up')} disabled={!canUp} onClick={onUp} narrow={narrow} nav="up">
          <ArrowUp size={18} />
        </ToolButton>
        {inputOpen ? (
          <input
            ref={inputRef}
            value={pathText}
            onChange={(e) => onPathText(e.target.value)}
            onKeyDown={onInputKey}
            aria-label={t('session.folderPicker.typePath')}
            aria-invalid={pathError ? true : undefined}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-folder-path-input=""
            style={{ flex: 1, minWidth: 0, height: 32, padding: '0 10px', border: 'none', borderRadius: R.chip, background: C.fill, color: C.label, fontFamily: FONT.mono, fontSize: 13 }}
          />
        ) : (
          <nav
            ref={navRef}
            aria-label={t('session.folderPicker.path')}
            data-folder-crumbs=""
            className="no-scrollbar"
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, minHeight: 32, padding: '0 6px', overflowX: 'auto', whiteSpace: 'nowrap' }}
          >
            {onPlaces && (
              <Fragment>
                {crumbBtn('places', t('session.folderPicker.root'), onPlaces, crumbs.length === 0)}
                {crumbs.length > 0 && chevron('places-sep')}
              </Fragment>
            )}
            {crumbs.map((c, i) => (
              <Fragment key={c.path}>
                {i > 0 && chevron(`${c.path}-sep`)}
                {crumbBtn(c.path, c.name, () => onCrumb(c.path), i === crumbs.length - 1)}
              </Fragment>
            ))}
          </nav>
        )}
        <ToolButton label={t('session.folderPicker.typePath')} onClick={onToggleInput} narrow={narrow} pressed={inputOpen} nav="type">
          <Pencil size={16} />
        </ToolButton>
      </div>
      {inputOpen && pathError && (
        <p role="status" style={{ margin: '6px 0 0', padding: '0 4px', fontSize: 13, lineHeight: 1.45, color: C.del }}>
          {pathError}
        </p>
      )}
    </div>
  )
}
