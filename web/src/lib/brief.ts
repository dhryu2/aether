// 브리프 전송 쪽 화면 계약. 옛 브리프 카드는 더 이상 그리지 않는다.

/** 진행 중 판정의 마지막 사람 말. 브리프 시작 사건과 갱신은 빠진다. 사람 말은 모두 턴을 연다. */
export function opensWorkTurn(item: {
  kind: string
  events?: readonly { type?: string }[] | null
}): boolean {
  if (item.kind === 'local_user') return true
  if (item.kind === 'local_notice' || item.kind === 'brief_opened' || item.kind === 'brief_updated') return false
  if (item.kind === 'user_msg') return true
  if (Array.isArray(item.events)) return item.events.some((event) => event?.type === 'user_text')
  return false
}

type OptimisticUser = { kind: string; text?: string; clientMessageId?: string }

/**
 * 지울 임시 말풍선의 위치. 없으면 -1.
 * 사건에 clientMessageId가 있으면 그 값만 맞춘다. 글자로는 넘어가지 않는다.
 * briefId가 있는 user_msg는 전달 식별자라서 임시 말을 지우지 않는다.
 */
export function optimisticUserIndex(
  items: readonly OptimisticUser[],
  event: { kind: string; text?: string; clientMessageId?: string; briefId?: string },
): number {
  if (event.kind !== 'user_msg' && event.kind !== 'brief_opened') return -1
  if (event.kind === 'user_msg' && event.briefId) return -1
  const id = typeof event.clientMessageId === 'string' && event.clientMessageId ? event.clientMessageId : undefined
  if (id) return items.findIndex((item) => item.kind === 'local_user' && item.clientMessageId === id)
  return items.findIndex((item) => item.kind === 'local_user' && item.text === event.text)
}
