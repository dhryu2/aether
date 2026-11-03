// 작업 중 알림 — 모델이 일하는 도중에 하는 말.
//   최종 답변과 같은 글꼴·크기·색으로 전부 그린다(잘라내지 않는다 — 사용자 결정, checkLiveLine이 대조한다).
//   다른 것은 왼쪽 세로줄 하나다. 재설계 4단계에서 답이 상자 없는 글이 되면서, 예전의 "옅은 회색 바탕 + 점선 상자"
//   대신 가는 세로줄로 "이건 답이 아니라 진행 보고"임을 가른다. 세로줄은 음수 여백으로 왼쪽 틈에 나가 있어서
//   글이 시작하는 세로선이 답과 같다(index.css .work-note) — 알림이 답으로 바뀌어도 글자가 옆으로 안 튄다.
//
//   새 말이 오면 하나 더 쌓는 대신 이 자리에서 갈아끼운다. 갈아끼울 때만 애니메이션을 돌린다 —
//   위에서 살짝 내려오며 나타난다. 여러 줄이라 높이가 매번 달라지므로 나가는 말을 겹쳐 두지는 않는다
//   (겹쳐 놓으면 줄 수가 다를 때 글자끼리 포개진다). 애니메이션은 CSS에만 있다(index.css).
import { useState } from 'react'
import { Markdown } from '../Markdown'
import { C } from '../../design/tokens'

export function WorkNote({ text }: { text: string }) {
  // n은 애니메이션을 다시 돌리기 위한 리마운트 표식이다. 토큰이 흘러오며 앞말에 뒤가 붙는 중이면
  //   같은 말이 자라는 것이므로 갈아끼우지 않는다(매 토큰마다 애니메이션을 돌리면 글자가 계속 깜빡인다).
  const [shown, setShown] = useState({ text, n: 0 })
  if (shown.text !== text) setShown({ text, n: shown.n + (text.startsWith(shown.text) ? 0 : 1) })

  return (
    <div
      key={shown.n}
      className={'work-note self-stretch' + (shown.n > 0 ? ' work-note-in' : '')}
      style={{ lineHeight: 1.65, color: C.label }}
    >
      <Markdown size={15.5}>{shown.text}</Markdown>
    </div>
  )
}
