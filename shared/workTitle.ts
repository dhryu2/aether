/**
 * 작업 목록에 올릴 짧은 제목.
 *
 * 사람이 직접 붙인 이름이 있으면 그걸 쓰고, 없으면 첫 말에서 뽑는다.
 * 폴더 이름·세션 식별자는 제목이 아니다 — 같은 프로젝트의 카드가 전부 같아 보이기 때문이다.
 *
 * 뽑기 규칙은 Orca `deriveGeneratedTabTitle`과 같다. 모델 요약 제목이 오기 전이나 요약이 실패했을 때 쓴다.
 */

export const WORK_TITLE_MAX_LENGTH = 40
export const WORK_TITLE_SOURCE_SCAN_LIMIT = 512
export const WORK_PREVIEW_MAX_LENGTH = 72

/** 목록 카드 둘째 줄용. 공백을 한 칸으로 접고 길이를 자른다. */
export function clampWorkPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  if (compact.length <= WORK_PREVIEW_MAX_LENGTH) return compact
  return compact.slice(0, WORK_PREVIEW_MAX_LENGTH - 1).trimEnd() + "…"
}

const LEADING_FILLER_PATTERNS: RegExp[] = [
  /^(?:can|could|would)\s+you(?:\s+please)?\s+/i,
  /^please(?:\s+|$)/i,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i,
  /^help\s+me(?:\s+to)?\s+/i,
  /^help\s+/i,
  /^let'?s\s+/i,
  /^we\s+need\s+to\s+/i,
  /^need\s+to\s+/i,
  /^(?:제발|부탁(?:해|드려요)?)\s+/,
  /^도와(?:줘|주세요)\s*/,
  /^좀\s+/,
]

function isTitleWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function foldTitleWhitespace(value: string): string {
  let normalized = ""
  let pendingWhitespace = false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (isTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += " "
      pendingWhitespace = false
    }
    normalized += value.charAt(i)
  }
  return normalized
}

function capitalizeFirstLetter(value: string): string {
  return value.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase())
}

function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const rawSlice = value.slice(0, maxLength)
  const sliced = rawSlice.trim()
  if (sliced.length < rawSlice.length) return sliced
  const lastSpace = sliced.lastIndexOf(" ")
  if (lastSpace >= Math.floor(maxLength * 0.55)) return sliced.slice(0, lastSpace).trim()
  return sliced
}

/** 수동 이름 > 자동 제목. 둘 다 없으면 빈 문자열 — 화면이 번역 문구로 채운다. */
export function resolveWorkTitle(name?: string | null, generatedName?: string | null): string {
  return (name ?? "").trim() || (generatedName ?? "").trim()
}

/** 맨 앞 슬래시 명령 단어를 뗀 나머지. 명령 뒤에 붙은 요청이 제목 재료다. */
export function stripLeadingCommand(prompt: string): string {
  return prompt.trim().replace(/^\/\S*\s*/, "")
}

/**
 * 첫 사용자 말에서 목록 제목을 뽑는다. 빈 말과 내용 없는 슬래시 명령은 제목이 아니다.
 */
export function deriveWorkTitle(prompt: string): string | null {
  const raw = stripLeadingCommand(prompt)
  if (!raw) return null

  const promptPreview = raw.slice(0, WORK_TITLE_SOURCE_SCAN_LIMIT)
  const firstClause = promptPreview
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*_~#>[\]{}()]/g, " ")
    .replace(/^(?:issue|task|bug|feature|pr)\s*(?:#?\d+)?\s*[:-]\s*/i, "")
    .split(/[.!?;\n\r\u2028\u2029]/u)
    .map((part) => part.trim())
    .find(Boolean) // 코드 블록으로 시작하면 첫 조각이 비므로 내용 있는 첫 조각을 쓴다

  if (!firstClause) return null

  let candidate = firstClause
  for (let i = 0; i < 3; i++) {
    const before = candidate
    for (const pattern of LEADING_FILLER_PATTERNS) {
      candidate = candidate.replace(pattern, "")
    }
    candidate = candidate.trim()
    if (candidate === before.trim()) break
  }

  candidate = foldTitleWhitespace(candidate.replace(/[^\p{L}\p{N}\s]/gu, " "))
  if (!candidate) return null

  return truncateAtWordBoundary(capitalizeFirstLetter(candidate), WORK_TITLE_MAX_LENGTH)
}
