import { FailureTracker } from "../providers/failureTracking";
import { classifyError } from "../observability/event";
/**
 * 작업 복사본 — git worktree.
 *
 * 실행기(Claude·Codex·Grok) 프로토콜이 아니다. 원 폴더를 건드리지 않는 디스크 복사본을 만들고
 * 그 경로를 세션 cwd로 올린다. 코어가 소유한다.
 *
 * 경로는 원 저장소 밖이어야 한다. 저장소 안에 만들면 git이 거절한다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { st } from "../i18n";
import type { IsolatedWorkspace } from "../providers/types";

const failures = new FailureTracker();

/** 작업 복사본을 만들거나 다룰 수 없는 사정. 문구는 경로나 git 출력 없이 사용자에게 그대로 보여도 된다. */
export class WorkspaceCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCopyError";
  }
}

function worktreeRoot(): string {
  return config.worktreeDir;
}

/** Aether가 만들고 관리하는 작업 복사본 경계. 원 프로젝트는 이 경계 밖에 있다. */
export function isManagedWorkspacePath(file: string): boolean {
  const configured = worktreeRoot();
  let root = configured;
  try { root = fs.realpathSync(root); } catch {
    // 선택적 작업 복사본 루트가 없거나 해소되지 않으면 설정된 경계로 판정한다.
  }
  return [configured, root].some(base => {
    const rel = path.relative(base, file);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

function isolatedPath(sessionId: string): string {
  return path.join(worktreeRoot(), sessionId);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 }).trim();
}

/** git 저장소 상태. git 프로그램이 없는 것(no_git)과 저장소가 아닌 것(not_repo)을 구분한다. */
function gitRepoState(cwd: string): "repo" | "not_repo" | "no_git" {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    return "repo";
  } catch (error) {
    // Git 저장소 여부를 탐지하는 정상 경로다.
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "no_git" : "not_repo";
  }
}

export function isGitRepo(cwd: string): boolean {
  return gitRepoState(cwd) === "repo";
}

/** 변경 목록. null은 확인에 실패했다는 뜻이다. 호출하는 쪽이 막는 쪽으로 처리한다. */
function porcelain(cwd: string): string | null {
  try {
    const status = git(["status", "--porcelain"], cwd);
    failures.clear(`status:${cwd}`);
    return status;
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.workspace.inspect", severity: "warning" }, `status:${cwd}`);
    return null;
  }
}

