const EXT: Record<string, string> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  ruby: "rb",
  rust: "rs",
  go: "go",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  cs: "cs",
  html: "html",
  css: "css",
  json: "json",
  yaml: "yml",
  yml: "yml",
  markdown: "md",
  md: "md",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  sql: "sql",
  text: "txt",
  plain: "txt",
  txt: "txt",
};

/** 코드 상자를 저장할 때 쓰는 파일 이름. 모르는 언어는 안전한 짧은 확장자거나 txt. */
export function codeFileName(lang: string, index: number): string {
  const key = lang.trim().toLowerCase();
  const known = EXT[key];
  const ext = known ?? (key.replace(/[^a-z0-9]/g, "").slice(0, 8) || "txt");
  const n = Number.isInteger(index) && index > 0 ? index : 1;
  return `code-${n}.${ext}`;
}
