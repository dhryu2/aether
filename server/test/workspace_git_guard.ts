/**
 * 허브의 git 보호 — 모델 호출 0.
 *
 * 받은 폴더의 .git 설정(훅·fsmonitor·필터·include·가짜 gitdir)이 허브의 git 호출에서 실행되지 않고,
 * 허브 비밀이 자식 환경에 실리지 않는지 본다. 표식 스크립트는 임시 폴더의 표식 파일에만 쓴다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-guard-")));
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-guard-data-"));
process.env.AETHER_PROJECT_ROOT = T;
process.env.AETHER_WORKTREE_DIR = path.join(T, "wt");
process.env.AETHER_JWT_SECRET = "dummy-dummy-dummy-dummy-dummy-dummy";
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
});

const ws = await import("../sessions/isolatedWorkspace");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}

const LOG = path.join(T, "marks.log");
fs.writeFileSync(LOG, "");
const MARK = path.join(T, "mark.sh");
const FLT = path.join(T, "flt.sh");
fs.writeFileSync(MARK, `#!/bin/sh\necho "$1 s=\${AETHER_JWT_SECRET:+J}" >> ${LOG}\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(FLT, `#!/bin/sh\necho "$1 s=\${AETHER_JWT_SECRET:+J}" >> ${LOG}\nexec cat\n`, { mode: 0o755 });
const marks = () => { const r = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean); fs.writeFileSync(LOG, ""); return r; };

const g = (a: string[], cwd: string) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(n: string): string {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(T, `${n}-`)));
  g(["init", "-q", "-b", "main"], r);
  fs.writeFileSync(path.join(r, "a.txt"), "base\n");
  g(["add", "a.txt"], r);
  g(["commit", "-q", "-m", "i"], r);
  return r;
}
const cfg = (r: string, t: string) => fs.appendFileSync(path.join(r, ".git", "config"), t);
const flt = (name: string, l: string) => `[filter "${name}"]\n\tclean = ${FLT} ${l}:clean\n\tsmudge = ${FLT} ${l}:smudge\n`;
const attr = (r: string, f: string) => fs.writeFileSync(path.join(r, ".git", "info", "attributes"), `* filter=${f}\n`);
let tick = 2_000_000_000;
const bump = (f: string) => { tick += 10; try { fs.utimesSync(f, tick, tick); } catch { /* 없는 파일은 건너뜀 */ } };

/** 만들기 → 상태 → 버리기 한 묶음. 표식(해당 접두어)과 만들기 성공 여부를 돌려준다. */
async function flow(l: string, r: string): Promise<{ created: boolean; marks: string[] }> {
  let dest: string | null = null;
  try { dest = ws.prepareIsolatedWorkspace(r, `sess-${l}`).cwd; } catch { /* 만들기 실패도 표식 수는 센다 */ }
  bump(path.join(r, "a.txt"));
  if (dest) {
    bump(path.join(dest, "a.txt"));
    await ws.workspaceCopyState(dest, r);
    try { ws.discardIsolatedWorkspace(dest, r, { force: true }); } catch { /* 치우기 실패 */ }
  }
  return { created: dest !== null, marks: marks().filter((m) => m.startsWith(`${l}:`)) };
}
const zero = async (l: string, name: string, r: string) => { const o = await flow(l, r); check(o.marks.length === 0, name, o.marks); return o; };

console.log("정상 흐름");
{
  const r = repo("ok");
  const c = ws.prepareIsolatedWorkspace(r, "sess-ok");
  check(fs.readFileSync(path.join(c.cwd, "a.txt"), "utf8") === "base\n", "복사본에 파일이 체크아웃된다");
  check(g(["rev-parse", "--abbrev-ref", "HEAD"], c.cwd).startsWith("aether/"), "브랜치 aether/");
  check((await ws.workspaceCopyState(c.cwd, r)).needsApply === false, "깨끗하면 needsApply 아님");
  fs.writeFileSync(path.join(c.cwd, "n.txt"), "n\n");
  check((await ws.workspaceCopyState(c.cwd, r)).needsApply === true, "수정하면 needsApply");
  ws.applyIsolatedWorkspace(c.cwd, r);
  check(fs.existsSync(path.join(r, "n.txt")), "반영된다");
  fs.rmSync(path.join(r, "n.txt"));
  ws.discardIsolatedWorkspace(c.cwd, r, { force: true });
  check(!fs.existsSync(c.cwd), "버리기 된다");
  marks();
}

