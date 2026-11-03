/**
 * 최대 4칸 — 칸 수, 배치, 열기·바꾸기·닫기, 포커스.
 *   실행: cd web && npx tsx --tsconfig tsconfig.app.json test/splitPane.test.ts
 */
import {
  decideClosePane,
  decideOpenBeside,
  decideReconnectMask,
  decideSelectSession,
  focusedSessionId,
  isVisibleSession,
  paneCapacity,
  movePane,
  swapPanes,
  replacePane,
  besideVictimIndex,
  hiddenPaneIds,
  paneNumberOf,
  paneIds,
  otherWaitingPanes,
  paneLayout,
  parsePanes,
  serializePanes,
  sidebarInset,
  toggleZoomed,
  visibleCapacity,
  visibleSessionIds,
  zoomAfterChange,
} from '../src/lib/splitPane'
import { modelChipLabel, sessionModelRaw, sessionRowModel } from '../src/lib/modelLabel'

let failed = 0
function check(name: string, cond: boolean) {
  if (!cond) {
    failed++
    console.error('실패:', name)
  }
}

check('칸 하나 최소 폭 420 두 개가 안 들어가면 1칸', paneCapacity(800, 900) === 1)
check('폭만 넓고 높이가 모자라면 2칸', paneCapacity(1200, 600) === 2)
check('폭과 높이가 되면 4칸', paneCapacity(1000, 680) === 4)
check('폭 경계: 847은 1칸, 848은 2칸(420×2 + 간격 8)', paneCapacity(847, 300) === 1 && paneCapacity(848, 300) === 2)
check('높이 경계: 607은 2칸, 608은 4칸(300×2 + 간격 8)', paneCapacity(900, 607) === 2 && paneCapacity(900, 608) === 4)
check('3칸 한 줄: 폭 1320 이상이고 높이가 4칸에 모자랄 때', paneCapacity(1320, 600) === 3 && paneCapacity(1319, 600) === 2)
check('높이가 칸 최소(300)에 못 미치면 3칸 한 줄도 아니다', paneCapacity(1400, 299) === 2)
check('창이 1100 미만이면 1칸', visibleCapacity(false, 1400, 900) === 1)
check('넓은 창은 대화 영역 상한을 따른다', visibleCapacity(true, 1400, 900) === 4)
check('넓은 창이라도 대화 영역이 좁으면 1칸', visibleCapacity(true, 700, 900) === 1)

check('보이는 칸은 상한까지만', visibleSessionIds('a', ['b', 'c', 'd'], 2).join() === 'a,b')
check('1칸이면 첫 칸만', visibleSessionIds('a', ['b'], 1).join() === 'a')
check('중복은 한 번', paneIds('a', ['a', 'b', 'b']).join() === 'a,b')
check('다섯 번째는 버린다', paneIds('a', ['b', 'c', 'd', 'e']).length === 4)
check('보이는지', isVisibleSession('c', 'a', ['b', 'c'], 4) && !isVisibleSession('c', 'a', ['b', 'c'], 2))
check('포커스가 안 보이면 첫 칸', focusedSessionId('c', 'a', ['b'], 2) === 'a')
check('포커스가 보이면 그 칸', focusedSessionId('b', 'a', ['b'], 2) === 'b')

const two = paneLayout(2, 800)
check('2칸은 좌우', two.columns.split(' ').length === 2 && two.rows.split(' ').length === 1 && two.places.every((p) => p.top))
const threeNarrow = paneLayout(3, 1100)
check('좁은 3칸은 왼쪽이 두 줄', threeNarrow.places[0]?.row === '1 / span 2' && threeNarrow.places[2]?.top === false)
const threeWide = paneLayout(3, 1320)
check('넓은 3칸은 한 줄', threeWide.columns.split(' ').length === 3 && threeWide.places.every((p) => p.top))
const four = paneLayout(4, 1600)
check('4칸은 2×2, 아랫줄은 여백 없음', four.places.map((p) => p.top).join() === 'true,true,false,false')

