/** 지운 이름 뽑기(순수 함수) — 모델 호출 0, 파일·DB 없음. */
import assert from "node:assert";
import { deletedFileStems, removedDefinitions } from "../sessions/reviewLeftovers";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✅ ${name}`);
    pass++;
  } catch {
    console.log(`  ❌ ${name} — ${JSON.stringify({ actual, expected })}`);
    fail++;
  }
}
const names = (r: { name: string }[]) => r.map((d) => d.name);

console.log("\n=== 지운 정의 ===");
eq("diff의 - 줄", names(removedDefinitions([{ toolId: "a", path: "/p/a.ts", diff: "@@ -1,2 +1,1 @@\n-export function oldThing() {\n-}\n+// gone\n" }])), ["oldThing"]);
eq("앞뒤 본문은 앞에만 있는 줄", names(removedDefinitions([{ toolId: "a", path: "/p/a.ts", before: "export const keepMe = 1;\nexport class Legacy {}\n", after: "export const keepMe = 1;\n" }])), ["Legacy"]);
eq("삭제(앞 본문만)는 앞 본문 전체", names(removedDefinitions([{ toolId: "a", path: "/p/a.ts", before: "def old_job():\n    pass\nfn run_it() {}\n" }])), ["old_job", "run_it"]);
eq("순번이 따라온다", removedDefinitions([{ toolId: "a", seq: 7, path: "/p/a.ts", before: "type Gone = 1\n", after: "" }]), [{ name: "Gone", seq: 7 }]);
eq("들여쓴 정의는 뺀다", names(removedDefinitions([{ toolId: "a", path: "/p/a.ts", before: "  function inner() {}\n\tconst nested = 1\n" , after: "" }])), []);
eq("4자 미만 이름은 뺀다", names(removedDefinitions([{ toolId: "a", path: "/p/a.ts", before: "const abc = 1\nconst abcd = 2\n", after: "" }])), ["abcd"]);
eq("같은 세션이 다시 더한 이름은 뺀다(코드를 옮긴 경우)", names(removedDefinitions([
  { toolId: "a", path: "/p/a.ts", before: "export function moved() {}\nexport function dropped() {}\n", after: "" },
  { toolId: "b", path: "/p/b.ts", after: "export function moved() {}\n" },
])), ["dropped"]);
eq("30개까지만", removedDefinitions([{ toolId: "a", path: "/p/a.ts", before: Array.from({ length: 40 }, (_, i) => `const name${i}x = 1`).join("\n"), after: "" }]).length, 30);

console.log("\n=== 지운 파일 이름 ===");
eq("기록의 바뀐 파일에 든 삭제만 남는다", deletedFileStems(["/r/legacyThing.ts", "/r/other.ts"], ["/r/legacyThing.ts"], []), ["legacyThing"]);
eq("셸 명령에 파일 이름이 나오면 남는다", deletedFileStems(["/r/oldModule.py"], [], ["git rm oldModule.py"]), ["oldModule"]);
eq("세션과 상관없는 삭제는 뺀다", deletedFileStems(["/r/oldModule.py"], [], ["ls"]), []);
eq("4자 미만과 흔한 이름은 뺀다", deletedFileStems(["/r/abc.ts", "/r/index.ts", "/r/Utils.ts", "/r/real_name.ts"], ["/r/abc.ts", "/r/index.ts", "/r/Utils.ts", "/r/real_name.ts"], []), ["real_name"]);

console.log(`\n${fail === 0 ? "✅" : "❌"} review_leftovers: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
