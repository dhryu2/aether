/**
 * 비밀번호 해시 저장소. 데이터 폴더의 auth-password.json이 먼저, 없으면 .env의 AETHER_PASSWORD_HASH.
 * 캐시하지 않고 매번 읽는다 — 파일을 지우면 재시작 없이 .env 값으로 돌아간다.
 * ⚠️ 해시를 로깅하지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { FailureTracker } from "../providers/failureTracking";

const failures = new FailureTracker();
const BCRYPT_SHAPE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const storeFile = () => path.join(config.dataDir, "auth-password.json");

function readStored(): string | undefined {
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
    return undefined;
  }
}

/** 저장 파일이 쓸 수 있는 상태면 true. 깨진 파일은 없는 것으로 본다. */
export function hasStoredPasswordHash(): boolean {
  return readStored() !== undefined;
}

export function currentPasswordHash(): string | undefined {
  return readStored() ?? (process.env.AETHER_PASSWORD_HASH || undefined);
}

/** 새 비밀번호 규칙: 8자 이상이고 bcrypt가 자르지 않는 72바이트 이하. 변경 API와 첫 설정이 같이 쓴다. */
export function isValidNewPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && Buffer.byteLength(v, "utf8") <= 72;
}

/** dir을 생략하면 현재 데이터 폴더. 첫 설정은 사용자가 고른 폴더를 넘긴다. */
export function savePasswordHash(hash: string, dir: string = config.dataDir): void {
  const file = path.join(dir, "auth-password.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ hash }), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
