// 입력창의 글 칸과 코드 상자.
//   상자는 Shift+Enter로만 생긴다. 새로고침 전에 ``` 만 쳐 둔 글은 상자가 되지 않는다.
//   보낼 때는 상자를 다시 ``` 로 감싼 글로 붙인다. 언어를 안 적었으면 화면의 plain은 글에 넣지 않는다.

export type TextBlock = { id: string; kind: 'text'; value: string }
export type CodeBlock = { id: string; kind: 'code'; lang: string; value: string; collapsed: boolean }
export type ComposerBlock = TextBlock | CodeBlock

// sessionStorage에 상자가 섞인 입력을 구분하는 표식. 일반 글은 예전처럼 글자만 저장한다.
const DRAFT_MARK = '\u0001aether-blocks:'

// 한 줄 전체가 상자를 여는 표시일 때만. 뒤에 언어 이름 하나만 허용한다.
const OPEN_FENCE = /^(```|~~~)[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/
// 상자 안에서 상자를 닫는 줄. 언어 이름은 받지 않는다.
const CLOSE_FENCE = /^(```|~~~)[ \t]*$/

export function openingFence(line: string): { lang: string } | null {
  const matched = OPEN_FENCE.exec(line)
  if (!matched) return null
  return { lang: matched[2] ?? '' }
}

export function isClosingFence(line: string): boolean {
  return CLOSE_FENCE.test(line)
}

/** 언어를 안 적었을 때 상자 왼쪽에 보이는 이름. 보내는 글에는 들어가지 않는다. */
export function codeLabel(lang: string): string {
  return lang || 'plain'
}

function lineAt(value: string, cursor: number): { start: number; end: number; text: string } {
  const safe = Math.max(0, Math.min(cursor, value.length))
  const start = value.lastIndexOf('\n', safe - 1) + 1
  let end = value.indexOf('\n', safe)
  if (end < 0) end = value.length
  return { start, end, text: value.slice(start, end) }
}

export function splitOpeningLine(value: string, cursor: number): { before: string; lang: string; after: string } | null {
  const line = lineAt(value, cursor)
  const fence = openingFence(line.text)
  if (!fence) return null
  const before = value.slice(0, line.start).replace(/\n$/, '')
  const afterStart = line.end < value.length && value[line.end] === '\n' ? line.end + 1 : line.end
  return { before, lang: fence.lang, after: value.slice(afterStart) }
}

export function splitClosingLine(value: string, cursor: number): { code: string; after: string } | null {
  const line = lineAt(value, cursor)
  if (!isClosingFence(line.text)) return null
  const code = value.slice(0, line.start).replace(/\n$/, '')
  const afterStart = line.end < value.length && value[line.end] === '\n' ? line.end + 1 : line.end
  return { code, after: value.slice(afterStart) }
}

