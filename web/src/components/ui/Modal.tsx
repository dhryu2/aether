/**
 * 공통 창 틀 — 막(ModalShell) · 상자(ModalCard) · 유리 머리(ModalHeader) · 유리 발(ModalFooter).
 *
 * 역할·초점·가두기는 막이 아니라 창 상자에 둔다. 발은 이 바퀴에서 만들어 두고, 폼 창이 2·3바퀴에서 쓴다.
 * 초점 가두기와 복귀는 lib/focusTrap.ts. 열린 창을 쌓아 맨 위만 초점을 다룬다.
 */
import {
  Children,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { C, R, SH, alpha } from '../../design/tokens'
import { useBodyScrollLock, useEscape, useScrimClose } from '../../lib/hooks'
import { useFocusTrap } from '../../lib/focusTrap'
import { useStore } from '../../lib/store'
import { leaveGhost } from '../../lib/leaveGhost'
import { ModalFrameCtx, useModalFrame } from './useModalFrame'

type FocusRef = RefObject<HTMLButtonElement | null> | RefObject<HTMLInputElement | null>

function headerH(narrow: boolean): number {
  return narrow ? 56 : 52
}

function footerBlock(narrow: boolean): string {
  return narrow ? 'calc(64px + env(safe-area-inset-bottom))' : '64px'
}

export function ModalShell({ onClose, zIndex, children, initialFocusRef }: {
  onClose: () => void
  zIndex: number
  children: ReactNode
  /** 여는 순간 초점. 없으면 닫기 버튼. */
  initialFocusRef?: FocusRef
}) {
  const narrow = useStore().isNarrow
  const titleId = useId()
  const descId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useEscape(true, onClose)
  useBodyScrollLock(true)
  useFocusTrap(boxRef, () => initialFocusRef?.current ?? closeRef.current)
  const scrim = useScrimClose(onClose)
  const scrimRef = useRef<HTMLDivElement>(null)
  // 정리 함수는 이 막이 문서에서 빠지기 직전에 돈다 — 그 순간의 모습으로 잔상을 만든다.
  useLayoutEffect(() => {
    const node = scrimRef.current
    return () => {
      if (node) leaveGhost(node, 'modal-ghost')
    }
  }, [])
  return (
    <div
      ref={scrimRef}
      className="scrim-in modal-scrim"
      style={{ position: 'fixed', inset: 0, zIndex, background: alpha.ink(0.34) }}
      {...scrim}
    >
      <ModalFrameCtx.Provider value={{ titleId, descId, closeRef, boxRef, narrow }}>
        {children}
      </ModalFrameCtx.Provider>
    </div>
  )
}

function splitChildren(children: ReactNode) {
  const header: ReactNode[] = []
  const footer: ReactNode[] = []
  const body: ReactNode[] = []
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === ModalHeader) header.push(child)
    else if (isValidElement(child) && child.type === ModalFooter) footer.push(child)
    else body.push(child)
  })
  return { header, footer, body }
}

