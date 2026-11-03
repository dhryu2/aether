/**
 * 질문 카드에 그릴 제목/본문. header는 짧은 라벨, question이 본문이다.
 * 본문이 비면 헤더를 승격하고, 둘이 같으면 제목을 한 번만 그린다.
 */
import type { AetherQuestion } from './types'

export function questionBody(q: AetherQuestion): string {
  const body = q.question.trim()
  if (body) return body
  return (q.header ?? '').trim()
}

/** 카드 맨 위 제목. 본문과 다른 헤더가 있을 때만 헤더, 아니면 폴백(「질문」). */
export function questionHeaderTitle(q: AetherQuestion | undefined, fallback: string): string {
  if (!q) return fallback
  const header = (q.header ?? '').trim()
  const body = questionBody(q)
  if (header && header !== body) return header
  return fallback
}

/** 두 번째 이후 질문의 작은 헤더 줄. 본문과 같으면 중복이라 숨긴다. */
export function showSecondaryHeader(q: AetherQuestion): boolean {
  const header = (q.header ?? '').trim()
  return !!header && header !== questionBody(q)
}
