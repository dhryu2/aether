/**
 * 자식 작업(ToolKind task) 화면 요약 — 원본 JSON을 그대로 보여 주지 않는다.
 * 화면은 이름·역할·상태·요약·실패 사유·손댄 파일만 그린다.
 */
import type { ToolResultView } from './agentEvents'

export type TeamTaskStatus = 'running' | 'waiting' | 'done' | 'failed'

export type TeamTaskView = {
  key: string
  title: string
  roleKey: 'explore' | 'implement' | 'review' | 'generic'
  status: TeamTaskStatus
  summary: string
  /** 실패일 때만 채운다. 접힌 줄에 쓰는 한 줄 사유. 성공·진행 중은 빈 문자열. */
  reason: string
  files: string[]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function roleKeyOf(input: Record<string, unknown>): TeamTaskView['roleKey'] {
  const blob = [str(input.subagent_type), str(input.role), str(input.agent), str(input.description), str(input.title)]
    .join(' ')
    .toLowerCase()
  if (/(explor|검색|탐색|research)/.test(blob)) return 'explore'
  if (/(review|리뷰|critic)/.test(blob)) return 'review'
  if (/(implement|executor|code|구현|write)/.test(blob)) return 'implement'
  return 'generic'
}

function titleOf(name: string, input: Record<string, unknown>): string {
  return str(input.description) || str(input.title) || str(input.name) || name || '작업'
}

function textFrom(v: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map((x) => textFrom(x, depth + 1)).filter(Boolean).join('\n')
  const rec = record(v)
  if (!rec) return ''
  if (typeof rec.text === 'string') return rec.text.trim()
  if (typeof rec.output === 'string') return rec.output.trim()
  if (typeof rec.summary === 'string') return rec.summary.trim()
  if (rec.content !== undefined) return textFrom(rec.content, depth + 1)
  return ''
}

/** 접힌 실패 줄용. 긴 경로 괄호와 공백을 접고 한 줄로 자른다. */
export function failReasonPreview(text: string): string {
  let s = text.replace(/\s+/g, ' ').trim()
  s = s.replace(/\s*\([^)]*[/\\][^)]*\)\.?\s*$/, '')
  if (s.length > 160) s = `${s.slice(0, 157)}…`
  return s
}

function filesFrom(input: Record<string, unknown>, result?: ToolResultView): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && /[\\/]/.test(v) && v.length < 400) out.push(v)
    else if (Array.isArray(v)) v.forEach(push)
  }
  push(input.files)
  push(input.file_path)
  push(input.path)
  const rec = record(result?.content)
  if (rec) {
    push(rec.files)
    push(rec.touched)
    push(rec.paths)
  }
  return [...new Set(out)].slice(0, 12)
}

export function teamTaskView(
  entry: { name: string; input: Record<string, unknown>; result?: ToolResultView; key: string },
  waiting: boolean,
): TeamTaskView {
  const resultText = textFrom(entry.result?.content) || (typeof entry.result?.content === 'string' ? entry.result.content.trim() : '')
  const prompt = str(entry.input.prompt) || str(entry.input.task)
  const summary = (resultText || prompt).replace(/\s+/g, ' ').trim().slice(0, 280)
  let status: TeamTaskStatus = 'running'
  if (entry.result?.is_error || /^\s*rejected:/i.test(resultText)) status = 'failed'
  else if (entry.result) status = 'done'
  else if (waiting) status = 'waiting'
  return {
    key: entry.key,
    title: titleOf(entry.name, entry.input),
    roleKey: roleKeyOf(entry.input),
    status,
    summary,
    reason: status === 'failed' ? failReasonPreview(resultText || summary) : '',
    files: filesFrom(entry.input, entry.result),
  }
}