export function ModalCard({ variant, maxWidth = 420, split, children, style, ...rest }: {
  /** palette: 위쪽에 뜨는 검색 팝업. 폰은 전체 화면. 머리·발·본문 여백 없이 안쪽이 스크롤을 직접 맡는다. */
  variant: 'sheet' | 'alert' | 'palette'
  maxWidth?: number
  /** 컴퓨터에서 높이를 고정하고 본문 스크롤 칸을 두지 않는다. 본문이 칸마다 따로 스크롤한다(설정 창의 목록+본문 배치). */
  split?: boolean
  children: ReactNode
  style?: CSSProperties
} & Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'children'>) {
  const { titleId, descId, boxRef, narrow } = useModalFrame()
  const alert = variant === 'alert'
  const phoneSheet = variant === 'sheet' && narrow
  const palette = variant === 'palette'
  const phonePalette = palette && narrow
  const { header, footer, body } = splitChildren(children)
  const hasFooter = footer.length > 0
  const head = headerH(narrow)
  const foot = footerBlock(narrow)
  const fixed = !!split && !narrow
  // 폰 시트의 split(설정 창)은 높이를 최대로 고정해 목록↔칸 이동 때 내용 길이에 따라 높이가 튀지 않게 한다.
  const phoneSplit = !!split && phoneSheet
  return (
    <div
      {...rest}
      ref={boxRef}
      role={alert ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={alert ? descId : undefined}
      className={phoneSheet ? 'window-frame window-phone sheet-up' : palette ? (narrow ? 'window-frame window-palette window-palette-full window-in' : 'window-frame window-palette window-in') : 'window-frame window-in'}
      style={{
        ...style,
        width: alert ? 'min(360px, calc(100vw - 40px))' : '100%',
        maxWidth: alert || phoneSheet || phonePalette ? undefined : maxWidth,
        // 폰 시트는 아래 8px와 안전 영역까지 빼야 위끝이 안전 영역 + 56에 닿는다.
        maxHeight: phoneSheet
          ? 'calc(100dvh - env(safe-area-inset-top) - 56px - 8px - env(safe-area-inset-bottom))'
          : palette ? undefined : 'min(88vh, 760px)',
        height: palette ? (narrow ? 'var(--app-h, 100%)' : 'min(560px, 80vh)') : fixed ? 'min(600px, 88vh)' : phoneSplit ? 'calc(100dvh - env(safe-area-inset-top) - 56px - 8px - env(safe-area-inset-bottom))' : undefined,
        borderRadius: phonePalette ? 0 : R.modal,
        background: alert ? C.cellHi : C.bg,
        color: C.label,
        boxShadow: SH.modal,
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        className={fixed || palette ? undefined : 'scroll-area'}
        style={palette ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' } : fixed ? { display: 'flex', flex: 1, minHeight: 0, boxSizing: 'border-box', paddingTop: head } : {
          overflowY: 'auto',
          overflowX: 'hidden',
          maxHeight: 'inherit',
          flex: phoneSplit ? 1 : undefined,
          minHeight: 0,
          boxSizing: 'border-box',
          paddingTop: alert ? 22 : head,
          paddingBottom: alert ? 16 : hasFooter ? `var(--modal-foot, ${foot})` : 20,
          paddingLeft: alert ? 20 : narrow ? 16 : 20,
          paddingRight: alert ? 20 : narrow ? 16 : 20,
          scrollPaddingTop: alert ? undefined : head,
          scrollPaddingBottom: alert ? undefined : hasFooter ? `var(--modal-foot, ${foot})` : 64,
        }}
      >
        {body}
      </div>
      {header}
      {footer}
    </div>
  )
}

/**
 * 창 머리. `onBack`이 있으면 창 안의 하위 화면이다. 왼쪽에 뒤로를 두고 닫기는 그리지 않는다.
 * 뒤로와 닫기를 한 머리에 같이 두면 어느 쪽이 창을 닫는지 헷갈린다(HIG sheets › Best practices).
 */
export function ModalHeader({ title, onClose, closeLabel, onBack, backLabel }: {
  title: ReactNode
  onClose: () => void
  closeLabel: string
  onBack?: () => void
  backLabel?: string
}) {
  const { titleId, closeRef, narrow } = useModalFrame()
  const back = onBack != null
  const close = (
    <button
      ref={back ? undefined : closeRef}
      type="button"
      aria-label={back ? backLabel : closeLabel}
      data-modal-back={back ? '' : undefined}
      onClick={back ? onBack : onClose}
      className={narrow ? 'press hit-44' : 'press'}
      style={{
        width: 30,
        height: 30,
        borderRadius: R.full,
        border: 'none',
        background: C.fill,
        color: C.label,
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
        justifySelf: 'center',
        padding: 0,
      }}
    >
      {back ? <ChevronLeft size={18} style={{ marginLeft: -1 }} /> : <X size={16} />}
    </button>
  )
  return (
    <div
      className="window-bar"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1,
        height: headerH(narrow),
        display: 'grid',
        gridTemplateColumns: '48px minmax(0, 1fr) 48px',
        alignItems: 'center',
      }}
    >
      {narrow || back ? close : <span />}
      <h2
        id={titleId}
        style={{
          margin: 0,
          textAlign: 'center',
          fontSize: 17,
          fontWeight: 600,
          color: C.label,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {title}
      </h2>
      {narrow || back ? <span /> : close}
    </div>
  )
}

/** 유리 발. 컴퓨터는 오른쪽, 폰은 버튼이 가로를 다 쓴다. 내용이 64를 넘으면 발이 위로 자란다. */
export function ModalFooter({ children }: { children: ReactNode }) {
  const { narrow } = useModalFrame()
  const footRef = useRef<HTMLDivElement>(null)
  // 오류 한 줄이 발 안에 들어오면 높이가 64를 넘는다. 스크롤 여백이 그 높이를 따라가야 본문이 발에 가리지 않는다.
  useLayoutEffect(() => {
    const foot = footRef.current
    const box = foot?.parentElement ?? null
    if (!foot || !box) return
    const apply = () => box.style.setProperty('--modal-foot', `${foot.offsetHeight}px`)
    apply()
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    if (watch) watch.observe(foot)
    return () => {
      if (watch) watch.disconnect()
      box.style.removeProperty('--modal-foot')
    }
  }, [])
  return (
    <div
      ref={footRef}
      className={narrow ? 'window-bar window-footer-narrow' : 'window-bar'}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1,
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        alignItems: narrow ? 'stretch' : 'center',
        justifyContent: narrow ? 'center' : 'flex-end',
        gap: 8,
        boxSizing: 'border-box',
        minHeight: footerBlock(narrow),
        padding: narrow ? '0 16px env(safe-area-inset-bottom)' : '0 20px',
      }}
    >
      {children}
    </div>
  )
}
