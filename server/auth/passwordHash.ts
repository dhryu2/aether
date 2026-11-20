/**
 * 비밀번호 해시 저장소. 데이터 폴더의 auth-password.json이 먼저, 없으면 .env의 AETHER_PASSWORD_HASH.
 * 캐시하지 않고 매번 읽는다 — 파일을 지우면 재시작 없이 .env 값으로 돌아간다.
 * 파일이 있는데 읽지 못하면(깨짐·권한) 없는 것으로 보지 않고 해시 없음으로 거절한다.
 * 같은 폴더의 auth-state.json은 로그인 토큰 서명 키에 섞는 세대 값(무작위)과 로그아웃한 토큰 번호 목록, 로그인한 기기 기록이다.
 * 세대 값은 비밀번호를 저장할 때마다 바뀌고, 파일이 없어지면 새로 만든다(옛 토큰은 되살아나지 않는다).
 * ⚠️ 해시를 로깅하지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { FailureTracker } from "../providers/failureTracking";

const failures = new FailureTracker();
const BCRYPT_SHAPE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const storeFile = (dir: string = config.dataDir) => path.join(dir, "auth-password.json");
const stateFile = (dir: string = config.dataDir) => path.join(dir, "auth-state.json");

/** tmp에 쓰고 rename으로 교체한다(0600). 실패하면 tmp를 지우고 throw. */
function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** undefined = 파일 없음, null = 있는데 쓸 수 없음(권한·깨짐·모양 불일치). */
function readStored(): string | undefined | null {
  const file = storeFile();
  try {
    const hash = JSON.parse(fs.readFileSync(file, "utf8"))?.hash;
    if (typeof hash === "string" && BCRYPT_SHAPE.test(hash)) {
      failures.recoveredFile(file);
      return hash;
    }
    throw new Error("auth-password.json의 hash가 bcrypt 모양이 아니다");
  } catch (error) {
    failures.file(error, { component: "auth", operation: "auth.password.read" }, file);
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : null;
  }
}

/** 저장 파일이 있으면 그 해시(읽지 못하면 undefined = 거절), 없을 때만 .env 값. */
export function currentPasswordHash(): string | undefined {
  const stored = readStored();
  if (stored === null) return undefined;
  return stored ?? (process.env.AETHER_PASSWORD_HASH || undefined);
}

/** 로그인한 기기 기록. 인증을 통과할 때 미루어 채운다(발급 시점에는 적지 않는다). */
type SessionRecord = { iat: number; exp: number; seen: number; ua?: string };
type AuthState = { epoch: string; revoked: Record<string, number>; sessions: Record<string, SessionRecord> };

function writeState(state: AuthState, dir?: string): void {
  atomicWrite(stateFile(dir), JSON.stringify(state));
}

function freshState(dir?: string): AuthState {
  const state: AuthState = { epoch: crypto.randomBytes(32).toString("hex"), revoked: {}, sessions: {} };
  writeState(state, dir);
  return state;
}

/** 없거나 깨졌으면 새 세대 값을 만들어 저장한다(모든 토큰이 무효가 되는 쪽). 그 밖의 읽기 오류(권한·폴더)는 throw. */
function readState(): AuthState {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return freshState();
  }
  try {
    const v = JSON.parse(raw);
    const revoked = v?.revoked;
    if (typeof v?.epoch === "string" && /^[0-9a-f]{64}$/.test(v.epoch) && revoked && typeof revoked === "object" && !Array.isArray(revoked)
      && Object.values(revoked).every((e) => typeof e === "number")) {
      // sessions 칸은 옛 파일에 없을 수 있다. 없거나 모양이 틀려도 세대 값을 새로 만들지 않고 빈 값으로 본다.
      const sessions = v.sessions;
      return { epoch: v.epoch, revoked, sessions: sessions && typeof sessions === "object" && !Array.isArray(sessions) ? sessions : {} };
    }
  } catch { /* 아래에서 새로 만든다 */ }
  return freshState();
}

/** 서명 키에 섞는 세대 값. */
export function tokenEpoch(): string {
  return readState().epoch;
}

export function isTokenRevoked(jti: string): boolean {
  return Object.hasOwn(readState().revoked, jti);
}

/** 토큰 하나를 폐기 목록에 적는다. exp(unix초)가 지난 항목은 이때 함께 지운다. */
export function revokeTokenId(jti: string, exp: number): void {
  const state = readState();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [id, e] of Object.entries(state.revoked)) if (e <= nowSec) delete state.revoked[id];
  state.revoked[jti] = exp;
  delete state.sessions[jti];
  writeState(state);
}

/** 세대 값을 새로 만들어 모든 토큰을 무효로 한다(기기 기록도 비워진다). */
export function revokeAllTokens(): void {
  freshState();
}

const SEEN_WRITE_GAP_SEC = 5 * 60; // 이 안의 재요청은 파일에 쓰지 않는다
const UA_MAX = 300;

/** 검증을 통과한 토큰의 기기 기록을 갱신한다. 최근에 같은 ua로 적었으면 쓰지 않는다. 만료된 항목은 이때 정리한다. */
export function noteSessionSeen(jti: string, iat: number, exp: number, ua?: string): void {
  const state = readState();
  const nowSec = Math.floor(Date.now() / 1000);
  const userAgent = ua?.slice(0, UA_MAX) || undefined;
  const prev = state.sessions[jti];
  if (prev && nowSec - prev.seen < SEEN_WRITE_GAP_SEC && prev.ua === userAgent) return;
  for (const [id, r] of Object.entries(state.sessions)) if (r.exp <= nowSec) delete state.sessions[id];
  state.sessions[jti] = { iat, exp, seen: nowSec, ...(userAgent ? { ua: userAgent } : {}) };
  writeState(state);
}

/** 지금 유효한 기기 기록(폐기·만료 제외). */
export function listSessions(): (SessionRecord & { id: string })[] {
  const state = readState();
  const nowSec = Math.floor(Date.now() / 1000);
  return Object.entries(state.sessions)
    .filter(([id, r]) => r.exp > nowSec && !Object.hasOwn(state.revoked, id))
    .map(([id, r]) => ({ id, ...r }));
}

/** 새 비밀번호 규칙: 8자 이상이고 bcrypt가 자르지 않는 72바이트 이하. 변경 API와 첫 설정이 같이 쓴다. */
export function isValidNewPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && Buffer.byteLength(v, "utf8") <= 72;
}

/**
 * dir을 생략하면 현재 데이터 폴더. 첫 설정은 사용자가 고른 폴더를 넘긴다.
 * 세대 값을 먼저 쓰고 해시를 쓴다 — 해시 쓰기가 실패해도 "비밀번호는 그대로, 모두 로그아웃"일 뿐이고
 * 반대 순서면 세대 쓰기 실패 뒤 파일 삭제로 옛 토큰이 살아날 길이 남는다.
 */
export function savePasswordHash(hash: string, dir: string = config.dataDir): void {
  freshState(dir);
  atomicWrite(storeFile(dir), JSON.stringify({ hash }));
}
