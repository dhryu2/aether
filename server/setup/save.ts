/**
 * 첫 설정 저장. 입력을 모두 검사한 뒤 .env → 비밀번호 해시 → config.json 순으로 쓴다.
 * config.json이 첫 실행 판정 기준이므로 맨 마지막에 쓴다 — 도중에 실패하면 다음 실행이 다시 첫 실행이다.
 * ⚠️ 비밀번호·해시·JWT 시크릿을 로깅하거나 응답에 싣지 않는다.
 */
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isBrowserBlockedPort } from "../../shared/browserPorts";
import { TERMS_VERSION } from "../../shared/terms";
import { config } from "../config";
import { isValidNewPassword, savePasswordHash } from "../auth/passwordHash";
import { resolveWorkFolderAsync } from "../sessions/safePath";
import { bundleProgramDir, isInsideDir, type AppPaths } from "./paths";

/** 화면이 문구로 바꿀 수 있는 기계용 오류 코드. field는 문제가 된 입력칸. */
export type SetupErrorCode =
  | "invalid_body" | "terms_required" | "password_invalid" | "port_invalid" | "port_in_use"
  | "data_dir_invalid" | "data_dir_unwritable" | "project_root_invalid" | "project_root_missing" | "save_failed";

export interface SetupInput { terms: unknown; password: unknown; port: unknown; dataDir: unknown; projectRoot: unknown }
export interface SavedSetup { port: number; dataDir: string; projectRoot: string }
/** detail은 start.log용 오류 코드(EACCES 등)뿐이다. 입력값·비밀은 싣지 않는다. */
export type SaveResult = { ok: true; saved: SavedSetup } | { ok: false; status: number; error: SetupErrorCode; field?: string; detail?: string };

export interface SaveDeps {
  savePasswordHash: (hash: string, dir: string) => void;
  portFree: (port: number) => Promise<boolean>;
  /** 시험용: 프로그램 폴더를 직접 지정한다(null이면 검사 없음). 비우면 묶음 파일 위치에서 알아낸다. */
  programDir?: string | null;
}

export const defaultSaveDeps: SaveDeps = {
  savePasswordHash,
  portFree: (port) => new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  }),
};

function writeAtomic(file: string, data: string, mode: number): void {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd); // 이름을 바꾸기 전에 내용을 디스크에 내린다
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

const fail = (status: number, error: SetupErrorCode, field?: string): SaveResult => ({ ok: false, status, error, field });

/** @param listeningPort 지금 설정 서버가 듣는 포트. 저장 포트가 이와 같으면 "비어 있음" 검사를 건너뛴다(곧 이 서버가 끝난다). */
export async function saveSetup(
  body: unknown, p: AppPaths, listeningPort: number, deps: SaveDeps = defaultSaveDeps,
): Promise<SaveResult> {
  if (!body || typeof body !== "object") return fail(400, "invalid_body");
  const i = body as SetupInput;
  if (i.terms !== true) return fail(400, "terms_required", "terms");
  if (!isValidNewPassword(i.password)) return fail(400, "password_invalid", "password");
  const port = i.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535 || isBrowserBlockedPort(port)) return fail(400, "port_invalid", "port");
  if (port !== listeningPort && !(await deps.portFree(port))) return fail(409, "port_in_use", "port");
  if (typeof i.dataDir !== "string" || !path.isAbsolute(i.dataDir)) return fail(400, "data_dir_invalid", "dataDir");
  if (typeof i.projectRoot !== "string" || !path.isAbsolute(i.projectRoot)) return fail(400, "project_root_invalid", "projectRoot");
  const dataDir = path.resolve(i.dataDir);
  // 재설치는 프로그램 폴더 안을 지운다. 데이터(DB)나 작업 폴더가 그 안에 있으면 사라지므로 거절한다.
  const programDir = deps.programDir === undefined ? bundleProgramDir() : deps.programDir;
  if (programDir && isInsideDir(dataDir, programDir)) return fail(400, "data_dir_invalid", "dataDir");
  // 작업 폴더를 먼저 본다 — 거절된 요청은 아무것도 만들지 않는다.
  // config.ts는 projectRoot를 path.delimiter로 쪼개 앞부분을 trim해 쓴다. 그 해석이 입력과 다르면 평소 서버가 다른 경로로 부팅하므로 막는다.
  if (i.projectRoot.split(path.delimiter)[0].trim() !== i.projectRoot) return fail(400, "project_root_invalid", "projectRoot");
  let projectRoot: string;
  try {
    projectRoot = await resolveWorkFolderAsync(i.projectRoot); // 보호 폴더(.ssh 등)와 파일은 여기서 거절된다
  } catch {
    return fail(400, "project_root_missing", "projectRoot");
  }
  if (programDir && isInsideDir(projectRoot, programDir)) return fail(400, "project_root_invalid", "projectRoot");
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const probe = path.join(dataDir, `.write-test-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
  } catch {
    return fail(400, "data_dir_unwritable", "dataDir");
  }

  try {
    const hash = await bcrypt.hash(i.password, config.bcryptCost);
    fs.mkdirSync(p.configDir, { recursive: true });
    // 기존 .env의 다른 줄은 두고 시크릿 줄만 바꾼다.
    let kept = "";
    try {
      kept = fs.readFileSync(p.envFile, "utf8").split(/\r?\n/).filter((l) => l.trim() && !/^\s*AETHER_JWT_SECRET\s*=/.test(l)).map((l) => `${l}\n`).join("");
    } catch {}
    writeAtomic(p.envFile, `${kept}AETHER_JWT_SECRET=${crypto.randomBytes(48).toString("base64url")}\n`, 0o600);
    deps.savePasswordHash(hash, dataDir);
    writeAtomic(p.configFile, JSON.stringify({
      authMode: "password", host: "127.0.0.1", port, dataDir, projectRoot,
      worktreeDir: path.join(dataDir, "worktrees"), webAutoBuild: false,
      termsAccepted: { version: TERMS_VERSION, at: new Date().toISOString() }, // 동의 시각은 서버가 정한다
    }, null, 2), 0o600);
  } catch (error) {
    return { ...fail(500, "save_failed"), detail: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN" } as SaveResult;
  }
  return { ok: true, saved: { port, dataDir, projectRoot } };
}
