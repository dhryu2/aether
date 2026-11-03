/**
 * 앱 껍데기 조각 모음 — 로드마스크·빈 화면·모바일 서랍·오버레이 묶음·전역 단축키.
 * App.tsx는 이것들을 배치만 하고, 각 조각의 실제 내용은 이 폴더 안에 있다.
 */
export { AuthGate } from './AuthGate'
export { LoadMask } from './LoadMask'
export { NoActive } from './NoActive'
export { Toasts } from './Toasts'
export { MobileDrawer } from './MobileDrawer'
export { Overlays } from './Overlays'
export { useGlobalShortcuts } from './useGlobalShortcuts'
export { ConversationPane } from './ConversationPane'
