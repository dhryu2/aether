/**
 * Claude 실행 파일을 못 찾는 영어 오류를 안내 문구로 바꾸는지 — 모델 호출 0.
 */
import { classifyServiceError } from "../providers/claude/errorOrigin";
import { st } from "../i18n";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const raw = new Error("Claude Code executable not found at /x/claude. Is options.pathToClaudeCodeExecutable set?");
const out = classifyServiceError(raw);
check("실행 파일 없음 오류는 안내 문구로 바뀐다", out.message === st("notice.claude.binaryMissing") && out !== raw, out.message);
check("원래 오류는 cause로 남는다", (out as Error & { cause?: unknown }).cause === raw);
check("환경 오류로 분류된다", (out as { errorOrigin?: string }).errorOrigin === "external_environment");

const native = classifyServiceError(new Error("Claude Code native binary not found at /x. Please ensure Claude Code is installed"));
check("네이티브 문구도 바뀐다", native.message === st("notice.claude.binaryMissing"));

const other = new Error("something else");
check("무관한 오류는 그대로다", classifyServiceError(other) === other && other.message === "something else");

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
