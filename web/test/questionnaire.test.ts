/**
 * 브리프 질문지 화면 쪽 시험(Q2). 실행: cd server && npx tsx ../web/test/questionnaire.test.ts
 *   (경로 별칭 때문에 서버 폴더에서 돈다.)
 *
 * 다루는 것: 닫힘 상태 계산, 질문지 상자 가리기, 카드 상태, 보내는 몸통, 보내기 실패 뒤 재전송,
 *   대기열 멈춤, 세션 상태(requires_action), 새로고침 복원(사건만으로), 글 입력 칸 Enter 판정.
 * 다루지 못하는 것(화면 확인 필요): 줄 펼침·초점 이동·sticky 아래 줄·폰 폭 배치 같은 DOM 동작.
 */
import {
  answerMessageId,
  buildAnswers,
  cardView,
  clearAnswer,
  draftFromAnswer,
  hideBoxes,
  initialDrafts,
  pendingQuestionnaire,
  pickOption,
  questionnaireStates,
  removeLastBox,
  rowStatus,
  setCustom,
  swallowEnter,
  type Drafts,
} from '../src/lib/questionnaire'
import { buildStreamSegments, type StreamSeg } from '../src/lib/streamSegments'
import { api } from '../src/lib/api'
import { actions, composerTurn, deriveTurn, getState, queueFlushHeld, __ingestForTest, type ConvoItem, type State } from '../src/lib/store'
import type { QuestionnaireQuestion } from '../src/lib/types'

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
const t = (key: string, params?: Record<string, string | number>) =>
  params && Object.keys(params).length ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key

// ── 사건 만들기 ──
let seq = 0
const own = (o: Record<string, unknown>): ConvoItem => ({ seq: ++seq, ts: 1000 + seq, ...o }) as unknown as ConvoItem
const userMsg = (text = '질문', extra: Record<string, unknown> = {}) => own({ kind: 'user_msg', text, ...extra })
/** 모델 글 한 사건. 조각 번호는 배열 순서다. */
const modelText = (...texts: string[]): ConvoItem => {
  const s = ++seq
  return {
    seq: s,
    ts: 1000 + s,
    kind: 'agent',
    events: texts.map((text, part) => ({ provider: 'claude', seq: s, part, ts: 1000 + s, type: 'text', text })),
  } as unknown as ConvoItem
}
const toolCall = (): ConvoItem => {
  const s = ++seq
  return { seq: s, ts: 1000 + s, kind: 'agent', events: [{ provider: 'claude', seq: s, part: 0, ts: 1000 + s, type: 'tool_call', toolId: `tc-${s}`, name: 'Bash', toolKind: 'bash', target: 'ls' }] } as unknown as ConvoItem
}
const delta = (text: string): ConvoItem => {
  const s = ++seq
  return { seq: s, ts: 1000 + s, kind: 'agent', events: [{ provider: 'claude', seq: s, part: 0, ts: 1000 + s, type: 'text_delta', text }] } as unknown as ConvoItem
}
const turnEnd = (): ConvoItem => {
  const s = ++seq
  return { seq: s, ts: 1000 + s, kind: 'agent', events: [{ provider: 'claude', seq: s, part: 0, ts: 1000 + s, type: 'turn_completed', status: 'ok' }] } as unknown as ConvoItem
}
const BOX = '```aether-questions\n{"questions":[]}\n```'
const questions: QuestionnaireQuestion[] = [
  { id: 'q1', text: '재시도할 오류 종류', kind: 'single', options: [{ label: 'GATEWAY_TIMEOUT만', description: '일시 오류만' }, { label: '모든 결제 오류' }], recommended: 'GATEWAY_TIMEOUT만' },
  { id: 'q2', text: '재시도할 단계', kind: 'multi', options: [{ label: '승인' }, { label: '취소' }, { label: '환불' }], recommended: ['승인'] },
  { id: 'q3', text: '재시도 횟수와 간격', kind: 'text', recommended: '2회, 100ms/300ms' },
  { id: 'q4', text: '기록 위치', kind: 'single', options: [{ label: '로그만' }, { label: '표에 컬럼' }] },
]
const questionnaire = (id: string, sourceSeq: number, sourcePart = 0, qs = questions): ConvoItem =>
  own({ kind: 'questionnaire', id, sourceSeq, sourcePart, questions: qs })
