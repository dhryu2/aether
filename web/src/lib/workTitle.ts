/** 목록·위쪽 막대·삭제 확인에 쓰는 작업 제목. 비면 화면이 준 '새 세션' 문구. */
export function sessionWorkTitle(s: { displayName?: string | null }, untitled: string): string {
  const n = s.displayName?.trim()
  return n || untitled
}

const PREVIEW_MAX = 72

function clampPreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= PREVIEW_MAX) return compact
  return compact.slice(0, PREVIEW_MAX - 1).trimEnd() + '…'
}

/** 지금 열린 대화에서 마지막 말을 뽑아 카드 미리보기를 즉시 갱신한다. */
export function previewFromConvo(
  items: Array<{ kind?: string; text?: string; events?: Array<{ type?: string; text?: string }> }> | undefined,
): string {
  if (!items?.length) return ''
  for (let i = items.length - 1; i >= 0; i--) {
    const ev = items[i]
    if (ev.kind === 'user_msg' && ev.text?.trim()) return clampPreview(ev.text)
    const parts = ev.events
    if (!Array.isArray(parts)) continue
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if ((part.type === 'text' || part.type === 'user_text') && part.text?.trim()) return clampPreview(part.text)
    }
  }
  return ''
}
