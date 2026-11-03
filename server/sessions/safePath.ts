import { FailureTracker } from "../providers/failureTracking";
import { classifyError } from "../observability/event";
import { isManagedWorkspacePath } from "./isolatedWorkspace";
/**
 * 작업 폴더 해소(공용). SessionManager와 /api/fs/list가 공유한다.
 * 허용 범위(루트) 제한은 없다 — 서버 컴퓨터의 어느 폴더든 고를 수 있다. 대신 입력은 절대 경로(또는 `~`)만 받고,
 * 홈의 비밀 폴더(.ssh 등)는 심볼릭 링크를 푼 실제 경로 기준으로 거부한다.
 * 이 파일은 node:path만 쓰고 플랫폼 이름을 모른다(경로 모양은 node:path가 실행 환경에 맞게 해석한다).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { st } from "../i18n";

const failures = new FailureTracker();

/** 홈 안에서 목록에 보이지 않고 작업 폴더로도 고를 수 없는 최상위 폴더(비밀 키·자격 증명·앱 데이터). 소문자로 비교한다. */
const HOME_DENY = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".trash", "library", "appdata"]);

/** 폴더 고르기가 거절된 원인. HTTP 상태로 옮길 때 쓴다(400/403/404). */
export type FolderReason = "invalid" | "not_found" | "not_directory" | "denied";

const REASON_NOTICE: Record<FolderReason, string> = {
  invalid: "notice.path.invalid",
  not_found: "notice.path.notFound",
  not_directory: "notice.path.notDirectory",
  denied: "notice.path.accessDenied",
};

/** 원인을 붙인 사용자 조치 오류. real 경로는 메시지에 넣지 않는다. */
function folderError(reason: FolderReason, cause?: unknown, notice: string = REASON_NOTICE[reason]): Error & { reason: FolderReason } {
  const error = new Error(st(notice as Parameters<typeof st>[0]), cause === undefined ? undefined : { cause }) as Error & { reason: FolderReason };
  error.reason = reason;
  return classifyError(error, "user_action") as Error & { reason: FolderReason };
}

/** 오류에서 FolderReason을 꺼낸다. 폴더 고르기 오류가 아니면 null(Aether 결함). */
export function folderReasonOf(error: unknown): FolderReason | null {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return reason === "invalid" || reason === "not_found" || reason === "not_directory" || reason === "denied" ? reason : null;
}

/** 구분자(`/` 또는 `\\`) 두 개로 시작하는가 — OS와 무관하게 네트워크·장치 경로로 보고 거부한다. */
const UNC_START = /^[\\/]{2}/;

/** 파일시스템을 건드리지 않는 입력 정리. 빈 값은 기본 폴더, 절대 경로(또는 `~`)만 통과하고 `..`는 정리한다. */
export function parseFolderInput(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return config.projectRoot;
  let s = raw;
  if (s.includes("\0")) throw folderError("invalid");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(1));
  if (UNC_START.test(s)) throw folderError("invalid"); // 네트워크 경로·장치 경로(`\\서버`, `//서버`, `/\서버` 등 구분자 두 개 시작)
  if (!path.isAbsolute(s)) throw folderError("invalid", undefined, "notice.path.absoluteOnly");
  const resolved = path.resolve(s);
  if (UNC_START.test(path.parse(resolved).root)) throw folderError("invalid"); // 정리한 결과가 네트워크 경로가 되는 경우
  return resolved;
}

let homeRealCache: { home: string; real: string } | null = null;
/** 홈의 실제 경로(realpath). 홈이 없으면 글자 그대로. */
function homeReal(): string {
  const home = os.homedir();
  if (homeRealCache?.home !== home) {
    let real = home;
    try {
      real = fs.realpathSync(home);
    } catch {
      /* 홈을 못 풀면 글자 그대로 비교한다 */
    }
    homeRealCache = { home, real };
  }
  return homeRealCache.real;
}

/** 홈 아래 비밀 폴더(또는 그 하위)인가. 실제 경로(realpath 후)를 받는다. 대소문자는 무시한다. */
export function isSensitivePath(real: string): boolean {
  const rel = path.relative(homeReal(), real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return HOME_DENY.has(rel.split(path.sep)[0].toLowerCase());
}

/** 폴더의 정체(장치:inode). 경로 표기가 달라도(`/System/Volumes/Data/...`, 대소문자) 같은 폴더면 같다. */
const idOf = (st: fs.Stats) => `${st.dev}:${st.ino}`;

/** 홈 바로 아래에 실제로 있는 보호 폴더들의 정체. 홈 아래 이름이 HOME_DENY에 드는 항목만 stat한다. */
function sensitiveIdsSync(): Set<string> {
  const ids = new Set<string>();
  try {
    const home = homeReal();
    for (const name of fs.readdirSync(home)) {
      if (!HOME_DENY.has(name.toLowerCase())) continue;
      try {
        ids.add(idOf(fs.statSync(path.join(home, name))));
      } catch {
        /* 끊긴 링크·권한 없음은 건너뛴다 */
      }
    }
  } catch {
    /* 홈을 못 읽으면 글자 비교만 남는다 */
  }
  return ids;
}

/** sensitiveIdsSync의 비동기판. */
export async function sensitiveIdsAsync(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const home = homeReal();
    for (const name of await fs.promises.readdir(home)) {
      if (!HOME_DENY.has(name.toLowerCase())) continue;
      try {
        ids.add(idOf(await fs.promises.stat(path.join(home, name))));
      } catch {
        /* 끊긴 링크·권한 없음은 건너뛴다 */
      }
    }
  } catch {
    /* 홈을 못 읽으면 글자 비교만 남는다 */
  }
  return ids;
}

