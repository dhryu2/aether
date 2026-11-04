// 워크스페이스 창(코드 이름 brain). 컴퓨터는 왼쪽 유리 기둥, 폰은 위 섬과 아래 탭 막대. 탭이 하나뿐이면 탭 막대는 없다.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKey, type RefObject } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import markUrl from '../../assets/aether-chamding-mark.png'
import { C, MS, R, SH, Z, alpha } from '../../design/tokens'
import { useEscape, useExitAnim, useScrimClose } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import type { BrainTab } from '../../lib/brain'
import { actions, useStore } from '../../lib/store'
import { IconButton } from '../ui'
import { BrainTabs } from './BrainTabs'
import { BRAIN_TABS } from './brainTabList'
import { BrainChrome } from './BrainChrome'
import { useBrainChrome } from './useBrainChrome'
import { HubView } from './HubView'
import { projectLabel } from './helpers'

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex="0"]'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute('disabled') || el.tabIndex < 0) return false
    if (getComputedStyle(el).visibility === 'hidden') return false
    return el.getClientRects().length > 0
  })
}

// 화면 밖에 있거나 크기가 0이면 초점을 두지 않는다. 닫힌 서랍 안의 버튼이 그렇다.
function isOnScreen(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
}

export function BrainOverlay() {
  const s = useStore()
  const anim = useExitAnim(s.brainOpen, MS.out)
  useEscape(s.brainOpen, actions.closeBrain)
  const openerRef = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  // 닫히는 즉시 열기 직전 초점으로 돌린다. 대상이 화면에 없으면 초점만 푼다.
  useEffect(() => {
    if (wasOpen.current && !s.brainOpen) {
      const opener = openerRef.current
      if (opener?.isConnected && isOnScreen(opener)) opener.focus()
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
    wasOpen.current = s.brainOpen
  }, [s.brainOpen])

  if (!anim.mounted) return null
  return (
    <BrainChrome>
      <BrainSheet openerRef={openerRef} open={s.brainOpen} closing={anim.closing} />
    </BrainChrome>
  )
}

function BrainSheet({ openerRef, open, closing }: { openerRef: RefObject<HTMLElement | null>; open: boolean; closing: boolean }) {
  const s = useStore()
  const t = useT()
  const { back } = useBrainChrome()
  const narrow = s.isNarrow
  const tab = s.brainTab
  const showTabs = BRAIN_TABS.length > 1
  const closeRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const scrim = useScrimClose(actions.closeBrain)
  const tabIndex = Math.max(0, BRAIN_TABS.findIndex((tb) => tb.id === tab))
  const [dir, setDir] = useState<'tab-in-r' | 'tab-in-l'>('tab-in-r')
  const [prevTab, setPrevTab] = useState(tabIndex)
  // 방향은 별도 상태에 남긴다. 비교값만 갱신하면 다시 그릴 때 오른쪽 들어오기로 덮인다.
  if (prevTab !== tabIndex) {
    setPrevTab(tabIndex)
    setDir(tabIndex >= prevTab ? 'tab-in-r' : 'tab-in-l')
  }

  // 열림이 참이 될 때마다 닫기 버튼으로 간다. 닫히는 중에 다시 열어도 다시 잡는다.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement
    if (opener instanceof HTMLElement && sheetRef.current && !sheetRef.current.contains(opener)) openerRef.current = opener
    const id = requestAnimationFrame(() => closeRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, openerRef])

  useEffect(() => { scrollerRef.current?.scrollTo({ top: 0 }) }, [tab])

  function onKeyDown(e: ReactKey<HTMLDivElement>) {
    if (e.key !== 'Tab' || !sheetRef.current) return
    const items = focusables(sheetRef.current)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !sheetRef.current.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const closeBtn = (
    <IconButton
      ref={closeRef}
      type="button"
      label={t('common.close')}
      size={32}
      color={C.label}
      lift={false}
      className="press icon-ghost hit-44"
      style={{ background: C.fill }}
      onClick={() => actions.closeBrain()}
    >
      <X size={16} />
    </IconButton>
  )
  const title = (
    <>
      <img src={markUrl} alt="" width={26} height={26} style={{ display: 'block', flexShrink: 0, borderRadius: 6 }} />
      <div id="brain-overlay-title" className="truncate" style={{ fontWeight: 600, color: C.label, fontSize: narrow ? 15 : 17, flex: narrow ? 1 : undefined, minWidth: 0 }}>
        {t('brain.header.title')}
      </div>
    </>
  )

  return (
    <div data-brain="" style={{ position: 'fixed', inset: 0, zIndex: Z.root.brain, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: closing ? 'none' : undefined }}>
      {/* 열고 닫는 움직임은 index.css(.brain-overlay·.brain-toast)에 있다. 인라인으로 적으면 '움직임 줄이기'가 끄지 못한다. */}
      <div className={closing ? 'brain-overlay is-closing' : 'brain-overlay'} style={{ position: 'absolute', inset: 0, background: alpha.ink(0.34), backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }} {...scrim} />
      <div
        ref={sheetRef}
        data-brain-sheet=""
        role="dialog"
        aria-modal="true"
        aria-labelledby="brain-overlay-title"
        className={['brain-toast', narrow && 'is-full', closing && 'is-closing'].filter(Boolean).join(' ')}
        inert={closing ? true : undefined}
        onKeyDown={onKeyDown}
        style={{
          position: 'relative', display: 'flex', flexDirection: narrow ? 'column' : 'row', overflow: 'hidden',
          width: narrow ? '100%' : 'min(1040px, 94vw)', height: narrow ? '100%' : 'min(88vh, 860px)',
          borderRadius: narrow ? 0 : R.modal, background: C.bg,
          border: narrow ? undefined : `0.5px solid ${C.sep}`,
          boxShadow: narrow ? undefined : SH.sheet,
        }}
      >
        {narrow ? (
          <div className="glass" style={{ position: 'absolute', left: 12, right: 12, top: 'calc(env(safe-area-inset-top) + 8px)', height: 44, borderRadius: R.full, zIndex: 5, display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 0 12px' }}>
            {title}
            {closeBtn}
          </div>
        ) : (
          <div className="glass" style={{ width: 216, margin: 8, borderRadius: 16, display: 'flex', flexDirection: 'column', flexShrink: 0, padding: '14px 10px 12px' }}>
            <div className="flex items-center" style={{ gap: 8, padding: '2px 8px 14px' }}>{title}</div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {showTabs && <BrainTabs orientation="vertical" value={tab} onChange={actions.setBrainTab} />}
            </div>
            <div style={{ padding: '12px 8px 2px' }}>
              <div style={{ fontSize: 12.5, color: C.label3 }}>{t('brain.env.label')}</div>
              <div className="truncate" style={{ fontSize: 13, color: C.label2, marginTop: 2 }}>{projectLabel(s, t)}</div>
            </div>
          </div>
        )}

        <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {!narrow && <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 4 }}>{closeBtn}</div>}
          <div className="brain-edge" style={narrow ? { top: 'calc(env(safe-area-inset-top) + 52px)' } : undefined} />
          <div
            ref={scrollerRef}
            className="scroll-area"
            style={{
              flex: 1, minHeight: 0, overflow: 'auto',
              paddingTop: narrow ? 'calc(env(safe-area-inset-top) + 68px)' : 28,
              paddingBottom: narrow ? (showTabs ? 'calc(84px + env(safe-area-inset-bottom))' : 'calc(16px + env(safe-area-inset-bottom))') : 32,
              paddingLeft: narrow ? 16 : 28,
              paddingRight: narrow ? 16 : 56,
            }}
          >
            <div style={{ maxWidth: narrow ? undefined : 720 }}>
              <PanelHead tab={tab} label={t(BRAIN_TABS.find((tb) => tb.id === tab)?.labelKey ?? 'brain.tabs.hub')} back={back} narrow={narrow} />
              <div key={tab} className={dir} {...(showTabs ? { id: 'brain-tabpanel', role: 'tabpanel', 'aria-labelledby': `brain-tab-${tab}` } : {})}>
                <HubView />
              </div>
            </div>
          </div>
        </div>

        {narrow && showTabs && (
          <div className="glass brain-tabbar" data-brain-tabbar="" style={{ position: 'absolute', left: 12, right: 12, bottom: 'calc(8px + env(safe-area-inset-bottom))', height: 60, borderRadius: R.full, zIndex: 5, display: 'flex', padding: '0 6px' }}>
            <BrainTabs orientation="horizontal" value={tab} onChange={actions.setBrainTab} />
          </div>
        )}
      </div>
    </div>
  )
}

function PanelHead({ tab, label, back, narrow }: { tab: BrainTab; label: string; back: { label: string; onBack: () => void } | null; narrow: boolean }) {
  if (back) {
    return (
      <button type="button" className="press hit-44" onClick={back.onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, height: 44, marginBottom: 8, padding: 0, border: 'none', background: 'transparent', color: C.tint, fontSize: 17, fontWeight: 600, cursor: 'pointer' }}>
        <ChevronLeft size={18} />
        {back.label}
      </button>
    )
  }
  if (tab === 'hub') return null
  return <h1 style={{ margin: '0 0 16px', fontSize: narrow ? 28 : 26, fontWeight: 700, letterSpacing: '-0.02em', color: C.label }}>{label}</h1>
}
