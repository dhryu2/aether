// 권한 카드의 거부·승인 버튼이 지금 화면에 보이는가 — 카드가 적고, 입력창 위 승인 줄이 읽는다.
//
// 왜 필요한가: 승인 줄은 "카드까지 스크롤하지 않고 여기서 누르라"고 있는 것이다. 그런데 카드 버튼이 이미
//   화면에 보이는데도 승인 줄이 떠서, 같은 거부·승인이 한 화면에 두 벌 보였다(디자인 감사 2026-09-25 F2).
//   폰에서는 그 줄이 입력창 위 약 50px을 더 먹었다.
//
// 전역 store에 넣지 않은 이유: 스크롤할 때마다 바뀌는 값이라, 넣으면 store를 읽는 화면 전부가 다시 그려진다.
//   여기서는 이 값을 읽는 곳(승인 줄)만 다시 그려진다.
import { useEffect, useSyncExternalStore, type RefObject } from 'react'

const visible = new Set<string>()
const listeners = new Set<() => void>()

function mark(id: string, on: boolean) {
  if (on === visible.has(id)) return
  if (on) visible.add(id)
  else visible.delete(id)
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 카드 쪽 — 버튼 줄(ref)이 화면에 대부분 보이는 동안 이 권한 id를 '보임'으로 적는다. */
export function useReportPermButtons(id: string, ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    // 대화 흐름은 스크롤 상자 안에 있다. 뷰포트 기준 관찰도 조상 상자가 잘라낸 부분은 안 보이는 것으로 친다.
    //   60%로 잡은 이유: 버튼 윗부분만 살짝 걸친 상태는 "보인다"고 하기 어렵다.
    //   입력창은 대화 위에 떠 있으므로(재설계 4단계) 그 높이(--composer-h)만큼 화면 아래를 빼고 잰다 — 입력창에 가린
    //   버튼을 "보인다"고 치면 승인 줄도 숨어서 누를 곳이 사라진다. 값은 관찰을 시작할 때 한 번 읽는다.
    const pane = el.closest('.session-pane')
    const composerH = pane ? parseFloat(getComputedStyle(pane).getPropertyValue('--composer-h')) || 0 : 0
    const io = new IntersectionObserver(([e]) => mark(id, e.isIntersecting), { threshold: 0.6, rootMargin: `0px 0px -${composerH}px 0px` })
    io.observe(el)
    return () => {
      io.disconnect()
      mark(id, false)
    }
  }, [id, ref, active])
}

/** 승인 줄 쪽 — 그 카드의 버튼이 지금 보이는가. */
export function usePermButtonsVisible(id: string): boolean {
  return useSyncExternalStore(subscribe, () => visible.has(id))
}
