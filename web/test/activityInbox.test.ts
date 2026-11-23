import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inboxLabel, inboxRows, inlinePermissionOk, liveSelection, plainPreview, resolveInOrder, tabTitle } from '../src/lib/activityInbox'
import { executionId } from '../src/lib/workspaceRooms'
import type { WorkspaceRoom } from '../src/lib/types'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

check(inboxLabel('waiting', 'plan') === '계획 승인', 'plan 라벨')
check(inboxLabel('waiting', 'permission') === '권한', 'permission 라벨')
check(inboxLabel('waiting', 'question') === '질문', 'question 라벨')
check(inboxLabel('waiting', undefined) === '대기', 'waiting 라벨')
check(inboxLabel('waiting', 'rate_limit') === '사용 한도 도달', 'rate_limit 라벨')
check(inboxLabel('waiting', 'interrupted_request') === '중단된 요청', 'interrupted_request 라벨')
check(inboxLabel('done', 'done') === '완료', 'done 라벨')
check(inboxLabel('failed', 'failed') === '실패', 'failed 라벨')
check(inboxLabel('running', undefined) === '', 'running 빈 라벨')

const rooms: WorkspaceRoom[] = [
  {
    id: 'dm:plan',
    kind: 'dm',
    title: 'plan',
    sourceSessionId: 'run-a',
    status: 'active',
    attention: 'waiting',
    attentionKind: 'plan',
    lastActivityAt: 100,
  },
  {
    id: 'dm:done-read',
    kind: 'dm',
    title: 'done-read',
    status: 'ended',
    attention: 'done',
    lastActivityAt: 100,
    lastViewedAt: 200,
  },
  {
    id: 'dm:done-unread',
    kind: 'dm',
    title: 'done-unread',
    status: 'ended',
    attention: 'done',
    lastActivityAt: 100,
  },
  {
    id: 'dm:running',
    kind: 'dm',
    title: 'running',
    status: 'active',
    attention: 'running',
    lastActivityAt: 50,
  },
]

const rows = inboxRows(rooms)
check(rows.some((r) => r.id === 'dm:plan'), 'waiting+plan 있음')
check(!rows.some((r) => r.id === 'dm:done-read'), '읽은 done 빠짐')
check(rows.some((r) => r.id === 'dm:done-unread'), '안 본 done 남음')
check(!rows.some((r) => r.id === 'dm:running'), 'running 0')
check(!inboxRows([{ id: 'dm:bg', kind: 'dm', title: 'bg', sourceSessionId: 'bg', status: 'active', attention: 'background' }]).some((r) => r.id === 'dm:bg'), '백그라운드 작업 중은 인박스에 없다')
check(inboxLabel('background', undefined) === '', 'background 빈 라벨')

const plan = rows.find((r) => r.id === 'dm:plan')!
check(executionId(plan) === 'run-a', 'executionId run-a')

const root = path.dirname(fileURLToPath(import.meta.url))
const topbar = fs.readFileSync(path.join(root, '../src/components/TopBar.tsx'), 'utf8')
check(topbar.includes('inboxLabel'), 'TopBar inboxLabel')
check(topbar.includes('inboxRows'), 'TopBar inboxRows')
check(topbar.includes('selectSession(jump.roomId)'), 'TopBar pick→selectSession(jump.roomId)')
check(topbar.includes('data-activity-inbox'), 'TopBar data-activity-inbox')

check(plainPreview('`main`을 **올렸다**\n- [가이드](http://x) 두 개') === 'main을 올렸다 가이드 두 개', 'plainPreview 마크다운 기호 제거')
check(plainPreview('## 제목\n```ts\ncode\n```') === '제목 code', 'plainPreview 제목·코드 울타리')

const mk = (id: string, attention: WorkspaceRoom['attention']): WorkspaceRoom => ({ id, kind: 'dm', title: id, sourceSessionId: id, status: 'active', attention })
const tabRooms = [mk('a', 'waiting'), mk('b', 'waiting'), mk('c', 'done')]
check(tabTitle(tabRooms, true) === '(2) Aether', '탭 제목: waiting 2개')
check(tabTitle(tabRooms, false) === 'Aether', '탭 제목: live 아님')
check(tabTitle([mk('c', 'done')], true) === 'Aether', '탭 제목: waiting 없음')

// 줄에서 바로 승인: 파일 변경 없음·한 줄·120자 이하만.
const bashReq = { id: 'a', toolKind: 'bash' }
check(inlinePermissionOk({ ...bashReq, input: { command: 'ls -la' } }), 'inline: bash 짧은 명령 참')
check(inlinePermissionOk({ ...bashReq }), 'inline: 인자 없음 참')
check(!inlinePermissionOk({ id: 'a', input: { command: 'ls' } }), 'inline: toolKind 없으면 거짓')
check(!inlinePermissionOk({ id: 'a', toolKind: 'file_change', input: { path: 'a.txt' } }), 'inline: file_change는 미리보기 없어도 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'ls' }, blockedPath: '/etc/x' }), 'inline: blockedPath 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'ls' }, mutation: { kind: 'write' } }), 'inline: mutation 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'a\nb' } }), 'inline: 줄바꿈 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'a\u202Eb' } }), 'inline: 방향 바꿈 문자 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'a\u200Bb' } }), 'inline: 폭 없는 문자 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'a\rb' } }), 'inline: CR 거짓')
check(!inlinePermissionOk({ ...bashReq, input: { command: 'x'.repeat(121) } }), 'inline: 121자 거짓')
check(inlinePermissionOk({ ...bashReq, input: { command: 'x'.repeat(120) } }), 'inline: 120자 참')

const k = { toolKind: 'bash' }
const live = [{ id: 'p1', ...k, input: { c: 'a' } }, { id: 'p2', ...k, input: { c: 'b' } }, { id: 'p3', ...k, input: { c: 'a\nb' } }, { id: 'new', ...k, input: { c: 'n' } }]
const sel = liveSelection(new Set(['p1', 'gone', 'p3']), live)
check(sel.length === 1 && sel[0] === 'p1', 'liveSelection: 사라진·승인 불가 id 빠짐', sel)
check(!liveSelection(['p1'], live).includes('new'), 'liveSelection: 새 요청 미포함')

const order: string[] = []
const res = await resolveInOrder(
  [1, 2, 3, 4].map((n) => ({ sessionId: `s${n}`, permissionId: `p${n}` })),
  async (sid) => {
    order.push(sid)
    if (sid === 's2') throw Object.assign(new Error('nf'), { status: 404 })
    if (sid === 's3') throw Object.assign(new Error('boom'), { status: 500 })
  },
)
check(order.join() === 's1,s2,s3,s4', 'resolveInOrder: 순서·실패 뒤에도 계속', order)
check(res.done === 2 && res.gone === 1 && res.failed === 1, 'resolveInOrder: done/gone/failed', res)

console.log(`\n${fail === 0 ? '✅' : '❌'} activityInbox: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
