// 비밀번호 변경 입력 검사. 기준은 서버(routes/auth.ts)와 같다: 새 비밀번호 8자 이상, UTF-8 72바이트 이하.
export type PasswordField = 'current' | 'next' | 'confirm'
export type PasswordFormError = { field: PasswordField; code: 'currentEmpty' | 'tooShort' | 'tooLong' | 'mismatch' }


/** 새 비밀번호 한 칸의 검사. 서버 isValidNewPassword와 같은 기준이다(첫 설정 화면도 쓴다). */
export function checkNewPassword(v: string): 'tooShort' | 'tooLong' | null {
  if (v.length < 8) return 'tooShort'
  if (new TextEncoder().encode(v).length > 72) return 'tooLong'
  return null
}

export function validatePasswordForm(f: { current: string; next: string; confirm: string }): PasswordFormError | null {
  if (!f.current) return { field: 'current', code: 'currentEmpty' }
  const bad = checkNewPassword(f.next)
  if (bad) return { field: 'next', code: bad }
  if (f.confirm !== f.next) return { field: 'confirm', code: 'mismatch' }
  return null
}