const failedQuestionnaire = (id: string, sourceSeq: number, sourcePart = 0): ConvoItem =>
  own({ kind: 'questionnaire', id, sourceSeq, sourcePart, invalid: true, error: 'JSON이 아니다' })

const build = (items: ConvoItem[], turn: 'idle' | 'running' = 'idle') =>
  buildStreamSegments({ items, turn, providerName: 'Mock', answers: {}, t })
const kinds = (segs: StreamSeg[]) => segs.map((s) => s.kind)
const textsOf = (segs: StreamSeg[]) => segs.flatMap((s) => (s.kind === 'text' || s.kind === 'live' ? [s.text] : []))

async function main() {
  console.log('──────── 상태 계산 ────────')
  {
    seq = 0
    const u = userMsg()
    const m = modelText(`정리했어요\n\n${BOX}`)
    const q = questionnaire('qn-a', m.seq)
    const end = turnEnd()
    eq('뒤에 보이는 사람 말이 없으면 열림', [...questionnaireStates([u, m, q, end]).entries()], [['qn-a', { status: 'open' }]])

    const answers = { q1: { chosen: ['GATEWAY_TIMEOUT만'] }, q2: { skipped: true as const } }
    const a = userMsg('브리프 질문지 답', { questionnaireAnswer: { id: 'qn-a', answers } })
    eq('닫은 말에 questionnaireAnswer가 있으면 카드로 답함(답도 돌려준다)', questionnaireStates([u, m, q, end, a]).get('qn-a'), { status: 'answered', answers })

    const chat = userMsg('그냥 채팅으로 답할게')
    eq('닫은 말에 그 필드가 없으면 채팅으로 이어감', questionnaireStates([u, m, q, end, chat]).get('qn-a'), { status: 'continued' })

    const brief = userMsg('새 브리프 요청', { briefId: 'b-1' })
    eq('새 브리프 요청도 채팅으로 이어감', questionnaireStates([u, m, q, end, brief]).get('qn-a'), { status: 'continued' })

    const other = userMsg('다른 질문지의 답', { questionnaireAnswer: { id: 'qn-zzz', answers } })
    eq('다른 질문지 id의 답은 이어감으로 본다', questionnaireStates([u, m, q, end, other]).get('qn-a'), { status: 'continued' })

    const local = own({ kind: 'local_user', text: '보내는 중' })
    eq('서버 사건이 아닌 임시 말은 닫지 않는다', questionnaireStates([u, m, q, end, local]).get('qn-a'), { status: 'open' })

    const m2 = modelText(BOX)
    const q2 = questionnaire('qn-b', m2.seq)
    const st = questionnaireStates([u, m, q, end, a, m2, q2, turnEnd()])
    eq('질문지가 둘이면 각자 계산한다', [st.get('qn-a')?.status, st.get('qn-b')?.status], ['answered', 'open'])
    eq('실패 사건은 상태가 없다', questionnaireStates([u, m, failedQuestionnaire('qn-x', m.seq), end]).size, 0)

    eq('pendingQuestionnaire: 질문지 뒤 입력이 없으면 그 질문지', pendingQuestionnaire([u, m, q, end])?.id, 'qn-a')
    eq('pendingQuestionnaire: 입력이 닫으면 없다', pendingQuestionnaire([u, m, q, end, chat]), null)
    eq('pendingQuestionnaire: 실패 사건이면 없다', pendingQuestionnaire([u, m, failedQuestionnaire('qn-x', m.seq), end]), null)
    eq('pendingQuestionnaire: 임시 말은 닫지 않는다', pendingQuestionnaire([u, m, q, end, local])?.id, 'qn-a')
    eq('pendingQuestionnaire: 목록이 없으면 없다', pendingQuestionnaire(undefined), null)
  }

  console.log('\n──────── 상자 처리(순수) ────────')
  {
    eq('상자 둘이면 마지막만 지운다', removeLastBox('앞\n```aether-questions\nA\n```\n중간\n```aether-questions\nB\n```\n끝'), '앞\n```aether-questions\nA\n```\n중간\n끝')
    eq('상자 뒤 글은 남는다', removeLastBox('앞글\n```aether-questions\nA\n```\n뒷글'), '앞글\n뒷글')
    eq('상자 없으면 원문 그대로', removeLastBox('그냥 글\n```js\nx\n```'), '그냥 글\n```js\nx\n```')
    eq('닫히지 않은 상자는 removeLastBox가 건드리지 않는다', removeLastBox('앞\n```aether-questions\n{'), '앞\n```aether-questions\n{')
    eq('여는 줄은 한 줄 전체여야 한다(문장 속은 상자가 아니다)', hideBoxes('이 글에 ```aether-questions 가 들어 있다').had, false)
    eq('닫힌 상자를 가린다', hideBoxes('앞\n```aether-questions\nA\n```\n뒤'), { text: '앞\n뒤', had: true })
    eq('닫히지 않은 상자는 끝까지 가린다', hideBoxes('앞\n```aether-questions\n{"questions":[{"id'), { text: '앞', had: true })
    eq('CRLF 줄바꿈도 같다', hideBoxes('앞\r\n```aether-questions\r\nA\r\n```\r\n뒤').had, true)
  }

  console.log('\n──────── 상자 숨기기(화면 조각) ────────')
  {
    // 1) 진행 중인 턴 — 닫히지 않은 상자도 자리 표시로
    seq = 0
    const u = userMsg()
    const open = modelText('정리했어요.\n\n```aether-questions\n{"questions":[{"id":"q1"')
    let r = build([u, open], 'running')
    eq('진행 중: 닫히지 않은 상자는 자리 표시로 바뀐다', kinds(r.segs), ['user', 'live', 'questionnairePending'])
    eq('진행 중: 상자 앞의 글은 남고 JSON은 안 보인다', textsOf(r.segs), ['정리했어요.'])

    const closed = modelText(`정리했어요.\n\n${BOX}`)
    r = build([userMsg(), closed], 'running')
    eq('진행 중: 닫힌 상자도 자리 표시로 바뀐다', kinds(r.segs), ['user', 'live', 'questionnairePending'])

    const onlyBox = modelText(BOX)
    r = build([userMsg(), onlyBox], 'running')
    eq('진행 중: 상자뿐인 글은 자리 표시만 남는다', kinds(r.segs), ['user', 'questionnairePending'])

    // 흘러오는 부분 글 — 상자가 열린 뒤부터는 자리 표시
    r = build([userMsg(), delta('정리했어요.\n```aether-que')], 'running')
    eq('진행 중: 상자 여는 줄이 완성되기 전 토큰은 그대로 보인다', kinds(r.segs).includes('questionnairePending'), false)
    r = build([userMsg(), delta('정리했어요.\n```aether-questions\n{"questions":[')], 'running')
    eq('진행 중: 흘러오는 글에 상자가 열리면 자리 표시', kinds(r.segs), ['user', 'live', 'questionnairePending'])
    r = build([userMsg(), modelText('기다립니다.'), turnEnd(), modelText('정리했어요.\n' + BOX)], 'running')
    eq('진행 중: 사람 말 없이 이어진 턴의 상자도 자리 표시로 바뀐다', kinds(r.segs).includes('questionnairePending'), true)
    {
      const src = modelText('정리\n' + BOX)
      const later = modelText('기다립니다.')
      r = build([userMsg(), src, later, questionnaire('after', src.seq), turnEnd()])
      check('상자 뒤에 글이 더 와도 카드가 나온다', kinds(r.segs).includes('questionnaire'), kinds(r.segs))
      check('상자 뒤에 글이 더 와도 원문 상자는 지운다', !textsOf(r.segs).some((x) => x.includes('aether-questions')))
      check('상자 뒤의 글은 남는다', textsOf(r.segs).some((x) => x.includes('기다립니다')))
    }
    r = build([userMsg(), modelText('끝난 글\n' + BOX), turnEnd(), modelText('이어진 글')], 'running')
    check('진행 중: 앞서 끝난 턴의 일반 상자는 원문 그대로다', textsOf(r.segs).some((x) => x.includes('aether-questions')))

    // 2) 성공 사건 — 마지막 상자를 지우고 그 글 뒤에 카드
    seq = 0
    const u2 = userMsg()
    const src = modelText(`정리했어요.\n\n${BOX}`)
    const ok = questionnaire('qn-1', src.seq)
    const done = turnEnd()
    r = build([u2, src, ok, done])
    eq('성공 사건: 말풍선, 카드, 결과 순서', kinds(r.segs), ['user', 'text', 'questionnaire', 'result'])
    eq('성공 사건: 말풍선에서 상자가 사라졌다', textsOf(r.segs), ['정리했어요.'])
    const card = r.segs.find((s) => s.kind === 'questionnaire')
    eq('성공 사건: 카드가 질문과 열림 상태를 든다', card && card.kind === 'questionnaire' ? [card.id, card.questions.length, card.state.status] : null, ['qn-1', 4, 'open'])
    check('성공 사건: 자리 표시는 없다', !kinds(r.segs).includes('questionnairePending'))

    // 성공 사건이 왔지만 턴 끝 전 — 이미 카드
    r = build([u2, src, ok], 'running')
    eq('성공 사건: 턴 끝 사건 전에도 카드가 뜬다', kinds(r.segs), ['user', 'text', 'questionnaire'])

    // 조각이 여럿인 글 — 좌표의 조각만 지운다
    seq = 0
    const u3 = userMsg()
    const multi = modelText(`첫 조각\n${BOX}`, `둘째 조각\n${BOX}`)
    const okPart = questionnaire('qn-2', multi.seq, 1)
    r = build([u3, multi, okPart, turnEnd()])
    const txt = textsOf(r.segs)[0] ?? ''
    check('조각 좌표: 지정한 조각의 상자만 지운다', txt.includes('둘째 조각') && !txt.split('둘째 조각')[1].includes('aether-questions') && txt.split('둘째 조각')[0].includes('aether-questions'), txt)

    // 3) 실패 사건 — 원문 그대로
    seq = 0
    const u4 = userMsg()
    const src4 = modelText(`정리했어요.\n\n${BOX}`)
    r = build([u4, src4, failedQuestionnaire('qn-f', src4.seq), turnEnd()])
    eq('실패 사건: 말풍선, 결과뿐 카드 없음', kinds(r.segs), ['user', 'text', 'result'])
    check('실패 사건: 원문(상자 포함)이 그대로 보인다', (textsOf(r.segs)[0] ?? '').includes('aether-questions'))
    r = build([u4, src4, failedQuestionnaire('qn-f', src4.seq)], 'running')
    check('실패 사건: 턴 끝 사건 전에도 원문을 보인다(자리 표시 아님)', !kinds(r.segs).includes('questionnairePending') && (textsOf(r.segs)[0] ?? '').includes('aether-questions'))

    // 4) 사건 없음 — 끝난 턴의 상자는 원문 그대로
    seq = 0
    const u5 = userMsg()
    const src5 = modelText(`정리했어요.\n\n${BOX}`)
    r = build([u5, src5, turnEnd()])
    eq('사건 없음: 끝난 턴이면 원문 그대로', kinds(r.segs), ['user', 'text', 'result'])
    check('사건 없음: 상자 글이 남아 있다', (textsOf(r.segs)[0] ?? '').includes('aether-questions'))

    // 5) 다음 턴이 진행 중일 때의 지난 질문지
    seq = 0
    const u6 = userMsg('첫 요청')
    const src6 = modelText(`지난 정리\n\n${BOX}`)
    const ok6 = questionnaire('qn-old', src6.seq)
    const end6 = turnEnd()
    const ans6 = userMsg('답', { questionnaireAnswer: { id: 'qn-old', answers: { q1: { chosen: ['모든 결제 오류'] } } } })
    const next6 = modelText(`이번 정리\n\n${BOX}`)
    r = build([u6, src6, ok6, end6, ans6, next6], 'running')
    eq('지난 질문지는 카드, 이번 턴의 상자는 자리 표시', kinds(r.segs), ['user', 'text', 'questionnaire', 'result', 'user', 'live', 'questionnairePending'])
    const old = r.segs.find((s) => s.kind === 'questionnaire')
    eq('지난 질문지는 답함 상태로 읽기 전용', old && old.kind === 'questionnaire' ? old.state.status : null, 'answered')

    // 6) 일반 세션 — 질문지 사건이 없고 턴이 끝났으면 상자는 평범한 코드 상자
    seq = 0
    r = build([userMsg('코드 보여줘'), modelText('예시입니다\n```aether-questions\n{"a":1}\n```'), turnEnd()])
    eq('일반 세션: 끝난 턴의 상자는 그대로 보인다', [kinds(r.segs), (textsOf(r.segs)[0] ?? '').includes('{"a":1}')], [['user', 'text', 'result'], true])

    // 작업 도중의 말(뒤에 도구가 붙는 말)의 상자는 사건이 없으면 원문
    seq = 0
    const mid = modelText(`먼저 정리\n${BOX}`)
    r = build([userMsg(), mid, toolCall(), modelText('끝났어요'), turnEnd()])
    check('작업 도중 글의 상자: 끝난 턴이면 원문으로 남는다', build([userMsg(), mid, toolCall(), modelText('끝났어요'), turnEnd()]).segs.some((s) => s.kind === 'live' && s.text.includes('aether-questions')))
    // 오류로 끝난 턴(턴 끝 사건 없이 status 사건)도 끝난 턴이다
    seq = 0
    const crashed = own({ kind: 'status', status: 'crashed' })
    r = build([userMsg(), modelText(`정리\n${BOX}`), crashed])
    check('오류로 끝난 턴의 상자는 원문 그대로', !kinds(r.segs).includes('questionnairePending'))
  }

  console.log('\n──────── 카드 상태 ────────')
  {
    const d0 = initialDrafts(questions)
    eq('추천을 미리 고른다(single, multi, text)', [d0.q1.chosen, d0.q2.chosen, d0.q3.custom], [['GATEWAY_TIMEOUT만'], ['승인'], '2회, 100ms/300ms'])
    eq('추천이 없으면 비어 있다', d0.q4, { chosen: [], custom: '', note: '' })
    let v = cardView(questions, d0)
    eq('줄 상태: 추천, 추천, 추천, 답 필요', v.rows.map((r) => r.status), ['recommended', 'recommended', 'recommended', 'needed'])
    eq('바꾼 수 0, 답 안 한 수 1, 답한 수 3', [v.changed, v.unanswered, v.answered, v.total], [0, 1, 3, 4])
    eq('답 필요가 남아 있으면 이대로 보내기', v.asIs, true)

    let d = { ...d0, q4: pickOption(questions[3], d0.q4, '로그만') }
    v = cardView(questions, d)
    eq('추천 없는 질문에 답하면 바꿈이 된다', v.rows[3].status, 'changed')
    eq('그 질문 하나만 바꿨으면 바꿈 1, 답 안 함 0', [v.changed, v.unanswered], [1, 0])

    const allRec = cardView(questions.slice(0, 3), initialDrafts(questions.slice(0, 3)))
    eq('모두 추천이면 바꿈 0 · 답 안 함 0 · 추천대로 보내기', [allRec.changed, allRec.unanswered, allRec.asIs], [0, 0, false])

    d = { ...d0, q1: pickOption(questions[0], d0.q1, '모든 결제 오류') }
    eq('single: 다른 선택지를 누르면 바꿈', rowStatus(questions[0], d.q1), 'changed')
    eq('single: 추천으로 되돌리면 다시 추천', rowStatus(questions[0], pickOption(questions[0], d.q1, 'GATEWAY_TIMEOUT만')), 'recommended')
    const m1 = pickOption(questions[1], d0.q2, '취소')
    eq('multi: 선택지를 더하면 바꿈(선택지 순서로 둔다)', [m1.chosen, rowStatus(questions[1], m1)], [['승인', '취소'], 'changed'])
    eq('multi: 다 끄면 답 필요', rowStatus(questions[1], pickOption(questions[1], d0.q2, '승인')), 'needed')
    const typed = setCustom(questions[0], d0.q1, '내가 쓴 답')
    eq('single: 직접 입력을 쓰면 고른 선택지가 풀린다', [typed.chosen, rowStatus(questions[0], typed)], [[], 'changed'])
    eq('single: 선택지를 다시 누르면 직접 입력이 비워진다', pickOption(questions[0], typed, '모든 결제 오류').custom, '')
    eq('text: 추천 문장을 지우면 답 필요', rowStatus(questions[2], setCustom(questions[2], d0.q3, '')), 'needed')
    eq('text: 추천과 다른 글이면 바꿈', rowStatus(questions[2], setCustom(questions[2], d0.q3, '3회')), 'changed')
    eq('덧붙일 말은 추천 여부를 바꾸지 않는다', rowStatus(questions[0], { ...d0.q1, note: '메모' }), 'recommended')
    eq('답 안 함 단추는 고른 것을 비운다', rowStatus(questions[0], clearAnswer(d0.q1)), 'needed')
  }

  console.log('\n──────── 보내는 몸통 ────────')
  {
    const d0 = initialDrafts(questions)
    eq('처음 상태: 추천대로, 추천 없는 질문은 답 안 함', buildAnswers(questions, d0), {
      q1: { chosen: ['GATEWAY_TIMEOUT만'] },
      q2: { chosen: ['승인'] },
      q3: { custom: '2회, 100ms/300ms' },
      q4: { skipped: true },
    })
    const d: Drafts = {
      q1: { chosen: [], custom: '  내 답  ', note: '  메모  ' },
      q2: { chosen: ['승인', '환불'], custom: '기타', note: '' },
      q3: { chosen: [], custom: '3회', note: '' },
      q4: { chosen: ['표에 컬럼'], custom: '', note: '  ' },
    }
    eq('single 직접 입력은 custom 하나, 앞뒤 공백을 뗀다, 덧붙임은 있을 때만', buildAnswers(questions, d).q1, { custom: '내 답', note: '메모' })
    eq('multi는 chosen 배열과 선택 custom', buildAnswers(questions, d).q2, { chosen: ['승인', '환불'], custom: '기타' })
    eq('text는 custom', buildAnswers(questions, d).q3, { custom: '3회' })
    eq('single 선택은 chosen 하나, 빈 덧붙임은 뺀다', buildAnswers(questions, d).q4, { chosen: ['표에 컬럼'] })
    eq('multi에서 직접 입력만 있어도 chosen은 빈 배열로 보낸다', buildAnswers([questions[1]], { q2: { chosen: [], custom: '환불만', note: '' } }).q2, { chosen: [], custom: '환불만' })
    eq('답 안 함은 덧붙임이 있어도 skipped만 보낸다', buildAnswers([questions[0]], { q1: { chosen: [], custom: '  ', note: '메모' } }).q1, { skipped: true })
    eq('모든 질문 id가 키로 들어간다', Object.keys(buildAnswers(questions, d)), ['q1', 'q2', 'q3', 'q4'])
    eq('보낸 답에서 거꾸로 만든 상태: 답 안 함은 빈 상태', draftFromAnswer({ skipped: true }), { chosen: [], custom: '', note: '' })
    eq('보낸 답에서 거꾸로 만든 상태: 값이 그대로', draftFromAnswer({ chosen: ['승인'], custom: 'x', note: 'n' }), { chosen: ['승인'], custom: 'x', note: 'n' })
  }

  console.log('\n──────── 보내기 실패와 재전송 ────────')
  {
    const answers = buildAnswers(questions, initialDrafts(questions))
    const first = answerMessageId(null, answers, () => 'id-1')
    eq('처음엔 새 식별자', first.id, 'id-1')
    eq('같은 답이면 같은 식별자를 쓴다', answerMessageId(first, answers, () => 'id-2').id, 'id-1')
    const changed = buildAnswers(questions, { ...initialDrafts(questions), q1: { chosen: ['모든 결제 오류'], custom: '', note: '' } })
    eq('답을 바꾸면 새 식별자(같은 식별자에 다른 답은 서버가 409)', answerMessageId(first, changed, () => 'id-3').id, 'id-3')

    const sid = 'qn-send-session'
    const calls: unknown[][] = []
    let failNext = true
    api.listSessions = async () => ({ rooms: [], sessions: [] })
    api.sendMessage = (async (...args: unknown[]) => {
      calls.push(args)
      if (failNext) throw new Error('boom')
      return { ok: true }
    }) as typeof api.sendMessage
    const ok1 = await actions.sendQuestionnaireAnswer(sid, 'qn-1', answers, first.id)
    eq('실패하면 false를 돌려준다', ok1, false)
    eq('실패 뒤 진행 중 표시가 풀린다', getState().pendingSend[sid], false)
    check('대기열에 넣지 않는다', !(getState().queued[sid]?.length))
    failNext = false
    const ok2 = await actions.sendQuestionnaireAnswer(sid, 'qn-1', answers, first.id)
    eq('같은 식별자로 다시 보내면 성공', ok2, true)
    eq('요청 몸통: 빈 글, 같은 clientMessageId, questionnaire { id, answers }', calls.map((c) => [c[0], c[1], c[4], c[5], c[6]]), [
      [sid, '', 'id-1', false, { id: 'qn-1', answers }],
      [sid, '', 'id-1', false, { id: 'qn-1', answers }],
    ])
    eq('성공하면 진행 중 표시가 켜진 채 서버 사건을 기다린다', getState().pendingSend[sid], true)
    check('화면에 임시 말풍선을 만들지 않는다(서버 사건이 만든다)', !(getState().convos[sid] ?? []).some((i) => i.kind === 'local_user'))
  }

  console.log('\n──────── 대기열 멈춤 ────────')
  {
    seq = 0
    const u = userMsg()
    const m = modelText(BOX)
    const q = questionnaire('qn-q', m.seq)
    const end = turnEnd()
    const idle = [u, modelText('끝'), turnEnd()]
    eq('열린 질문지가 없으면 대기열을 비운다', queueFlushHeld(idle, false), false)
    eq('열린 질문지가 있으면 자동으로 비우지 않는다', queueFlushHeld([u, m, q, end], false), true)
    eq('지금 보내기(사람이 명시한 전송)는 멈추지 않는다', queueFlushHeld([u, m, q, end], true), false)
    eq('질문지를 사람이 닫았으면 비운다', queueFlushHeld([u, m, q, end, userMsg('채팅')], false), false)
    const perm = own({ kind: 'permission_request', req: { id: 'p1', toolName: 'Bash', input: {}, toolUseID: 't', createdAt: 1 } })
    eq('권한 카드는 지금 보내기여도 계속 멈춘다(기존 동작)', queueFlushHeld([u, perm], true), true)
  }

  console.log('\n──────── 세션 목록 requires_action ────────')
  {
    seq = 0
    const u = userMsg()
    const m = modelText(BOX)
    const q = questionnaire('qn-s', m.seq)
    const end = turnEnd()
    eq('열린 질문지가 있으면 requires_action', deriveTurn([u, m, q, end], false), 'requires_action')
    eq('턴 끝 사건이 오기 전 틈은 아직 running', deriveTurn([u, m, q], false), 'running')
    eq('막 답을 보낸 직후(pendingSend)는 running', deriveTurn([u, m, q, end], true), 'running')
    eq('채팅으로 닫은 뒤 새 턴은 running', deriveTurn([u, m, q, end, userMsg('채팅')], false), 'running')
    eq('새 턴이 끝나면 idle', deriveTurn([u, m, q, end, userMsg('채팅'), modelText('네'), turnEnd()], false), 'idle')
    eq('실패 질문지는 idle', deriveTurn([u, m, failedQuestionnaire('qn-x', m.seq), end], false), 'idle')

    const stateOf = (items: ConvoItem[]) => ({ convos: { s: items }, pendingSend: {} }) as unknown as State
    eq('입력창은 열린 질문지를 기다림으로 보지 않는다(친 글이 바로 나간다)', composerTurn(stateOf([u, m, q, end]), 's'), 'idle')
    const perm = own({ kind: 'permission_request', req: { id: 'p1', toolName: 'Bash', input: {}, toolUseID: 't', createdAt: 1 } })
    eq('입력창: 권한 카드 기다림은 그대로', composerTurn(stateOf([u, perm]), 's'), 'requires_action')
    eq('입력창: 모델이 도는 중은 그대로', composerTurn(stateOf([u, m]), 's'), 'running')
  }

  console.log('\n──────── 새로고침 복원(사건만으로) ────────')
  {
    seq = 0
    const u = userMsg('요청')
    const src = modelText(`정리\n\n${BOX}`)
    const ok = questionnaire('qn-r', src.seq)
    const end = turnEnd()
    const view = (extra: ConvoItem[]) => {
      const seg = build([u, src, ok, end, ...extra]).segs.find((s) => s.kind === 'questionnaire')
      return seg && seg.kind === 'questionnaire' ? seg.state : null
    }
    eq('복원: 열림', view([]), { status: 'open' })
    const answers = { q1: { chosen: ['GATEWAY_TIMEOUT만'] }, q2: { chosen: ['승인'] }, q3: { custom: '2회' }, q4: { skipped: true as const } }
    eq('복원: 카드로 답함(답을 사건에서 읽는다)', view([userMsg('답', { questionnaireAnswer: { id: 'qn-r', answers } })]), { status: 'answered', answers })
    eq('복원: 채팅으로 이어감', view([userMsg('채팅')]), { status: 'continued' })

    // 저장소를 지나는 길: 사건 수신 → 답 글을 되돌리기로 숨기면 다시 열림
    const sid = 'qn-store-session'
    const evs = [
      { ...u, seq: 1 },
      { ...src, seq: 2, events: (src as { events: { seq: number }[] }).events.map((e) => ({ ...e, seq: 2 })) },
      { ...ok, seq: 3, sourceSeq: 2 },
      { ...end, seq: 4 },
      { seq: 5, ts: 5, kind: 'user_msg', text: '답', questionnaireAnswer: { id: 'qn-r', answers } },
    ] as unknown as Parameters<typeof __ingestForTest>[1][]
    for (const ev of evs) __ingestForTest(sid, ev)
    const stateAfterAnswer = () => build(getState().convos[sid] ?? []).segs.find((s) => s.kind === 'questionnaire')
    eq('저장소: 답 글이 들어오면 답함', (stateAfterAnswer() as { state: { status: string } }).state.status, 'answered')
    api.rewind = async () => ({ restored: [], skipped: [], after: 4, until: 5 })
    await actions.rewind(sid, 5)
    eq('저장소: 답 글을 되돌리기로 숨기면 다시 열림', (stateAfterAnswer() as { state: { status: string } }).state.status, 'open')
    eq('저장소: 다시 열린 질문지가 열린 질문지로 잡힌다', pendingQuestionnaire(getState().convos[sid])?.id, 'qn-r')
  }

  console.log('\n──────── 글 입력 칸 Enter ────────')
  {
    eq('Enter는 삼킨다(카드를 보내지 않는다)', swallowEnter({ key: 'Enter', isComposing: false, keyCode: 13 }), true)
    eq('한글 조합 중 Enter(isComposing)는 건드리지 않는다', swallowEnter({ key: 'Enter', isComposing: true, keyCode: 13 }), false)
    eq('조합 확정 키코드 229도 건드리지 않는다', swallowEnter({ key: 'Enter', isComposing: false, keyCode: 229 }), false)
    eq('다른 키는 건드리지 않는다', swallowEnter({ key: 'a' }), false)
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} questionnaire: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
