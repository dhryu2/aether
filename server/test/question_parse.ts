/**
 * 구조화 질문 매핑. 실행: npx tsx server/test/question_parse.ts
 */
import { mapQuestionOption, parseAskQuestions, sanitizePreview } from "../sessions/questionParse";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`);
  c ? pass++ : fail++;
};

check(sanitizePreview("**굵게**") === "**굵게**", "마크다운 미리보기 보존");
check(sanitizePreview("<script>x</script>") === undefined, "script 미리보기 폐기");
check(sanitizePreview("<!DOCTYPE html><div>x</div>") === undefined, "HTML 문서 폐기");
check(sanitizePreview("  ") === undefined, "빈 미리보기 폐기");

const mapped = mapQuestionOption({ label: "Compact", description: "짧게", preview: "- a\n- b" });
check(mapped?.label === "Compact" && mapped.preview === "- a\n- b", "옵션 preview 매핑");
check(mapQuestionOption({ label: "X", preview: "<style>x</style>" })?.preview === undefined, "옵션 HTML preview 폐기");

const qs = parseAskQuestions({
  questions: [{ question: "레이아웃?", header: "배치", options: [{ label: "A", preview: "`ok`" }, { label: "B" }] }],
});
check(qs[0]?.question === "레이아웃?" && qs[0].options[0]?.preview === "`ok`", "질문 배열에서 preview 유지");
check(parseAskQuestions([{ header: "진행 방식", options: [{ label: "바로" }] }])[0]?.question === "진행 방식", "question 없으면 header를 본문으로");

console.log(`────────────────────────────────────────────────────────`);
console.log(`question_parse: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
