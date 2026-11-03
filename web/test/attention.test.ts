/**
 * 세션 주의 칸 병합·손길 칩 판정.
 *   실행: npx tsx web/test/attention.test.ts
 */
import {
  cardPreviewLine,
  cardUsesAttentionDot,
  handRooms,
  handSessions,
  isLongWait,
  waitAge,
  mergePresenceSnapshot,
  mergePresenceUpdate,
  mergeRoomPresenceSnapshot,
  mergeRoomPresenceUpdate,
  parseLegacyPresenceSnapshot,
  parsePresenceSession,
  parsePresenceSnapshot,
} from '../src/lib/attention'
import type { SessionListItem, WorkspaceRoom } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function sess(partial: Partial<SessionListItem> & { id: string }): SessionListItem {
  return {
    cwd: '/x',
    displayName: partial.id,
    provider: 'claude',
    model: '',
    permissionMode: 'manual',
    status: 'active',
    createdAt: 0,
    ...partial,
  }
}

check('옛 sessions만 있으면 새 파서가 거부(null)', parsePresenceSnapshot({ sessions: [] }) === null)
check('channels가 배열이 아니면 거부', parsePresenceSnapshot({ channels: {} }) === null)
check('옛 파서는 sessions 배열을 읽는다', parseLegacyPresenceSnapshot({ sessions: [{ id: 'a', attention: 'idle', status: 'active' }] })?.sessions.length === 1)
check('세션 id 없는 행은 스킵', parsePresenceSession({ attention: 'waiting', status: 'active' }) === null)
check(
  'attention 값이 이상하면 거부',
  parsePresenceSession({ id: 'a', attention: 'busy', status: 'active' }) === null,
)

const parsed = parsePresenceSession({
  id: 'a',
  attention: 'waiting',
  attentionKind: 'question',
  attentionPreview: '질문에 답해 주세요',
  status: 'active',
  lastActivityAt: 10,
})
check('정상 행을 읽는다', parsed?.id === 'a' && parsed.attention === 'waiting' && parsed.attentionKind === 'question')

const items = [
  sess({ id: 'w', attention: 'waiting', attentionPreview: '권한을 확인해 주세요', lastActivityAt: 1 }),
  sess({ id: 'r', attention: 'running', lastActivityAt: 9 }),
  sess({ id: 'd', attention: 'done', attentionPreview: '작업이 끝났습니다', lastActivityAt: 5 }),
  sess({ id: 'f', attention: 'failed', attentionPreview: '세션이 비정상 종료됐습니다', lastActivityAt: 8 }),
  sess({ id: 'i', attention: 'idle', lastActivityAt: 3 }),
]

const hands = handSessions(items)
check(
  '손길은 대기·실패·끝남만, 그 순서',
  hands.map((s) => s.id).join(',') === 'w,f,d',
  hands.map((s) => s.id),
)

const patched = mergePresenceUpdate(items, {
  id: 'i',
  attention: 'waiting',
  attentionKind: 'permission',
  attentionPreview: '명령을 허용할까요?',
  status: 'active',
  lastActivityAt: 99,
})
check('모르는 id는 목록을 안 늘린다', mergePresenceUpdate(items, { id: 'ghost', attention: 'done', status: 'ended' }) === items)
check('갱신이 쉼을 대기로 바꾼다', patched.find((s) => s.id === 'i')?.attention === 'waiting')
check('갱신이 미리보기를 덮는다', patched.find((s) => s.id === 'i')?.attentionPreview === '명령을 허용할까요?')

const snap = mergePresenceSnapshot(items, [
  { id: 'r', attention: 'done', status: 'active', attentionPreview: '방금 끝났습니다' },
])
check('스냅샷은 있는 세션만 덮는다', snap.find((s) => s.id === 'r')?.attention === 'done' && snap.length === items.length)

check('손상 카드는 수명 점', cardUsesAttentionDot(sess({ id: 'c', status: 'corrupted', attention: 'failed' })) === false)
check('주의 칸 없으면 수명 점', cardUsesAttentionDot(sess({ id: 'old' })) === false)
check('주의 칸 있으면 주의 점', cardUsesAttentionDot(sess({ id: 'n', attention: 'idle' })) === true)

check(
  '대기 카드는 알림 한 줄을 쓴다',
  cardPreviewLine(sess({ id: 'w', attention: 'waiting', attentionPreview: '질문', preview: '옛글' }), '라이브') === '질문',
)
check(
  '쉼 카드는 대화 미리보기',
  cardPreviewLine(sess({ id: 'i', attention: 'idle', preview: '마지막 말' }), '') === '마지막 말',
)

