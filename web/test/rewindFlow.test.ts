// 「여기서 다시 시작」: 확인창의 선택, 파일 복원 여부, 입력창 복원을 저장소 수준에서 본다.
import { api } from '../src/lib/api'
import { drafts } from '../src/lib/drafts'
import { actions, getState, __ingestForTest } from '../src/lib/store'

let pass = 0
let fail = 0
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++
  else {
    fail++
    console.log(`  ❌ ${name} — ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`)
  }
}

async function main() {
  const sid = 'rewind-flow-session'
  const events = [
    { seq: 1, ts: 1, kind: 'user_msg', text: 'A 검토해줘' },
    { seq: 2, ts: 2, kind: 'status', status: 'completed' },
  ] as unknown as Parameters<typeof __ingestForTest>[1][]
  for (const ev of events) __ingestForTest(sid, ev)
  const images = [{ media_type: 'image/png', data: 'AAAA' }]
  const sent: boolean[] = []
  api.rewind = async (_id, _seq, restoreFiles = false) => {
    sent.push(restoreFiles)
    return { restored: [], skipped: [], after: 0, until: 2, idleSeq: 3 }
  }

  // 복원할 파일이 있으면 두 선택을 묻고, 쓰던 글이 바뀐다고 알린다.
  api.rewindPreview = async () => ({ restore: ['a.ts'], skipped: [{ path: 'b.bin', reason: 'binary' }] })
  drafts.set(sid, 'typing')
  await actions.requestRewind(sid, 1, { text: 'A 검토해줘', images })
  const asked = getState().dialog
  eq('파일이 있으면 두 번째 선택이 있다', !!asked?.secondary, true)
  eq('안내에 파일과 쓰던 글이 나온다', ['a.ts', 'b.bin', '\n'].every((word) => asked?.message.includes(word)), true)
  actions.closeDialog()
  asked?.secondary?.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('대화와 파일을 고르면 파일 복원을 요청한다', sent, [true])
  eq('고른 말은 화면에서 사라진다', (getState().convos[sid] ?? []).some((item) => item.seq === 1), false)
  eq('글과 첨부가 입력창으로 돌아온다', [getState().composerFill?.text, getState().composerFill?.images], ['A 검토해줘', images])

  // 복원할 파일이 없으면 하나만 묻고 파일은 건드리지 않는다.
  api.rewindPreview = async () => ({ restore: [], skipped: [] })
  drafts.set(sid, '')
  await actions.requestRewind(sid, 1, { text: 'A 검토해줘' })
  const plain = getState().dialog
  eq('파일이 없으면 두 번째 선택이 없다', !!plain?.secondary, false)
  actions.closeDialog()
  plain?.onConfirm?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('파일이 없으면 파일 복원을 요청하지 않는다', sent, [true, false])

  console.log(`\n${fail === 0 ? '✅' : '❌'} rewindFlow: ${pass} PASS / ${fail} FAIL`)
  if (fail) process.exit(1)
}

void main()
