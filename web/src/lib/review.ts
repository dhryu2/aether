// 검토함의 순수 계산. 묶음 나누기, 위아래 이동, 다음 행 고르기, 행 둘째 줄 글.
import type { ReviewRow } from '@shared/brain'

export type ReviewGroups = { attention: ReviewRow[]; changes: ReviewRow[] }

type Tr = (key: string, params?: Record<string, string | number>) => string

const newest = (a: ReviewRow, b: ReviewRow) => b.lastActivityAt - a.lastActivityAt

/** 실패나 남은 할 일이 있는 것을 위로, 변경만 있는 것을 아래로 나눈다. 각 묶음은 최신순. */
export function groupReview(rows: readonly ReviewRow[]): ReviewGroups {
  return {
    attention: rows.filter((r) => r.needsAttention).sort(newest),
    changes: rows.filter((r) => !r.needsAttention).sort(newest),
  }
}

/** 화면에 그려지는 순서의 한 줄 목록. 위아래 키가 이 순서를 따른다. */
export function flatReview(g: ReviewGroups): ReviewRow[] {
  return [...g.attention, ...g.changes]
}

/** 위아래로 한 칸 옮긴 행 id. 끝에서 멈춘다. 지금 행이 없으면 첫 행. */
export function stepReview(flat: readonly ReviewRow[], id: string | null, delta: 1 | -1): string | null {
  if (!flat.length) return null
  const i = flat.findIndex((r) => r.id === id)
  if (i < 0) return flat[0].id
  return flat[Math.min(flat.length - 1, Math.max(0, i + delta))].id
}

/** 이 행을 처리한 뒤 고를 행. 아래 행, 없으면 위 행, 둘 다 없으면 null. */
export function nextAfterDone(flat: readonly ReviewRow[], id: string): string | null {
  const i = flat.findIndex((r) => r.id === id)
  if (i < 0) return flat[0]?.id ?? null
  return (flat[i + 1] ?? flat[i - 1])?.id ?? null
}

/** 행 둘째 줄: "프로젝트 · 파일 N개 · 실패 N개 · 할 일 N개". 0인 값은 뺀다. */
export function rowSubtitle(row: ReviewRow, t: Tr): string {
  return [
    row.projectName,
    row.fileCount > 0 ? t('brain.review.files', { n: row.fileCount }) : '',
    row.failureCount > 0 ? t('brain.review.failures', { n: row.failureCount }) : '',
    row.turnFailed ? t(row.turnFailed === 'failed' ? 'brain.review.turnFailedShort' : 'brain.review.turnInterruptedShort') : '',
    row.todoCount > 0 ? t('brain.review.todos', { n: row.todoCount }) : '',
  ].filter(Boolean).join(' · ')
}

/** 프로젝트 폴더 안의 경로는 상대 경로로 줄여 보인다. 밖이면 그대로. */
export function displayPath(file: string, projectPath: string): string {
  const base = projectPath.replace(/\/+$/, '')
  return base && file.startsWith(base + '/') ? file.slice(base.length + 1) : file
}
