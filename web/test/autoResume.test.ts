/**
 * 자동 재개 화면 계산 테스트. 실행: npx tsx web/test/autoResume.test.ts
 * 시각 표시 문구, 다음 날로 넘어가는 경우, 주의 통로 받아 들이기(옛 서버 모양 포함).
 */
import { autoResumeTimeText, nextOccurrence, timeInputValue } from '../src/lib/autoResume'
import { parseAutoResume, parsePresenceSession, patchSessionFromPresence } from '../src/lib/attention'
import type { SessionListItem } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 로컬 시각 기준으로 만든다(시험 기계의 시간대와 무관하게 통과).
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const now = at(2026, 11, 2, 22, 30)

check('같은 날은 시각만', autoResumeTimeText(at(2026, 11, 2, 23, 5), now) === '23:05')
check('시(時)는 한 자리로 쓰고 분은 두 자리', autoResumeTimeText(at(2026, 11, 2, 3, 0), now) === '3:00')
check('다른 날은 날짜가 앞에 붙는다', autoResumeTimeText(at(2026, 11, 3, 3, 0), now) === '11/3 3:00')

check('아직 안 지난 시각은 오늘', nextOccurrence('23:00', now) === at(2026, 11, 2, 23, 0))
check('이미 지난 시각은 다음 날', nextOccurrence('03:00', now) === at(2026, 11, 3, 3, 0))
check('같은 분은 다음 날', nextOccurrence('22:30', now) === at(2026, 11, 3, 22, 30))
check('모양이 틀리면 null', nextOccurrence('', now) === null && nextOccurrence('25:00', now) === null && nextOccurrence('ab', now) === null)
check('시각 입력 칸 값은 두 자리', timeInputValue(at(2026, 11, 2, 3, 5)) === '03:05')

const plan = { action: { type: 'send', text: '이어서' }, at: 1_800_000_000_000, attempts: 1 }
check('예약 받아 들이기', parseAutoResume(plan)?.at === 1_800_000_000_000)
check('포기한 예약도 받는다', parseAutoResume({ action: { type: 'send', text: 'x' }, attempts: 3, gaveUp: true })?.gaveUp === true)
check('시각도 포기도 없으면 버린다', parseAutoResume({ action: { type: 'send', text: 'x' }, attempts: 1 }) === undefined)
check('모양이 틀리면 버린다', parseAutoResume({ action: { type: 'other' }, attempts: 1, at: 1 }) === undefined && parseAutoResume('x') === undefined)

const base = { id: 's1', attention: 'idle', status: 'ended' }
check('주의 통로에 예약이 실린다', parsePresenceSession({ ...base, autoResume: plan })?.autoResume?.action.text === '이어서')
check('옛 서버(필드 없음)도 깨지지 않는다', parsePresenceSession(base)?.autoResume === undefined)
const item = { id: 's1', autoResume: plan } as unknown as SessionListItem
const p = parsePresenceSession(base)!
check('예약이 없어진 갱신은 목록에서도 지운다', patchSessionFromPresence(item, p).autoResume === undefined)

console.log(`\n${fail === 0 ? '✅' : '❌'} autoResume web: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
