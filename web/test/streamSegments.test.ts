/**
 * 세그먼트 빌더 전수 렌더 테스트 (Phase 8d-3 완료 게이트 ②).
 *   실행: npx tsx web/test/streamSegments.test.ts   (src 밖이라 앱 빌드 tsc -b에 미포함)
 *
 * 무엇을 지키는가: **두 번째 provider의 봉투로도 화면 요소가 하나도 빠짐없이 그려지는가.**
 * 8d-3에서 원본 폴백을 지웠으므로, 어떤 화면 요소가 정규화 계약에서 값을 못 읽으면 에러도 없이 그냥 빈다.
 * 그래서 목록에서 하나가 빠지는 것 자체가 실패다 — 아래 `EXPECTED_KINDS`가 그 목록이고, 빌더가 만들 수
 * 있는 모든 조각 종류를 여기서 한 번씩 확인한다.
 *
 * 봉투에는 원본 본문이 없다. 계약만으로 화면 조각이 나와야 한다.
 *
 * 실제 모듈을 import한다(로직 복제본이 아니다 — 8c에서 어겼던 규칙). 프레임워크 없는 독립 tsx.
 */
import { buildStreamSegments, type StreamSeg } from '../src/lib/streamSegments'
import { INITIAL_PRESENCE, nextWake, stepPresence, tickPresence } from '../src/lib/chamdingPresence'
import type { ConvoItem } from '../src/lib/store'
import type { AgentEvent, ChamdingPhase } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want })
}

/** 번역은 키와 인자를 그대로 드러내는 스텁 — 어떤 문구가 어떤 값으로 만들어졌는지 문자열로 대조하려고. */
const t = (key: string, params?: Record<string, string | number>) => (params && Object.keys(params).length ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key)

let seq = 0
/** 두 번째 provider의 클라이언트 봉투 — 원본 본문 없이 계약만 싣는다. */
const foreign = (events: Omit<AgentEvent, 'provider' | 'seq' | 'part' | 'ts'>[]): ConvoItem => {
  const s = ++seq
  return {
    seq: s,
    ts: 1000 + s,
    kind: 'agent',
    events: events.map((e, part) => ({ provider: 'codex', seq: s, part, ts: 1000 + s, ...e })),
  } as unknown as ConvoItem
}
/** provider와 무관한 Aether 자체 이벤트(권한·질문·상태 등). */
const own = (o: Record<string, unknown>): ConvoItem => ({ seq: ++seq, ts: 1000 + seq, ...o }) as unknown as ConvoItem

const permReq = { id: 'perm-1', toolName: 'Bash', input: {}, toolUseID: 'tu-1', createdAt: 1 }
const questReq = { id: 'q-1', toolUseID: 'tu-2', questions: [{ question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }], createdAt: 1 }

// ── 두 번째 provider 봉투 하나로 만들 수 있는 모든 조각 ──
//   턴 두 개로 짰다. 앞 턴은 최종 답변까지 정상으로 끝나고, 뒤 턴은 답을 못 내고 끊긴다.
const items: ConvoItem[] = [
  own({ kind: 'user_msg', text: '빌드해줘' }),
  foreign([{ type: 'reasoning', text: '빌드 명령을 먼저 확인하자' }]), // 접힌 줄 하나로 나간다(8h)
  foreign([{ type: 'reasoning', text: '그다음 결과를 읽자' }]), // 같은 턴의 생각은 이어 붙는다
  foreign([{ type: 'text', text: '먼저 살펴볼게요' }]), // 뒤에 도구 호출이 붙으므로 작업 중 알림이 된다
  foreign([{ type: 'tool_call', toolId: 'tc-1', name: 'commandExecution', toolKind: 'bash', target: 'npm run build', input: { command: 'npm run build', timeout: 60 } }]),
  foreign([{ type: 'tool_result', toolId: 'tc-1', output: 'built in 3s' }]),
  foreign([{ type: 'tool_call', toolId: 'task-1', name: 'Task', toolKind: 'task', target: 'auth', input: { description: '인증 탐색', subagent_type: 'Explore', prompt: '로그인 흐름을 찾아라', files: ['src/auth.ts'] } }]),
  foreign([{ type: 'tool_result', toolId: 'task-1', output: 'src/auth.ts 를 읽었다' }]),
  foreign([{ type: 'command_output', text: 'context: 12k/200k' }]),
  foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'warn', limitType: 'weekly', utilization: 0.87, resetsAt: 4102444800 }]),
  foreign([{ type: 'provider_notice', kind: 'compact', severity: 'warn' }]),
  foreign([{ type: 'provider_notice', kind: 'compact' }]), // severity 없음(사용자 /clear) = 배너 없음
  foreign([{ type: 'provider_notice', kind: 'model_fallback', severity: 'warn', detail: 'gpt-fallback', originalModel: 'gpt-original', category: 'safety' }]),
  own({ kind: 'permission_request', req: permReq }),
  own({ kind: 'question_request', req: questReq }),
  own({ kind: 'question_resolved', id: 'q-1', answered: true, answers: [['A']] }),
  foreign([{ type: 'plan_text', text: '1. 확인' }]),
  own({ kind: 'plan_request', req: { id: 'plan-1', planId: 'p1', text: '1. 확인', createdAt: 1 } }),
  own({ kind: 'notice', notice: 'resumed' }),
  own({ kind: 'notice', notice: 'auth_expired' }),
  own({ kind: 'notice', notice: 'distill_model', detail: 'small' }),
  own({ kind: 'command_operation', operationId: 'op-1', state: 'started', detail: '압축 중', blocksInput: true }),
  own({ kind: 'command_operation', operationId: 'op-1', state: 'completed', detail: '압축 완료', blocksInput: true }),
  foreign([{ type: 'text', text: '해볼게요' }]), // 이 턴의 마지막 말 = 최종 답변
  foreign([{ type: 'turn_completed', status: 'failed', error: '중단', durationMs: 2500, outputTokens: 321, errors: ['529 overloaded'] }]),
  own({ kind: 'local_notice', variant: 'model', detail: 'gpt-small' }),
  own({ kind: 'user_msg', text: '한 번 더' }),
  foreign([{ type: 'text', text: '다시 해볼게요' }]), // 끊기기 직전에 하던 말 = 작업 줄로 고정된다
  own({ kind: 'status', status: 'interrupted' }),
]

const built = buildStreamSegments({ items, turn: 'idle', providerName: 'MockProvider', answers: {}, t })
const kinds = built.segs.map((s) => s.kind)

/** 빌더가 만들 수 있는 조각 종류 전부. 하나라도 안 나오면 그 화면 요소는 두 번째 provider에서 빈다. */
const EXPECTED_KINDS: StreamSeg['kind'][] = ['user', 'text', 'live', 'tools', 'team', 'commandOutput', 'banner', 'permission', 'question', 'choice', 'authExpired', 'operation', 'result', 'reasoning', 'plan', 'planCard']
for (const k of EXPECTED_KINDS) check(`조각 '${k}' 렌더됨`, kinds.includes(k), kinds)

// 조각마다 실제 내용이 계약에서 왔는지 — "렌더는 됐는데 값이 비었다"를 잡는다.
const seg = <K extends StreamSeg['kind']>(k: K) => built.segs.find((s) => s.kind === k) as Extract<StreamSeg, { kind: K }>

