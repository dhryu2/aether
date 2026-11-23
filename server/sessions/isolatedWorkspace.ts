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
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { st } from "../i18n";
import { modelEnv } from "../providers/modelEnv";
import type { IsolatedWorkspace } from "../providers/types";
import { countLines, parseUnifiedDiff, patch, readBefore, type MutationPreview } from "./mutationPreview";
import { resolveFileUnderCwd } from "./safePath";

const failures = new FailureTracker();
const execFileP = promisify(execFile);

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

/**
 * 받은 폴더의 .git 설정(훅·fsmonitor·필터)이 허브의 git 호출에서 실행되지 않게 하는 고정 설정.
 * aether.guard는 환경변수 설정이 실제로 먹는지 확인하는 표식이다.
 */
const GUARD_PAIRS: [string, string][] = [
  ["aether.guard", "1"],
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["safe.bareRepository", "explicit"],
];

/** 허브 비밀을 뺀 환경에 보호 설정을 실어 돌려준다. git -c는 이름에 =가 든 필터를 못 비우므로 환경변수 쌍(git 2.31 이상)을 쓴다. */
function guardEnv(extra: [string, string][] = []): NodeJS.ProcessEnv {
  const env = modelEnv();
  const pairs = [...GUARD_PAIRS, ...extra];
  env.GIT_ALLOW_PROTOCOL = "none"; // 저장소 설정의 protocol.<이름>.allow보다 우선한다. 지연 가져오기와 원격 도우미를 막는다.
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

const FILTER_LIST_ARGS = ["config", "--includes", "--show-scope", "--name-only", "--null", "--list"];

/** 필터 목록 출력에서 비울 필터 설정을 뽑아 보호 환경을 만든다. 보호가 실제로 먹지 않으면(옛 git) 던진다. */
function guardedEnvFrom(stdout: Buffer): NodeJS.ProcessEnv {
  const f = new TextDecoder("utf-8", { fatal: true }).decode(stdout).split("\0").filter(Boolean);
  let guarded = false;
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < f.length; i += 2) {
    const [scope, key] = [f[i], f[i + 1]];
    if (key !== "aether.guard" && !key.startsWith("filter.")) continue; // 정규식 대신 전체 목록에서 거른다(UTF-8이 아닌 이름을 놓치지 않으려고)
    if (scope === "command" && key === "aether.guard") guarded = true;
    if (!key.startsWith("filter.")) continue;
    if (scope === "global" || scope === "system") continue; // 사용자가 직접 켠 lfs 같은 필터는 둔다
    const name = key.split(".").slice(1, -1).join(".");
    for (const k of ["clean", "smudge", "process"]) pairs.push([`filter.${name}.${k}`, ""]);
  }
  if (!guarded) throw new Error("git environment config not applied");
  return guardEnv(pairs);
}

/** cwd 기준으로 폴더의 필터 설정을 읽어, 그 필터를 비운 보호 환경을 만든다. */
function gitEnv(cwd: string): NodeJS.ProcessEnv {
  const listed = gitBytes(FILTER_LIST_ARGS, cwd, guardEnv(), { timeout: 15_000 });
  if (listed.status !== 0) throw new Error("git config failed");
  return guardedEnvFrom(listed.stdout);
}

/** 바이트 그대로 받는 git 실행. 실행 자체의 실패(없음·시간 초과·버퍼 초과)는 던진다. */
function gitBytes(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: { input?: string; maxBuffer?: number; timeout?: number } = {}) {
  const r = spawnSync("git", args, { cwd, env, input: opts.input, maxBuffer: opts.maxBuffer, timeout: opts.timeout ?? 60_000 });
  if (r.error) throw r.error;
  return r;
}

/** gitEnv의 비동기판. 읽기 경로(목록)가 이벤트 루프를 막지 않게 한다. */
async function gitEnvAsync(cwd: string): Promise<NodeJS.ProcessEnv> {
  const { stdout } = await execFileP("git", FILTER_LIST_ARGS, { cwd, timeout: 15_000, env: guardEnv(), encoding: "buffer" });
  return guardedEnvFrom(stdout);
}

// configCwd: 조건부 include는 위치에 따라 달라지므로 필터가 실제로 도는 폴더 기준으로 목록을 읽는다.
function git(args: string[], cwd: string, configCwd = cwd): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, env: gitEnv(configCwd) }).trim();
}

/** git 저장소 상태. git 프로그램이 없는 것(no_git)과 저장소가 아닌 것(not_repo)을 구분한다. */
function gitRepoState(cwd: string): "repo" | "not_repo" | "no_git" {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], env: guardEnv() });
    return "repo";
  } catch (error) {
    // Git 저장소 여부를 탐지하는 정상 경로다.
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "no_git" : "not_repo";
  }
}

