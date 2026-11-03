/**
 * 모델/CLI가 빈 답을 채우려고 넣는 자리표시자.
 * `/clear` 직후 Claude가 보내는 "(no content)"가 대표. 화면과 검색 색인에서 같이 뺀다.
 */
const PLACEHOLDER = /^\((?:no content|no text)\)$/i;

export function isBlankAssistantText(text: string): boolean {
  const s = text.trim();
  return !s || PLACEHOLDER.test(s);
}
