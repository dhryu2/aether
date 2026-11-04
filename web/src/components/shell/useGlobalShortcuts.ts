// 전역 키보드 단축키 — Mod+K(지난 대화 검색) · Mod+F(세션 안 찾기) · Mod+/(워크스페이스) · Mod+,(설정) · Esc(닫기/실행중 중단) · ?(도움말).
//   Cmd/Ctrl+N·Shift+N은 브라우저/OS 예약이라 미사용(억지 preventDefault는 적대적). 다른 오버레이 위엔 겹침 방지.
import { useEffect, useRef } from 'react'
import { actions, chromeRoomId, chromeSessionId, focusedTurn, type State } from '../../lib/store'
import { MOD } from '../../lib/format'

/**
 * 지금 화면 위에 떠 있는 것이 하나라도 있는가.
 *
 * 왜 이런 목록이 필요한가: 모달·대화상자·전체화면 패널은 저마다 Esc를 스스로 처리한다(useEscape·ModalShell).
 * 그래서 그중 하나라도 열려 있으면 아래 전역 처리기는 Esc에 손을 대면 안 된다. 손을 대면 Esc 한 번에
 * 창이 닫히면서 그 아래 "진행 중인 작업 중단" 가지까지 같이 실행돼 버린다.
 *
 * ⚠️ 새 오버레이를 만들면 여기 목록에 반드시 추가해야 한다. 손으로 세는 목록이라 빠뜨리기 쉽다.
 *    실제로 확인 대화상자(s.dialog)가 빠져 있어서, 대화상자만 띄운 채 Esc를 누르면 대화상자가 닫히는
 *    동시에 진행 중이던 턴까지 중단되는 버그가 있었다. 다만 이제 빠뜨릴 자리는 여기 하나뿐이다.
 */
function overlayOpen(s: State): boolean {
  return !!(
    s.brainOpen ||
    s.searchOpen ||
    s.settingsOpen ||
    s.modalOpen ||
    s.shortcutsOpen ||
    s.providerAuth.open ||
    s.deleteTarget ||
    s.handoffSheet ||
    s.dialog ||
    s.contextMenu || // Esc는 메뉴가 window 캡처 단계에서 먼저 삼킨다(ContextMenu.tsx). 여기는 칸 이동 같은 다른 단축키를 막기 위한 것.
    s.renameTarget ||
    s.updateProgress
  )
}

