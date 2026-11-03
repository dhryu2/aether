import { useEffect } from 'react'
import { Square } from 'lucide-react'
import { C, R, alpha } from '../../design/tokens'
import { actions, useStore } from '../../lib/store'
import { useT } from '../../lib/i18n'

// 진행 중인 턴 중단(Stop) — 입력창 알약 안, 전송 버튼 왼쪽의 회색 동그라미에 네모 아이콘(재설계 4단계, 시안 A).
//   글자("중단")는 빼고 이름은 aria-label·title로만 준다. 폰과 컴퓨터가 같은 모양이다.
//
// Esc로 멈출 때는 두 번 눌러야 한다. 첫 Esc가 오면 이 버튼이 네모 아이콘 대신 "ESC" 글자로 바뀌어,
// 다음 한 번이 무엇을 할지 화면이 먼저 말해 준다. 잠깐 사이에 안 누르면 아이콘으로 되돌아간다.
// (Esc는 습관적으로 누르는 키라 한 번에 멈추면 긴 작업이 실수로 날아간다. 판정 자체는 전역 단축키
//  한 곳에서만 한다 — shell/useGlobalShortcuts.ts. 여기서는 그 결과를 보여주기만 한다.)
//
// 버튼을 손으로 누르는 것은 한 번으로 끝난다. 누르려면 이미 버튼을 겨냥해야 해서 실수로 눌릴 일이 없다.
export function InterruptButton({ sessionId, size }: { sessionId: string; size: number }) {
  const t = useT()
  const armed = useStore().interruptArmed

  // 멈출 것이 사라지면(턴 종료·세션 전환으로 이 버튼이 내려가면) 무장도 함께 푼다.
  //   안 그러면 다음 턴이 시작될 때 "ESC" 글자가 붙은 채로 버튼이 나타난다.
  useEffect(() => () => actions.disarmInterrupt(), [])

  const label = armed ? t('composer.interrupt.armedAria') : t('composer.interrupt.aria')
  return (
    <button
      onClick={() => actions.interrupt(sessionId)}
      aria-label={label}
      title={label}
      // stop-in = 제자리에서 작게 시작해 커진다(index.css). 턴이 시작돼 이 버튼이 입력칸 자리를
      //   밀고 들어온 것이 눈에 보여야 입력칸이 갑자기 좁아진 이유를 알 수 있다.
      className="stop-in press hit-44 inline-flex items-center justify-center"
      style={{
        height: size,
        width: size,
        // 무장되면 회색이던 버튼을 꽉 채운 진한 빨강으로 바꾼다 — 다음 한 번이 진짜로 멈춘다는 것이
        //   곁눈질로도 보여야 한다. 은은한 강조로는 습관적으로 두 번째 Esc를 눌러 버린다.
        background: armed ? C.delFill : C.fill,
        boxShadow: armed ? `0 0 0 3px ${alpha.del(0.22)}` : 'none',
        color: armed ? C.onTint : C.label,
        borderRadius: R.full,
        flexShrink: 0,
      }}
    >
      {armed ? (
        // 버튼 폭이 아이콘 하나 크기라 글자를 작게 쓴다. 자간을 조금 벌리는 건 키캡처럼 읽히게 하려는 것 —
        //   이건 문구가 아니라 눌러야 할 키 이름이다. 굵게(800) 쓰는 이유도 같다 — 다음 행동을 알리는 경고다.
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>ESC</span>
      ) : (
        <Square size={13} fill="currentColor" strokeWidth={0} aria-hidden />
      )}
    </button>
  )
}