/** 경로 자신과 모든 조상(루트까지). */
function selfAndAncestors(real: string): string[] {
  const out: string[] = [];
  for (let cur = real; ; ) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}

/** 실제 경로나 그 조상 중 하나가 보호 폴더와 같은 폴더인가(글자 비교 + 폴더 정체 비교). */
function isSensitiveRealSync(real: string, ids: Set<string>): boolean {
  if (isSensitivePath(real)) return true;
  if (ids.size === 0) return false;
  for (const p of selfAndAncestors(real)) {
    try {
      if (ids.has(idOf(fs.statSync(p)))) return true;
    } catch {
      /* 조상을 못 읽으면 그 칸은 건너뛴다 */
    }
  }
  return false;
}

/** isSensitiveRealSync의 비동기판. 목록 API가 링크의 실제 경로를 확인할 때도 쓴다. */
export async function isSensitiveRealAsync(real: string, ids: Set<string>): Promise<boolean> {
  if (isSensitivePath(real)) return true;
  if (ids.size === 0) return false;
  for (const p of selfAndAncestors(real)) {
    try {
      if (ids.has(idOf(await fs.promises.stat(p)))) return true;
    } catch {
      /* 조상을 못 읽으면 그 칸은 건너뛴다 */
    }
  }
  return false;
}

/**
 * 목록의 폴더 항목 하나가 보호 폴더인가. 이름이 HOME_DENY에 드는 항목만 stat해 정체를 비교한다(비용 최소).
 * 홈을 다른 경로 표기로 열어 본 경우에도 `.ssh` 같은 항목이 빠지게 한다.
 */
export async function isSensitiveEntry(abs: string, name: string, ids: Set<string>): Promise<boolean> {
  if (isSensitivePath(abs)) return true;
  if (!HOME_DENY.has(name.toLowerCase()) || ids.size === 0) return false;
  try {
    return ids.has(idOf(await fs.promises.stat(abs)));
  } catch {
    return false;
  }
}

function reasonOfErrno(cause: unknown): FolderReason | null {
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return "not_found";
  if (code === "ENAMETOOLONG" || code === "EINVAL") return "invalid";
  if (code === "EACCES" || code === "EPERM") return "denied";
  return null;
}

/** 작업 폴더로 쓸 수 있는 실제 경로. 입력이 잘못됐거나 없거나 폴더가 아니거나 보호 폴더면 원인을 붙여 throw. */
export function resolveWorkFolder(raw: unknown): string {
  const target = parseFolderInput(raw);
  let real: string;
  try {
    real = fs.realpathSync.native(target); // 비동기판(libuv realpath)과 같은 결과 — 맥에서 대소문자를 디스크 표기로 맞춘다
  } catch (cause) {
    const reason = reasonOfErrno(cause);
    if (reason) throw folderError(reason, cause);
    throw classifyError(new Error(st("notice.path.notFound"), { cause }), "aether_defect");
  }
  if (isSensitiveRealSync(real, sensitiveIdsSync())) throw folderError("denied");
  if (!fs.statSync(real).isDirectory()) throw folderError("not_directory");
  return real;
}

/** resolveWorkFolder의 비동기판. 같은 순서·같은 원인. 목록 API 전용. */
export async function resolveWorkFolderAsync(raw: unknown): Promise<string> {
  const target = parseFolderInput(raw);
  let real: string;
  try {
    real = await fs.promises.realpath(target);
  } catch (cause) {
    const reason = reasonOfErrno(cause);
    if (reason) throw folderError(reason, cause);
    throw classifyError(new Error(st("notice.path.notFound"), { cause }), "aether_defect");
  }
  if (await isSensitiveRealAsync(real, await sensitiveIdsAsync())) throw folderError("denied");
  if (!(await fs.promises.stat(real)).isDirectory()) throw folderError("not_directory");
  return real;
}

/** 두 경로가 같은 곳인가. */
export function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

/**
 * Write/Edit before 읽기 전용: 세션 cwd 경계검사. 비존재(신규)=isNew 정상, 디렉터리 강제 없음.
 * resolveWorkFolder(디렉터리 강제·비존재 throw)와 달리 cwd 기준·파일 허용.
 * ⚠️ startsWith 금지(형제디렉터리 버그). path.relative 경계검사만.
 */
export function resolveFileUnderCwd(cwd: string, filePath: string): { real: string; rel: string; isNew: boolean } {
  const target = path.resolve(cwd, filePath);
  let real: string;
  let isNew = false;
  try {
    real = fs.realpathSync(target); // 심볼릭 해소
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      isNew = true;
      // 신규 파일: 부모 디렉터리를 realpath 해소(심볼릭 부모를 통한 cwd 탈출 차단). 부모도 없으면 lexical.
      try {
        real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
      } catch (error) {
        if (!isManagedWorkspacePath(path.dirname(target)) && ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM")) classifyError(error as Error, "user_action");
        failures.file(error, { component: "session", operation: "session.path.parent", severity: "warning" }, path.dirname(target));
        real = target;
      }
    } else {
      throw classifyError(new Error(st("notice.path.accessDenied"), { cause: e }), (e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM" ? "user_action" : "aether_defect");
    }
  }
  const rel = path.relative(cwd, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw classifyError(new Error(st("notice.path.outsideCwd")), "user_action");
  return { real, rel, isNew };
}
