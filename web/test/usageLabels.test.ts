/**
 * 사용량 한도 창 라벨 (Phase 8h).
 *   실행: npx tsx web/test/usageLabels.test.ts   (src 밖이라 앱 빌드 tsc -b에 미포함)
 *
 * 지키는 것은 셋이다.
 *
 * ① **이름을 주는 서비스는 그 이름의 뜻대로 부른다.** Claude는 창마다 `five_hour` 같은 이름을 준다.
 * ② **이름 없이 길이만 주는 서비스는 길이로 부른다.** Codex는 이름이 없고 `windowDurationMins`만 준다
 *    (실측 2026-08-19). 여기서 내부 키(`codex_primary`)를 그대로 띄우면 사용자에게 아무 뜻도 없다.
 * ③ **모르면 지어내지 않는다.** 이름도 길이도 모르면 받은 이름을 그대로 보여준다 — 표에 없다는 이유로
 *    화면에서 정보가 사라지면 새 창이 생겼을 때 아무도 모르게 된다.
 */
import { rateLimitLabel } from '../src/lib/usageLabels'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const okay = got === want
  if (okay) pass++
  else fail++
  console.log(`${okay ? '✅' : '❌'} ${name}${okay ? '' : ` — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

// 번역기 대역 — 키와 파라미터가 그대로 보이게 해서 "어떤 문구를 골랐나"만 본다.
const t = (key: string, params?: Record<string, string | number>) =>
  params && 'n' in params ? `${key}(${params.n})` : key

// ① 이름을 아는 창
eq('아는 이름은 그 뜻대로', rateLimitLabel('five_hour', t), 'stream.rateLimit.fiveHour')
eq('아는 이름은 길이가 함께 와도 이름을 쓴다', rateLimitLabel('seven_day', t, 10080), 'stream.rateLimit.sevenDay')

// ② 이름이 없고 길이만 아는 창
eq('7일(10080분) → 일 단위', rateLimitLabel('codex_primary', t, 10080), 'stream.rateLimit.lastDays(7)')
eq('5시간(300분) → 시간 단위', rateLimitLabel('codex_primary', t, 300), 'stream.rateLimit.lastHours(5)')
eq('30분 → 분 단위', rateLimitLabel('codex_secondary', t, 30), 'stream.rateLimit.lastMinutes(30)')
eq('딱 안 떨어지면 시간으로 반올림', rateLimitLabel('codex_primary', t, 100), 'stream.rateLimit.lastHours(2)')

// ③ 모르는 창
eq('길이를 모르면 받은 이름 그대로', rateLimitLabel('brand_new_window', t), 'brand_new_window')
eq('이름도 없으면 일반 문구', rateLimitLabel(undefined, t), 'stream.rateLimit.default')
eq('길이가 0이면 지어내지 않는다', rateLimitLabel('brand_new_window', t, 0), 'brand_new_window')

console.log(`\n${fail === 0 ? '✅' : '❌'} usageLabels: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
