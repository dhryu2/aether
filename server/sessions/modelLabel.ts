import type { ModelInfo } from "../../shared/http";

/** 이름 끝의 대괄호 변종 표시를 뗀다. `name[1m]` → `name`. */
function stripVariant(name: string): string {
  return name.replace(/\[[^\]]*\]$/, "");
}

function preferSpecific(rows: readonly ModelInfo[]): ModelInfo | undefined {
  return rows.find((row) => !row.isDefault) ?? rows[0];
}

/**
 * 세션 모델 원문을 사람이 읽는 이름으로 바꾼다.
 *
 * 맞추는 순서는 화면의 모델 칩과 같다. 이름을 지어내지 않으므로, 맞는 줄이 없으면 빈 문자열이다.
 *  1. `value`가 원문과 같다(대소문자 무시).
 *  2. `resolvedModel`이 원문과 같다. 여러 줄이면 기본 줄이 아닌 쪽을 고른다.
 *  3. 끝의 `[...]` 변종 표시만 떼고 `value`와 `resolvedModel`을 다시 비교한다. 여러 줄이면 기본이 아닌 쪽을 고른다.
 */
export function resolveModelDisplayName(raw: string, models: readonly ModelInfo[]): string {
  const name = raw.trim();
  if (!name || models.length === 0) return "";
  const cur = name.toLowerCase();
  const byValue = models.find((row) => row.value.toLowerCase() === cur);
  if (byValue) return byValue.displayName.trim();
  const byResolved = preferSpecific(models.filter((row) => (row.resolvedModel ?? "").toLowerCase() === cur));
  if (byResolved) return byResolved.displayName.trim();
  const bare = stripVariant(cur);
  const same = (rowName: string | undefined) => !!rowName && stripVariant(rowName.toLowerCase()) === bare;
  const byBare = preferSpecific(models.filter((row) => same(row.resolvedModel) || same(row.value)));
  return byBare?.displayName.trim() ?? "";
}
