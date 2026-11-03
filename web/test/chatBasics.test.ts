/** 대화의 기본 동작 — 이전 말, 보통 글, 내려받기, 말 이동, 코드 파일 이름. */
import { browseDown, browseUp, rememberPrompt, promptsFor } from '../src/lib/promptHistory'
import { markdownToPlain } from '../src/lib/plainText'
import { eventsToMarkdown } from '../src/lib/transcriptMarkdown'
import { stepUserSeq, userSeqsOf } from '../src/lib/userJump'
import { codeFileName } from '../src/lib/codeFileName'
import { dictationLang, finalTranscript } from '../src/lib/dictation'
import { deriveTurn, restoreQueuedSnapshot, withRewindIdle, type ConvoItem } from '../src/lib/store'
import { buildStreamSegments } from '../src/lib/streamSegments'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  },
})

rememberPrompt('s', '하나')
rememberPrompt('s', '둘')
rememberPrompt('s', '하나')
check(promptsFor('s').join('|') === '둘|하나', '같은 말은 맨 뒤로 옮기고 세션마다 나눈다', promptsFor('s'))
const up = browseUp(promptsFor('s'), { cursor: null, draft: '' }, '')
check(up?.text === '하나' && up.state.cursor === 1, '위 화살표는 마지막 말을 꺼낸다')
const older = up && browseUp(promptsFor('s'), up.state, up.text)
check(older?.text === '둘', '한 번 더 위는 그 이전 말이다')
const back = older && browseDown(promptsFor('s'), older.state)
const home = back && browseDown(promptsFor('s'), back.state)
check(home?.text === '' && home.state.cursor === null, '맨 아래에서 아래 화살표는 쓰던 글로 돌아온다')

check(markdownToPlain('**굵게** `코드`\n\n```ts\nconst a = 1\n```\n[링크](https://example.com)') === '굵게 코드\n\nconst a = 1\n\n링크', '기호는 걷고 코드 내용은 남긴다')

const md = eventsToMarkdown([
  { kind: 'user_msg', text: '안녕', images: [{}, {}] },
  { kind: 'agent', events: [{ type: 'text_delta', text: '숨김' }, { type: 'text', text: '대답' }, { type: 'tool_call', toolId: 't1', name: 'read', target: 'a.ts' }] },
])
check(md.includes('안녕') && md.includes('이미지 2개') && md.includes('대답') && md.includes('도구: read a.ts') && !md.includes('숨김'), '내려받기는 확정된 글과 도구 한 줄만 담는다', md)

check(stepUserSeq([2, 5, 9], null, -1) === 9, '처음 위는 마지막 사용자 말이다')
check(stepUserSeq([2, 5, 9], 2, -1) === null, '맨 위에서 더 위는 없다')
check(stepUserSeq([2, 5, 9], 5, 1) === 9, '다음은 더 최근 말이다')
check(userSeqsOf([{ seq: -1, kind: 'local_user' }, { seq: 3, kind: 'user_msg' }, { seq: 4, kind: 'agent', events: [{ type: 'user_text', text: '질문' }] }]).join(',') === '3,4', '사용자 말과 같은 순번만 모은다')

check(codeFileName('python', 2) === 'code-2.py', '파이썬은 py')
check(codeFileName('c++', 1) === 'code-1.cpp', 'c++ 는 cpp')
check(codeFileName('', 1) === 'code-1.txt', '언어가 없으면 txt')
check(codeFileName('../etc', 1) === 'code-1.etc', '경로 기호는 빼고 짧은 확장자만 남긴다')
check(codeFileName('...', 1) === 'code-1.txt', '글자가 없으면 txt')

check(dictationLang('ko') === 'ko-KR' && dictationLang('en') === 'en-US', '말 입력 언어는 화면 언어를 따른다')
const spoken = finalTranscript(
  [
    { isFinal: true, 0: { transcript: '안녕' } },
    { isFinal: false, 0: { transcript: '아직' } },
  ],
  0,
)
check(spoken.text === '안녕' && spoken.next === 1, '확정된 말만 붙인다')

const keptUser = { seq: 1, ts: 1, kind: 'user_msg', text: '남겨' } as ConvoItem
const idleList = withRewindIdle([keptUser], 4, 4)
check(deriveTurn([keptUser], false) === 'running', '완료가 없으면 마지막 말은 아직 진행 중이다')
check(deriveTurn(idleList, false) === 'idle', '되돌린 직후 조용한 완료가 붙으면 턴이 쉰다')
const refreshed = [
  { seq: 1, ts: 1, kind: 'user_msg', text: '남겨' },
  { seq: 4, ts: 4, kind: 'status', status: 'completed' },
] as ConvoItem[]
check(deriveTurn(refreshed, false) === 'idle', '새로고침이 받는 목록도 쉰 상태다', deriveTurn(refreshed, false))
check(withRewindIdle(idleList, 4).length === idleList.length, '같은 완료가 이미 있으면 한 번 더 붙이지 않는다')
const painted = buildStreamSegments({
  items: idleList,
  turn: 'idle',
  providerName: 'Agent',
  answers: {},
  t: (key) => key,
})
check(!painted.segs.some((seg) => seg.kind === 'banner' && seg.variant === 'stop') && painted.chamdingPhase === 'idle', '조용한 완료는 중단 배너를 만들지 않는다')

const restoredQueue = restoreQueuedSnapshot(
  {
    'room-1': [{ qid: 'q1', text: '방 대기' }],
    'exec-9': [{ qid: 'q2', text: '실행 대기' }],
    gone: [{ qid: 'q3', text: '없는 방' }],
  },
  ['room-1'],
  ['exec-9'],
)
check(restoredQueue['room-1']?.[0]?.text === '방 대기', '방 id로 저장한 글 대기열은 새로고침 뒤에도 남는다')
check(restoredQueue['exec-9']?.[0]?.text === '실행 대기', '실행 id로 저장한 대기열도 남는다')
check(restoredQueue.gone === undefined, '없는 방의 대기열은 버린다')

console.log(`\n${fail ? '❌' : '✅'} chat basics: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