export function isGitRepo(cwd: string): boolean {
  return gitRepoState(cwd) === "repo";
}

/** isGitRepo의 비동기판. 폴더 목록 응답이 이벤트 루프를 막지 않게 한다. */
export async function isGitRepoAsync(cwd: string): Promise<boolean> {
  try {
    await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 15_000, env: guardEnv() });
    return true;
  } catch {
    // Git 저장소 여부를 탐지하는 정상 경로다.
    return false;
  }
}

/** 변경 목록. null은 확인에 실패했다는 뜻이다. 호출하는 쪽이 막는 쪽으로 처리한다. */
function porcelain(cwd: string): string | null {
  try {
    const status = git(["status", "--porcelain", "--ignore-submodules=dirty"], cwd);
    failures.clear(`status:${cwd}`);
    return status;
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.workspace.inspect", severity: "warning" }, `status:${cwd}`);
    return null;
  }
}

/** porcelain의 비동기판. 실패 기록 키와 의미는 같다. */
async function porcelainAsync(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain", "--ignore-submodules=dirty"], { cwd, encoding: "utf8", timeout: 60_000, env: await gitEnvAsync(cwd) });
    failures.clear(`status:${cwd}`);
    return stdout.trim();
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

/** 작업 검토함이 쓰는 폴더의 저장소 상태. dirty는 커밋 안 된 변경의 절대 경로(새 폴더는 끝에 `/`), ignored는 files 중 무시된 파일(확인 못 하면 null). */
export type FolderReviewState = { root: string; dirty: string[]; ignored: Set<string> | null; /** 지워졌거나 이름이 바뀐 파일의 옛 절대 경로. */ deleted: string[] };

/**
 * 폴더의 커밋 안 된 변경과 files의 무시 여부를 읽는다. 저장소가 아니거나 확인에 실패하면 null이다.
 * 상태는 `-z`로 받아 한글·공백 경로의 따옴표 처리를 피하고, 이름 바뀜은 새 경로와 옛 경로를 모두 넣는다.
 * files는 절대 경로여야 하고 저장소 밖 경로는 무시 검사에서 뺀다.
 */
export async function folderReviewStateAsync(cwd: string, files: readonly string[]): Promise<FolderReviewState | null> {
  if (!(await isGitRepoAsync(cwd))) return null;
  try {
    const env = await gitEnvAsync(cwd);
    const out = (args: string[]) => execFileP("git", args, { cwd, encoding: "utf8", timeout: 60_000, env, maxBuffer: 16 * 1024 * 1024 });
    const root = (await out(["rev-parse", "--show-toplevel"])).stdout.trim();
    const status = (await out(["status", "--porcelain=v1", "-z", "--ignore-submodules=dirty"])).stdout.split("\0");
    failures.clear(`status:${cwd}`);
    const dirty: string[] = [];
    const deleted: string[] = [];
    for (let i = 0; i < status.length; i++) {
      const entry = status[i];
      if (entry.length < 4) continue;
      const here = path.join(root, entry.slice(3)); // join은 끝의 /를 보존한다
      dirty.push(here);
      if (entry[0] === "D" || entry[1] === "D") deleted.push(here);
      if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
        i += 1; // 이름 바뀜·복사는 다음 칸이 옛 경로다
        if (status[i]) {
          const old = path.join(root, status[i]);
          dirty.push(old);
          if (entry[0] === "R" || entry[1] === "R") deleted.push(old);
        }
      }
    }
    const inside = files.filter((f) => f.startsWith(root + path.sep));
    return { root, dirty, deleted, ignored: inside.length ? await ignoredAmong(cwd, env, inside) : new Set() };
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.workspace.inspect", severity: "warning" }, `status:${cwd}`);
    return null;
  }
}

export type FolderGrepResult = { hits: Map<string, { path: string; line: number; text: string }[]>; incomplete: boolean };

const GREP_MAX_BYTES = 2 * 1024 * 1024;
const GREP_PER_NAME = 5;
const GREP_MAX_NAMES = 20;
const GREP_LINE_MAX = 200;

/**
 * 폴더에서 낱말(고정 글자, 낱말 경계)이 나오는 줄을 찾는다. 추적 파일과 추적 안 된 파일을 보고 .gitignore 대상은 보지 않는다.
 * 이름마다 GREP_PER_NAME곳, 이름은 GREP_MAX_NAMES개까지만 남긴다. 시간(10초)·출력(2MB)이 넘으면 그때까지 받은 것만 쓰고 incomplete.
 * isSecret이 참인 경로는 뺀다. git 저장소가 아니거나 git 실행이 실패하면 null이다. 낱말은 인자 배열로 넘겨 셸을 거치지 않는다.
 */
