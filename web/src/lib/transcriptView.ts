/** 대화 화면이 진행 보고를 얼마나 남기는지. 서버는 모른다. */
export type TranscriptView = 'normal' | 'verbose' | 'summary'

export const TRANSCRIPT_VIEWS: readonly TranscriptView[] = ['normal', 'verbose', 'summary']

export function parseTranscriptView(v: unknown): TranscriptView {
  return v === 'verbose' || v === 'summary' ? v : 'normal'
}

export function nextTranscriptView(cur: TranscriptView): TranscriptView {
  const i = TRANSCRIPT_VIEWS.indexOf(cur)
  return TRANSCRIPT_VIEWS[(i + 1) % TRANSCRIPT_VIEWS.length] ?? 'normal'
}
