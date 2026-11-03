import { Component, type ReactNode } from 'react'
import { reportClientError } from '../lib/errorReporting'
import { STALE_RELOAD_KEY, shouldReloadStaleBuild } from '../lib/contractReload'

declare const __AETHER_SOURCE_HASH__: string | undefined

// 멈췄을 때 서버에 있는 빌드가 지금 실행 중인 빌드와 다르면 한 번만 자동으로 새로고침한다(옛 화면이 새 데이터를 못 읽은 경우).
async function reloadIfStale() {
  try {
    const running = typeof __AETHER_SOURCE_HASH__ === 'undefined' ? null : __AETHER_SOURCE_HASH__
    const res = await fetch('/build-info.json', { cache: 'no-store' })
    const info = res.ok ? await res.json() : null
    if (shouldReloadStaleBuild(info?.sourceHash, running, sessionStorage.getItem(STALE_RELOAD_KEY))) {
      sessionStorage.setItem(STALE_RELOAD_KEY, info.sourceHash)
      location.reload()
    }
  } catch { /* 확인하지 못하면 아래 버튼으로 사람이 다시 불러온다 */ }
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { reportClientError(error, { operation: 'ui.render' }); void reloadIfStale() }
  render() {
    return this.state.failed ? <div role="alert" style={{ padding: 24 }}>
      <p>화면을 표시하지 못했어요. 새로고침하면 복구를 시도해요.</p>
      <button onClick={() => location.reload()}>새로고침</button>
    </div> : this.props.children
  }
}

/**
 * 대화 칸 하나가 그리다 실패해도 세션 목록과 다른 칸은 살린다. 부모가 칸마다 key를 줘서 세션이 바뀌면 새로 만들어진다.
 * 격자 위치(place)와 숨김(hidden)을 그대로 받아 칸 자리를 지키고, 칸이 여럿일 때만 닫기를 보인다.
 */
export class PaneErrorBoundary extends Component<
  { children: ReactNode; place?: { column?: string | number; row?: string | number }; hidden?: boolean; onClose?: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { reportClientError(error, { operation: 'ui.render.pane' }); void reloadIfStale() }
  render() {
    if (!this.state.failed) return this.props.children
    const { place, hidden, onClose } = this.props
    const btn = { minHeight: 44, minWidth: 44, padding: '0 16px', marginRight: 8 }
    return <section role="alert" hidden={hidden} className="session-pane relative flex min-h-0 min-w-0 flex-col"
      style={{ gridColumn: place?.column, gridRow: place?.row, padding: 24 }}>
      <p>이 대화를 표시하지 못했어요.</p>
      <div>
        <button style={btn} onClick={() => this.setState({ failed: false })}>다시 시도</button>
        {onClose && <button style={btn} onClick={onClose}>이 패널 닫기</button>}
      </div>
    </section>
  }
}