export async function folderGrepAsync(cwd: string, words: readonly string[], isSecret: (rel: string) => boolean): Promise<FolderGrepResult | null> {
  const names = [...new Set(words)].slice(0, GREP_MAX_NAMES);
  if (!names.length || !(await isGitRepoAsync(cwd))) return null;
  let stdout = "";
  let incomplete = false;
  try {
    const env = await gitEnvAsync(cwd);
    const args = ["grep", "--null", "-n", "-I", "-w", "-F", "--untracked", "--no-color", ...names.flatMap((w) => ["-e", w])];
    stdout = (await execFileP("git", args, { cwd, encoding: "utf8", timeout: 10_000, env, maxBuffer: GREP_MAX_BYTES })).stdout;
  } catch (error) {
    const e = error as { code?: unknown; killed?: boolean; stdout?: string };
    if (e.code === 1 && !e.stdout) return { hits: new Map(), incomplete: false }; // 일치 없음
    if (e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && !e.killed) {
      failures.report(error, { component: "session", operation: "session.workspace.grep", severity: "warning" }, `grep:${cwd}`);
      return null;
    }
    incomplete = true;
    stdout = e.stdout ?? "";
  }
  const hits = new Map<string, { path: string; line: number; text: string }[]>();
  const re = new Map(names.map((n) => [n, new RegExp(`(^|[^\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`)]));
  for (const row of stdout.split("\n")) {
    const [rel, line, ...rest] = row.split("\0");
    if (!rel || !line || isSecret(rel)) continue;
    const text = rest.join("\0");
    for (const [n, r] of re) {
      const list = hits.get(n) ?? [];
      if (list.length >= GREP_PER_NAME || !r.test(text)) continue;
      list.push({ path: rel, line: Number(line), text: text.trim().slice(0, GREP_LINE_MAX) });
      hits.set(n, list);
    }
  }
  return { hits, incomplete };
}

/**
 * 작업 폴더 안의 파일 목록(추적 + 추적 안 된 것, .gitignore 대상 제외). cwd 기준 상대 경로, 저장소가 아니거나 실패하면 null.
 * cwd가 저장소 안쪽 폴더이면 git이 그 폴더 아래만 상대 경로로 답한다.
 */
export async function folderFileListAsync(cwd: string): Promise<string[] | null> {
  if (!(await isGitRepoAsync(cwd))) return null;
  try {
    const env = await gitEnvAsync(cwd);
    const { stdout } = await execFileP("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", timeout: 10_000, env, maxBuffer: 32 * 1024 * 1024 });
    return [...new Set(stdout.split("\0").filter(Boolean))]; // 추적 중이면서 수정·삭제된 파일이 겹쳐 나올 수 있다
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.workspace.list", severity: "warning" }, `list:${cwd}`);
    return null;
  }
}

/** git check-ignore로 무시된 파일을 가린다. 무시된 것이 없으면 git이 1로 끝나므로 그것은 빈 결과다. 그 밖의 실패는 null. */
function ignoredAmong(cwd: string, env: NodeJS.ProcessEnv, files: readonly string[]): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const child = execFile("git", ["check-ignore", "-z", "--stdin"], { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (!error || code === 1) resolve(new Set(String(stdout).split("\0").filter(Boolean)));
      else resolve(null);
    });
    child.stdin?.on("error", () => { /* 실패는 콜백이 알린다 */ });
    child.stdin?.end(files.map((f) => f + "\0").join(""));
  });
}

/**
 * 파일 하나의 커밋 안 된 변경을 미리보기로 만든다(기록에 내용이 없을 때의 대체 수단). absPath는 실제 경로로 푼 절대 경로여야 한다.
 * 저장소 밖·무시된 파일·변경 없음·git 실패는 null이다.
 * 이미 커밋된 파일은 찾지 않는다 — 마지막 커밋이 이 세션의 것인지 알 수 없어 남의 변경을 보여 줄 수 있다.
 * 보호 환경에서 돌리고 외부 diff 프로그램과 textconv를 끈다. 추적하지 않는 새 파일은 git 없이 직접 읽는다.
 */
