/**
 * DB 복원 예약과 적용. 복원은 "다음 서버 시작 때 교체"다.
 * 화면은 표식 파일만 쓰고, 서버가 시작할 때(index.ts, 서버 잠금 직후) applyPendingRestore가 DB 파일을 바꾼다.
 * 표식과 결과는 DB 옆 파일이다. 복원 중에는 DB 안에 쓸 수 없기 때문이다.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RestoreFailCode, RestoreResult, RestoreStatus } from "../../shared/http";
import { reportError } from "../observability/report";
import { createBackup, listBackups } from "./backups";
import { closeDatabases, database } from "./sqlite";

export class RestoreNotFoundError extends Error {
  constructor() {
    super("백업을 찾을 수 없다");
  }
}

class RestoreFail extends Error {
  constructor(readonly code: RestoreFailCode, detail: string, readonly safetyId?: string) {
    super(detail);
  }
}

const pendingFile = (dbPath: string) => `${dbPath}.restore-pending.json`;
const resultFile = (dbPath: string) => `${dbPath}.restore-result.json`;

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function restoreStatus(dbPath: string): RestoreStatus {
  return { pending: readJson(pendingFile(dbPath)), last: readJson(resultFile(dbPath)) };
}

/** id는 목록에서 찾는 열쇠로만 쓴다. 목록에 없으면 던진다. */
export function scheduleRestore(dbPath: string, backupDir: string, id: string): void {
  if (!listBackups(backupDir).some((b) => b.id === id)) throw new RestoreNotFoundError();
  fs.rmSync(resultFile(dbPath), { force: true });
  writeJson(pendingFile(dbPath), { id, requestedAt: new Date().toISOString() });
}

export function cancelRestore(dbPath: string): void {
  fs.rmSync(pendingFile(dbPath), { force: true });
}

function removeRestoring(tmp: string): void {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
}

/** 복사본이 열리고 무결성이 맞고 Aether의 표가 있는지 본다. */
function verifyCopy(tmp: string): void {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error("integrity_check 실패");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_event'").get()) throw new Error("Aether DB가 아니다");
  } catch (err) {
    throw new RestoreFail("corrupt", err instanceof Error ? err.message : String(err));
  } finally {
    try {
      db?.close();
    } catch {
      /* 열지 못한 연결은 닫을 것이 없다. */
    }
  }
}

/** 표식이 있으면 DB를 백업으로 바꾼다. 어떤 경우에도 던지지 않고 결과 파일에 남긴다. */
export async function applyPendingRestore(opts: { dbPath: string; backupDir: string }): Promise<void> {
  const { dbPath, backupDir } = opts;
  const tmp = `${dbPath}.restoring`;
  try {
    removeRestoring(tmp); // 지난 실행이 중간에 죽으며 남긴 흔적
    const pending = readJson<{ id: string }>(pendingFile(dbPath));
    if (!pending) return;
    let result: RestoreResult;
    let safetyId: string | undefined; // 복원 전 백업을 만든 뒤 실패해도 화면이 파일을 알 수 있게 둔다(지우지 않는다)
    try {
      if (!listBackups(backupDir).some((b) => b.id === pending.id)) throw new RestoreFail("missing", pending.id);
      try {
        fs.copyFileSync(path.join(backupDir, pending.id), tmp);
      } catch (err) {
        throw new RestoreFail("io", err instanceof Error ? err.message : String(err));
      }
      verifyCopy(tmp);
      const db = database();
      try {
        safetyId = (await createBackup(db, { dir: backupDir, kind: "beforeRestore" })).id;
      } catch (err) {
        throw new RestoreFail("io", err instanceof Error ? err.message : String(err));
      }
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* 다른 연결이 잡고 있으면 실패한다. 아래 -wal 검사가 막는다. */
      }
      closeDatabases();
      if (fs.existsSync(`${dbPath}-wal`)) throw new RestoreFail("inUse", `${dbPath}-wal`, safetyId);
      try {
        fs.rmSync(`${dbPath}-shm`, { force: true });
        fs.renameSync(tmp, dbPath);
        // 검사용으로 열 때 SQLite가 만든 보조 파일이 남지 않게 한다.
        fs.rmSync(`${tmp}-wal`, { force: true });
        fs.rmSync(`${tmp}-shm`, { force: true });
      } catch (err) {
        throw new RestoreFail("io", err instanceof Error ? err.message : String(err));
      }
      result = { ok: true, id: pending.id, at: new Date().toISOString(), safetyId };
    } catch (err) {
      const fail = err instanceof RestoreFail ? err : new RestoreFail("io", err instanceof Error ? err.message : String(err));
      removeRestoring(tmp);
      result = { ok: false, id: pending.id, at: new Date().toISOString(), code: fail.code, detail: fail.message, ...(safetyId ? { safetyId } : {}) };
      console.error(`[aether] DB 복원 실패(${fail.code}):`, fail.message);
      await reportError(fail, { component: "database", operation: "database.restore" }).catch(() => {});
    }
    fs.rmSync(pendingFile(dbPath), { force: true }); // 결과를 못 써도 부팅마다 반복하지 않는다
    writeJson(resultFile(dbPath), result);
  } catch (err) {
    console.error("[aether] DB 복원 처리 중 오류:", err);
  }
}