eq('사람 입력 그대로', seg('user').text, '빌드해줘')
// 8h: 생각은 한 턴에 하나로 합쳐 접힌 줄로 내보낸다(조각마다 줄을 만들면 대화가 생각으로 뒤덮인다).
eq('한 턴의 생각은 하나로 합쳐진다', seg('reasoning').text, '빌드 명령을 먼저 확인하자\n\n그다음 결과를 읽자')
check('생각 줄은 한 구간에 하나만 만든다', built.segs.filter((x) => x.kind === 'reasoning').length === 1, kinds)
check('생각은 같은 묶음의 말·도구보다 앞에 온다', kinds.indexOf('reasoning') < kinds.indexOf('live'), kinds)
check('생각은 세션 안 찾기 색인에 넣지 않는다', !built.searchable.some((x) => x.text.includes('빌드 명령을 먼저')), built.searchable)
eq('최종 답변은 그 턴의 마지막 말', seg('text').text, '해볼게요')
const lives = built.segs.filter((s) => s.kind === 'live') as Extract<StreamSeg, { kind: 'live' }>[]
eq('질문 카드 앞의 말은 카드 위에 굳는다', lives[0].text, '먼저 살펴볼게요')
eq('끊긴 턴에는 마지막에 하던 말이 작업 중 알림으로 남는다', lives[lives.length - 1].text, '다시 해볼게요')
eq('질문 카드는 그 앞의 말과 명령 요약 줄 다음에 온다', kinds.slice(kinds.indexOf('live'), kinds.indexOf('question') + 1), ['live', 'team', 'tools', 'question'])
eq('도구 카드는 인자 전체를 받는다', seg('tools').tools[0].input, { command: 'npm run build', timeout: 60 })
eq('도구 결과가 호출과 이어진다', seg('tools').tools[0].result, { content: 'built in 3s', is_error: undefined })
check('자식 작업은 일반 도구 줄에 묻히지 않는다', !seg('tools').tools.some((x) => x.name === 'Task'), seg('tools').tools)
eq('팀 카드는 자식 작업만 담는다', seg('team').tasks.map((x) => x.name), ['Task'])
check('팀 없는 턴의 빈 팀 조각은 없다', built.segs.filter((x) => x.kind === 'team').length === 1, kinds)
eq('슬래시 명령 출력', seg('commandOutput').text, 'context: 12k/200k')
check('명령 작업은 완료 이벤트가 오면 시작 카드 자리를 완료 카드로 바꾼다', seg('operation').key === 'op-op-1' && seg('operation').state === 'completed' && seg('operation').text === '압축 완료', seg('operation'))

const operationOnly = buildStreamSegments({
  items: [own({ kind: 'command_operation', operationId: 'op-live', state: 'started', detail: '압축 중', blocksInput: true })],
  turn: 'operation', providerName: 'MockProvider', answers: {}, t,
})
const liveOperation = operationOnly.segs.find((x) => x.kind === 'operation') as Extract<StreamSeg, { kind: 'operation' }>
check('완료 전에는 명령 작업 카드가 실행 중 상태로 먼저 그려진다', liveOperation?.state === 'started' && liveOperation?.text === '압축 중', liveOperation)
eq('결과 푸터 값', [seg('result').turn.status, seg('result').turn.outputTokens, seg('result').turn.errors], ['failed', 321, ['529 overloaded']])
eq('권한 카드 요청 전달', seg('permission').req.id, 'perm-1')
eq('질문 카드 요청 전달', seg('question').req.id, 'q-1')
eq('답한 질문은 선택 에코를 남긴다', seg('choice').labels, ['A'])
eq('계획문 조각', seg('plan').text, '1. 확인')
eq('계획 카드 요청 전달', seg('planCard').req.id, 'plan-1')
// 할 일 목록(plan_update)은 흐름에 조각을 만들지 않는다. 칸 머리 칩과 턴 끝 카드가 대신 보인다.
const todoOnly = buildStreamSegments({
  items: [
    own({ kind: 'user_msg', text: '해줘' }),
    foreign([{ type: 'plan_update', items: [{ text: '읽기', status: 'completed' }, { text: '고치기', status: 'pending' }] }]),
    foreign([{ type: 'plan_update', text: '옛 서버 모양' } as unknown as AgentEvent]), // 옛 서버 사건도 깨지지 않는다
  ],
  turn: 'idle', providerName: 'MockProvider', answers: {}, t,
})
check("목록(plan_update)만 있는 턴에는 'plan' 조각이 없다", !todoOnly.segs.some((x) => x.kind === 'plan'), todoOnly.segs.map((x) => x.kind))
// 8d-3 ④: 인증 만료 안내가 "Claude"를 박지 않고 이 세션의 서비스 이름을 받는다.
eq('인증 만료 안내에 이 세션의 서비스 이름이 들어간다', seg('authExpired').text, 'stream.notice.authExpired(provider=MockProvider)')

const banners = built.segs.filter((s) => s.kind === 'banner') as Extract<StreamSeg, { kind: 'banner' }>[]
const bannerTexts = banners.map((b) => b.text)
check(
  '한도 임박 경고는 대화 배너로 내지 않는다',
  !bannerTexts.some((x) => x.includes('weekly 87%')),
  bannerTexts,
)
check('자동 압축은 배너로 알린다', bannerTexts.filter((x) => x === 'stream.notice.compacted').length === 1, bannerTexts)
check('사용자가 직접 비운 것(/clear)은 배너를 안 띄운다', bannerTexts.filter((x) => x === 'stream.notice.compacted').length === 1, bannerTexts)
check(
  '모델 전환 배너에 전·후 모델과 사유가 들어간다',
  bannerTexts.some((x) => x.includes('original=gpt-original') && x.includes('fallback=gpt-fallback') && x.includes('cat=')),
  bannerTexts,
)
check('중단 상태 배너', bannerTexts.some((x) => x === 'stream.notice.interrupted'), bannerTexts)
check('세션 재개 배너', bannerTexts.some((x) => x === 'stream.notice.resumed'), bannerTexts)
check('모델 변경 로컬 알림', bannerTexts.some((x) => x.includes('stream.notice.modelChanged')), bannerTexts)

// ── 진행 중 표시 ──
const retryBuilt = buildStreamSegments({
  items: [foreign([{ type: 'provider_notice', kind: 'retry', severity: 'warn', detail: 'overloaded', attempt: 2, max: 5 }])],
  turn: 'running',
  providerName: 'MockProvider',
  answers: {},
  t,
})
eq('재시도 인디케이터(진행 중에만)', retryBuilt.retry, { attempt: 2, max: 5, error: 'overloaded' })
check('재시도 중에도 진행 구슬을 띄운다', retryBuilt.showOrb === true)
check('재시도는 히스토리에 쌓이지 않는다', retryBuilt.segs.length === 0, retryBuilt.segs)