console.log("A 훅");
{ const r = repo("a"); for (const n of ["post-checkout", "reference-transaction", "post-index-change"]) fs.writeFileSync(path.join(r, ".git", "hooks", n), `#!/bin/sh\n${MARK} A:${n}\n`, { mode: 0o755 }); await zero("A", "훅이 돌지 않는다", r); }
console.log("B fsmonitor");
{ const r = repo("b"); cfg(r, `[core]\n\tfsmonitor = ${MARK} B:fs\n`); await zero("B", "fsmonitor가 돌지 않는다", r); }
console.log("C 필터");
{ const r = repo("c"); cfg(r, flt("evil", "C")); attr(r, "evil"); const o = await zero("C", "필터가 돌지 않는다", r); check(o.created, "필터가 있어도 복사본은 만들어진다"); }
console.log("D 이름에 =");
{ const r = repo("d"); cfg(r, flt("a=b", "D")); attr(r, "a=b"); await zero("D", "이름에 =가 든 필터가 돌지 않는다", r); }
console.log("F include");
{ const r = repo("f"); fs.writeFileSync(path.join(r, ".git", "inc"), flt("i", "F")); cfg(r, `[include]\n\tpath = inc\n`); attr(r, "i"); await zero("F", "include로 들어온 필터가 돌지 않는다", r); }
console.log("G onbranch include");
{ const r = repo("g"); fs.writeFileSync(path.join(r, ".git", "inc"), flt("c", "G")); cfg(r, `[includeIf "onbranch:aether/**"]\n\tpath = inc\n`); attr(r, "c"); await zero("G", "복사본 브랜치에서만 켜지는 필터가 돌지 않는다", r); }
console.log("I 서브모듈 필터 + ignore=none");
{
  const lib = repo("il"); const r = repo("i");
  g(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "m"], r);
  fs.appendFileSync(path.join(r, ".gitmodules"), "\tignore = none\n"); g(["add", ".gitmodules"], r); g(["commit", "-q", "-m", "m"], r);
  fs.appendFileSync(path.join(r, ".git", "modules", "m", "config"), flt("s", "I") + `[core]\n\tfsmonitor = ${MARK} I:fs\n`);
  fs.writeFileSync(path.join(r, ".git", "modules", "m", "info", "attributes"), "* filter=s\n");
  const dest = ws.prepareIsolatedWorkspace(r, "sess-i").cwd;
  bump(path.join(r, "m", "a.txt")); await ws.workspaceCopyState(dest, r); ws.folderUncommittedChanges(r);
  check(marks().filter((m) => m.startsWith("I:")).length === 0, "서브모듈의 필터·fsmonitor가 돌지 않는다");
  fs.writeFileSync(path.join(r, "m", "b.txt"), "x"); // 서브모듈 안 내용 변경은 보이지 않는다
  g(["add", "b.txt"], path.join(r, "m")); g(["commit", "-q", "-m", "x"], path.join(r, "m")); marks();
  check((await ws.workspaceCopyState(dest, r)).applyBlocked === true, "서브모듈 커밋 변경은 원 폴더 status에 나와 applyBlocked");
  marks();
}
console.log("J promisor ssh");
{
  const r = repo("j"); const b = g(["rev-parse", "HEAD:a.txt"], r);
  fs.rmSync(path.join(r, ".git", "objects", b.slice(0, 2), b.slice(2)), { force: true }); fs.rmSync(path.join(r, "a.txt"));
  g(["config", "core.repositoryformatversion", "1"], r);
  cfg(r, `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = ssh://git.example.invalid/x\n\tpromisor = true\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[core]\n\tsshCommand = ${MARK} J:ssh\n`);
  const o = await flow("J", r);
  check(o.marks.length === 0 && !o.created, "원격 가져오기가 시작되지 않고 만들기는 실패한다", o);
  check(!g(["branch", "--list", "aether/*"], r), "반쯤 만든 브랜치가 남지 않는다");
}
console.log("K 추적 파일 모양을 담은 clone 하위 폴더");
{
  const src = repo("ks"); const v = path.join(src, "vendor");
  g(["clone", "-q", "--bare", src, v], src); fs.rmSync(path.join(v, "packed-refs"), { force: true });
  fs.mkdirSync(path.join(v, "refs", "heads"), { recursive: true }); fs.writeFileSync(path.join(v, "refs", "heads", "main"), g(["rev-parse", "HEAD"], src) + "\n");
  fs.writeFileSync(path.join(v, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = ${MARK} K:fs\n`);
  g(["add", "-A", "-f"], src); g(["commit", "-q", "-m", "a"], src);
  const dst = fs.mkdtempSync(path.join(T, "kd-")); g(["clone", "-q", src, "o"], dst);
  await zero("K", "저장소 모양 폴더의 fsmonitor가 돌지 않는다", path.join(dst, "o", "vendor"));
}
console.log("L 복사본 .git을 가짜 gitdir로 교체");
{
  const r = repo("l"); const w = ws.prepareIsolatedWorkspace(r, "sess-l").cwd;
  fs.mkdirSync(path.join(w, ".fake", "info"), { recursive: true });
  fs.mkdirSync(path.join(w, ".fake", "objects")); fs.mkdirSync(path.join(w, ".fake", "refs"));
  fs.writeFileSync(path.join(w, ".fake", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(w, ".fake", "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = ${MARK} L:fs\n` + flt("q", "L"));
  fs.writeFileSync(path.join(w, ".fake", "info", "attributes"), "* filter=q\n");
  fs.writeFileSync(path.join(w, ".git"), `gitdir: ${w}/.fake\n`);
  await ws.workspaceCopyState(w, r);
  check(marks().filter((m) => m.startsWith("L:")).length === 0, "가짜 gitdir의 fsmonitor·필터가 돌지 않는다");
}
console.log("M 넘기기 뼈대와 저장소 모양 폴더");
{
  const r = repo("m1"); cfg(r, `[core]\n\tfsmonitor = ${MARK} M1:fs\n`); ws.folderUncommittedChanges(r);
  check(marks().filter((m) => m.startsWith("M1:")).length === 0, "일반 폴더의 fsmonitor가 돌지 않는다");
  const n = fs.realpathSync(fs.mkdtempSync(path.join(T, "m2-")));
  fs.mkdirSync(path.join(n, "objects")); fs.mkdirSync(path.join(n, "refs")); fs.writeFileSync(path.join(n, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(n, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = ${MARK} M2:fs\n`);
  ws.folderUncommittedChanges(n); ws.isGitRepo(n);
  check(marks().filter((m) => m.startsWith("M2:")).length === 0, "저장소 모양만 한 폴더의 fsmonitor가 돌지 않는다");
}
console.log("N 필터 이름 변형");
{
  for (const [i, name] of ["", "UPPER", "a.clean", "한글"].entries()) {
    const l = `N${i}`; const r = repo(`n${i}`);
    cfg(r, `[filter "${name}"]\n\tclean = ${FLT} ${l}:clean\n\tsmudge = ${FLT} ${l}:smudge\n`); attr(r, name);
    await zero(l, `필터 이름 '${name}'이 돌지 않는다`, r);
  }
}
console.log("E config.worktree");
{
  const r = repo("e"); g(["config", "core.repositoryformatversion", "1"], r); cfg(r, "[extensions]\n\tworktreeConfig = true\n");
  fs.writeFileSync(path.join(r, ".git", "config.worktree"), flt("wt", "E")); attr(r, "wt");
  await zero("E", "config.worktree의 필터가 돌지 않는다", r);
}
console.log("N1 UTF-8이 아닌 필터 이름");
{
  const r = repo("n1b"); attr(r, "x");
  fs.appendFileSync(path.join(r, ".git", "config"), Buffer.concat([Buffer.from('[filter "'), Buffer.from([0xff, 0xfe]), Buffer.from(`"]\n\tclean = ${FLT} NB:clean\n\tsmudge = ${FLT} NB:smudge\n`)]));
  fs.writeFileSync(path.join(r, ".git", "info", "attributes"), Buffer.concat([Buffer.from("* filter="), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]));
  const o = await flow("NB", r);
  check(o.marks.length === 0, "UTF-8이 아닌 이름의 필터가 돌지 않는다", o);
  check(ws.folderUncommittedChanges(r) === null || marks().length === 0, "상태 확인에서도 돌지 않는다");
}
console.log("N7 전역 필터는 유지된다");
{
  const gfile = path.join(T, "global.cfg"); fs.writeFileSync(gfile, flt("glob", "N7"));
  const r = repo("n7"); attr(r, "glob"); process.env.GIT_CONFIG_GLOBAL = gfile;
  const o = await flow("N7", r); process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  check(o.marks.length > 0 && o.marks.every((m) => m.endsWith("s=")), "사용자 전역 필터는 돌고 비밀은 없다", o.marks);
}
console.log("옛 git");
{
  // 옛 git 흉내: GIT_CONFIG_COUNT를 읽지 않는 git
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(T, "oldbin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nunset GIT_CONFIG_COUNT\nexec ${real} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    const r2 = repo("old"); cfg(r2, flt("e", "OLD")); attr(r2, "e"); fs.appendFileSync(path.join(r2, ".git", "config"), "[aether]\n\tguard = 1\n");
    const o = await flow("OLD", r2);
    check(!o.created && o.marks.length === 0, "옛 git이면 복사본을 만들지 않고 표식도 없다(저장소가 aether.guard를 적어도)", o);
    check(ws.folderUncommittedChanges(r2) === null, "옛 git이면 상태를 모른다(null)");
    marks();
  } finally { process.env.PATH = oldPath; }
}

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
