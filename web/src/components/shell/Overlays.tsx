// 앱 위에 떠서 화면을 덮는 것들을 한자리에 모아 놓은 곳.
//   가벼운 것은 스스로 열림 여부를 판단하므로 조건 없이 나열한다.
//   설정·넘기기·로그인·단축키 창은 코드가 커서 처음 열릴 때 받는다(React.lazy).
//   받는 동안은 아무것도 그리지 않는다. 받기에 실패하면 앱을 멈추지 않고 그 창만 닫고 알린다.
//   렌더 순서는 겹침에 영향을 주지 않는다 — 각자 tokens.ts의 Z.root 값으로 앞뒤가 정해진다.
//
// ⚠️ 여기에 오버레이를 추가하면 shell/useGlobalShortcuts.ts의 `overlayOpen`에도 같이 넣어야 한다.
//    그 목록이 "지금 뭔가 떠 있는지"를 판단해 전역 Esc가 손을 뗄지 정하기 때문이다.
import { lazy, Suspense, useEffect, type ComponentType } from 'react'
import { actions, useStore } from '../../lib/store'
import { reportClientError } from '../../lib/errorReporting'
import { t } from '../../lib/i18n'
import { BrainOverlay } from '../brain/BrainOverlay'
import { SearchPalette } from '../brain/SearchPalette'
import { FindBar } from '../FindBar'
import { NewSessionModal } from '../NewSessionModal'
import { DeleteConfirmModal } from '../DeleteConfirmModal'
import { ConfirmDialog } from '../ConfirmDialog'
import { UpdateProgress } from '../UpdateProgress'
import { RenameModal } from '../RenameModal'
import { ContextMenu } from './ContextMenu'
import { Toasts } from './Toasts'

/**
 * 받기 실패를 렌더 오류로 올리지 않는다. React.lazy는 실패를 기억하므로 다음에 열 때 새로 만들어 다시 받는다.
 * 서버 빌드가 바뀌어 옛 파일이 없어진 탭도 여기로 온다. 입력을 날리지 않게 새로고침은 사람이 고른다.
 */
function overlay(load: () => Promise<{ default: ComponentType }>, close: () => void): ComponentType {
  const make = () => lazy(() => load().catch((error: unknown) => {
    reportClientError(error, { operation: 'ui.overlay.load' })
    return {
      default: function LoadFailed() {
        useEffect(() => {
          current = make()
          close()
          actions.showNotice({ title: t('common.loadFailed'), action: { label: t('common.refresh'), onClick: () => location.reload() } })
        }, [])
        return null
      },
    }
  }))
  let current = make()
  return function Overlay() {
    const Current = current
    return <Suspense fallback={null}><Current /></Suspense>
  }
}

const SettingsModal = overlay(() => import('../SettingsModal').then((m) => ({ default: m.SettingsModal })), () => actions.closeSettings())
const ProviderAuthModal = overlay(() => import('../ProviderAuthModal').then((m) => ({ default: m.ProviderAuthModal })), () => actions.closeProviderAuth())
const ShortcutsHelp = overlay(() => import('../ShortcutsHelp').then((m) => ({ default: m.ShortcutsHelp })), () => actions.closeShortcuts())
const HandoffSheet = overlay(() => import('../HandoffSheet').then((m) => ({ default: m.HandoffSheet })), () => actions.closeHandoff())
const FileViewer = overlay(() => import('../FileViewer').then((m) => ({ default: m.FileViewer })), () => actions.closeFileViewer())

export function Overlays() {
  const s = useStore()
  return (
    <>
      <FindBar />
      <NewSessionModal />
      <DeleteConfirmModal />
      <RenameModal />
      <BrainOverlay />
      <SearchPalette />
      {s.handoffSheet && <HandoffSheet />}
      {s.fileViewer && <FileViewer />}
      {s.settingsOpen && <SettingsModal />}
      {s.providerAuth.open && <ProviderAuthModal />}
      {s.shortcutsOpen && <ShortcutsHelp />}
      <ConfirmDialog />
      <UpdateProgress />
      <ContextMenu />
      <Toasts />
    </>
  )
}