export function useGlobalShortcuts(s: State) {
  // 최신 상태를 ref에 담아 두고 키를 누른 순간에 읽는다(lib/hooks.ts의 useDismiss·useEscape와 같은 방식).
  //   이러면 리스너를 딱 한 번만 등록한다. 예전에는 상태 아홉 개를 의존성으로 나열해서,
  //   ① 응답이 흘러드는 동안 상태가 바뀔 때마다 리스너를 떼었다 붙였다 했고
  //   ② 새 오버레이를 만들 때 그 목록에 넣는 것을 잊으면 조용히 옛 값으로 판정했다(그래서 Esc 버그가 났다).
  //   이제 판정에 쓰는 필드는 위 overlayOpen 한 곳에만 적으면 된다.
  const sRef = useRef(s)
  sRef.current = s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = sRef.current
      const running = focusedTurn(s) === 'running'
      const mod = e.metaKey || e.ctrlKey
      // 검색·찾기는 맥에서 ⌘만 본다. 맥의 Ctrl+K·Ctrl+F는 입력칸의 편집 키라 가로채지 않는다.
      const modSearch = MOD === '⌘' ? e.metaKey : e.ctrlKey
      const el = e.target as HTMLElement | null
      const editable = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      // 확인 창·삭제 창이 맨 위에 있으면 검색·찾기·워크스페이스·설정 단축키는 아무것도 하지 않는다.
      const confirmOpen = !!(s.dialog || s.deleteTarget)
      if (modSearch && e.key.toLowerCase() === 'k') {
        // 검색 팝업이 이미 맨 위면 닫는 토글이다. 그 밖의 창이 떠 있으면 열지 않는다.
        if (confirmOpen || (overlayOpen(s) && !s.searchOpen)) return
        e.preventDefault()
        if (s.searchOpen) actions.closeSearch()
        else actions.openSearch()
      } else if (modSearch && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        // 다른 창이 떠 있거나 찾을 세션이 없으면 브라우저 기본 찾기에 맡긴다.
        if (overlayOpen(s) || !chromeSessionId(s)) return
        e.preventDefault()
        actions.toggleFind()
      } else if (mod && e.key === '/') {
        // 쌓기에 등록된 창(설정·새 작업·단축키·재인증·확인·삭제)이 하나라도 열려 있으면
        // Brain을 열지도 닫지도 않는다. Brain은 쌓기에 없으므로, 아무 창도 없을 때의 여닫기와
        // Brain만 열린 상태의 토글은 그대로다. Brain 위의 확인 창(s.dialog)도 여기 포함된다.
        if (confirmOpen || s.searchOpen || s.settingsOpen || s.modalOpen || s.shortcutsOpen || s.providerAuth.open) return
        e.preventDefault()
        if (s.brainOpen) actions.closeBrain()
        else actions.openBrain()
      } else if (mod && e.key === ',') {
        if (confirmOpen || s.modalOpen || s.brainOpen || s.searchOpen || s.shortcutsOpen || s.providerAuth.open) return
        e.preventDefault()
        if (s.settingsOpen) actions.closeSettings()
        else actions.openSettings()
      } else if (e.key === 'Escape') {
        if (s.findOpen) { actions.closeFind(); return }
        if (overlayOpen(s)) return // 각 모달이 자체 Esc 처리
        // 아무 창도 안 열렸고 턴 진행 중 → 중단(AI 챗 관례). 단 한 번에 멈추지 않는다 —
        //   첫 Esc는 멈춤 버튼을 "ESC" 글자로 바꿔 다음 한 번이 무엇을 할지 알리고, 그 사이에 눌러야 멈춘다.
        if (running) actions.armOrInterrupt()
      } else if (!mod && e.key === '?' && !editable) {
        if (s.brainOpen || s.searchOpen || s.settingsOpen || s.modalOpen || s.findOpen || s.providerAuth.open || s.deleteTarget) return
        e.preventDefault()
        if (s.shortcutsOpen) actions.closeShortcuts()
        else actions.openShortcuts()
      } else if (mod && !e.shiftKey && !e.altKey && /^[1-4]$/.test(e.key) && !editable) {
        // 입력칸에 글자를 치는 중에는 가로채지 않는다. 칸이 없으면 조용히 무시.
        if (overlayOpen(s) || s.findOpen) return
        e.preventDefault()
        actions.focusPaneAt(Number(e.key) - 1)
      } else if (mod && e.shiftKey && !e.altKey && e.key === 'Enter') {
        // 지금 칸 확대/해제. Esc는 응답 중단 전용이라 건드리지 않는다.
        if (overlayOpen(s) || s.findOpen) return
        const id = chromeRoomId(s)
        if (!id) return
        e.preventDefault()
        actions.toggleZoom(id)
      } else if (mod && !e.shiftKey && !e.altKey && e.key === '\\') {
        if (overlayOpen(s) || s.findOpen || s.isNarrow) return
        e.preventDefault()
        actions.toggleSidebarCollapsed()
      } else if (e.altKey && e.shiftKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // 지금 칸을 왼쪽·오른쪽으로 옮긴다. 입력칸에서는 글자 선택(단어 단위)과 겹치므로 가로채지 않는다.
        if (editable || overlayOpen(s) || s.findOpen) return
        const id = chromeRoomId(s)
        if (!id) return
        e.preventDefault()
        actions.movePane(id, e.key === 'ArrowLeft' ? -1 : 1)
      } else if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (editable || overlayOpen(s) || s.findOpen) return
        e.preventDefault()
        void actions.jumpUser(e.key === 'ArrowUp' ? -1 : 1)
      } else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'o') {
        // Claude Code와 같은 Ctrl+O (Cmd+O가 아님). 오버레이 위에서는 순환하지 않는다.
        if (overlayOpen(s)) return
        e.preventDefault()
        actions.cycleTranscriptView()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
