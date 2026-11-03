/**
 * 새 세션 작업 폴더(cwd) 검사 — 모델 호출 0(mock provider, 메시지를 보내지 않는다).
 *
 * 규칙: 작업 폴더 범위 제한은 없다. 실재하는 폴더면 어디든 열 수 있고,
 *   없는 경로·파일·상대경로·홈의 비밀 폴더(.ssh 등)만 거부한다. 임시 홈과 임시 기본 폴더만 쓴다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-cwdcheck-")));
const home = path.join(tmp, "home");
const root = path.join(tmp, "home", "project"); // 기본 폴더
const sibling = path.join(tmp, "other"); // 기본 폴더 밖(옛 규칙이면 거부되던 곳)
for (const d of [root, path.join(home, ".ssh"), sibling]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(root, "file.txt"), "x");
process.env.HOME = home;
process.env.AETHER_PROJECT_ROOT = root;
process.env.AETHER_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.AETHER_DATA_DIR);

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("cwd_check"); // 임시 SQLite 일기
const { __registerProviderForTest } = await import("../providers/registry");
const { mockEntry, MOCK_PROVIDER } = await import("./support/mockProvider");
const unregister = __registerProviderForTest(mockEntry);

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}
function expectThrow(cwd: string, name: string) {
  try {
    sessionManager.create({ provider: MOCK_PROVIDER, cwd });
    check(false, `${name} — 예외 안 남(위험!)`);
  } catch (e) {
    check(true, `${name} — 차단: ${(e as Error).message}`);
  }
}
function expectOk(cwd: string | undefined, want: string, name: string) {
  try {
    const s = sessionManager.create({ provider: MOCK_PROVIDER, cwd });
    check(s.cwd === want, name, s.cwd);
  } catch (e) {
    check(false, `${name} — ${(e as Error).message}`);
  }
}

console.log(`기본 폴더: ${root}`);
expectThrow("/nonexistent/xyz", "존재하지 않는 cwd 거부");
expectThrow(path.join(root, "file.txt"), "파일 경로 거부");
expectThrow("../../..", "상대경로 거부");
expectThrow(path.join(home, ".ssh"), "홈의 .ssh 거부");
expectOk(undefined, root, "cwd 없음 = 기본 폴더");
expectOk(path.dirname(root), home, "기본 폴더의 부모 폴더 통과(범위 제한 없음)");
expectOk(sibling, sibling, "기본 폴더 밖 폴더 통과");

console.log("─".repeat(40));
console.log(fail === 0 ? `✅ CWD 검사 PASS (단언 ${pass}개)` : `❌ FAIL (${fail}건)`);
unregister();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