let seq = 0
export function newBlockId(): string {
  seq += 1
  return `b${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function textBlock(value: string, id = newBlockId()): TextBlock {
  return { id, kind: 'text', value }
}

export function codeBlock(lang: string, value = '', id = newBlockId()): CodeBlock {
  return { id, kind: 'code', lang, value, collapsed: false }
}

// 빈 글 칸은 맨 끝의 하나(상자 아래를 누르는 자리)만 남긴다. 맞닿은 글 칸은 한 칸으로 합친다.
export function normalizeBlocks(blocks: ComposerBlock[]): ComposerBlock[] {
  const merged: ComposerBlock[] = []
  for (const block of blocks) {
    const last = merged[merged.length - 1]
    if (block.kind === 'text' && last?.kind === 'text') {
      const joiner = last.value && block.value ? '\n' : ''
      merged[merged.length - 1] = { ...last, value: last.value + joiner + block.value }
      continue
    }
    merged.push(block)
  }
  const kept = merged.filter((block, index) => {
    if (block.kind !== 'text' || block.value.length > 0) return true
    return index === merged.length - 1
  })
  if (kept.length === 0) return [textBlock('')]
  if (kept[kept.length - 1].kind === 'code') kept.push(textBlock(''))
  return kept
}

export function soleText(blocks: ComposerBlock[]): string | null {
  if (blocks.length === 1 && blocks[0].kind === 'text') return blocks[0].value
  return null
}

export function setBlockValue(blocks: ComposerBlock[], id: string, value: string): ComposerBlock[] {
  return blocks.map((block) => (block.id === id ? { ...block, value } : block))
}

export function toggleCodeCollapsed(blocks: ComposerBlock[], id: string): ComposerBlock[] {
  return blocks.map((block) => (block.id === id && block.kind === 'code' ? { ...block, collapsed: !block.collapsed } : block))
}

export function neighborBlock(blocks: ComposerBlock[], id: string, dir: -1 | 1): ComposerBlock | null {
  const index = blocks.findIndex((block) => block.id === id)
  if (index < 0) return null
  return blocks[index + dir] ?? null
}

function focusOf(blocks: ComposerBlock[], id: string, at: number, fallbackId?: string): { focusId: string; focusAt: number } {
  const found = blocks.find((block) => block.id === id)
  if (found) return { focusId: found.id, focusAt: Math.max(0, Math.min(at, found.value.length)) }
  const fallback = fallbackId ? blocks.find((block) => block.id === fallbackId) : undefined
  const text = fallback ?? [...blocks].reverse().find((block) => block.kind === 'text') ?? blocks[blocks.length - 1]
  return { focusId: text.id, focusAt: text.value.length }
}

// 글 칸의 현재 줄이 ``` 또는 ~~~ 이면 그 줄을 상자로 바꾼다.
export function openCodeAt(
  blocks: ComposerBlock[],
  textId: string,
  cursor: number,
): { blocks: ComposerBlock[]; focusId: string; focusAt: number } | null {
  const index = blocks.findIndex((block) => block.id === textId && block.kind === 'text')
  if (index < 0) return null
  const block = blocks[index] as TextBlock
  const split = splitOpeningLine(block.value, cursor)
  if (!split) return null
  const code = codeBlock(split.lang)
  const next: ComposerBlock[] = blocks.slice(0, index)
  if (split.before.length > 0) next.push({ ...block, value: split.before })
  next.push(code)
  const rest = blocks.slice(index + 1)
  if (split.after.length > 0) {
    const following = rest[0]
    if (following?.kind === 'text') {
      const joiner = following.value ? '\n' : ''
      next.push({ ...following, value: split.after + joiner + following.value })
      next.push(...rest.slice(1))
    } else {
      next.push(textBlock(split.after), ...rest)
    }
  } else {
    next.push(...rest)
  }
  const normalized = normalizeBlocks(next)
  return { blocks: normalized, ...focusOf(normalized, code.id, 0) }
}

// 상자 안의 ``` 또는 ~~~ 줄에서 상자를 닫고, 그 아래 글 칸으로 커서를 옮긴다.
export function closeCodeAt(
  blocks: ComposerBlock[],
  codeId: string,
  cursor: number,
): { blocks: ComposerBlock[]; focusId: string; focusAt: number } | null {
  const index = blocks.findIndex((block) => block.id === codeId && block.kind === 'code')
  if (index < 0) return null
  const block = blocks[index] as CodeBlock
  const split = splitClosingLine(block.value, cursor)
  if (!split) return null
  const next: ComposerBlock[] = blocks.slice(0, index)
  if (split.code.length > 0) next.push({ ...block, value: split.code, collapsed: false })
  const rest = blocks.slice(index + 1)
  const following = rest[0]
  let focusId: string
  let focusAt: number
  if (following?.kind === 'text') {
    const joiner = split.after && following.value ? '\n' : ''
    next.push({ ...following, value: split.after + joiner + following.value }, ...rest.slice(1))
    focusId = following.id
    focusAt = split.after.length
  } else {
    const text = textBlock(split.after)
    next.push(text, ...rest)
    focusId = text.id
    focusAt = split.after.length
  }
  const normalized = normalizeBlocks(next)
  return { blocks: normalized, ...focusOf(normalized, focusId, focusAt, blocks[index - 1]?.id) }
}

// 빈 상자에서 백스페이스. 글이 있으면 지우지 않는다.
export function removeEmptyCode(
  blocks: ComposerBlock[],
  codeId: string,
): { blocks: ComposerBlock[]; focusId: string; focusAt: number } | null {
  const index = blocks.findIndex((block) => block.id === codeId && block.kind === 'code')
  if (index < 0) return null
  const block = blocks[index] as CodeBlock
  if (block.value.length > 0) return null
  const previous = blocks[index - 1]
  const normalized = normalizeBlocks(blocks.filter((item) => item.id !== codeId))
  const targetId = previous?.id ?? normalized.find((item) => item.kind === 'text')?.id ?? normalized[0].id
  const target = normalized.find((item) => item.id === targetId) ?? normalized[normalized.length - 1]
  // 앞 글과 뒷 글이 한 칸으로 합쳐지면 커서는 합쳐진 자리, 곧 원래 앞 글의 끝에 둔다.
  const at = previous && target.id === previous.id ? previous.value.length : target.value.length
  return { blocks: normalized, focusId: target.id, focusAt: at }
}

// 내 말풍선에 그릴 조각. 코드 앞뒤 빈 줄과 빈 글 칸은 말풍선에 빈 줄로 남지 않게 뺀다.
export function bubbleBlocks(text: string): ComposerBlock[] {
  return blocksFromMessage(text)
    .map((block) => (block.kind === 'text' ? { ...block, value: block.value.replace(/^\n+|\n+$/g, '') } : block))
    .filter((block) => block.kind === 'code' || block.value.length > 0)
}

// 에이전트에게 보낼 글. 빈 상자는 빠지고, 언어가 없으면 ``` 만 붙인다.
export function serializeBlocks(blocks: ComposerBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'text') {
      const value = block.value.replace(/^\n+|\n+$/g, '')
      if (value) parts.push(value)
      continue
    }
    if (block.value.length === 0) continue
    const body = block.value.replace(/\n$/, '')
    parts.push('```' + block.lang + '\n' + body + '\n```')
  }
  return parts.join('\n').trim()
}

