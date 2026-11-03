/**
 * Claude 모델 목록 줄에 중립 필드를 채운다(배경 작업 모델 측정 계획 4절).
 *
 * 공통 코드는 모델 이름의 생김새를 보지 않는다. 대신 이 어댑터가 판정해 두 필드로 옮긴다.
 *   - `followsAccountDefault`: `default` 줄. "계정 기본 모델을 쓰겠다"는 선택지이지 모델이 아니다.
 *   - `movingAlias`: `haiku`·`sonnet`·`opus`처럼 버전이 오르면 다른 정식 id를 가리키게 되는 이름.
 *     정식 id(`claude-…`)는 별칭이 아니다. `resolvedModel`이 없으면 무엇을 가리키는지 모르므로 별칭으로 보지 않는다.
 * 대화 세션의 준비 신호와 배경 작업의 목록 조회가 같은 규칙을 쓴다(지문이 두 경로에서 같게 나와야 한다).
 */
type Row = { value: string; resolvedModel?: string };

export function claudeModelTraits(m: Row): { followsAccountDefault?: true; movingAlias?: true } {
  if (m.value === "default") return { followsAccountDefault: true };
  if (m.resolvedModel && m.value !== m.resolvedModel && !m.value.startsWith("claude-")) return { movingAlias: true };
  return {};
}
