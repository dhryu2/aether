/**
 * 작업 복사본 반영의 경계 — 모델 호출 0.
 *
 * 무시 파일을 덮지 않고, 링크·서브모듈·.git 자리를 따라 원 폴더 밖이나 .git에 쓰지 않는지 본다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-applyb-")));
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-applyb-data-"));
process.env.AETHER_PROJECT_ROOT = T;
process.env.AETHER_WORKTREE_DIR = path.join(T, "wt");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
});
const { prepareIsolatedWorkspace, applyIsolatedWorkspace, splitListedPath } = await import("../sessions/isolatedWorkspace");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}
const g = (a: string[], cwd: string) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const rd = (f: string) => fs.readFileSync(f, "utf8");
const w = (f: string, c = "x") => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const outside = path.join(T, "outside"); fs.mkdirSync(outside); w(path.join(outside, "keep.txt"), "KEEP");
let n = 0;
function setup(): string {
  const src = fs.realpathSync(fs.mkdtempSync(path.join(T, "src-")));
  g(["init", "-q", "-b", "main"], src);
  w(path.join(src, "a.txt"), "base\n"); w(path.join(src, ".gitignore"), ".env\nnode_modules/\n");
  g(["add", "-A"], src); g(["commit", "-q", "-m", "i"], src);
  return src;
}
const mk = (src: string) => prepareIsolatedWorkspace(src, `s${++n}`).cwd;
const commit = (src: string) => { g(["add", "-A"], src); g(["commit", "-q", "-m", "c"], src); };
const apply = (d: string, src: string): string | null => { try { applyIsolatedWorkspace(d, src); return null; } catch (e) { return (e as Error).message; } };

console.log("무시 파일");
{
  const src = setup(); w(path.join(src, ".env"), "ORIG"); const d = mk(src);
  w(path.join(d, ".env"), "EVIL"); w(path.join(d, "new.txt"), "n"); w(path.join(d, "a.txt"), "edit\n"); w(path.join(d, "node_modules/x"), "x");
  check(apply(d, src) === null, "반영 성공");
  check(rd(path.join(src, ".env")) === "ORIG", "무시 파일 .env는 원래 값", rd(path.join(src, ".env")));
  check(fs.existsSync(path.join(src, "new.txt")) && rd(path.join(src, "a.txt")) === "edit\n", "새 파일과 수정은 반영");
  check(!fs.existsSync(path.join(src, "node_modules")), "무시 폴더는 옮기지 않는다");
}
{
  const src = setup(); w(path.join(src, ".env"), "ORIG"); const d = mk(src);
  w(path.join(d, ".gitignore"), "# none\n"); w(path.join(d, ".env"), "EVIL"); g(["add", "-f", ".env", ".gitignore"], d);
  apply(d, src);
  check(rd(path.join(src, ".env")) === "ORIG", "복사본 .gitignore 무력화+색인 강제 추가에도 .env는 원래 값");
}
console.log("링크");
{
  const src = setup(); fs.symlinkSync(outside, path.join(src, "lnk")); commit(src); const d = mk(src);
  fs.rmSync(path.join(d, "lnk")); w(path.join(d, "lnk/keep.txt"), "EVIL"); w(path.join(d, "z-first.txt"), "z");
  check(apply(d, src) !== null, "폴더 링크 자리에 실제 폴더는 오류");
  check(rd(path.join(outside, "keep.txt")) === "KEEP" && !fs.existsSync(path.join(src, "z-first.txt")), "바깥 파일 그대로, 다른 새 파일도 안 옮겨짐");
}
{
  const src = setup(); fs.symlinkSync(outside, path.join(src, "lnk")); fs.symlinkSync("/nonexistent/dangling", path.join(src, "dang")); fs.symlinkSync("a.txt", path.join(src, "rel")); commit(src);
  const d = mk(src); w(path.join(d, "b.txt"), "b");
  check(apply(d, src) === null, "그대로인 링크(바깥·끊김·상대) + 새 파일은 성공");
  check(fs.readlinkSync(path.join(src, "lnk")) === outside && fs.readlinkSync(path.join(src, "dang")) === "/nonexistent/dangling" && fs.readlinkSync(path.join(src, "rel")) === "a.txt", "링크 값 그대로");
}
{
  const src = setup(); const d = mk(src); fs.symlinkSync(path.join(src, ".git"), path.join(d, "g"));
  check(apply(d, src) !== null && !fs.existsSync(path.join(src, "g")), "새 링크 -> 원 폴더 .git은 거절");
}
{
  const src = setup(); const d = mk(src); fs.mkdirSync(path.join(d, "sub")); fs.symlinkSync(outside, path.join(d, "sub/o"));
  check(apply(d, src) !== null && !fs.existsSync(path.join(src, "sub")), "새 링크 -> 바깥은 거절");
}
{
  const src = setup(); const d = mk(src); w(path.join(d, "sub/.gitignore"), "*\n"); fs.symlinkSync(path.join(src, ".git"), path.join(d, "sub/g"));
  const cfg = rd(path.join(src, ".git/config"));
  apply(d, src); apply(d, src);
  check(!fs.existsSync(path.join(src, "sub")) && rd(path.join(src, ".git/config")) === cfg, "자기 무시 폴더의 .git 링크는 두 번 반영해도 .git에 안 쓴다");
  check(!fs.existsSync(path.join(src, ".git/hooks/g")) || fs.lstatSync(path.join(src, ".git/hooks")).isDirectory(), ".git/hooks 그대로");
}
{
  const src = setup(); const d = mk(src); fs.symlinkSync("a.txt", path.join(d, "inside"));
  check(apply(d, src) === null && fs.readlinkSync(path.join(src, "inside")) === "a.txt", "새 링크 -> 원 폴더 안은 성공");
}
{
  const src = setup(); const d = mk(src); w(path.join(d, "f/in.txt"), "i"); g(["add", "f/in.txt"], d);
  fs.rmSync(path.join(d, "f"), { recursive: true }); w(path.join(outside, "in.txt"), "OUT-SECRET"); fs.symlinkSync(outside, path.join(d, "f"));
  check(apply(d, src) !== null && !fs.existsSync(path.join(src, "f/in.txt")), "색인 경로가 복사본 링크를 지나면 거절, 바깥 내용 안 옮겨짐");
}
{
  const src = setup(); fs.symlinkSync(path.join(src, "a.txt"), path.join(src, "fl")); commit(src); const d = mk(src);
  fs.rmSync(path.join(d, "fl")); w(path.join(d, "fl"), "E");
  check(apply(d, src) !== null && rd(path.join(src, "a.txt")) === "base\n", "파일 링크 자리에 일반 파일은 거절, 링크 대상 그대로");
}
console.log("서브모듈과 내장 저장소");
{
  const src = setup(); const lib = setup(); g(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "m"], src); commit(src); const d = mk(src);
  w(path.join(d, "b.txt"), "b");
  check(apply(d, src) === null, "서브모듈 빈 폴더는 정상 반영"); fs.rmSync(path.join(src, "b.txt"));
  const before = rd(path.join(src, "m/a.txt")); w(path.join(d, "m/a.txt"), "EVIL");
  check(apply(d, src) !== null && rd(path.join(src, "m/a.txt")) === before, "복사본 서브모듈 폴더에 내용이 있으면 거절");
  fs.rmSync(path.join(d, "m/a.txt")); g(["rm", "-q", "--cached", "m"], d); w(path.join(d, "m/a.txt"), "EVIL");
  check(apply(d, src) !== null && rd(path.join(src, "m/a.txt")) === before, "복사본 색인에서 서브모듈을 빼고 파일을 두면 거절");
}
{
  const src = setup(); const d = mk(src); fs.mkdirSync(path.join(d, "emb")); g(["init", "-q"], path.join(d, "emb")); w(path.join(d, "emb/f"), "1");
  check(apply(d, src) !== null && !fs.existsSync(path.join(src, "emb")), "복사본 안 새 내장 저장소는 거절");
}
{
  const src = setup(); const d = mk(src); w(path.join(d, "sub/.GIT/config"), "x"); const cfg = rd(path.join(src, ".git/config"));
  apply(d, src);
  check(rd(path.join(src, ".git/config")) === cfg && !fs.existsSync(path.join(src, "sub/.GIT")), "sub/.GIT/config는 안 옮겨짐");
}
console.log("이름과 권한");
{
  const src = setup(); const d = mk(src); const nfd = "한글".normalize("NFD");
  w(path.join(d, " 앞공백.txt"), "s"); w(path.join(d, `${nfd}.txt`), "k"); w(path.join(d, "뒤공백 "), "t");
  const e = apply(d, src); const names = fs.readdirSync(src).map((x) => x.normalize("NFC"));
  check(e === null && names.includes(" 앞공백.txt") && names.includes("한글.txt") && names.includes("뒤공백 "), "앞 공백, 뒤 공백, NFD 한글 이름 모두 옮겨짐", { e, names });
}
{
  const src = setup(); w(path.join(src, "ro.txt"), "r"); fs.chmodSync(path.join(src, "ro.txt"), 0o444);
  w(path.join(src, "x.sh"), "#!/bin/sh\n"); fs.chmodSync(path.join(src, "x.sh"), 0o755); commit(src);
  const d = mk(src); fs.chmodSync(path.join(d, "ro.txt"), 0o644); w(path.join(d, "ro.txt"), "R2"); fs.chmodSync(path.join(d, "ro.txt"), 0o444);
  w(path.join(d, "x.sh"), "#!/bin/sh\necho 2\n");
  check(apply(d, src) === null && rd(path.join(src, "ro.txt")) === "R2" && (fs.statSync(path.join(src, "x.sh")).mode & 0o777) === 0o755, "읽기 전용 파일 덮기와 실행 권한 유지");
}
{
  const src = setup(); const d = mk(src); const bulk = path.join(d, "bulk"); fs.mkdirSync(bulk);
  for (let i = 0; i < 6000; i++) fs.writeFileSync(path.join(bulk, `${"f".repeat(200)}${i}`), "");
  check(apply(d, src) === null && fs.readdirSync(path.join(src, "bulk")).length === 6000, "목록이 1MiB를 넘어도 성공");
}
if (process.platform !== "win32") {
  const src = setup(); const d = mk(src); fs.rmSync(path.join(d, "a.txt")); execFileSync("mkfifo", [path.join(d, "a.txt")]);
  const e = apply(d, src);
  check(e !== null && rd(path.join(src, "a.txt")) === "base\n", "추적 파일을 FIFO로 바꾸면 멈추지 않고 거절");
}
console.log("커밋 없는 저장소와 링크 교체");
{
  const src = fs.realpathSync(fs.mkdtempSync(path.join(T, "empty-"))); g(["init", "-q", "-b", "main"], src);
  let e: string | null = null; let d = "";
  try { d = mk(src); } catch (x) { e = (x as Error).message; }
  check(e === null && d !== "" && fs.existsSync(d), "커밋 없는 저장소에서도 복사본이 만들어진다", e);
}
{
  const src = setup(); w(path.join(src, "b.txt"), "B"); commit(src); const d = mk(src);
  w(path.join(d, "a-first.txt"), "first"); fs.rmSync(path.join(d, "b.txt")); fs.symlinkSync("a.txt", path.join(d, "b.txt"));
  check(apply(d, src) !== null, "추적 파일을 링크로 바꾸면 거절");
  check(!fs.existsSync(path.join(src, "a-first.txt")) && rd(path.join(src, "b.txt")) === "B", "원 폴더가 그대로(앞선 파일도 안 쓰임)");
}
console.log("윈도우 경로 구분자(순수 함수, 윈도우 실행은 못 했다)");
{
  check(splitListedPath("sub\\.git\\config", true).some((x) => x === ".git"), "win32에서는 \\로도 나눈다");
  check(!splitListedPath("sub\\.git\\config", false).some((x) => x === ".git"), "그 외 플랫폼은 /로만 나눈다");
}
console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
