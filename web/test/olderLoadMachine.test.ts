import { canFetchOlder, OLDER_IDLE, olderLoadNext, type OlderLoadEvent, type OlderLoadState } from '../src/components/stream/olderLoadMachine'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}
const run = (evs: OlderLoadEvent[], from: OlderLoadState = OLDER_IDLE) => evs.reduce(olderLoadNext, from)

check(run([{ type: 'fetch', cursor: 10 }]).phase === 'fetching', 'idle → fetching')
check(run([{ type: 'fetch', cursor: 10 }, { type: 'fetched', cursor: 10, changed: true, anchored: true }]).phase === 'settling', '성공 + 앵커 → settling')
check(run([{ type: 'fetch', cursor: 10 }, { type: 'fetched', cursor: 10, changed: true, anchored: false }]).phase === 'idle', '성공 + 앵커 없음(빈 대화 탐색) → idle')
check(run([{ type: 'fetch', cursor: 10 }, { type: 'fetched', cursor: 10, changed: true, anchored: true }, { type: 'settled' }]).phase === 'idle', 'settling → settled → idle')
{
  const s = run([{ type: 'fetch', cursor: 10 }, { type: 'fetched', cursor: 10, changed: false, anchored: true }])
  check(s.phase === 'idle' && s.failedAt === 10, '실패·빈 페이지 → idle + 실패 지점 기록', s)
}
check(run([{ type: 'expand' }]).phase === 'settling', '로컬 창 확장 → settling')
check(run([{ type: 'expand' }, { type: 'fetch', cursor: 10 }]).phase === 'settling', 'settling 중에는 새 불러오기를 시작하지 않는다')
check(run([{ type: 'fetch', cursor: 10 }, { type: 'expand' }]).phase === 'fetching', 'fetching 중에는 창 확장을 시작하지 않는다')
check(run([{ type: 'fetch', cursor: 10 }, { type: 'fetch', cursor: 20 }]).cursor === 10, '진행 중 요청은 덮어쓰지 않는다')
{
  const s = run([{ type: 'fetch', cursor: 10 }, { type: 'reset' }, { type: 'fetched', cursor: 10, changed: false, anchored: true }])
  check(s.phase === 'idle' && s.failedAt === null, '리셋 뒤 늦게 온 옛 응답은 무시')
}
{
  const s = run([{ type: 'fetch', cursor: 10 }, { type: 'fetched', cursor: 99, changed: false, anchored: true }])
  check(s.phase === 'fetching', '다른 지점의 응답은 무시')
}
check(run([{ type: 'settled' }]).phase === 'idle', 'idle에서 settled는 무시')
check(run([{ type: 'fetch', cursor: 10 }, { type: 'settled' }]).phase === 'fetching', 'fetching 중 settled는 무시')

const older = { oldestSeq: 10, hasOlder: true, loading: false }
check(canFetchOlder(OLDER_IDLE, older, false), 'idle + 과거 있음 → 허용')
check(!canFetchOlder(OLDER_IDLE, { ...older, hasOlder: false }, false), '과거 없음 → 거절')
check(!canFetchOlder(OLDER_IDLE, { ...older, loading: true }, false), '스토어가 로딩 중 → 거절')
check(!canFetchOlder(run([{ type: 'expand' }]), older, false), 'settling 중 → 거절')
{
  const failed = run([{ type: 'fetch', cursor: 10 }, { type: 'fetched', cursor: 10, changed: false, anchored: true }])
  check(!canFetchOlder(failed, older, true), '자동 경로는 실패 지점을 다시 시도하지 않는다')
  check(canFetchOlder(failed, older, false), '사용자 스크롤은 실패 지점도 다시 시도할 수 있다')
  check(canFetchOlder(failed, { ...older, oldestSeq: 5 }, true), '지점이 바뀌면 자동 경로도 다시 허용')
}
check(!canFetchOlder(OLDER_IDLE, undefined, false), '페이징 정보 없음 → 거절')

console.log(`\n${fail === 0 ? '✅' : '❌'} olderLoadMachine: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
