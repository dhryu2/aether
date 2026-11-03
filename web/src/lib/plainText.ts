/** 마크다운 기호를 걷어 낸 읽기용 글. 코드 울타리의 내용은 남긴다. */
export function markdownToPlain(src: string): string {
  let text = src.replace(/\r\n/g, "\n");
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_all, body: string) => body);
  text = text.replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, (_all, body: string) => body);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2");
  return text.replace(/[ \t]+\n/g, "\n").trim();
}