export async function folderFileDiffAsync(cwd: string, absPath: string): Promise<MutationPreview | null> {
  if (!(await isGitRepoAsync(cwd))) return null;
  try {
    const env = await gitEnvAsync(cwd);
    const run = (args: string[], maxBuffer = 1024 * 1024) =>
      execFileP("git", ["--literal-pathspecs", ...args], { cwd, encoding: "utf8", timeout: 10_000, env, maxBuffer });
    const root = (await run(["rev-parse", "--show-toplevel"])).stdout.trim();
    const inRepo = path.relative(root, absPath);
    if (!inRepo || inRepo.startsWith("..") || path.isAbsolute(inRepo)) return null;
    // 폴더나 비밀을 품은 폴더가 통째로 나오지 않게 한다. 삭제된 파일(없음)은 통과시킨다.
    if (fs.statSync(absPath, { throwIfNoEntry: false })?.isDirectory()) return null;
    const realCwd = fs.realpathSync.native(cwd);
    const rel = path.relative(realCwd, absPath);
    const tracked = await run(["ls-files", "--error-unmatch", "--", absPath]).then(() => true, () => false);
    if (tracked) {
      let out: string;
      let truncated = false;
      try {
        out = (await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", absPath], config.diffMaxBytes)).stdout;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
        out = "";
        truncated = true;
      }
      failures.clear(`diff:${cwd}`);
      if (truncated) return { kind: "edit", path: rel, truncated: true };
      const { hunks, inexact } = parseUnifiedDiff(out);
      if (hunks.length) return { kind: "edit", path: rel, hunks, ...(inexact ? { inexact: true } : {}), ...countLines(hunks) };
      return /^Binary files /m.test(out) ? { kind: "edit", path: rel, binary: true } : null;
    }
    if ((await ignoredAmong(cwd, env, [absPath]))?.has(absPath) !== false) return null; // 무시된 파일이거나 확인 실패
    const b = readBefore(resolveFileUnderCwd(realCwd, absPath).real);
    if (b.binary) return { kind: "write", path: rel, binary: true, isCreate: true, totalBytes: b.totalBytes };
    if (b.before === null) return null;
    return { kind: "write", path: rel, isCreate: true, truncated: b.truncated, totalBytes: b.totalBytes, ...(b.truncated ? {} : patch(rel, "", b.before)) };
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.workspace.inspect", severity: "warning" }, `diff:${cwd}`);
    return null;
  }
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
export async function workspaceCopyState(cwd: string, workspaceSource: string): Promise<{ needsApply: boolean; applyBlocked: boolean }> {
  const copyReady = isolatedWorkspaceExists(cwd) && isLinkedWorktree(cwd) && !samePath(cwd, workspaceSource);
  return {
    // 상태를 모르면(null) 변경이 있다고 본다. 모르면 막는 쪽이 안전하다.
    needsApply: copyReady && ((await porcelainAsync(cwd))?.length ?? 1) > 0,
    applyBlocked: fs.existsSync(workspaceSource) && ((await porcelainAsync(workspaceSource))?.length ?? 1) > 0,
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
    let hasHead = true;
    try { git(["rev-parse", "--verify", "-q", "HEAD"], sourceCwd); } catch { hasHead = false; }
    if (hasHead) {
      git(["worktree", "add", "--no-checkout", "-b", branch, dest], sourceCwd);
      git(["reset", "--hard", "-q", "--no-recurse-submodules"], dest); // 체크아웃은 새 복사본 기준의 필터 목록으로 한다
    } else {
      git(["worktree", "add", "-b", branch, dest], sourceCwd); // 커밋이 없으면 --no-checkout과 --orphan이 충돌한다. 체크아웃할 파일도 없다.
    }
  } catch (e) {
    try { git(["worktree", "remove", "--force", dest], sourceCwd); git(["branch", "-D", branch], sourceCwd); } catch { /* 첫 명령이 실패했으면 치울 것이 없다 */ }
    throw new Error(st("notice.workspace.createFailed") + `: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  return { cwd: fs.realpathSync(dest), workspaceSource: sourceCwd };
}

const APPLY_LIST_MAX = 64 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true }); // UTF-8이 아닌 이름은 조용히 건너뛰지 않고 반영을 멈춘다

/** git이 내놓은 상대 경로를 구간으로 나눈다. 윈도우에서는 \\도 구분자로 본다(가짜 색인의 .git\\config 같은 경로를 놓치지 않으려고). */
export function splitListedPath(rel: string, win32 = process.platform === "win32"): string[] {
  return win32 ? rel.split(/[\\/]/) : rel.split("/");
}

const hasGitSegment = (p: string) => p.split(/[\\/]/).some((seg) => seg.toLowerCase() === ".git");

/** root부터 rel을 따라 내려가며 중간이 디렉터리가 아니거나(링크 포함) .git과 같은 항목이면 던진다. */
function assertPlainPath(root: string, rel: string, gitStat?: fs.Stats | undefined): void {
  const segs = splitListedPath(rel).filter(Boolean);
  let p = root;
  for (let i = 0; i < segs.length; i++) {
    p = path.join(p, segs[i]);
    const s = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!s) return;
    if (gitStat && s.dev === gitStat.dev && s.ino === gitStat.ino) throw new Error(rel); // 윈도우의 git~1 같은 별칭까지 막는다
    if (i < segs.length - 1 && !s.isDirectory()) throw new Error(rel);
  }
}

/**
 * 복사본에서 원 폴더로 옮길 [원본, 대상] 쌍을 모두 검사한 뒤 돌려준다. 하나라도 어긋나면 아무것도 쓰기 전에 던진다.
 * 후보는 복사본의 git 목록(추적+미추적, 무시 제외)이고, 무시 판정은 원 폴더 기준이다.
 * 복사본의 .gitignore·색인은 복사본 안의 모델이 바꿀 수 있어 판정에 쓰지 않는다.
 */
function collectApplyTargets(cwd: string, workspaceSource: string): [string, string][] {
  const listing = gitBytes(["ls-files", "-z", "-c", "-o", "--exclude-standard"], cwd, gitEnv(cwd), { maxBuffer: APPLY_LIST_MAX });
  if (listing.status !== 0) throw new Error("git ls-files failed");
  const listed = utf8.decode(listing.stdout).split("\0").filter(Boolean).filter((rel) => {
    const segs = splitListedPath(rel);
    if (segs.includes("..")) throw new Error(rel); // 복사본 .git이 가짜 gitdir로 바뀌었으면 색인 내용도 믿을 수 없다
    return !segs.some((seg) => seg.toLowerCase() === ".git");
  });
  const checked = gitBytes(["check-ignore", "-z", "--stdin"], workspaceSource, gitEnv(workspaceSource), { input: listed.map((r) => r + "\0").join(""), maxBuffer: APPLY_LIST_MAX });
  if (checked.status !== 0 && checked.status !== 1) throw new Error(`git check-ignore failed: ${checked.stderr.toString().trim().slice(0, 80)}`);
  const ignored = new Set(utf8.decode(checked.stdout).split("\0").filter(Boolean));
  const gitStat = fs.lstatSync(path.join(workspaceSource, ".git"), { throwIfNoEntry: false });
  const todo: [string, string][] = [];
  for (const rel of listed) {
    if (ignored.has(rel)) continue;
    assertPlainPath(cwd, rel);
    assertPlainPath(workspaceSource, rel, gitStat);
    const from = path.join(cwd, rel);
    const to = path.join(workspaceSource, rel);
    const f = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!f) continue; // 복사본에서 지운 파일
    if (f.isDirectory()) { // 서브모듈 자리: 복사본은 비운 채 만들어지므로 비어 있어야 정상이다
      if (fs.readdirSync(from).length) throw new Error(rel);
      continue;
    }
    const t = fs.lstatSync(to, { throwIfNoEntry: false });
    if (f.isSymbolicLink()) {
      const link = fs.readlinkSync(from);
      if (t?.isSymbolicLink() && fs.readlinkSync(to) === link) continue; // 그대로인 링크
      const r = path.relative(workspaceSource, path.resolve(path.dirname(to), link));
      if (r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r) || hasGitSegment(r)) throw new Error(rel);
    } else if (!f.isFile()) throw new Error(rel); // FIFO 같은 특수 파일을 읽다 멈추지 않게
    if (f.isSymbolicLink() && t) throw new Error(rel); // 값이 다른 링크로 바꾼 추적 파일: 복사 때 EEXIST로 실패해 앞선 파일만 쓰이는 것을 막는다
    if (t && (t.isSymbolicLink() || t.isDirectory())) throw new Error(rel);
    todo.push([from, to]);
  }
  return todo;
}

export function applyIsolatedWorkspace(cwd: string, workspaceSource: string): void {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(st("notice.workspace.missing"));
  if (!fs.existsSync(workspaceSource)) throw new Error(st("notice.workspace.missing"));
  const sourceStatus = porcelain(workspaceSource);
  if (sourceStatus === null) throw new Error(st("notice.workspace.gitCheckFailed"));
  if (sourceStatus.length) throw new Error(st("notice.workspace.sourceDirty"));
  try {
    for (const [from, to] of collectApplyTargets(cwd, workspaceSource)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { verbatimSymlinks: true }); // cpSync는 대상을 지우고 새로 써서 읽기 전용·실행 권한이 그대로 동작한다
    }
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
    git(force ? ["worktree", "remove", "--force", cwd] : ["worktree", "remove", cwd], source, cwd);
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
