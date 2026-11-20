import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { actions, useStore, showLoadMask } from './lib/store'
import { paneLayout, visibleCapacity, visibleSessionIds } from './lib/splitPane'
import { useBodyScrollLock, useExitAnim } from './lib/hooks'
import { useT } from './lib/i18n'
import { MS } from './design/tokens'
import { TopBar } from './components/TopBar'
import { topBarInset } from './components/topBarInset'
import { tabTitle } from './lib/activityInbox'
import { Sidebar } from './components/Sidebar'
import { PaneErrorBoundary } from './components/ErrorBoundary'
import {
  AuthGate,
  ConversationPane,
  LoadMask,
  MobileDrawer,
  NoActive,
  Overlays,
  useGlobalShortcuts,
} from './components/shell'

/** 확대/해제를 낭독기에 알린다. 처음 그릴 때는 말하지 않고 값이 바뀔 때만 말한다. */
function ZoomAnnouncer({ zoomed }: { zoomed: boolean }) {
  const t = useT()
  const [prev, setPrev] = useState(zoomed)
  const [note, setNote] = useState('')
  if (prev !== zoomed) {
    setPrev(zoomed)
    setNote(zoomed ? t('nav.split.zoomedNote') : t('nav.split.unzoomedNote'))
  }
  return <div className="sr-only" role="status" aria-live="polite">{note}</div>
}

/** 칸을 열고 옮긴 일을 낭독기에 알린다. 같은 글이 다시 와도 읽도록 seq가 홀수일 때 보이지 않는 글자를 덧붙인다. */
function PaneNoteAnnouncer() {
  const note = useStore().paneNote
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {note ? note.text + (note.seq % 2 ? '​' : '') : ''}
    </div>
  )
}

export default function App() {
  const s = useStore()
  const narrow = s.isNarrow
  const paneObs = useRef<ResizeObserver | null>(null)
  useGlobalShortcuts(s)
  const title = tabTitle(s.rooms, s.presenceLive)
  useEffect(() => { if (document.title !== title) document.title = title }, [title])
  // 칸 수는 대화 영역(목록 기둥을 뺀 폭·높이)으로 정한다. 창 크기만으로는 기둥이 빠지지 않는다.
  // 인증 게이트는 준비되기 전에 자식을 그리지 않는다. 빈 의존 효과는 그때 main이 없어 관찰이 끝나고
  // 다시 안 붙으므로, 요소가 실제로 붙을 때 등록한다.
  const attachPaneBox = useCallback((el: HTMLElement | null) => {
    paneObs.current?.disconnect()
    paneObs.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      actions.setPaneBox(Math.round(box.width), Math.round(box.height))
    })
    ro.observe(el)
    paneObs.current = ro
  }, [])
  useEffect(() => () => paneObs.current?.disconnect(), [])
  const paneIds = s.activeId ? visibleSessionIds(s.activeId, s.sideIds, visibleCapacity(s.isWide, s.paneW, s.paneH)) : []
  // 확대: 확대 칸이 보이는 칸이면 그 칸만 1칸 배치로 놓고, 나머지는 숨기기만 한다(언마운트하면 쓰던 글·스크롤이 사라진다).
  const zoomedId = s.zoomedId && paneIds.length >= 2 && paneIds.includes(s.zoomedId) ? s.zoomedId : null
  const layout = paneLayout(zoomedId ? 1 : Math.max(paneIds.length, 1), s.paneW)
  // 로드마스크는 걷히는 모습까지 보여준다 — 조건이 거짓이 되는 순간 지우면 흐림이 한 프레임에 사라진다.
  const mask = useExitAnim(showLoadMask(s), MS.out)
  // 드로어 열림 동안 뒤 콘텐츠 스크롤 잠금(배경 스트림이 따라 움직이지 않게)
  useBodyScrollLock(narrow && s.drawerOpen)

  return (
    <AuthGate>
      {/* .app-root — index.css가 VisualViewport 실측 높이에 맞춰 고정하는 바깥 틀(iOS 키보드 패닝 상쇄). */}
      <div className="app-root">
        {/* 드로어 열림 시 뒤 콘텐츠는 inert(포커스·터치 차단) */}
        <div className="relative z-10 flex h-full flex-col" inert={narrow && s.drawerOpen ? true : undefined}>
          {/* 재설계 A: 목록은 왼쪽에 뜬 기둥, 상단바는 대화 칸 위에 뜬 섬이다. 대화는 섬 밑까지 깔리고
              --bar-h만큼 위를 비워 첫 글이 섬에 가리지 않는다(index.css .session-pane 규칙). */}
          <div className="flex min-h-0 flex-1">
            {!narrow && <Sidebar />}
            <main
              ref={attachPaneBox}
              className="main-edge relative flex min-h-0 min-w-0 flex-1 flex-col"
              data-wide={s.isWide ? 'true' : 'false'}
              data-split={paneIds.length >= 2 ? '1' : '0'}
              // 칸이 나뉘면 상단바가 없으니 위를 비우지 않는다.
              style={{ '--bar-h': paneIds.length >= 2 ? '0px' : topBarInset(narrow) } as CSSProperties}
            >
              <TopBar />
              {paneIds.length > 0 ? (
                <div
                  className="pane-grid"
                  style={{ gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows }}
                >
                  {paneIds.map((id, i) => (
                    <PaneErrorBoundary
                      key={id}
                      place={zoomedId ? layout.places[0] : layout.places[i]}
                      hidden={!!zoomedId && id !== zoomedId}
                      onClose={paneIds.length >= 2 ? () => actions.closePane(id) : undefined}
                    >
                      <ConversationPane
                        sessionId={id}
                        index={i}
                        top={zoomedId ? true : (layout.places[i]?.top ?? false)}
                        place={zoomedId ? layout.places[0] : layout.places[i]}
                        zoomed={id === zoomedId}
                        hidden={!!zoomedId && id !== zoomedId}
                        showHead={paneIds.length >= 2}
                        onClose={() => actions.closePane(id)}
                      />
                    </PaneErrorBoundary>
                  ))}
                </div>
              ) : (
                <NoActive />
              )}
              {mask.mounted && <LoadMask reconnecting={!s.booting} closing={mask.closing} />}
            </main>
          </div>
        </div>

        {narrow && <MobileDrawer open={s.drawerOpen} />}
        <ZoomAnnouncer zoomed={!!zoomedId} />
        <PaneNoteAnnouncer />
        <Overlays />
      </div>
    </AuthGate>
  )
}
