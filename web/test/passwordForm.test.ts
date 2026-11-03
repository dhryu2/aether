/** 비밀번호 변경 입력 검사 순수 로직 시험. */
import { checkNewPassword, validatePasswordForm } from '../src/lib/passwordForm'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}
const v = (current: string, next: string, confirm: string) => validatePasswordForm({ current, next, confirm })

check(v('', 'abcdefgh', 'abcdefgh')?.code === 'currentEmpty', '현재 비밀번호가 비면 거절')
check(v('old', 'abcdefg', 'abcdefg')?.code === 'tooShort', '7자는 거절')
check(v('old', 'abcdefgh', 'abcdefgh') === null, '8자는 통과')
const ko25 = '가'.repeat(25) // 75바이트
check(v('old', ko25, ko25)?.code === 'tooLong', '한글 25자(75바이트)는 거절')
const ko24 = '가'.repeat(24) // 72바이트
check(v('old', ko24, ko24) === null, '한글 24자(72바이트)는 통과')
const bad = v('old', 'abcdefgh', 'abcdefgx')
check(bad?.code === 'mismatch' && bad.field === 'confirm', '확인 칸이 다르면 확인 칸 오류', bad)
check(v('old', 'abcdefgh', 'abcdefgh') === null, '정상 입력은 오류 없음')

// 첫 설정 화면이 쓰는 새 비밀번호 한 칸 검사: 서버 isValidNewPassword(8자 이상, 72바이트 이하)와 같은 기준
check(checkNewPassword('abcdefg') === 'tooShort', 'checkNewPassword: 7자 거절')
check(checkNewPassword('abcdefgh') === null, 'checkNewPassword: 8자 통과')
check(checkNewPassword('a'.repeat(72)) === null && checkNewPassword('a'.repeat(73)) === 'tooLong', 'checkNewPassword: 72/73바이트 경계')
check(checkNewPassword('가'.repeat(24)) === null && checkNewPassword('가'.repeat(25)) === 'tooLong', 'checkNewPassword: 한글 72/75바이트')

console.log(`\n${fail ? '❌' : '✅'} passwordForm: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
