// Agent Brain REST 응답 모양은 shared/brain.ts 한 벌이다. 탭 이름과 하이라이트 분해만 화면에 남긴다.

export type { DeletedSessionRow, SearchHit } from '@shared/brain'

export type BrainTab = 'hub'

/** 오늘 0시(로컬 시각)의 밀리초. 검색 기간 "오늘"의 시작이다. */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 하이라이트 마커(\u0001/\u0002)를 {text, mark} 세그먼트로 분해 → <mark> 렌더용.
export function splitHighlight(s: string): { text: string; mark: boolean }[] {
  const OPEN = '\u0001'
  const CLOSE = '\u0002'
  const out: { text: string; mark: boolean }[] = []
  let i = 0
  while (i < s.length) {
    const open = s.indexOf(OPEN, i)
    if (open === -1) {
      out.push({ text: s.slice(i), mark: false })
      break
    }
    if (open > i) out.push({ text: s.slice(i, open), mark: false })
    const close = s.indexOf(CLOSE, open + 1)
    if (close === -1) {
      out.push({ text: s.slice(open + 1), mark: true })
      break
    }
    out.push({ text: s.slice(open + 1, close), mark: true })
    i = close + 1
  }
  return out.filter((seg) => seg.text.length)
}