// 질문 카드가 끼면 그 지점이 구간 경계다 — 앞뒤 생각이 각각 자기 줄을 갖고, 자리 이름도 안 겹친다.
{
  const split = buildStreamSegments({
    items: [
      own({ kind: 'user_msg', text: '해줘' }),
      foreign([{ type: 'reasoning', text: '먼저 물어보자' }]),
      own({ kind: 'question_request', req: questReq }),
      foreign([{ type: 'reasoning', text: '답을 들었으니 진행하자' }]),
      foreign([{ type: 'text', text: '했습니다' }]),
      foreign([{ type: 'turn_completed', status: 'ok' }]),
    ],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  const rows = split.segs.filter((x) => x.kind === 'reasoning') as Extract<StreamSeg, { kind: 'reasoning' }>[]
  eq('질문 카드가 구간을 끊으면 생각 줄도 앞뒤로 나뉜다', rows.map((r) => r.text), ['먼저 물어보자', '답을 들었으니 진행하자'])
  check('나뉜 생각 줄의 자리 이름은 서로 다르다', rows[0].key !== rows[1].key, rows.map((r) => r.key))
  const order = split.segs.map((x) => x.kind)
  check('앞 생각은 질문 카드 위에 남는다', order.indexOf('reasoning') < order.indexOf('question'), order)
}

const idleRetry = buildStreamSegments({ items: retryBuilt ? [foreign([{ type: 'provider_notice', kind: 'retry', attempt: 1, max: 3 }])] : [], turn: 'idle', providerName: 'MockProvider', answers: {}, t })
check('턴이 끝나면 재시도 표시도 사라진다', idleRetry.retry === null)

// ── 라이브 미리보기 → 최종본 치환(작업 중 알림이 미리보기를 흡수한다) ──
const deltaOnly = buildStreamSegments({ items: [foreign([{ type: 'text_delta', text: '부분' }]), foreign([{ type: 'text_delta', text: ' 토큰' }])], turn: 'running', providerName: 'MockProvider', answers: {}, t })
eq('부분 토큰은 이어붙여 보인다', deltaOnly.segs.map((s) => (s.kind === 'live' ? s.text : s.kind)), ['부분 토큰'])
const deltaThenFinal = buildStreamSegments({
  items: [foreign([{ type: 'text_delta', text: '부분' }]), foreign([{ type: 'text', text: '완성된 답변' }])],
  turn: 'running',
  providerName: 'MockProvider',
  answers: {},
  t,
})
eq('완성본이 오면 미리보기는 버린다', deltaThenFinal.segs.map((s) => (s.kind === 'live' ? s.text : s.kind)), ['완성된 답변'])

// ── 말 자리 규칙: 뒤에 도구가 붙은 말은 작업 중 알림, 도구 없이 턴이 끝나면 최종 답변 ──
const turnItems = (): ConvoItem[] => [
  own({ kind: 'user_msg', text: '고쳐줘' }),
  foreign([{ type: 'text', text: '1번 파일부터' }]),
  foreign([{ type: 'tool_call', toolId: 'e1', name: 'Edit', input: { file_path: '/a.ts' } }]),
  foreign([{ type: 'text', text: '2번 파일도' }]),
  foreign([{ type: 'tool_call', toolId: 'e2', name: 'Edit', input: { file_path: '/b.ts' } }]),
  foreign([{ type: 'text', text: '다 고쳤습니다' }]),
]
const build = (items: ConvoItem[], turn: 'idle' | 'running') => buildStreamSegments({ items, turn, providerName: 'MockProvider', answers: {}, t })

const liveTextsOf = (r: ReturnType<typeof build>) => r.segs.flatMap((s) => (s.kind === 'live' ? [s.text] : []))

const done = build([...turnItems(), foreign([{ type: 'turn_completed', status: 'ok' }])], 'idle')
eq('끝난 턴은 작업 중 알림 → 명령 요약 줄 → 최종 답변 → 결과 푸터', done.segs.map((s) => s.kind), ['user', 'live', 'tools', 'text', 'result'])
eq('도구 없이 턴이 끝난 마지막 말이 최종 답변이다', (done.segs.find((s) => s.kind === 'text') as Extract<StreamSeg, { kind: 'text' }>).text, '다 고쳤습니다')
eq('작업 중 알림은 가장 최근 것 하나만 남는다(앞의 말은 갈아끼워진다)', liveTextsOf(done), ['2번 파일도'])
eq('말이 껴도 한 턴의 도구는 하나의 요약 줄로 합쳐진다', (done.segs.find((s) => s.kind === 'tools') as Extract<StreamSeg, { kind: 'tools' }>).tools.length, 2)

const running = build(turnItems(), 'running')
eq('진행 중인 턴은 작업 중 알림 → 명령 요약 줄 → 지금 하는 말', running.segs.map((s) => s.kind), ['user', 'live', 'tools', 'live'])
eq('알림 자리엔 확정된 것, 꼬리엔 방금 한 말', liveTextsOf(running), ['2번 파일도', '다 고쳤습니다'])
check('꼬리가 모델의 말이면 아직 돌고 있다는 구슬을 그 아래에 띄운다', running.showOrb === true)

// 최종 답변은 말풍선이 있고 작업 중 알림은 없다 = 말풍선의 유무가 "다 됐다"는 신호다.
//   그래서 턴이 끝나기 전에는 아무리 길어도 말풍선으로 올리지 않는다(길이·줄바꿈으로 짐작하지 않는다).
const longAnswer = '가'.repeat(201)
const longRun = build([own({ kind: 'user_msg', text: '설명해줘' }), foreign([{ type: 'tool_call', toolId: 'r1', name: 'Read', input: { file_path: '/a.ts' } }]), foreign([{ type: 'text', text: longAnswer }])], 'running')
eq('진행 중엔 긴 답변도 말풍선 없이 본문으로 보인다', longRun.segs.map((s) => s.kind), ['user', 'tools', 'live'])
const multiRun = build([own({ kind: 'user_msg', text: '설명해줘' }), foreign([{ type: 'text', text: '첫 줄\n둘째 줄' }])], 'running')
eq('여러 줄이어도 턴이 끝나기 전엔 말풍선이 아니다', multiRun.segs.map((s) => s.kind), ['user', 'live'])
const multiDone = build([own({ kind: 'user_msg', text: '설명해줘' }), foreign([{ type: 'text', text: '첫 줄\n둘째 줄' }]), foreign([{ type: 'turn_completed', status: 'ok' }])], 'idle')
eq('턴이 끝나는 순간 말풍선이 된다', multiDone.segs.map((s) => s.kind), ['user', 'text', 'result'])

// 끊긴 턴(D5): 최종 답변이 없으므로 마지막에 하던 말을 말풍선으로 올리지 않고 중단 배너 위에 남긴다.
const cut = build([...turnItems(), own({ kind: 'status', status: 'crashed' })], 'idle')
eq('끊긴 턴은 알림 → 명령 요약 줄 → 하던 말 → 중단 배너', cut.segs.map((s) => s.kind), ['user', 'live', 'tools', 'live', 'banner'])
const cutByNext = build([...turnItems(), own({ kind: 'user_msg', text: '아니 이거 말고' })], 'idle')
eq('다음 질문이 먼저 오면 앞 턴도 끊긴 것으로 본다', cutByNext.segs.map((s) => s.kind), ['user', 'live', 'tools', 'live', 'user'])

// 질문 카드: 답을 고를 근거가 되는 앞의 말이 카드 위에 남고, 명령 요약 줄도 거기서 한 번 끊긴다.
const withQuestion = build(
  [
    own({ kind: 'user_msg', text: '골라줘' }),
    foreign([{ type: 'tool_call', toolId: 'q0', name: 'Read', input: { file_path: '/a.ts' } }]),
    foreign([{ type: 'text', text: '조사 결과 두 가지가 있습니다' }]),
    own({ kind: 'question_request', req: questReq }),
    foreign([{ type: 'tool_call', toolId: 'q1', name: 'Edit', input: { file_path: '/a.ts' } }]),
    foreign([{ type: 'text', text: '반영했습니다' }]),
    foreign([{ type: 'turn_completed', status: 'ok' }]),
  ],
  'idle',
)
eq('질문 앞의 설명이 카드 위에 남는다', withQuestion.segs.map((s) => s.kind), ['user', 'tools', 'live', 'question', 'tools', 'text', 'result'])
eq('카드 위의 말이 곧 질문의 근거다', liveTextsOf(withQuestion)[0], '조사 결과 두 가지가 있습니다')

{
  const lead = '조사 결과 두 가지가 있습니다'
  const withLead = build(
    [
      own({ kind: 'user_msg', text: '골라줘' }),
      foreign([{ type: 'tool_call', toolId: 'q0', name: 'Read', input: { file_path: '/a.ts' } }]),
      foreign([{ type: 'text', text: lead }]),
      own({ kind: 'question_request', req: { ...questReq, id: 'q-lead', lead } }),
    ],
    'idle',
  )
  eq('lead가 있으면 같은 글을 말풍선으로 한 번만 둔다', withLead.segs.map((s) => s.kind), ['user', 'tools', 'text', 'question'])
  eq('lead 말풍선 본문', (withLead.segs.find((s) => s.kind === 'text') as Extract<StreamSeg, { kind: 'text' }>).text, lead)
  const summaryLead = buildStreamSegments({
    items: [
      own({ kind: 'user_msg', text: '골라줘' }),
      foreign([{ type: 'text', text: '진행 중' }]),
      foreign([{ type: 'tool_call', toolId: 'q0', name: 'Read', input: { file_path: '/a.ts' } }]),
      foreign([{ type: 'text', text: lead }]),
      own({ kind: 'question_request', req: { ...questReq, id: 'q-lead', lead } }),
    ],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
    view: 'summary',
  })
  eq('요약에서도 lead 말풍선은 남고 진행 보고는 숨긴다', summaryLead.segs.map((s) => (s.kind === 'text' || s.kind === 'live' ? `${s.kind}:${s.text}` : s.kind)), ['user', 'tools', `text:${lead}`, 'question'])
}

// 명령 요약 줄은 턴이 닫힐 때 한꺼번에 놓이므로, 턴 도중에 뜬 카드·배너보다 아래에 온다.
//   카드끼리의 시간 순서는 그대로 지킨다 — 그것만 어긋나면 "무엇을 승인했는지"가 뒤바뀌어 보인다.
const withCard = build(
  [
    own({ kind: 'user_msg', text: '고쳐줘' }),
    foreign([{ type: 'tool_call', toolId: 'p0', name: 'Read', input: { file_path: '/a.ts' } }]),
    own({ kind: 'permission_request', req: permReq }),
    foreign([{ type: 'tool_call', toolId: 'p1', name: 'Edit', input: { file_path: '/a.ts' } }]),
    foreign([{ type: 'text', text: '고쳤습니다' }]),
    foreign([{ type: 'turn_completed', status: 'ok' }]),
  ],
  'idle',
)
eq('턴 도중의 카드는 제자리에 두고 명령 요약 줄은 그 아래로 모은다', withCard.segs.map((s) => s.kind), ['user', 'permission', 'tools', 'text', 'result'])
eq('카드로 끊기지 않고 도구는 여전히 하나로 합쳐진다', (withCard.segs.find((s) => s.kind === 'tools') as Extract<StreamSeg, { kind: 'tools' }>).tools.length, 2)

// ── 찾기 대상: 화면에 남는 말 전부. 조각에서 뽑으므로 결과를 누르면 항상 갈 자리가 있다. ──
eq('찾기 대상은 사람 입력·작업 중 알림·최종 답변', done.searchable.map((x) => x.text), ['고쳐줘', '2번 파일도', '다 고쳤습니다'])
eq('진행 중에도 화면에 보이는 말은 전부 찾힌다', running.searchable.map((x) => x.text), ['고쳐줘', '2번 파일도', '다 고쳤습니다'])
check('찾기 대상은 조각의 점프 좌표를 그대로 쓴다', done.searchable.every((x) => done.segs.some((s) => s.seq === x.seq)))

// ── 한도 배너: 경고와 정보성은 없고, 막힘은 마지막 1건만 ──
const spam = buildStreamSegments({
  items: [
    foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'blocked', utilization: 0.5 }]),
    foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'warn', utilization: 0.9 }]),
    foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'blocked', utilization: 1 }]),
    foreign([{ type: 'provider_notice', kind: 'rate_limit' }]), // severity 없음 = 정보성
  ],
  turn: 'idle',
  providerName: 'MockProvider',
  answers: {},
  t,
})
eq('경고·정보성은 배너 없음, 막힘은 마지막 1건만', spam.segs.map((s) => (s.kind === 'banner' ? s.text : s.kind)).filter((x) => String(x).includes('stream.rateLimit.rejected')).length, 1)
check('남은 배너는 마지막 막힘의 사용률이다', spam.segs.some((s) => s.kind === 'banner' && s.text.includes('100%')))
eq('한도 배너 총 1개', spam.segs.filter((s) => s.kind === 'banner').length, 1)