const opened = decideOpenBeside('b', 'a', [], 'a', 4, ['a'])
check('옆에 연다', opened.ok && opened.sideIds.join() === 'b' && opened.focusedId === 'b' && opened.replacedId === null)
const focusOnly = decideOpenBeside('a', 'a', ['b'], 'b', 4, ['a', 'b'])
check('이미 보이면 포커스만', focusOnly.ok && focusOnly.focusedId === 'a' && focusOnly.sideIds.join() === 'b')
const full = decideOpenBeside('e', 'a', ['b', 'c', 'd'], 'a', 4, ['d', 'c', 'b', 'a'])
check(
  '꽉 차면 가장 오래 포커스된 칸을 바꾼다',
  full.ok && full.replacedId === 'd' && full.focusedId === 'e' && full.sideIds.includes('e') && !full.sideIds.includes('d'),
)
check('칸이 하나면 옆에 열기를 거부', decideOpenBeside('b', 'a', [], 'a', 1, ['a']).ok === false)
check('대상이 없으면 거부', decideOpenBeside('', 'a', [], 'a', 4, []).ok === false)

const hidden = decideOpenBeside('c', 'a', ['b', 'c'], 'a', 2, ['a', 'b', 'c'])
check('가려진 칸을 옆에 열면 보이게 당긴다', hidden.ok && visibleSessionIds(hidden.ok ? hidden.activeId : null, hidden.ok ? hidden.sideIds : [], 2).includes('c'))

const picked = decideSelectSession('b', 'a', ['b'], 'a', 2, false, ['a', 'b'])
check('보이는 세션은 포커스만', picked.focusedId === 'b' && picked.activeId === 'a' && picked.sideIds.join() === 'b')
const replaced = decideSelectSession('d', 'a', ['b'], 'b', 2, false, ['a', 'b'])
check('아니면 포커스된 칸을 바꾼다', replaced.activeId === 'a' && replaced.sideIds.join() === 'd' && replaced.focusedId === 'd')
const phone = decideSelectSession('d', 'a', ['b', 'c'], 'a', 1, false, ['a'])
check('폰은 첫 칸만 바꾸고 나머지는 기억', phone.activeId === 'd' && phone.sideIds.join() === 'b,c')
const beside = decideSelectSession('c', 'a', ['b'], 'a', 4, true, ['a', 'b'])
check('수정 키는 옆에 열기', beside.sideIds.join() === 'b,c' && beside.focusedId === 'c')

const closed = decideClosePane('a', 'a', ['b', 'c'], 'a')
check('첫 칸을 닫으면 다음이 첫 칸', closed.activeId === 'b' && closed.sideIds.join() === 'c' && closed.focusedId === 'b')
const closedSide = decideClosePane('b', 'a', ['b'], 'a', )
check('옆 칸만 닫으면 포커스는 그대로', closedSide.activeId === 'a' && closedSide.sideIds.length === 0 && closedSide.focusedId === 'a')

const maskGone = decideReconnectMask(null, true)
check('첫 칸이 없으면 재연결 가림막과 타이머를 내린다', maskGone.cancelTimer && maskGone.reconnectMask === false)
const maskGoneQuiet = decideReconnectMask(null, false)
check('가림막이 꺼져 있어도 첫 칸이 없으면 타이머는 취소한다', maskGoneQuiet.cancelTimer && maskGoneQuiet.reconnectMask === false)
const maskMoved = decideReconnectMask('b', true)
check('다른 세션이 첫 칸이면 재연결 가림막을 유지한다', !maskMoved.cancelTimer && maskMoved.reconnectMask === true)
const maskHeld = decideReconnectMask('a', false)
check('첫 칸이 있으면 꺼진 재연결 가림막을 켜지 않는다', !maskHeld.cancelTimer && maskHeld.reconnectMask === false)

const raw = serializePanes({ ids: ['a', 'b'], focusedId: 'b' })
const back = parsePanes(raw)
check('저장이 돌아온다', back.ids.join() === 'a,b' && back.focusedId === 'b')
check('깨진 저장은 빈 칸', parsePanes('{').ids.length === 0 && parsePanes('{"ids":[1]}').ids.length === 0)