export function encodeDraft(blocks: ComposerBlock[]): string {
  if (!blocks.some((block) => block.kind === 'code')) {
    return blocks.map((block) => (block.kind === 'text' ? block.value : '')).join('\n')
  }
  const payload = blocks.map((block) =>
    block.kind === 'text'
      ? { k: 't' as const, v: block.value }
      : { k: 'c' as const, l: block.lang, v: block.value, c: block.collapsed || undefined },
  )
  return DRAFT_MARK + JSON.stringify(payload)
}

export function decodeDraft(raw: string): ComposerBlock[] {
  if (!raw.startsWith(DRAFT_MARK)) return [textBlock(raw)]
  try {
    const parsed = JSON.parse(raw.slice(DRAFT_MARK.length)) as unknown
    if (!Array.isArray(parsed)) return [textBlock('')]
    const blocks: ComposerBlock[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const record = item as { k?: string; v?: unknown; l?: unknown; c?: unknown }
      if (record.k === 't' && typeof record.v === 'string') blocks.push(textBlock(record.v))
      else if (record.k === 'c' && typeof record.v === 'string') {
        const code = codeBlock(typeof record.l === 'string' ? record.l : '', record.v)
        code.collapsed = record.c === true
        blocks.push(code)
      }
    }
    return normalizeBlocks(blocks)
  } catch {
    // 선택적 초안이 이전 형식이거나 JSON이 아니면 빈 입력으로 시작한다.
    return [textBlock('')]
  }
}

// 이미 보낸 글을 입력창에 다시 넣을 때. 닫힌 ``` 만 상자로 되돌리고, 안 닫힌 표시는 글 그대로 둔다.
export function blocksFromMessage(text: string): ComposerBlock[] {
  const lines = text.split('\n')
  const blocks: ComposerBlock[] = []
  let buf: string[] = []
  let code: { marker: string; lang: string; lines: string[] } | null = null
  const flush = () => {
    if (buf.length === 0) return
    const value = buf.join('\n')
    buf = []
    if (value.length > 0) blocks.push(textBlock(value))
  }
  for (const line of lines) {
    if (code) {
      if (isClosingFence(line)) {
        blocks.push(codeBlock(code.lang, code.lines.join('\n')))
        code = null
      } else code.lines.push(line)
      continue
    }
    const open = openingFence(line)
    if (open) {
      flush()
      const marker = line.trimStart().startsWith('~~~') ? '~~~' : '```'
      code = { marker, lang: open.lang, lines: [] }
      continue
    }
    buf.push(line)
  }
  if (code) buf.push(code.marker + code.lang, ...code.lines)
  flush()
  if (blocks.length === 0) return [textBlock(text)]
  return normalizeBlocks(blocks)
}
