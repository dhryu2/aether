// 모바일 서랍 — 뒤를 옅게 덮는 막과, 왼쪽에서 밀려 나오는 목록 기둥(재설계 A: 화면 가장자리에서 8px 띄운 유리 판).
//   좁은 화면(isNarrow)에서만 App이 렌더한다. 닫혀 있어도 DOM에는 남겨 두고 위치와 투명도만 바꾼다 —
//   그래야 열고 닫을 때 미끄러지는 애니메이션이 붙는다.
import { actions } from '../../lib/store'
import { useScrimClose } from '../../lib/hooks'
import { Sidebar } from '../Sidebar'
import { Z, alpha } from '../../design/tokens'

export function MobileDrawer({ open }: { open: boolean }) {
  const scrim = useScrimClose(() => actions.toggleDrawer(false))
  return (
    <>
      {/* 열고 닫는 시간은 index.css(.drawer-scrim·.drawer-panel)에 있다. 인라인으로 적으면 '움직임 줄이기'가 끄지 못한다. */}
      <div
        {...scrim}
        aria-hidden
        className="drawer-scrim"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: Z.root.drawerScrim,
          background: alpha.ink(0.22),
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      />
      <div
        className="drawer-panel"
        data-drawer-open={open ? '1' : '0'}
        style={{
          position: 'fixed',
          // 상태 표시줄·홈 막대 자리는 비운다(유리 판이 화면 끝에 붙지 않고 뜬다).
          left: 'max(8px, env(safe-area-inset-left))',
          top: 'calc(env(safe-area-inset-top) + 8px)',
          bottom: 'max(8px, env(safe-area-inset-bottom))',
          zIndex: Z.root.drawer,
          // 닫히면 판 폭에 왼쪽 여백까지 더 밀어 그림자 끝도 화면 밖으로 나가게 한다.
          transform: open ? 'translateX(0)' : 'translateX(calc(-100% - 24px))',
        }}
      >
        <Sidebar />
      </div>
    </>
  )
}
