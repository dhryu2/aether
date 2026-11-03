// 턴 끝 "남은 항목" 카드 — 에이전트가 이번 턴에 만든·고친 목록에 아직 안 끝난 항목이 있을 때만.
//   버튼도 판정도 없다. 남은 항목과 상태 글자만 보여 준다(칸 머리 칩의 "n개 남음"과 같은 목록).
import { ListTodo } from 'lucide-react'
import { sessionTurn, useStore } from '../../lib/store'
import { todoCounts } from '../../lib/agentEvents'
import { useT } from '../../lib/i18n'
import { todoViewOf } from '../../lib/todoView'
import { TodoRow } from '../TodoChip'
import { C } from '../../design/tokens'

export function TodoLeftover({ sessionId }: { sessionId: string }) {
  const s = useStore()
  const t = useT()
  const view = todoViewOf(s, sessionId)
  // 턴이 도는 중·응답을 기다리는 중·명령 실행 중에는 아직 끝난 게 아니다.
  if (!view || !view.inLatestTurn || sessionTurn(s, sessionId) !== 'idle') return null
  const { left } = todoCounts(view.items)
  if (left === 0) return null
  const open = view.items.filter((i) => i.status !== 'completed')
  const title = t('stream.todo.leftover', { n: left })
  return (
    <div
      role="group"
      aria-label={title}
      data-todo-leftover={left}
      className="msg-in flex flex-col self-start"
      style={{ gap: 8, maxWidth: '88%', padding: '10px 12px', background: C.fill, border: `0.5px solid ${C.sep}`, borderRadius: 12 }}
    >
      <div className="flex items-center" style={{ gap: 6, fontSize: 13, fontWeight: 600, color: C.label }}>
        <ListTodo size={14} aria-hidden style={{ color: C.label2 }} />
        {title}
      </div>
      {open.map((item, i) => <TodoRow key={i} item={item} />)}
    </div>
  )
}