// ── 뒤 작업 ──
{
  const p = parsePresenceSession({
    id: 'bg1',
    attention: 'background',
    status: 'active',
    backgroundTasks: [
      { id: 't1', kind: 'agent', description: '조사' },
      { id: 't2', kind: 'weird', description: 'x' },
      { id: 3, kind: 'agent', description: 'x' },
      { id: 't4', kind: 'command' },
      'junk',
    ],
    backgroundCanStop: true,
  })
  check('background 값을 읽는다', p?.attention === 'background')
  check('잘못된 작업 항목만 거른다', p?.backgroundTasks?.length === 1 && p.backgroundTasks[0].id === 't1', p?.backgroundTasks)
  check('backgroundCanStop을 읽는다', p?.backgroundCanStop === true)
  const bad = parsePresenceSession({ id: 'bg2', attention: 'background', status: 'active', backgroundTasks: 'nope', backgroundCanStop: 'yes' })
  check('작업 칸이 배열이 아니면 그 칸만 버리고 갱신은 산다', bad?.attention === 'background' && bad.backgroundTasks === undefined && bad.backgroundCanStop === undefined)
  const merged = mergePresenceUpdate([sess({ id: 'bg1', attention: 'running' })], p!)
  check('갱신이 작업 목록을 덧입힌다', merged[0].backgroundTasks?.length === 1 && merged[0].backgroundCanStop === true)
  check('background는 손길 칩에 안 세진다', handSessions([sess({ id: 'bg1', attention: 'background' })]).length === 0)
}

// ── 대기 시작 시각: 파싱·정렬·표기 ──
check('attentionSince를 읽는다', parsePresenceSession({ id: 'a', attention: 'waiting', status: 'active', attentionSince: 123 })?.attentionSince === 123)
{
  const w = (id: string, since: number | undefined, act: number): WorkspaceRoom => ({
    id, kind: 'dm', title: id, status: 'active', attention: 'waiting', attentionSince: since, lastActivityAt: act,
  })
  const order = handRooms([w('new', 300, 9), w('old', 100, 1), w('nosince', undefined, 5)]).map((r) => r.id).join(',')
  check('대기끼리는 오래 기다린 순', order.indexOf('old') < order.indexOf('new'), order)
  const sorted = handSessions([sess({ id: 'x', attention: 'waiting', attentionSince: 50, lastActivityAt: 9 }), sess({ id: 'y', attention: 'waiting', attentionSince: 10, lastActivityAt: 1 })])
  check('세션 목록도 같은 규칙', sorted.map((r) => r.id).join(',') === 'y,x', sorted.map((r) => r.id))
}
{
  const now = 10_000_000
  check('1분 미만 방금', waitAge(now - 30_000, now).unit === 'now')
  check('12분째', JSON.stringify(waitAge(now - 12 * 60_000, now)) === JSON.stringify({ unit: 'minutes', n: 12 }))
  check('2시간째', JSON.stringify(waitAge(now - 125 * 60_000, now)) === JSON.stringify({ unit: 'hours', n: 2 }))
  check('하루 넘으면 어제부터', waitAge(now - 25 * 3600_000, now).unit === 'yesterday')
  check('10분 미만은 강조 안 함', !isLongWait(now - 9 * 60_000, now))
  check('10분부터 강조', isLongWait(now - 10 * 60_000, now))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} attention: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)


const rooms: WorkspaceRoom[] = [
  { id: 'dm:a', kind: 'dm', title: 'A', sourceSessionId: 'a', status: 'active', attention: 'idle' },
  { id: 'dm:b', kind: 'dm', title: 'T', sourceSessionId: 'b', status: 'active', attention: 'done' },
]
const roomSnap = parsePresenceSnapshot({
  contractVersion: 4,
  channels: [{ id: 'dm:b', attention: 'waiting', status: 'active' }],
  sessions: [{ id: 'a', attention: 'running', status: 'active' }],
})
check('새 스냅샷은 channels를 읽는다', roomSnap?.channels[0]?.id === 'dm:b')
const mergedRooms = mergeRoomPresenceSnapshot(rooms, roomSnap?.channels ?? [])
check('새 merge는 방 id만', mergedRooms.find((r) => r.id === 'dm:b')?.attention === 'waiting')
const bgUpdate = { id: 'b', attention: 'background' as const, status: 'active' as const, backgroundTasks: [{ id: 't', kind: 'agent' as const, description: 'x' }] }
const updatedRooms = mergeRoomPresenceUpdate([{ ...rooms[0], id: 'dm:b', sourceSessionId: 'b', attention: 'running' }], bgUpdate)
check('실시간 갱신은 실행 id로 방을 찾는다', updatedRooms[0].attention === 'background' && updatedRooms[0].id === 'dm:b' && updatedRooms[0].backgroundTasks?.length === 1)
const titled = mergeRoomPresenceUpdate([{ ...rooms[0], id: 'dm:b', sourceSessionId: 'b', title: '임시 제목' }], { ...bgUpdate, displayName: '요약 제목' })
check('실시간 갱신이 방 제목을 바꾼다', titled[0].title === '요약 제목')
const untouched = mergeRoomPresenceUpdate([{ ...rooms[0], id: 'dm:b', sourceSessionId: 'b', title: '임시 제목' }], bgUpdate)
check('제목 칸이 없는 옛 서버 갱신은 제목을 지우지 않는다', untouched[0].title === '임시 제목')
check('옛 sessions만 스냅샷은 방을 안 바꿈', mergeRoomPresenceSnapshot(rooms, []) === rooms)
