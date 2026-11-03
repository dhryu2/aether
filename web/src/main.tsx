import { classifyTransportError } from './lib/api'
import { installErrorReporting, reportClientError } from './lib/errorReporting'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installAppViewportBinding } from './lib/appViewport.ts'

// 키보드가 실제로 열린 동안만 visualViewport를 사용한다. 알림/백그라운드 복귀 때 WebKit이
// 키보드 높이를 stale 상태로 남겨도 평상시 앱 높이는 CSS 100dvh로 복구된다.
installErrorReporting()
installAppViewportBinding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
)

// 서비스워커 등록(Web Push·PWA). secure context(https/localhost)에서만 동작 — http면 조용히 실패.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // 비보안 컨텍스트·미지원 거절은 정상 기능 탐지다. 그 밖의 등록 실패는 워커 없이 계속하는 기능 축소라 warning이다.
      const name = (error as { name?: string } | null)?.name
      if (name !== 'SecurityError' && name !== 'NotSupportedError') {
        reportClientError(classifyTransportError(error), { component: 'push', operation: 'web.service_worker.register', severity: 'warning' })
      }
      /* 기본 웹 화면은 계속 표시한다. */
    })
  })
}