/** 폴더의 커밋 안 된 변경 줄들. git 저장소가 아니거나 확인에 실패하면 null이다(넘기기 인계서가 쓴다). */
export function folderUncommittedChanges(cwd: string): string[] | null {
  if (!isGitRepo(cwd)) return null;
  const status = porcelain(cwd);
  return status === null ? null : status.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** 연결 작업 복사본인가. 원 저장소(.git 디렉터리)는 해당하지 않는다. */
export function isLinkedWorktree(cwd: string): boolean {
  try {
    const marker = path.join(cwd, ".git");
    return fs.existsSync(marker) && fs.statSync(marker).isFile();
  } catch (error) {
    if (!isManagedWorkspacePath(cwd) && ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM")) classifyError(error as Error, "user_action");
    failures.file(error, { component: "session", operation: "session.workspace.stat", severity: "warning" }, path.join(cwd, ".git"));
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  let target = a;
  try {
    const real = fs.realpathSync(a);
    target = b;
    return real === fs.realpathSync(b);
  } catch (error) {
    if (!isManagedWorkspacePath(target) && ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM")) classifyError(error as Error, "user_action");
    failures.file(error, { component: "session", operation: "session.workspace.stat", severity: "warning" }, target);
    return false;
  }
}

/** 복사본·원 폴더에 아직 반영하지 않은 변경이 있는지. git 명령 이름은 밖으로 나가지 않는다. */
export function workspaceCopyState(cwd: string, workspaceSource: string): { needsApply: boolean; applyBlocked: boolean } {
  const copyReady = isolatedWorkspaceExists(cwd) && isLinkedWorktree(cwd) && !samePath(cwd, workspaceSource);
  return {
    // 상태를 모르면(null) 변경이 있다고 본다. 모르면 막는 쪽이 안전하다.
    needsApply: copyReady && (porcelain(cwd)?.length ?? 1) > 0,
    applyBlocked: fs.existsSync(workspaceSource) && (porcelain(workspaceSource)?.length ?? 1) > 0,
  };
}

/** 작업 이름에서 git 브랜치 이름을 만든다. 세션 id 조각으로 겹치지 않게 한다. */
export function branchNameForWork(sessionId: string, name?: string): string {
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "work";
  const slug = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `aether/${slug || "work"}-${short}`;
}

export function prepareIsolatedWorkspace(sourceCwd: string, sessionId: string, name?: string): IsolatedWorkspace {
  const repo = gitRepoState(sourceCwd);
  if (repo === "no_git") throw new WorkspaceCopyError(st("notice.workspace.gitMissing"));
  if (repo === "not_repo") throw new WorkspaceCopyError(st("notice.workspace.notGit"));
  const dest = isolatedPath(sessionId);
  if (fs.existsSync(dest)) throw new Error(st("notice.workspace.createFailed"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const branch = branchNameForWork(sessionId, name);
  try {
    git(["worktree", "add", "-b", branch, dest], sourceCwd);
  } catch (e) {
    throw new Error(st("notice.workspace.createFailed") + `: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  return { cwd: fs.realpathSync(dest), workspaceSource: sourceCwd };
}

export function applyIsolatedWorkspace(cwd: string, workspaceSource: string): void {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(st("notice.workspace.missing"));
  if (!fs.existsSync(workspaceSource)) throw new Error(st("notice.workspace.missing"));
  const sourceStatus = porcelain(workspaceSource);
  if (sourceStatus === null) throw new Error(st("notice.workspace.gitCheckFailed"));
  if (sourceStatus.length) throw new Error(st("notice.workspace.sourceDirty"));
  try {
    fs.cpSync(cwd, workspaceSource, {
      recursive: true,
      filter: (src) => path.basename(src) !== ".git",
    });
  } catch (e) {
    throw new Error(st("notice.workspace.applyFailed") + `: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

/**
 * 복사본 폴더를 치운다. force가 아니면 반영하지 않은 변경이 있을 때 거절한다.
 * force는 세션 삭제와, 사용자가 확인한 버리기만 쓴다. 원 폴더 자체는 어느 경우에도 지우지 않는다.
 */
export function discardIsolatedWorkspace(cwd: string, workspaceSource: string, opts?: { force?: boolean }): void {
  const force = opts?.force === true;
  if (!fs.existsSync(cwd)) return;
  if (!isLinkedWorktree(cwd) || samePath(cwd, workspaceSource)) return;
  if (!force) {
    const copyStatus = porcelain(cwd);
    if (copyStatus === null) throw new Error(st("notice.workspace.gitCheckFailed"));
    if (copyStatus.length) throw new Error(st("notice.workspace.discardDirty"));
  }
  let branch = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    failures.clear(`branch:${cwd}`);
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.workspace.inspect", severity: "warning" }, `branch:${cwd}`);
    branch = "";
  }
  const source = fs.existsSync(workspaceSource) ? workspaceSource : cwd;
  try {
    git(force ? ["worktree", "remove", "--force", cwd] : ["worktree", "remove", cwd], source);
  } catch (e) {
    throw new Error(st("notice.workspace.discardFailed") + `: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  if (branch && branch !== "HEAD" && branch.startsWith("aether/")) {
    try {
      // 확인 없는 폐기는 아직 합쳐지지 않은 브랜치를 남긴다. 확인된 폐기는 그 브랜치도 지운다.
      git(["branch", force ? "-D" : "-d", branch], source);
    } catch {
      /* 다른 작업 트리가 쓰는 브랜치는 남긴다 */
    }
  }
}

export function isolatedWorkspaceExists(cwd: string): boolean {
  try {
    return fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
  } catch (error) {
    if (!isManagedWorkspacePath(cwd) && ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM")) classifyError(error as Error, "user_action");
    failures.file(error, { component: "session", operation: "session.workspace.stat", severity: "warning" }, cwd);
    return false;
  }
}
