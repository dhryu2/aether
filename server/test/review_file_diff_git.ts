/**
 * 검토함 파일 diff의 git 대체(folderFileDiffAsync) 안전과 경로 모양 — 모델 호출 0.
 * 외부 diff 프로그램·textconv가 실행되지 않고, 새 파일이 FIFO여도 멈추지 않고, 이상한 경로 이름도 읽는다.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-fdiff-")));
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-fdiff-data-"));
process.env.AETHER_PROJECT_ROOT = T;
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
});
const { folderFileDiffAsync } = await import("../sessions/isolatedWorkspace");

// 자식 모드: FIFO 시험은 동기 차단까지 잡도록 별도 프로세스에서 돌리고 부모가 시간 제한을 건다.
if (process.argv[2] === "fifo") {
  await folderFileDiffAsync(process.argv[3], process.argv[4]);
  console.log("done");
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}
const g = (a: string[], cwd: string) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const LOG = path.join(T, "marks.log");
fs.writeFileSync(LOG, "");
const MARK = path.join(T, "mark.sh");
fs.writeFileSync(MARK, `#!/bin/sh\necho "$1" >> ${LOG}\nexit 0\n`, { mode: 0o755 });

const repo = path.join(T, "repo");
fs.mkdirSync(repo);
g(["init", "-q", "-b", "main"], repo);
const names = ["plain.txt", "한글 파일.txt", "with space.txt", "a[1].ts", "x*.ts", "ext.txt", "bin.dat"];
for (const n of names) fs.writeFileSync(path.join(repo, n), "old\n");
fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
fs.writeFileSync(path.join(repo, ".gitattributes"), "ext.txt diff=evil\n");
g(["add", "-A"], repo);
g(["commit", "-q", "-m", "i"], repo);
g(["config", "diff.external", MARK], repo);
g(["config", "diff.evil.textconv", MARK], repo);
for (const n of names) fs.writeFileSync(path.join(repo, n), "new\n");
fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
fs.writeFileSync(path.join(repo, "ignored.log"), "x\n");
fs.writeFileSync(path.join(repo, "fresh.txt"), "a\nb\n");
fs.writeFileSync(path.join(repo, "한글 새.txt"), "가\n");

for (const n of ["plain.txt", "한글 파일.txt", "with space.txt", "a[1].ts", "x*.ts", "ext.txt"]) {
  const r = await folderFileDiffAsync(repo, path.join(repo, n));
  check(!!r?.hunks?.length && r.additions === 1 && r.deletions === 1 && r.path === n, `추적 파일 변경: ${n}`, r);
}
check(fs.readFileSync(LOG, "utf8") === "", "외부 diff 프로그램과 textconv는 실행되지 않는다", fs.readFileSync(LOG, "utf8"));
check((await folderFileDiffAsync(repo, path.join(repo, "bin.dat")))?.binary === true, "이진 파일은 binary");
const fresh = await folderFileDiffAsync(repo, path.join(repo, "fresh.txt"));
check(fresh?.isCreate === true && fresh.additions === 2, "추적하지 않는 새 파일", fresh);
check((await folderFileDiffAsync(repo, path.join(repo, "한글 새.txt")))?.additions === 1, "한글 이름의 새 파일");
check((await folderFileDiffAsync(repo, path.join(repo, "ignored.log"))) === null, "무시된 파일은 null");
check((await folderFileDiffAsync(repo, path.join(T, "outside.txt"))) === null, "저장소 밖은 null");
g(["add", "-A"], repo);
g(["commit", "-q", "-m", "n"], repo);
check((await folderFileDiffAsync(repo, path.join(repo, "plain.txt"))) === null, "이미 커밋된 파일은 찾지 않는다(null)");

const fifo = path.join(repo, "pipe");
execFileSync("mkfifo", [fifo]);
const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "fifo", repo, fifo], { timeout: 8000, encoding: "utf8" });
check(child.status === 0 && child.stdout.includes("done"), "새 파일이 FIFO여도 멈추지 않는다(별도 프로세스, 8초 제한)", { status: child.status, signal: child.signal });

// 저장소 하위 폴더에서 연 세션: 경로 기준이 최상위가 아니라 작업 폴더로 같아야 한다.
fs.mkdirSync(path.join(repo, "sub"));
fs.writeFileSync(path.join(repo, "sub", "s.ts"), "1\n");
fs.writeFileSync(path.join(repo, "sub", "t.ts"), "1\n");
g(["add", "-A"], repo);
g(["commit", "-q", "-m", "s"], repo);
fs.writeFileSync(path.join(repo, "sub", "s.ts"), "2\n");
const sub = await folderFileDiffAsync(path.join(repo, "sub"), path.join(repo, "sub", "s.ts"));
check(!!sub?.hunks?.length && !sub.isCreate && sub.kind === "edit" && sub.path === "s.ts" && sub.additions === 1 && sub.deletions === 1, "하위 폴더 세션: 수정된 추적 파일은 수정으로 나온다", sub);
check((await folderFileDiffAsync(path.join(repo, "sub"), path.join(repo, "sub", "t.ts"))) === null, "하위 폴더 세션: 커밋된 파일은 null");

// 폴더는 git을 부르지 않고 null. 폴더 안 비밀이 나오지 않는다.
fs.mkdirSync(path.join(repo, "secretdir"));
fs.writeFileSync(path.join(repo, "secretdir", ".env"), "TOP_SECRET=1\n");
check((await folderFileDiffAsync(repo, path.join(repo, "secretdir"))) === null, "추적하지 않는 폴더는 null");
g(["add", "-A"], repo);
check((await folderFileDiffAsync(repo, path.join(repo, "secretdir"))) === null, "추적 중인 폴더도 null(안의 비밀이 나오지 않는다)");
fs.rmSync(path.join(repo, "sub", "t.ts"));
check(!!(await folderFileDiffAsync(repo, path.join(repo, "sub", "t.ts")))?.hunks?.length, "삭제된 추적 파일은 diff가 나온다");

console.log(`\n${fail === 0 ? "✅" : "❌"} review_file_diff_git: ${pass} pass / ${fail} fail`);
fs.rmSync(T, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
