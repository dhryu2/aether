/**
 * 브리프로 보낸 글은 보통 말풍선이다.
 * 잠든 세션도 깨우고, 임시 말에는 카드 표지를 달지 않는다.
 * 실행: tsx --tsconfig tsconfig.app.json test/briefSendBubble.test.ts
 */
import { api } from '../src/lib/api'
import { buildStreamSegments } from '../src/lib/streamSegments'
import { actions, getState, __ingestForTest } from '../src/lib/store'
import type { SessionListItem } from '../../shared/http'
import type { AetherEvent } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const t = (key: string) => key
const id = 'brief-bubble-ended'
const text = '화면 문구만 다듬어 주세요'
const ended: SessionListItem = {
  id,
  cwd: '/tmp/brief-bubble',
  displayName: '잠든 작업',
  provider: 'mock',
  model: 'mock',
  permissionMode: 'full',
  status: 'ended',
  createdAt: 1,
}

const steps: string[] = []
let sentBrief: boolean | undefined
api.listSessions = async () => ({ rooms: [], sessions: [ended] })
api.wakeSession = async (sessionId) => {
  steps.push(`wake:${sessionId}`)
  return { ok: true, alreadyAwake: false }
}
api.sendMessage = async (sessionId, bodyText, _images, _documents, _clientMessageId, brief) => {
  steps.push(`send:${sessionId}:${bodyText}`)
  sentBrief = brief
  return { ok: true }
}

function view() {
  return buildStreamSegments({
    items: getState().convos[id] ?? [],
    turn: 'idle',
    providerName: 'Mock',
    answers: {},
    t,
  }).segs
}

async function main() {
  await actions.refreshSessions()
  check('잠든 세션이 목록에 있다', getState().sessions.some((session) => session.id === id && session.status === 'ended'))
  const ok = await actions.sendTo(id, text, undefined, undefined, true)
  const local = (getState().convos[id] ?? []).find((item) => item.kind === 'local_user')
  check('전송이 성공한다', ok === true)
  check('잠든 세션을 먼저 깨운다', steps[0] === `wake:${id}` && steps[1] === `send:${id}:${text}`, steps)
  check('보내기 요청에 브리프 표지를 싣는다', sentBrief === true, sentBrief)
  check('임시 말에 카드 표지가 없다', !!local && local.kind === 'local_user' && !('briefSend' in local) && !('briefId' in local), local)
  check('임시 말은 보통 말풍선 하나다', view().map((seg) => seg.kind).join(',') === 'user', view().map((seg) => seg.kind))

  const clientMessageId = local && local.kind === 'local_user' ? local.clientMessageId : undefined
  const event: AetherEvent = { seq: 1, ts: 1, kind: 'user_msg', text, ...(clientMessageId ? { clientMessageId } : {}) }
  check('서버 사건에 브리프 번호가 없다', event.kind === 'user_msg' && event.briefId === undefined)
  __ingestForTest(id, event)
  const items = getState().convos[id] ?? []
  const segs = view()
  check('서버 글이 임시 말을 대체한다', items.length === 1 && items[0]?.kind === 'user_msg')
  check('서버 글도 보통 말풍선 하나다', segs.map((seg) => seg.kind).join(',') === 'user', segs.map((seg) => seg.kind))

  console.log(`\n${fail === 0 ? '✅' : '❌'} briefSendBubble: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
