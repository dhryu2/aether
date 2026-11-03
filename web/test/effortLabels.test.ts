/**
 * 추론 강도 설명 고르기 (Phase 8i).
 *   실행: npx tsx web/test/effortLabels.test.ts   (src 밖이라 앱 빌드 tsc -b에 미포함)
 *
 * 지키는 것은 넷이다.
 *
 * ① **화면은 강도 이름을 모른다.** 설명의 출처는 모델 목록에 실려 오는 표 하나뿐이다. 표에 없으면
 *    설명을 지어내지 않고 비운다(화면은 강도 이름만 보여준다).
 * ② **번역과 원문을 다르게 다룬다.** `byLocale`은 aether가 만든 번역이라 내 언어가 없으면 비운다.
 *    `text`는 provider가 준 원문이라 언어가 달라도 보여준다 — 그 서비스의 권위 있는 설명이다.
 * ③ **언어 대분류로도 찾는다.** `ko-KR`처럼 세분화된 값이 와도 `ko` 번역을 찾아 쓴다.
 * ④ **없는 것을 받아도 안 터진다.** 설명 표 자체가 없는 응답(구버전 서버)에서도 빈 문자열을 준다.
 */
import { effortDescription } from '../src/lib/effortLabels'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const okay = got === want
  if (okay) pass++
  else fail++
  console.log(`${okay ? '✅' : '❌'} ${name}${okay ? '' : ` — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

const claude = { byLocale: { ko: '깊은 추론', en: 'Deep reasoning' } } // aether 번역(Claude 어댑터가 채움)
const codex = { text: 'Balances speed and depth' } // provider 원문(Codex가 직접 줌)

// ① 내 언어가 있으면 그것
eq('한국어 화면은 한국어 번역', effortDescription(claude, 'ko'), '깊은 추론')
eq('영어 화면은 영어 번역', effortDescription(claude, 'en'), 'Deep reasoning')

// ② 번역은 내 언어가 없으면 비운다 — 영어를 임의로 들이밀지 않는다
eq('번역에 내 언어가 없으면 비운다', effortDescription({ byLocale: { en: 'Deep reasoning' } }, 'ko'), '')

// ② provider 원문은 언어가 달라도 보여준다(출처가 다르므로 취급도 다르다)
eq('원문은 언어가 달라도 보여준다', effortDescription(codex, 'ko'), 'Balances speed and depth')

// ② 번역이 있으면 원문보다 번역이 먼저
eq('번역이 원문보다 먼저', effortDescription({ ...codex, byLocale: { ko: '균형' } }, 'ko'), '균형')

// ③ 언어 대분류 폴백
eq('ko-KR는 ko 번역을 쓴다', effortDescription(claude, 'ko-KR'), '깊은 추론')
eq('정확한 키가 있으면 대분류보다 우선', effortDescription({ byLocale: { ko: '기본', 'ko-KR': '세분화' } }, 'ko-KR'), '세분화')

// ④ 없는 것을 받아도 안 터진다
eq('설명 표가 없으면 빈 문자열', effortDescription(undefined, 'ko'), '')
eq('빈 설명이면 빈 문자열', effortDescription({}, 'ko'), '')
eq('빈 번역표면 빈 문자열', effortDescription({ byLocale: {} }, 'ko'), '')

console.log(`\neffortLabels: ${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