// ── 빈 세션 판정: 배너만 있으면 대화 없음 ──
const bannerOnly = buildStreamSegments({ items: [own({ kind: 'notice', notice: 'resumed' }), own({ kind: 'status', status: 'crashed' })], turn: 'idle', providerName: 'MockProvider', answers: {}, t })
check('배너만 있는 세션은 "대화 없음"으로 본다', bannerOnly.hasConvo === false)
check('사람 입력이 있으면 대화 있음', buildStreamSegments({ items: [own({ kind: 'user_msg', text: '안녕' })], turn: 'idle', providerName: 'MockProvider', answers: {}, t }).hasConvo === true)

// ── 점프 좌표: 모든 조각이 자기 이벤트 seq를 안다 ──
check('모든 조각이 seq를 갖는다(검색 점프 좌표)', built.segs.every((s) => Number.isFinite(s.seq) && s.seq > 0))
check('조각 key는 서로 다르다(React 재사용 사고 방지)', new Set(built.segs.map((s) => s.key)).size === built.segs.length)

const noTask = buildStreamSegments({
  items: [own({ kind: 'user_msg', text: '안녕' }), foreign([{ type: 'text', text: '안녕' }, { type: 'turn_completed', status: 'ok' }])],
  turn: 'idle',
  providerName: 'MockProvider',
  answers: {},
  t,
})
check('자식 작업이 없으면 팀 조각을 안 만든다', !noTask.segs.some((s) => s.kind === 'team'), noTask.segs.map((s) => s.kind))

