/** 메타데이터-only 초기 꼬리의 자동 과거 탐색 상태기계. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyHistorySearchCursor, mergeOlderPageEvents, nextOlderBoundary } from '../src/components/stream/olderHistorySearch'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const decision = (oldestSeq: number, over: Partial<Parameters<typeof emptyHistorySearchCursor>[0]> = {}) =>
  emptyHistorySearchCursor({
    hasConvo: false,
    paging: { oldestSeq, hasOlder: true, loading: false },
    inFlightAt: null,
    failedAt: null,
    ...over,
  })

check('최초 페이지가 메타데이터뿐이면 이전 cursor를 요청', decision(901) === 901)
check('같은 cursor 요청이 진행 중이면 중복 요청하지 않음', decision(901, { inFlightAt: 901 }) === null)
check('한 페이지 뒤 cursor가 줄면 다음 메타데이터-only 페이지를 계속 요청', decision(601) === 601)
check('여러 페이지 뒤에도 대화가 없으면 계속 직렬 요청', decision(301) === 301)
check('과거 대화를 찾으면 즉시 자동 탐색 종료', decision(1, { hasConvo: true }) === null)
check('끝까지 대화가 없는 진짜 빈 세션은 hasOlder=false에서 종료', decision(1, { paging: { oldestSeq: 1, hasOlder: false, loading: false } }) === null)
check('같은 cursor 실패는 무한 자동 재시도하지 않음', decision(301, { failedAt: 301 }) === null)
check('스토어가 로딩 중이면 새 요청을 겹치지 않음', decision(301, { paging: { oldestSeq: 301, hasOlder: true, loading: true } }) === null)

const overlapped = mergeOlderPageEvents(
  [{ seq: 50 }, { seq: 200 }, { seq: 1_000 }, { seq: -1 }],
  [{ seq: 100 }, { seq: 199 }, { seq: 201 }, { seq: 399 }],
)
check('초기 씨앗과 과거 페이지가 겹쳐도 seq 순서가 뒤집히지 않음', overlapped.map((x) => x.seq).join(',') === '50,100,199,200,201,399,1000,-1')

check('다음 조회는 서버가 읽은 페이지의 첫 순번을 쓴다', nextOlderBoundary(80, 30, 101) === 80)
check('그 값이 없으면 새로 붙은 첫 순번을 쓴다', nextOlderBoundary(undefined, 30, 101) === 30)
check('둘 다 없으면 지금 경계를 유지한다', nextOlderBoundary(undefined, undefined, 101) === 101)
const seenStall = new Set([5, 6])
const stallFresh = [{ seq: 5 }, { seq: 6 }].filter((ev) => !seenStall.has(ev.seq))
check('덧붙인 사건만 남은 페이지도 경계를 앞으로 민다', stallFresh.length === 0 && nextOlderBoundary(5, stallFresh[0]?.seq, 101) === 5)
check('검색 점프도 읽은 페이지의 첫 순번으로 다음 조회를 한다', nextOlderBoundary(200, 350, 101) === 200)
const seenScreen = new Set([30, 31, 150])
const olderFresh = [{ seq: 30 }, { seq: 31 }, { seq: 80 }, { seq: 90 }].filter((ev) => !seenScreen.has(ev.seq))
const once = mergeOlderPageEvents([{ seq: 30 }, { seq: 31 }, { seq: 150 }], olderFresh)
check('이미 있는 원문과 카드는 이전 페이지를 합쳐도 한 번만 남는다', once.map((ev) => ev.seq).join(',') === '30,31,80,90,150')

const here = path.dirname(fileURLToPath(import.meta.url))
const streamSource = fs.readFileSync(path.join(here, '../src/components/stream/Stream.tsx'), 'utf8')
const findSource = fs.readFileSync(path.join(here, '../src/components/FindBar.tsx'), 'utf8')
const hookSource = fs.readFileSync(path.join(here, '../src/components/stream/useStreamScroll.ts'), 'utf8')
check('빈 화면 분기에 과거 기록 로더가 실제 마운트됨', /searchingOlderConversation[\s\S]*OlderLoading/.test(streamSource))
check('훅이 빈 대화 전용 자동 탐색 결정을 실제 사용함', hookSource.includes('emptyHistorySearchCursor({'))
check('세션 전환 뒤 늦게 끝난 요청이 같은 숫자 cursor의 새 세션 상태를 못 지움', hookSource.includes('ctxRef.current.id !== id'))

console.log(`\n${fail === 0 ? '✅' : '❌'} olderHistorySearch: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