check('모델 목록에 있으면 칩 이름', modelChipLabel('opus', [{ value: 'opus', displayName: 'Opus 4.6' }]) === 'Opus 4.6')
check('없으면 세션 값', modelChipLabel('custom-x', null) === 'custom-x')
check('빈 모델은 빈 줄', modelChipLabel('  ', []) === '')
check('고른 모델이 있으면 그 이름', sessionModelRaw({ model: 'opus', accountDefaultModel: 'gpt-6-astra' }) === 'opus')
check('고른 모델이 없으면 계정 기본 모델', sessionModelRaw({ model: '', accountDefaultModel: 'gpt-6-astra' }) === 'gpt-6-astra')
check('둘 다 없으면 빈 줄', sessionModelRaw({ model: '' }) === '' && sessionModelRaw(undefined) === '')
check(
  '스트림에서 본 모델이 고른 모델보다 앞선다',
  sessionModelRaw({ observedModel: 'claude-opus-5-5', model: 'opus', accountDefaultModel: 'claude-fable-5-1' }) === 'claude-opus-5-5',
)
check('빈 관측값은 고른 모델로 넘어간다', sessionModelRaw({ observedModel: ' ', model: 'opus', accountDefaultModel: 'gpt-6-astra' }) === 'opus')
check(
  '서버 표시 이름이 있으면 그 이름을 쓴다',
  sessionRowModel({ modelLabel: 'Mock Large', model: 'opus' }, [{ value: 'opus', displayName: 'Opus 4.6' }]) === 'Mock Large',
)
check(
  '표시 이름이 없으면 목록으로 번역한다',
  sessionRowModel({ observedModel: 'opus' }, [{ value: 'opus', displayName: 'Opus 4.6' }]) === 'Opus 4.6',
)
check(
  '빈 표시 이름은 목록 번역으로 돌아간다',
  sessionRowModel({ modelLabel: '  ', observedModel: 'opus' }, [{ value: 'opus', displayName: 'Opus 4.6' }]) === 'Opus 4.6',
)
const catalogRows = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', isDefault: true },
  { value: 'opus[1m]', displayName: 'Opus 5 (1M)', resolvedModel: 'claude-opus-5[1m]' },
]
check('정식 id로 찾으면 기본 줄보다 구체적인 줄 이름', modelChipLabel('claude-opus-5[1m]', catalogRows) === 'Opus 5 (1M)')

// ── 칸 임시 확대 ──
const zp = ['a', 'b']
check('확대: 칸이 둘이면 켠다', toggleZoomed(null, 'a', zp) === 'a')
check('확대: 같은 칸을 다시 누르면 해제', toggleZoomed('a', 'a', zp) === null)
check('확대: 칸이 하나면 켜지 않는다', toggleZoomed(null, 'a', ['a']) === null)
check('확대: 보이지 않는 칸은 켜지 않는다', toggleZoomed(null, 'z', zp) === null)
check('확대 유지: 확대 칸이 포커스면 유지', zoomAfterChange('a', zp, 'a') === 'a')
check('확대 해제: 포커스가 다른 칸으로 가면', zoomAfterChange('a', zp, 'b') === null)
check('확대 해제: 칸이 사라지면', zoomAfterChange('b', ['a'], 'a') === null)
check('확대 유지: 포커스가 비면 첫 칸이 포커스', zoomAfterChange('a', zp, null) === 'a')
check('확대 안 함이면 그대로 null', zoomAfterChange(null, zp, 'a') === null)
check(
  '다른 칸 대기: 오래 기다린 순, 확대 칸·안 보이는 칸 제외',
  otherWaitingPanes(['a', 'b', 'c'], 'a', [
    { id: 'a', attention: 'waiting', attentionSince: 1 },
    { id: 'b', attention: 'waiting', attentionSince: 50 },
    { id: 'c', attention: 'waiting', attentionSince: 10 },
    { id: 'd', attention: 'waiting', attentionSince: 5 },
  ]).join(',') === 'c,b',
)
check('다른 칸 대기: 없으면 빈 배열', otherWaitingPanes(['a', 'b'], 'a', [{ id: 'b', attention: 'running' }]).length === 0)

