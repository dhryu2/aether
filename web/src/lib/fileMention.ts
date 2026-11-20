// 입력창의 `@` 파일 고르기와 파일 찾기 창이 함께 쓰는 순수 함수. React에 기대지 않는다.

/** 커서 앞의 `@검색어`. `@`는 글 맨 앞이거나 공백 바로 뒤여야 하고, `@`와 커서 사이에 공백이 없어야 한다(메일 주소 a@b는 아니다). */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (/\s/.test(ch)) return null
    if (ch === '@') return i === 0 || /\s/.test(value[i - 1]) ? { start: i, query: value.slice(i + 1, caret) } : null
  }
  return null
}

/** 검색어로 파일을 거르고 순위대로 정렬한다(대소문자 무시). 파일 이름이 검색어로 시작 > 파일 이름에 포함 > 경로에 포함, 같으면 짧은 경로가 앞. */
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase()
  const ranked: { f: string; rank: number }[] = []
  for (const f of files) {
    const lower = f.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1
    if (rank >= 0) ranked.push({ f, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.f.length - b.f.length)
  return ranked.slice(0, limit).map((r) => r.f)
}
