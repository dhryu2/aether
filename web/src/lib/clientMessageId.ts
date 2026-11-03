/**
 * 전송 clientMessageId 고르기. 실패 fill 재전송은 같은 id, 성공 후는 새 UUID.
 */
export function pickClientMessageId(opts: {
  sessionId: string
  text: string
  fill: { id: string; text: string; clientMessageId?: string } | null
}): string {
  const fill = opts.fill
  if (
    fill &&
    fill.id === opts.sessionId &&
    fill.text === opts.text &&
    typeof fill.clientMessageId === 'string' &&
    fill.clientMessageId
  ) {
    return fill.clientMessageId
  }
  return crypto.randomUUID()
}