// ── 질문 카드: 답한 뒤에도 원문·선택지가 남고, 새로고침은 이벤트 답을 쓴다 ──
{
  const q = {
    id: 'q-keep',
    toolUseID: 'tu-k',
    questions: [{ question: '이 작업에 어떤 방식을 쓸까요?', header: '진행 방식', options: [{ label: '바로 실행' }, { label: 'plan으로 먼저' }] }],
    createdAt: 1,
  }
  const fromStore = buildStreamSegments({
    items: [own({ kind: 'user_msg', text: '배포해줘' }), own({ kind: 'question_request', req: q }), own({ kind: 'question_resolved', id: 'q-keep', answered: true })],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: { 'q-keep': [['바로 실행']] },
    t,
  })
  const qSeg = fromStore.segs.find((s) => s.kind === 'question') as Extract<StreamSeg, { kind: 'question' }>
  eq('답한 카드도 질문 원문을 들고 있다', qSeg.req.questions[0].question, '이 작업에 어떤 방식을 쓸까요?')
  eq('로컬 답을 카드에 넘긴다', qSeg.savedAnswers, [['바로 실행']])
  check('찾기에 질문 원문이 들어간다', fromStore.searchable.some((x) => x.text.includes('이 작업에 어떤 방식을 쓸까요?')), fromStore.searchable)

  const fromEvent = buildStreamSegments({
    items: [
      own({ kind: 'user_msg', text: '배포해줘' }),
      own({ kind: 'question_request', req: q }),
      own({ kind: 'question_resolved', id: 'q-keep', answered: true, answers: [['바로 실행']] }),
    ],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  const qSeg2 = fromEvent.segs.find((s) => s.kind === 'question') as Extract<StreamSeg, { kind: 'question' }>
  eq('새로고침 후에도 이벤트에 남은 답을 쓴다', qSeg2.savedAnswers, [['바로 실행']])
  const echo = fromEvent.segs.find((s) => s.kind === 'choice') as Extract<StreamSeg, { kind: 'choice' }>
  eq('선택 에코는 질문 카드 다음에 온다', fromEvent.segs.map((s) => s.kind).slice(fromEvent.segs.findIndex((s) => s.kind === 'question'), fromEvent.segs.findIndex((s) => s.kind === 'question') + 2), ['question', 'choice'])
  eq('선택 에코 라벨', echo.labels, ['바로 실행'])
}

{
  const blank = build(
    [own({ kind: 'user_msg', text: '비워' }), foreign([{ type: 'text', text: '(no content)' }]), foreign([{ type: 'turn_completed', status: 'ok' }])],
    'idle',
  )
  eq('자리표시자 텍스트는 조각이 되지 않는다', blank.segs.map((s) => s.kind), ['user', 'result'])
  const pendingQ = build([own({ kind: 'user_msg', text: '골라' }), own({ kind: 'question_request', req: questReq })], 'running')
  check('미답 질문에는 선택 에코가 없다', !pendingQ.segs.some((s) => s.kind === 'choice'), pendingQ.segs.map((s) => s.kind))
}

{
  const skipped = buildStreamSegments({
    items: [
      own({ kind: 'user_msg', text: '골라' }),
      own({ kind: 'question_request', req: questReq }),
      own({ kind: 'question_resolved', id: 'q-1', answered: false }),
    ],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  const qSeg = skipped.segs.find((s) => s.kind === 'question') as Extract<StreamSeg, { kind: 'question' }>
  check('넘어간 질문은 카드가 닫힌다', qSeg.resolved === true && qSeg.skipped === true, qSeg)
  check('넘어간 질문에는 선택 에코가 없다', !skipped.segs.some((s) => s.kind === 'choice'), skipped.segs.map((s) => s.kind))
}

{
  const verbose = buildStreamSegments({
    items: [...turnItems(), foreign([{ type: 'turn_completed', status: 'ok' }])],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
    view: 'verbose',
  })
  eq('자세히 모드는 진행 보고를 쌓는다', liveTextsOf(verbose), ['1번 파일부터', '2번 파일도'])
  eq('자세히 모드도 마지막 말은 최종 답이다', (verbose.segs.find((s) => s.kind === 'text') as Extract<StreamSeg, { kind: 'text' }>).text, '다 고쳤습니다')
  const summary = buildStreamSegments({
    items: [...turnItems(), foreign([{ type: 'turn_completed', status: 'ok' }])],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
    view: 'summary',
  })
  eq('요약 모드는 진행 보고를 숨긴다', summary.segs.map((s) => s.kind), ['user', 'tools', 'text', 'result'])
  check('요약 모드 찾기에 진행 보고가 없다', !summary.searchable.some((x) => x.text === '2번 파일도'), summary.searchable)
  check('자세히 모드 찾기에 앞 진행 보고가 있다', verbose.searchable.some((x) => x.text === '1번 파일부터'), verbose.searchable)
}

{
  const hidden = buildStreamSegments({
    items: [
      own({ kind: 'user_msg', text: '골라' }),
      foreign([
        { type: 'tool_call', toolId: 'a1', name: 'AskUserQuestion', toolKind: 'other', target: 'q' },
        { type: 'tool_call', toolId: 'a2', name: 'ask_user_question', toolKind: 'other', target: 'q' },
        { type: 'tool_call', toolId: 'r1', name: 'read_file', toolKind: 'file_read', target: 'a.ts' },
      ]),
    ],
    turn: 'running',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  const tools = hidden.segs.filter((s) => s.kind === 'tools') as Extract<StreamSeg, { kind: 'tools' }>[]
  const names = tools.flatMap((s) => s.tools.map((x) => x.name))
  check('질문 도구는 명령 줄에 안 나온다', names.every((n) => n === 'read_file') && names.includes('read_file'), names)
}

// ── 참딩 국면(chamdingPhase) ──
//   사건 → 국면 매핑(streamSegments.ts 끝부분)이 맞는지. success/error/confused는 "방금 막 온 사건"일 때만
//   그 값이어야 한다 — 뒤에 새 사건이 더 오면 다른 국면으로 넘어가야 한다.
{
  const thinking = build([own({ kind: 'user_msg', text: '빌드해줘' })], 'running')
  eq('도구도 말도 아직 없으면 생각 중', thinking.chamdingPhase, 'thinking')

  const working = build([own({ kind: 'user_msg', text: '빌드해줘' }), foreign([{ type: 'tool_call', toolId: 'w1', name: 'Bash', toolKind: 'bash', target: 'npm run build' }])], 'running')
  eq('도구가 도는 중이면 일하는 중', working.chamdingPhase, 'working')
  check('꼬리가 도구 줄이고 턴이 돌면 진행 구슬을 띄운다', working.showOrb === true)

  const ok = build([...turnItems(), foreign([{ type: 'turn_completed', status: 'ok' }])], 'idle')
  eq('턴이 방금 성공으로 끝났으면 성공', ok.chamdingPhase, 'success')
  check('성공 몸짓이 뜨도록 구슬 자리를 계속 보여준다(turn이 idle이어도)', ok.showOrb === true)

  const failed = build([...turnItems(), foreign([{ type: 'turn_completed', status: 'failed', error: '중단' }])], 'idle')
  eq('턴이 방금 실패로 끝났으면 실패', failed.chamdingPhase, 'error')

  const interrupted = build([...turnItems(), own({ kind: 'status', status: 'interrupted' })], 'idle')
  eq('사용자가 멈춘 것은 성공/실패 몸짓 없이 가만히', interrupted.chamdingPhase, 'idle')

  const toolErr = build(
    [own({ kind: 'user_msg', text: '읽어줘' }), foreign([{ type: 'tool_call', toolId: 'r1', name: 'Read', toolKind: 'file_read', target: '/missing.ts' }]), foreign([{ type: 'tool_result', toolId: 'r1', output: 'ENOENT', isError: true }])],
    'running',
  )
  eq('마지막 도구가 실패로 끝나고 새 도구가 없으면 실패', toolErr.chamdingPhase, 'error')

  const recovered = build(
    [
      own({ kind: 'user_msg', text: '읽어줘' }),
      foreign([{ type: 'tool_call', toolId: 'r1', name: 'Read', toolKind: 'file_read', target: '/missing.ts' }]),
      foreign([{ type: 'tool_result', toolId: 'r1', output: 'ENOENT', isError: true }]),
      foreign([{ type: 'tool_call', toolId: 'r2', name: 'Read', toolKind: 'file_read', target: '/ok.ts' }]),
    ],
    'running',
  )
  eq('실패한 도구 뒤에 새 도구가 돌면 다시 일하는 중', recovered.chamdingPhase, 'working')

  const teamOnly = build(
    [own({ kind: 'user_msg', text: '찾아줘' }), foreign([{ type: 'tool_call', toolId: 'task-9', name: 'Task', toolKind: 'task', target: 'auth' }])],
    'running',
  )
  eq('자식 작업만 도는 턴은 일하는 중', teamOnly.chamdingPhase, 'working')
  check('자식 작업만 도는 턴도 진행 구슬을 띄운다', teamOnly.showOrb === true)

  const blocked = build([own({ kind: 'user_msg', text: '빌드해줘' }), foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'blocked', limitType: 'weekly' }])], 'running')
  eq('막 받은 과금 한도 차단 알림은 당황', blocked.chamdingPhase, 'confused')
  check('당황 몸짓이 뜨도록 구슬 자리를 보여준다', blocked.showOrb === true)

  const blockedThenTool = build(
    [
      own({ kind: 'user_msg', text: '빌드해줘' }),
      foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'blocked', limitType: 'weekly' }]),
      foreign([{ type: 'tool_call', toolId: 'w2', name: 'Bash', toolKind: 'bash', target: 'npm run build' }]),
    ],
    'running',
  )
  eq('당황 알림 뒤에 새 사건이 오면 당황은 풀린다', blockedThenTool.chamdingPhase, 'working')

  const idleNoTurn = build([], 'idle')
  eq('아무 턴도 없으면 idle', idleNoTurn.chamdingPhase, 'idle')

  const fallback = build([own({ kind: 'user_msg', text: '계속해줘' }), foreign([{ type: 'provider_notice', kind: 'model_fallback', severity: 'warn', detail: 'gpt-fallback', originalModel: 'gpt-original', category: 'safety' }])], 'running')
  eq('막 받은 모델 강제 전환 알림은 놀람', fallback.chamdingPhase, 'surprise')
  check('놀람 몸짓이 뜨도록 구슬 자리를 보여준다', fallback.showOrb === true)

  const fallbackThenText = build(
    [
      own({ kind: 'user_msg', text: '계속해줘' }),
      foreign([{ type: 'provider_notice', kind: 'model_fallback', severity: 'warn', detail: 'gpt-fallback', originalModel: 'gpt-original', category: 'safety' }]),
      foreign([{ type: 'text', text: '다시 해볼게요' }]),
    ],
    'running',
  )
  eq('놀람 알림 뒤에 새 사건이 오면 놀람은 풀린다', fallbackThenText.chamdingPhase, 'thinking')

  const waiting = buildStreamSegments({
    items: [own({ kind: 'user_msg', text: '지워도 될까?' }), own({ kind: 'permission_request', req: permReq })],
    turn: 'requires_action',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  eq('권한 카드가 떠서 답을 기다리는 중이면 대기', waiting.chamdingPhase, 'waiting')
  check('대기 중에도 구슬 자리를 보여준다(카드만 뜨던 지금까지와 다르게)', waiting.showOrb === true)

  // 실측(2026-10-01, 개발 서버 스크린샷)으로 잡은 버그: 도구 호출 바로 뒤에 권한 카드가 뜨면, 그 도구는
  //   settle 없이 카드 뒤로 밀려 쌓이다가 맨 끝에 flush되어 "꼬리가 도구런"으로 오판되고 참딩이 숨었다.
  const waitingAfterTool = buildStreamSegments({
    items: [
      own({ kind: 'user_msg', text: '파일 하나 써줘' }),
      foreign([{ type: 'tool_call', toolId: 'w1', name: 'Write', toolKind: 'file_change', target: '/tmp/x.txt' }]),
      own({ kind: 'permission_request', req: permReq }),
    ],
    turn: 'requires_action',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  eq('도구 호출 직후 권한 카드가 떠도 대기 국면이다', waitingAfterTool.chamdingPhase, 'waiting')
  check('도구 호출 직후 권한 카드여도 구슬을 숨기지 않는다(회귀)', waitingAfterTool.showOrb === true)
}

// ── 턴 끝 원인·turnKey (목록 순서, 결과 조각의 자리 이름) ──
{
  const learned = build(
    [own({ kind: 'user_msg', text: '배워' }), foreign([{ type: 'turn_completed', status: 'ok' }]), own({ kind: 'notice', notice: 'distill_model', detail: 'small' })],
    'idle',
  )
  eq('성공 결과 뒤의 배경 모델 알림은 성공을 지우지 않는다', learned.chamdingPhase, 'success')

  // 옛 서버가 저장한 학습 알림은 그릴 곳이 없어 조각을 만들지 않는다.
  const legacy = build(
    [own({ kind: 'user_msg', text: '옛' }), own({ kind: 'notice', notice: 'skill_learned' } as never)],
    'idle',
  )
  eq('옛 학습 알림은 조각이 되지 않는다', legacy.segs.some((x) => x.kind === 'banner'), false)

  const modelInfo = build(
    [own({ kind: 'user_msg', text: '배워' }), foreign([{ type: 'turn_completed', status: 'ok' }]), foreign([{ type: 'model_info', model: 'x' }])],
    'idle',
  )
  eq('성공 결과 뒤의 모델 정보는 성공을 지우지 않는다', modelInfo.chamdingPhase, 'success')

  const blockedCrash = build(
    [
      own({ kind: 'user_msg', text: '해' }),
      foreign([{ type: 'provider_notice', kind: 'rate_limit', severity: 'blocked', limitType: 'weekly' }]),
      own({ kind: 'status', status: 'crashed' }),
    ],
    'idle',
  )
  eq('과금 차단 뒤 비정상 종료가 붙어도 당황이 이긴다', blockedCrash.chamdingPhase, 'confused')

  const crashed = build([own({ kind: 'user_msg', text: '해' }), own({ kind: 'status', status: 'crashed' })], 'idle')
  eq('비정상 종료만 있으면 실패', crashed.chamdingPhase, 'error')

  const stopped = build([own({ kind: 'user_msg', text: '해' }), own({ kind: 'status', status: 'interrupted' })], 'idle')
  eq('사용자가 멈춘 상태만 있으면 가만히', stopped.chamdingPhase, 'idle')

  const firstUser = own({ kind: 'user_msg', text: '첫' })
  const doneEvt = foreign([{ type: 'turn_completed', status: 'ok' }])
  const localNext = { seq: -7, ts: 50, kind: 'local_user', text: '다음' } as ConvoItem
  const serverNext = own({ kind: 'user_msg', text: '다음' })
  const pre = build([firstUser], 'running')
  const doneOnly = build([firstUser, doneEvt], 'idle')
  const withLocal = build([firstUser, doneEvt, localNext], 'running')
  const withServer = build([firstUser, doneEvt, serverNext], 'running')
  check('결과가 없으면 turnKey는 비어 있다', pre.turnKey === null)
  eq('결과가 붙으면 turnKey는 그 결과 조각의 자리다', doneOnly.turnKey, `r-${doneEvt.seq}`)
  check('결과가 붙으면 결과 전의 turnKey와 다르다', doneOnly.turnKey !== pre.turnKey)
  check('임시 글이 서버 글로 바뀌어도 turnKey는 그대로다', withLocal.turnKey === withServer.turnKey && withLocal.turnKey === doneOnly.turnKey)
  check('대기열 글이 결과와 같은 목록에 붙어도 결과 전의 turnKey와는 다르다', withLocal.turnKey !== pre.turnKey)
}

// ── 보이기 관리자. 시각은 시험이 넘긴다. ──
{
  const input = (active: boolean, phase: ChamdingPhase, turnKey: string | null = null) => ({ active, phase, turnKey })

  // 생각 0 → 도구 100. 500ms에 예약된 시각이 오면 일하는 중으로 한 번 바뀐다.
  //   900ms의 생각은 렌즈를 너무 빨리 올리지 않으므로 되돌아가지 않는다. 1600ms의 도구는 이미 그 자세다.
  let chain = stepPresence(INITIAL_PRESENCE, input(true, 'thinking'), 0)
  chain = stepPresence(chain, input(true, 'working'), 100)
  eq('도구가 끼어든 직후에도 보이는 국면은 생각', chain.shown, 'thinking')
  chain = tickPresence(chain, 500)
  eq('최소 유지가 지나면 일하는 중으로 한 번 바뀐다', chain.shown, 'working')
  chain = tickPresence(chain, 700)
  chain = stepPresence(chain, input(true, 'thinking'), 900)
  eq('짧은 생각으로는 일하는 중에서 되돌아가지 않는다', chain.shown, 'working')
  chain = stepPresence(chain, input(true, 'working'), 1600)
  eq('다시 도구가 와도 일하는 중 그대로다', chain.shown, 'working')

  let lens = stepPresence(INITIAL_PRESENCE, input(true, 'working'), 0)
  lens = stepPresence(lens, input(true, 'thinking'), 0)
  eq('일하는 중에서 생각으로 바로 바꾸지 않는다', lens.shown, 'working')
  lens = tickPresence(lens, 1199)
  eq('1200ms 전에는 렌즈를 올리지 않는다', lens.shown, 'working')
  lens = tickPresence(lens, 1200)
  eq('생각이 1200ms 넘게 이어지면 생각으로 바뀐다', lens.shown, 'thinking')

  let dwell = stepPresence(INITIAL_PRESENCE, input(true, 'thinking'), 0)
  dwell = stepPresence(dwell, input(true, 'working'), 100)
  dwell = tickPresence(dwell, 499)
  eq('500ms 전에는 국면이 안 바뀐다', dwell.shown, 'thinking')
  dwell = tickPresence(dwell, 500)
  eq('500ms가 되면 국면이 바뀐다', dwell.shown, 'working')

  // 드러남은 이미 끝난 뒤라, 500ms에 변화가 없어도 다음 기한은 렌즈 유지(1200)다.
  let wake = stepPresence(INITIAL_PRESENCE, input(true, 'working'), -1000)
  wake = tickPresence(wake, -200)
  check('마운트 후 700ms가 지나면 드러난다', wake.revealed === true)
  wake = stepPresence(wake, input(true, 'thinking'), 0)
  const mid = tickPresence(wake, 500)
  eq('500ms에 깨워도 아직 일하는 중이다', mid.shown, 'working')
  eq('변화가 없어도 다음 기한은 1200ms다', nextWake(mid, 500), 1200)

  let jumped = stepPresence(INITIAL_PRESENCE, input(true, 'thinking'), 0)
  jumped = stepPresence(jumped, input(true, 'working'), 100)
  jumped = tickPresence(jumped, 3000)
  eq('한 번에 여러 기한을 지나도 마지막 국면은 일하는 중이다', jumped.shown, 'working')
  check('한 번에 여러 기한을 지나도 드러나 있다', jumped.revealed === true && jumped.mounted === true)

  let earlyEnd = stepPresence(INITIAL_PRESENCE, input(true, 'thinking'), 0)
  earlyEnd = stepPresence(earlyEnd, input(false, 'success', 'r'), 699)
  check('699ms에 끝난 턴은 드러나지 않고 바로 치운다', earlyEnd.mounted === false)

  let finale = stepPresence(INITIAL_PRESENCE, input(true, 'thinking'), 0)
  finale = stepPresence(finale, input(false, 'success', 'r'), 700)
  check('700ms에 끝난 턴은 마무리로 남는다', finale.mounted === true && finale.shown === 'success' && finale.endAt === 2500)

  const refresh = stepPresence(INITIAL_PRESENCE, input(false, 'success', 'r'), 0)
  check('끝난 턴의 성공만으로는 마운트하지 않는다', refresh === INITIAL_PRESENCE && refresh.mounted === false)

  let shown = stepPresence(INITIAL_PRESENCE, input(true, 'thinking', 'k'), 0)
  shown = tickPresence(shown, 700)
  shown = stepPresence(shown, input(false, 'success', 'k'), 1000)
  check('성공 마무리는 1560ms 전에 아직 흐려지지 않는다', tickPresence(shown, 2559).leaving === false && tickPresence(shown, 2559).mounted === true)
  check('성공 마무리는 1560ms에 흐려진다', tickPresence(shown, 2560).leaving === true && tickPresence(shown, 2560).mounted === true)
  check('성공 마무리는 1800ms에 치운다', tickPresence(shown, 2800).mounted === false)

  let bigTick = stepPresence(INITIAL_PRESENCE, input(true, 'thinking', 'k'), 0)
  bigTick = tickPresence(bigTick, 700)
  bigTick = stepPresence(bigTick, input(false, 'success', 'k'), 700)
  bigTick = tickPresence(bigTick, 3700)
  check('마무리를 한 번에 지나면 치워진 상태가 된다', bigTick.mounted === false)

  let stoppedRun = stepPresence(INITIAL_PRESENCE, input(true, 'thinking'), 0)
  stoppedRun = tickPresence(stoppedRun, 800)
  stoppedRun = stepPresence(stoppedRun, input(false, 'idle'), 900)
  check('사용자가 멈추면 바로 치운다', stoppedRun.mounted === false)

  let again = stepPresence(INITIAL_PRESENCE, input(true, 'thinking', 'k'), 0)
  again = tickPresence(again, 700)
  again = stepPresence(again, input(false, 'success', 'k'), 1000)
  const epochBefore = again.epoch
  again = stepPresence(again, input(true, 'thinking', 'k'), 1200)
  check('마무리 중 새 턴이면 마운트를 유지하고 턴 번호가 하나 오른다', again.mounted === true && again.epoch === epochBefore + 1 && again.endAt === null)

  let keyed = stepPresence(INITIAL_PRESENCE, input(true, 'working', 'a'), 0)
  keyed = tickPresence(keyed, 700)
  keyed = stepPresence(keyed, input(false, 'success', 'a'), 1000)
  const keyedEpoch = keyed.epoch
  keyed = stepPresence(keyed, input(true, 'working', 'b'), 1100)
  check('마운트 중 turnKey가 바뀌면 턴 번호가 오르고 마무리를 생략한다', keyed.mounted === true && keyed.epoch === keyedEpoch + 1 && keyed.endAt === null && keyed.shown === 'working')

  let wait = stepPresence(INITIAL_PRESENCE, input(true, 'waiting'), 0)
  wait = tickPresence(wait, 5000)
  check('권한 대기는 마운트를 유지하고 대기 국면이다', wait.mounted === true && wait.shown === 'waiting')

  const beforeSwitch = tickPresence(stepPresence(INITIAL_PRESENCE, input(true, 'working', 'a'), 0), 900)
  check('세션을 바꾸기 전에는 마운트돼 있다', beforeSwitch.mounted === true)
  const afterSwitch = stepPresence(INITIAL_PRESENCE, input(false, 'success', 'a'), 1000)
  check('세션이 바뀌면 처음 상태라 끝난 성공으로는 다시 안 뜬다', afterSwitch === INITIAL_PRESENCE)

  const same = stepPresence(INITIAL_PRESENCE, input(true, 'thinking', 'a'), 0)
  check('같은 입력이면 같은 객체를 돌려준다', stepPresence(same, { active: true, phase: 'thinking', turnKey: 'a' }, 999) === same)
  check('기한이 안 된 tick도 같은 객체를 돌려준다', tickPresence(same, 0) === same)
}

// 권한 칩으로 바꾼 사실도 대화에 한 줄 남는다. 켠 쪽과 끈 쪽이 서로 다른 문구다.
{
  const perm = buildStreamSegments({
    items: [own({ kind: 'local_notice', variant: 'permission', detail: 'full' }), own({ kind: 'local_notice', variant: 'permission', detail: 'ask' }), own({ kind: 'local_notice', variant: 'permission', detail: 'auto' })],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  }).segs.filter((x) => x.kind === 'banner') as Extract<StreamSeg, { kind: 'banner' }>[]
  // 옛 기록의 'ask'는 수동으로 읽는다.
  eq(
    '권한 모드 변경 알림',
    perm.map((x) => x.text).join('|'),
    [
      'stream.notice.permissionChanged(mode=session.permission.mode.full)',
      'stream.notice.permissionChanged(mode=session.permission.mode.manual)',
      'stream.notice.permissionChanged(mode=session.permission.mode.auto)',
    ].join('|'),
  )
}

{
  // 옛 서버가 남긴 브리프 사건은 카드를 그리지 않고, 앞뒤 대화 조각도 바꾸지 않는다.
  const doneTurn = [
    own({ kind: 'user_msg', text: '안녕' }),
    foreign([{ type: 'text', text: '네' }]),
    foreign([{ type: 'turn_completed', status: 'ok', durationMs: 10 }]),
  ]
  const plain = buildStreamSegments({ items: doneTurn, turn: 'idle', providerName: 'MockProvider', answers: {}, t })
  const withOld = buildStreamSegments({
    items: [
      ...doneTurn,
      own({ kind: 'brief_opened', briefId: 'b1', version: 1, text: '원문', clientMessageId: 'cm-1', state: { id: 'b1', version: 1, slots: [] } }),
      own({ kind: 'brief_updated', briefId: 'b1', version: 2, state: { id: 'b1', version: 2, slots: [] } }),
      own({ kind: 'agent' }),
    ],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  eq('옛 브리프 사건은 조각을 더하지 않는다', withOld.segs.map((seg) => seg.kind), plain.segs.map((seg) => seg.kind))
  eq('옛 브리프 사건이 있어도 진행 단계는 그대로다', withOld.chamdingPhase, plain.chamdingPhase)
  eq('옛 브리프 사건은 찾기 색인에 들지 않는다', withOld.searchable, plain.searchable)
  const proceeded = buildStreamSegments({
    items: [...doneTurn, own({ kind: 'user_msg', text: '진행본문', briefId: 'b1', clientMessageId: 'brief:b1:1' })],
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  eq('옛 브리프의 진행 글은 보통 말풍선으로 남는다', proceeded.segs.filter((seg) => seg.kind === 'user').map((seg) => (seg.kind === 'user' ? seg.text : '')), ['안녕', '진행본문'])
}

{
  const answer = '최종 답입니다'
  const user = own({ kind: 'user_msg', text: '일반 질문' })
  const body = foreign([{ type: 'text', text: answer }])
  const done = foreign([{ type: 'turn_completed', status: 'ok', durationMs: 12 }])
  const opened = own({ kind: 'brief_opened', briefId: 'b-mid', version: 1, text: '브리프 원문', clientMessageId: 'cm-mid', state: { id: 'b-mid', version: 1, slots: [] } })
  const plain = [user, body, done]
  const mixed = [user, body, opened, done]
  const finals = (items: ConvoItem[], view: 'normal' | 'summary') =>
    buildStreamSegments({
      items,
      turn: 'idle',
      providerName: 'MockProvider',
      answers: {},
      t,
      view,
    }).segs.flatMap((seg) => (seg.kind === 'text' ? [seg.text] : []))
  eq('브리프가 없으면 일반 화면의 마지막 말이 최종 답변이다', finals(plain, 'normal'), [answer])
  eq('브리프가 없으면 요약 화면의 마지막 말도 최종 답변이다', finals(plain, 'summary'), [answer])
  eq('옛 브리프 사건이 끼어도 일반 화면의 최종 답변은 같다', finals(mixed, 'normal'), finals(plain, 'normal'))
  eq('옛 브리프 사건이 끼어도 요약 화면의 최종 답변은 같다', finals(mixed, 'summary'), finals(plain, 'summary'))
  const temp = own({ kind: 'local_user', text: '임시 말', clientMessageId: 'cm-temp' })
  const mixedTemp = [user, body, temp, done]
  eq('임시 말이 끼면 앞 턴의 최종 답변은 닫힌다', finals(mixedTemp, 'normal'), [])
  eq('임시 말이 끼면 요약 화면의 최종 답변도 닫힌다', finals(mixedTemp, 'summary'), [])
  const tempShown = buildStreamSegments({
    items: mixedTemp,
    turn: 'idle',
    providerName: 'MockProvider',
    answers: {},
    t,
  })
  check('임시 말은 그 자리에 남는다', tempShown.segs.some((seg) => seg.kind === 'user' && seg.text === '임시 말'))
  const proceed = own({ kind: 'user_msg', text: '진행본문', briefId: 'b-mid', clientMessageId: 'brief:b-mid:1' })
  const closed = finals([user, body, opened, proceed, done], 'normal')
  eq('옛 브리프 진행 사건은 앞 턴의 최종 답변을 닫는다', closed, [])
}

// ── 하위 작업(보조 에이전트) 발화는 메인 대화에 그리지 않는다 ──
{
  const u = own({ kind: 'user_msg', text: '질문', clientMessageId: 'cm-sub' })
  const sub = foreign([{ type: 'text', text: '보조 발화', subtaskOf: 'tu-agent' } as never])
  const main = foreign([{ type: 'text', text: '메인 발화' }])
  const r = buildStreamSegments({ items: [u, sub, main], turn: 'idle', providerName: 'MockProvider', answers: {}, t })
  const texts = r.segs.flatMap((seg) => ('text' in seg && typeof seg.text === 'string' ? [seg.text] : []))
  check('하위 작업 발화는 숨기고 메인 발화는 남는다', !texts.includes('보조 발화') && texts.includes('메인 발화'), texts)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} streamSegments: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