// ── 칸 자리 옮기기·교환·바꾸기 ──
const ord = ['a', 'b', 'c', 'd']
check('왼쪽으로: b가 a 자리로', movePane(ord, 'b', -1, 4).join() === 'b,a,c,d')
check('오른쪽으로: b가 c 자리로', movePane(ord, 'b', 1, 4).join() === 'a,c,b,d')
check('첫 칸을 왼쪽으로 옮기면 그대로', movePane(ord, 'a', -1, 4).join() === 'a,b,c,d')
check('마지막 칸을 오른쪽으로 옮기면 그대로', movePane(ord, 'd', 1, 4).join() === 'a,b,c,d')
check('숨은 칸과는 자리를 바꾸지 않는다', movePane(ord, 'b', 1, 2).join() === 'a,b,c,d')
check('없는 id는 그대로', movePane(ord, 'z', 1, 4).join() === 'a,b,c,d')
check('교환', swapPanes(ord, 'a', 'c').join() === 'c,b,a,d')
check('교환: 없는 id는 그대로', swapPanes(ord, 'a', 'z').join() === 'a,b,c,d')
check('바꾸기: 새 세션이 그 자리로', replacePane(ord, 'b', 'x').join() === 'a,x,c,d')
check('바꾸기: 이미 칸에 있으면 맞교환', replacePane(ord, 'b', 'd').join() === 'a,d,c,b')
check('숨은 칸 칩: 포커스 칸과 숨은 칸을 맞바꿔도 칸 수는 그대로', replacePane(['a', 'b', 'c'], 'a', 'c').join() === 'c,b,a')
check('바꾸기: 없는 칸이면 그대로', replacePane(ord, 'z', 'x').join() === 'a,b,c,d')
check('바뀔 칸 번호: 꽉 차면 가장 오래 안 본 칸', besideVictimIndex('e', 'a', ['b', 'c', 'd'], 'a', 4, ['d', 'c', 'b', 'a']) === 3)
check('바뀔 칸 번호: 자리가 있으면 null', besideVictimIndex('c', 'a', ['b'], 'a', 4, ['a', 'b']) === null)
check('숨은 칸: 용량 밖의 뒤쪽 칸', hiddenPaneIds('a', ['b', 'c', 'd'], 2).join() === 'c,d')
check('숨은 칸: 다 보이면 없다', hiddenPaneIds('a', ['b'], 4).length === 0)

check('칸 번호: 둘 이상일 때 1부터', paneNumberOf('b', 'a', ['b'], 4) === 2)
check('칸 번호: 칸이 하나면 0', paneNumberOf('a', 'a', [], 4) === 0)
check('칸 번호: 숨은 칸은 0', paneNumberOf('c', 'a', ['b', 'c'], 2) === 0)

// ── 목록 접기: 칸 수 경계(대화 영역 폭 = 창 폭 − 기둥 폭) ──
check('기둥 폭: 펼침 308, 접힘 66', sidebarInset(false) === 308 && sidebarInset(true) === 66)
{
  const cap = (winW: number, winH: number, collapsed: boolean) => paneCapacity(winW - sidebarInset(collapsed), winH)
  check('1366x800 펼침 W=1058 → 4칸', cap(1366, 800, false) === 4)
  check('1366x800 접힘 W=1300 → 4칸', cap(1366, 800, true) === 4)
  check('1280x720 펼침 W=972 → 4칸', cap(1280, 720, false) === 4)
  check('1280x720 접힘 W=1214 → 4칸', cap(1280, 720, true) === 4)
  check('높이 모자라면 접어도 2칸', cap(1366, 600, true) === 2)
  check('펼침 1100 창은 W=792라 1칸', cap(1100, 800, false) === 1)
}

if (failed) {
  console.error(`splitPane: ${failed}건 실패`)
  process.exit(1)
}
console.log('splitPane: 통과')
