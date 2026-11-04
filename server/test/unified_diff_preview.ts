/**
 * unified diff 미리보기 — 모델 호출 0.
 * 폴더 밖 경로·이동 도착지를 카드에 정직하게 보이고, 덩어리 줄 수와 안 맞는 입력은 줄을 버리지 않고 경고한다.
 */
import path from "node:path";
import { previewFromUnifiedDiff, parseUnifiedDiff } from "../sessions/mutationPreview";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const cwd = path.resolve("/tmp/example-project");
const OUT = "/tmp/example-outside";

console.log("=== 경로 표시 ===");
{
  const p = previewFromUnifiedDiff([{ path: `${OUT}/.profile`, diff: "@@ -1 +1 @@\n-a\n+b\n" }], cwd);
  check(p?.path === `${OUT}/.profile`, "폴더 밖 변경은 전체 경로를 보인다", p?.path);
  check(p?.files?.[0].path === ".profile", "복원 기록용 files 경로는 이전 그대로", p?.files);
  const inside = previewFromUnifiedDiff([{ path: path.join(cwd, "src/a.txt"), diff: "@@ -1 +1 @@\n-a\n+b\n" }], cwd);
  check(inside?.path === "src/a.txt", "폴더 안은 상대 경로", inside?.path);
  const moved = previewFromUnifiedDiff([{ path: "src/inside.txt", movePath: `${OUT}/target`, diff: "@@ -1 +1 @@\n-a\n+b\n" }], cwd);
  check(moved?.path === `src/inside.txt → ${OUT}/target`, "이동은 도착 경로까지 보인다", moved?.path);
  const secretDest = previewFromUnifiedDiff([{ path: "src/inside.txt", movePath: `${OUT}/.env`, diff: "@@ -1 +1 @@\n-a\n+DUMMY\n" }], cwd);
  check(secretDest?.redacted === true && !secretDest.hunks, "도착 경로가 비밀 경로면 내용을 가린다", secretDest);
}

console.log("=== 숨은 줄과 줄 수 ===");
{
  const hiddenAdd = previewFromUnifiedDiff([{ path: "a.py", diff: "@@ -1 +1,2 @@\n import os\n+++ dummy()\n" }], cwd);
  check(hiddenAdd?.additions === 1 && !!hiddenAdd.hunks?.[0].lines.includes("+++ dummy()") && !hiddenAdd.inexact, "'+++ ' 내용 줄이 더한 줄로 센다", hiddenAdd);
  const hiddenDel = previewFromUnifiedDiff([{ path: "a.py", diff: "@@ -1,2 +1 @@\n keep\n--- guard()\n" }], cwd);
  check(hiddenDel?.deletions === 1 && !!hiddenDel.hunks?.[0].lines.includes("--- guard()") && !hiddenDel.inexact, "'--- ' 내용 줄이 지운 줄로 센다", hiddenDel);
  const extra = previewFromUnifiedDiff([{ path: "a.py", diff: "@@ -1 +1 @@\n-a\n+b\n+++ hidden\n" }], cwd);
  check(extra?.inexact === true && !!extra.hunks?.[0].lines.includes("+++ hidden"), "줄 수보다 많은 줄은 버리지 않고 경고한다", extra);
  const short = previewFromUnifiedDiff([{ path: "a.py", diff: "@@ -1,3 +1,3 @@\n-a\n+b\n" }], cwd);
  check(short?.inexact === true, "줄 수보다 적은 입력도 경고한다", short);
  const clean = previewFromUnifiedDiff([{ path: "a.py", diff: "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-c\n+d\n" }], cwd);
  check(clean?.inexact === undefined && clean?.additions === 2 && clean?.deletions === 2, "파일 머리글이 있는 정상 diff는 경고가 없다", clean);
  check(parseUnifiedDiff("").hunks.length === 0, "덩어리가 없으면 빈 목록");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} unified_diff_preview: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
