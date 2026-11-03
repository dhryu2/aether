/* Aether Web Push 서비스워커 — push 수신 시 알림, 클릭 시 앱 포커스/해당 세션 이동. 권한 알림은 승인/거부 액션 버튼. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    /* 비-JSON 페이로드 무시 */
  }
  const title = data.title || 'Aether'
  event.waitUntil(
    (async () => {
      // 앱이 이미 포커스/표시 상태면 알림 생략(화면에 이미 보임 → 중복·방해 방지).
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (wins.some((c) => c.focused || c.visibilityState === 'visible')) return
      const opts = {
        body: data.body || '',
        tag: data.tag || 'aether',
        renotify: true,
        data,
        icon: '/icon-192.png',
        badge: '/favicon-32.png',
      }
      // 권한 요청 알림이면 앱을 열지 않고 바로 결정할 수 있는 액션 버튼을 단다.
      if (data.permissionId) {
        opts.actions = [
          { action: 'allow', title: '승인' },
          { action: 'deny', title: '거부' },
        ]
      }
      await self.registration.showNotification(title, opts)
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {}
  const action = event.action
  event.notification.close()
  event.waitUntil(
    (async () => {
      // 승인 REST는 executionId 우선, 없으면 sessionId.
      const executionId = data.executionId || data.sessionId
      // 화면 이동은 roomId 우선, 없으면 sessionId.
      const roomId = data.roomId || data.sessionId
      // 승인/거부 액션 → 앱을 열지 않고 백엔드에 결정 POST. 이미 처리됐으면 404(무시).
      if ((action === 'allow' || action === 'deny') && executionId && data.permissionId) {
        try {
          await fetch(`/api/sessions/${executionId}/permission`, {
            method: 'POST',
            credentials: 'same-origin', // 쿠키(password 모드) 자동 포함; whois/off 모드는 무관
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permissionId: data.permissionId, decision: action }),
          })
        } catch {
          /* 네트워크 실패 — 무시(앱에서 카드로 재처리 가능) */
        }
        return
      }
      // 그냥 클릭(본문 탭) → 앱 포커스 + 해당 방으로 이동.
      //   iOS PWA는 백그라운드에서 페이지를 폐기해도 창(client)은 남겨둬서 focus+postMessage 경로를 타는데,
      //   재생성된 페이지엔 postMessage가 유실된다(?s 없이 부팅 → 엉뚱한 세션). → Cache Storage에 pending
      //   딥링크를 먼저 기록해두고(페이지가 부팅/복귀 시 소비·삭제), postMessage는 살아있는 페이지용 빠른 경로로 유지.
      if (roomId) {
        try {
          const cache = await caches.open('aether-deeplink')
          await cache.put('/pending-session', new Response(JSON.stringify({ sessionId: roomId, ts: Date.now() })))
        } catch {
          /* Cache 실패 — postMessage/openWindow 경로만으로 동작 */
        }
      }
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of wins) {
        if ('focus' in c) {
          await c.focus()
          if (roomId) c.postMessage({ type: 'aether:open-session', sessionId: roomId })
          return
        }
      }
      // 열린 창이 없으면 새로 열기 — ?s=<id>로 시작해 해당 방을 활성화.
      if (self.clients.openWindow) {
        const url = roomId ? '/?s=' + encodeURIComponent(roomId) : '/'
        return self.clients.openWindow(url)
      }
    })(),
  )
})
