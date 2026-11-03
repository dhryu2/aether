/** 데스크톱 껍데기 감지·알림. @tauri-apps 패키지 import 없음 — window.__TAURI__만. */
import { createClientErrorReporter } from './errors'

// 알림 없이 본 화면을 계속하는 기능 축소다. 연속 실패는 첫 건만 warning으로 남긴다.
const notifyFailure = createClientErrorReporter({ component: 'desktop', operation: 'web.desktop_notify.show', severity: 'warning' })

type TauriCore = { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
type TauriGlobal = { core?: TauriCore }
type ShellWindow = { __TAURI__?: TauriGlobal }

function shellWindow(): ShellWindow | undefined {
  const g = globalThis as { window?: ShellWindow }
  return g.window
}

function tauri(): TauriGlobal | undefined {
  const w = shellWindow()
  if (!w || !('__TAURI__' in w)) return undefined
  return w.__TAURI__
}

export function isDesktopShell(): boolean {
  const w = shellWindow()
  return !!w && '__TAURI__' in w
}

/** 제목·본문만. sessionId/url 칸 없음. invoke 없으면 no-op. */
export function showDesktopNotification(opts: { title: string; body: string }): void {
  const invoke = tauri()?.core?.invoke
  if (typeof invoke !== 'function') return
  void invoke('show_desktop_notification', { title: opts.title, body: opts.body }).then(() => notifyFailure.reset(), (error: unknown) => {
    notifyFailure.report(error)
    /* 껍데기 알림 실패는 UI에 무해 */
  })
}
