/**
 * 작업 복사본(git worktree) — 모델 호출 0.
 *
 * 실행기와 무관하다. 원 폴더 밖에 복사본을 만들고, 반영·폐기는 원 폴더 git 상태를 본다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const source = fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-src-"));
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-data-"));
process.env.AETHER_PROJECT_ROOT = source;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-wt-"));
process.env.AETHER_WORKTREE_DIR = WORK;
const DATA = process.env.AETHER_DATA_DIR as string;

const {
  prepareIsolatedWorkspace,
  applyIsolatedWorkspace,
  discardIsolatedWorkspace,
  isolatedWorkspaceExists,
  branchNameForWork,
  workspaceCopyState,
  isLinkedWorktree,
  isGitRepo,
  WorkspaceCopyError,
} = await import("../sessions/isolatedWorkspace");
const { st } = await import("../i18n");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const named = branchNameForWork("sess-iso-1", "로그인 수정");
check(named.startsWith("aether/"), "브랜치 이름은 aether/ 로 시작한다", named);
check(named.includes("sessiso1"), "브랜치에 세션 id 조각이 들어간다", named);

git(["init"], source);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "i"], source);
fs.writeFileSync(path.join(source, "seed.txt"), "SEED");
git(["add", "seed.txt"], source);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"], source);

{
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-nogit-"));
  let threw = false;
  try {
    prepareIsolatedWorkspace(notGit, "no-git");
  } catch {
    threw = true;
  }
  check(threw, "git 저장소가 아니면 분리를 거절한다");
  fs.rmSync(notGit, { recursive: true, force: true });
}

const iso = prepareIsolatedWorkspace(source, "sess-iso-1", "로그인 수정");
check(iso.workspaceSource === source, "원 폴더 경로를 남긴다", iso);
check(iso.cwd !== source, "실제 작업 경로는 원 폴더와 다르다", { cwd: iso.cwd, source });
check(isolatedWorkspaceExists(iso.cwd), "분리된 폴더가 존재한다");
check(iso.cwd.startsWith(fs.realpathSync(WORK)), "분리 경로는 Aether worktree 아래다", iso.cwd);
check(fs.readFileSync(path.join(iso.cwd, "seed.txt"), "utf8") === "SEED", "분리된 폴더는 원 커밋을 본다");
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], iso.cwd);
check(branch.startsWith("aether/"), "복사본은 이름 있는 브랜치에 있다", branch);
check(branch.includes("sessiso1"), "브랜치에 세션 조각이 있다", branch);

fs.writeFileSync(path.join(iso.cwd, "agent.txt"), "FROM-ISO");
check(!fs.existsSync(path.join(source, "agent.txt")), "원 폴더는 분리된 쓰기를 아직 안 본다");

applyIsolatedWorkspace(iso.cwd, source);
check(fs.readFileSync(path.join(source, "agent.txt"), "utf8") === "FROM-ISO", "적용하면 원 폴더에 파일이 생긴다");
check(isolatedWorkspaceExists(iso.cwd), "적용 후에도 분리 폴더는 남는다");

fs.writeFileSync(path.join(source, "dirty.txt"), "DIRTY");
let applyDirty = false;
try {
  applyIsolatedWorkspace(iso.cwd, source);
} catch {
  applyDirty = true;
}
check(applyDirty, "원 폴더가 더러우면 적용을 거절한다");
fs.rmSync(path.join(source, "dirty.txt"));
git(["add", "agent.txt"], source);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "applied"], source);

fs.writeFileSync(path.join(iso.cwd, "uncommitted.txt"), "KEEP");
let discardDirty = false;
try {
  discardIsolatedWorkspace(iso.cwd, source);
} catch {
  discardDirty = true;
}
check(discardDirty, "커밋 안 된 변경이 있으면 폐기를 거절한다");
fs.rmSync(path.join(iso.cwd, "uncommitted.txt"));
execFileSync("git", ["clean", "-fd"], { cwd: iso.cwd, encoding: "utf8" });
execFileSync("git", ["checkout", "--", "."], { cwd: iso.cwd, encoding: "utf8" });

const branchBeforeDiscard = git(["rev-parse", "--abbrev-ref", "HEAD"], iso.cwd);
discardIsolatedWorkspace(iso.cwd, source);
check(!isolatedWorkspaceExists(iso.cwd), "폐기 후 분리 폴더가 없다");
check(fs.existsSync(path.join(source, "agent.txt")), "폐기는 원 폴더의 적용된 파일을 지우지 않는다");
let leftover = "";
try {
  leftover = git(["branch", "--list", branchBeforeDiscard], source);
} catch {
  leftover = "error";
}
check(!leftover.trim(), "폐기 후 aether/ 브랜치도 지운다", leftover);

{
  const iso2 = prepareIsolatedWorkspace(source, "sess-iso-2", "반영표시");
  const clean = workspaceCopyState(iso2.cwd, source);
  check(clean.needsApply === false && clean.applyBlocked === false, "깨끗한 복사본은 반영 필요가 없다", clean);
  fs.writeFileSync(path.join(iso2.cwd, "pending.txt"), "PENDING");
  const dirtyCopy = workspaceCopyState(iso2.cwd, source);
  check(dirtyCopy.needsApply === true, "복사본이 더러우면 반영 필요", dirtyCopy);
  fs.writeFileSync(path.join(source, "source-dirty.txt"), "SRC");
  const both = workspaceCopyState(iso2.cwd, source);
  check(both.needsApply === true && both.applyBlocked === true, "원 폴더가 더러우면 반영 거절과 복사본 dirty를 가른다", both);
  fs.rmSync(path.join(source, "source-dirty.txt"));
  check(isLinkedWorktree(iso2.cwd) === true, "복사본은 연결 작업 트리이다");
  check(isLinkedWorktree(source) === false, "원 폴더는 연결 작업 트리가 아니다");
  check(isGitRepo(source) === true, "원 폴더는 git 저장소다");
  fs.rmSync(path.join(iso2.cwd, "pending.txt"));
  execFileSync("git", ["clean", "-fd"], { cwd: iso2.cwd, encoding: "utf8" });
  discardIsolatedWorkspace(iso2.cwd, source);
}

{
  const forced = prepareIsolatedWorkspace(source, "sess-iso-force", "강제폐기");
  const forcedBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], forced.cwd);
  fs.writeFileSync(path.join(forced.cwd, "keep.txt"), "KEEP");
  git(["add", "keep.txt"], forced.cwd);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "keep"], forced.cwd);
  fs.writeFileSync(path.join(forced.cwd, "dirty.txt"), "DIRTY");
  let refused = false;
  try {
    discardIsolatedWorkspace(forced.cwd, source);
  } catch {
    refused = true;
  }
  check(refused, "확인 없는 폐기는 더러운 복사본을 거절한다");
  check(isolatedWorkspaceExists(forced.cwd), "거절하면 복사본 폴더가 남는다");
  discardIsolatedWorkspace(forced.cwd, source, { force: true });
  check(!isolatedWorkspaceExists(forced.cwd), "확인된 폐기는 더러운 복사본 폴더를 지운다");
  check(!fs.existsSync(path.join(source, "keep.txt")), "강제 폐기는 원 폴더에 복사본 변경을 넣지 않는다");
  check(!fs.existsSync(path.join(source, "dirty.txt")), "강제 폐기는 원 폴더에 미커밋 파일을 넣지 않는다");
  let forcedLeft = "";
  try {
    forcedLeft = git(["branch", "--list", forcedBranch], source);
  } catch {
    forcedLeft = "error";
  }
  check(!forcedLeft.trim(), "확인된 폐기는 병합되지 않은 aether 브랜치도 지운다", forcedLeft);
  discardIsolatedWorkspace(source, source, { force: true });
  check(fs.existsSync(path.join(source, "seed.txt")), "강제 폐기도 원 폴더는 지우지 않는다");
}

{
  const grokRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-grok-"));
  const grokDest = path.join(grokRoot, "old-sess");
  git(["worktree", "add", "-b", "aether/legacy-old1", grokDest], source);
  fs.writeFileSync(path.join(grokDest, "legacy.txt"), "OLD");
  let dirtyLegacy = false;
  try {
    discardIsolatedWorkspace(grokDest, source);
  } catch {
    dirtyLegacy = true;
  }
  check(dirtyLegacy, "옛 경로의 더러운 복사본도 폐기를 거절한다");
  check(isolatedWorkspaceExists(grokDest), "거절하면 옛 경로 복사본이 남는다");
  fs.rmSync(path.join(grokDest, "legacy.txt"));
  execFileSync("git", ["clean", "-fd"], { cwd: grokDest, encoding: "utf8" });
  discardIsolatedWorkspace(grokDest, source);
  check(!isolatedWorkspaceExists(grokDest), "깨끗한 옛 경로 복사본은 폐기된다");
  fs.rmSync(grokRoot, { recursive: true, force: true });
}

{
  const { sessionManager } = await import("../sessions/SessionManager");
  await (await import("./support/tempDb")).useTempDiary("isolated_workspace"); // 임시 SQLite 일기
  const store = await import("../sessions/persistence");
  const dirtyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const cleanId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const dirtyIso = prepareIsolatedWorkspace(source, dirtyId, "삭제거절");
  const cleanIso = prepareIsolatedWorkspace(source, cleanId, "삭제정리");
  const cleanBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], cleanIso.cwd);
  fs.writeFileSync(path.join(dirtyIso.cwd, "keep.txt"), "KEEP");
  const writeDisk = (id: string, cwd: string) => {
    const dir = path.join(DATA, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
      id,
      cwd,
      workspaceSource: source,
      model: "haiku",
      resumeKey: `sid-${id}`,
      createdAt: 1,
    }));
    store.appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" } as never);
  };
  writeDisk(dirtyId, dirtyIso.cwd);
  writeDisk(cleanId, cleanIso.cwd);
  sessionManager.restoreFromDisk();
  const dirtyBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], dirtyIso.cwd);
  fs.writeFileSync(path.join(source, "blocked.txt"), "BLOCK");
  const dirtyRow = sessionManager.list().find((s) => s.id === dirtyId);
  check(dirtyRow?.needsApply === true, "목록에 복사본 반영 필요가 실린다", dirtyRow);
  check(dirtyRow?.applyBlocked === true, "원 폴더가 더러우면 반영이 막힌다", dirtyRow);
  let applyBlocked = false;
  try {
    sessionManager.applyWorkspace(dirtyId);
  } catch {
    applyBlocked = true;
  }
  check(applyBlocked, "원 폴더가 더러우면 반영은 여전히 거절한다");
  check(sessionManager.delete(dirtyId) === true, "더러운 복사본 작업 삭제는 복사본을 버리고 지운다");
  check(!isolatedWorkspaceExists(dirtyIso.cwd), "삭제 후 더러운 복사본 폴더가 없다");
  check(!sessionManager.list().some((s) => s.id === dirtyId), "삭제 후 더럽던 작업이 목록에 없다");
  check(fs.readFileSync(path.join(source, "blocked.txt"), "utf8") === "BLOCK", "삭제는 원 폴더의 다른 변경을 지우지 않는다");
  let leftoverDirty = "";
  try {
    leftoverDirty = git(["branch", "--list", dirtyBranch], source);
  } catch {
    leftoverDirty = "error";
  }
  check(!leftoverDirty.trim(), "삭제 후 더럽던 복사본의 aether 브랜치가 없다", leftoverDirty);
  fs.rmSync(path.join(source, "blocked.txt"));
  check(sessionManager.delete(cleanId) === true, "깨끗한 복사본 작업은 지워진다");
  check(!isolatedWorkspaceExists(cleanIso.cwd), "삭제 후 깨끗한 복사본이 없다");
  check(!sessionManager.list().some((s) => s.id === cleanId), "삭제 후 작업이 목록에 없다");
  let leftoverClean = "";
  try {
    leftoverClean = git(["branch", "--list", cleanBranch], source);
  } catch {
    leftoverClean = "error";
  }
  check(!leftoverClean.trim(), "삭제 후 aether/ 브랜치가 없다", leftoverClean);
}

// git 프로그램이 없는 컴퓨터 — PATH를 빈 폴더로 바꿔 흉내 낸다. 끝나면 반드시 되돌린다.
{
  const kept = prepareIsolatedWorkspace(source, "sess-iso-nogit", "git없음");
  fs.writeFileSync(path.join(kept.cwd, "kept.txt"), "KEPT");
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-nobin-"));
  const originalPath = process.env.PATH;
  const sourceBefore = fs.readdirSync(source).sort();
  try {
    process.env.PATH = emptyBin;
    check(isGitRepo(source) === false, "git이 없으면 isGitRepo는 false다");
    let createErr: unknown;
    try { prepareIsolatedWorkspace(source, "sess-iso-nogit-2"); } catch (e) { createErr = e; }
    check(createErr instanceof WorkspaceCopyError && (createErr as Error).message === st("notice.workspace.gitMissing"), "git이 없으면 복사본 생성은 gitMissing 문구의 WorkspaceCopyError다", String(createErr));
    let applyErr: unknown;
    try { applyIsolatedWorkspace(kept.cwd, source); } catch (e) { applyErr = e; }
    check(applyErr instanceof Error && applyErr.message === st("notice.workspace.gitCheckFailed"), "상태를 못 읽으면 반영은 gitCheckFailed로 거부된다", String(applyErr));
    check(!fs.existsSync(path.join(source, "kept.txt")) && fs.readdirSync(source).sort().join() === sourceBefore.join(), "거부된 반영은 원 폴더 파일을 바꾸지 않는다");
    let discardErr: unknown;
    try { discardIsolatedWorkspace(kept.cwd, source); } catch (e) { discardErr = e; }
    check(discardErr instanceof Error && discardErr.message === st("notice.workspace.gitCheckFailed"), "상태를 못 읽으면 강제가 아닌 버리기는 거부된다", String(discardErr));
    check(fs.existsSync(path.join(kept.cwd, "kept.txt")), "거부된 버리기 뒤에도 복사본이 남는다");
    check(workspaceCopyState(kept.cwd, source).applyBlocked === true, "상태를 못 읽으면 applyBlocked는 true다");
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
  // PATH를 되돌린 뒤 정리, 그리고 git 저장소가 아닌 폴더는 notGit 문구
  discardIsolatedWorkspace(kept.cwd, source, { force: true });
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "aether-iso-plain-"));
  let plainErr: unknown;
  try { prepareIsolatedWorkspace(plain, "sess-iso-plain"); } catch (e) { plainErr = e; }
  check(plainErr instanceof WorkspaceCopyError && (plainErr as Error).message === st("notice.workspace.notGit"), "git 저장소가 아닌 폴더는 notGit 문구의 WorkspaceCopyError다", String(plainErr));
  fs.rmSync(plain, { recursive: true, force: true });
}

fs.rmSync(source, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
if (DATA) fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} isolated_workspace: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
