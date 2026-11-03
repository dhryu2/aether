/** 목록·칸 머리에 쓰는 모델 이름. 칩(ModelPicker)과 같이, 목록에 있으면 displayName, 없으면 세션이 준 값 그대로. */

export type ModelNameRow = {
  value: string
  displayName: string
  resolvedModel?: string | null
  isDefault?: boolean
}

/**
 * 목록 카드에 쓸 세션 모델 원문.
 * 스트림에서 본 실제 모델이 있으면 그걸 쓰고, 없으면 고른 모델, 그것도 없으면 계정 기본 모델.
 */
export function sessionModelRaw(
  sess?: { observedModel?: string; model?: string; accountDefaultModel?: string } | null,
): string {
  return sess?.observedModel?.trim() || sess?.model?.trim() || sess?.accountDefaultModel?.trim() || ''
}

export function modelChipLabel(raw: string | undefined | null, models?: readonly ModelNameRow[] | null): string {
  const name = (raw ?? '').trim()
  if (!name) return ''
  if (!models?.length) return name
  const cur = name.toLowerCase()
  // 정식 id로 찾으면 계정 기본 줄과 그 모델을 직접 고른 줄이 함께 걸린다. 구체적인 이름 쪽을 쓴다.
  const byResolved = models.filter((m) => (m.resolvedModel ?? '').toLowerCase() === cur)
  const hit =
    models.find((m) => m.value.toLowerCase() === cur) ?? byResolved.find((m) => !m.isDefault) ?? byResolved[0]
  return (hit?.displayName || name).trim()
}

/** 칩에 쓸 줄 이름. 계정 기본 줄은 같은 모델을 직접 가리키는 줄의 이름을 빌려 실제로 도는 모델을 보인다. */
export function modelRowLabel(row: ModelNameRow, models: readonly ModelNameRow[]): string {
  const resolved = row.isDefault ? row.resolvedModel?.toLowerCase() : undefined
  const same = resolved && models.find((m) => !m.isDefault && m.resolvedModel?.toLowerCase() === resolved)
  return (same || row).displayName
}

type SessionModelSource = {
  observedModel?: string
  model?: string
  accountDefaultModel?: string
  modelLabel?: string
}

/** 사이드바 줄에 보여줄 모델 이름. 서버가 붙인 표시 이름이 있으면 그걸 쓰고, 없으면 목록으로 번역한다. */
export function sessionRowModel(sess?: SessionModelSource | null, models?: readonly ModelNameRow[] | null): string {
  const stored = sess?.modelLabel?.trim()
  if (stored) return stored
  return modelChipLabel(sessionModelRaw(sess), models)
}
