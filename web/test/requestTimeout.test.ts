/**
 * 전송 fetch 타임아웃 — 작은 JSON은 30초, 이미지 첨부는 본문 크기에 비례해 늘린다.
 * 실행: npx tsx web/test/requestTimeout.test.ts
 *
 * 버그: api.req가 모든 POST에 30초 abort. 수 MB 첨부는 업로드 도중에 끊기고,
 *   컴포저가 이미 비운 뒤 낙관적 말풍선만 지워져 요청이 증발한 것처럼 보인다.
 */
import { REQUEST_TIMEOUT_DEFAULT_MS, REQUEST_TIMEOUT_MAX_MS, requestTimeoutMs } from '../src/lib/api'

let pass = 0
let fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) pass++; else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

check('본문 없음 → 기본 30초', requestTimeoutMs(undefined), REQUEST_TIMEOUT_DEFAULT_MS)
check('작은 JSON은 30초 근처', requestTimeoutMs('{"text":"hi"}') < REQUEST_TIMEOUT_DEFAULT_MS + 1000, true)
check('override가 이김', requestTimeoutMs('x'.repeat(1_000_000), 120_000), 120_000)

const large = 3_709_570
const largeMs = requestTimeoutMs('x'.repeat(large))
check('3.7MB 첨부는 30초보다 길다', largeMs > REQUEST_TIMEOUT_DEFAULT_MS, true)
check('3.7MB 첨부는 5분 상한 이하', largeMs <= REQUEST_TIMEOUT_MAX_MS, true)

const huge = requestTimeoutMs('x'.repeat(20_000_000))
check('매우 큰 본문도 5분에서 자른다', huge, REQUEST_TIMEOUT_MAX_MS)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
