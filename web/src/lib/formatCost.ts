/** 유한한 숫자만 비용 문자열. 아니면 null. */
export function formatCostUsd(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return `$${n.toFixed(2)}`
}
