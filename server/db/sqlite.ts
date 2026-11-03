/**
 * Aether의 SQLite 파일 하나. 세션 일기, 글자 색인, 검색 감사, 공통 오류가 같은 파일에 산다.
 * 경로는 configureDatabase가 정하거나 AETHER_DB_PATH를 읽는다. 둘 다 없으면 열지 않는다.
 * 같은 경로는 프로세스 안에서 연결 하나를 같이 쓴다. 쓰기는 동기 트랜잭션 안에서 끝난다.
 * 다른 프로세스(CLI, 백업)가 같은 파일을 열 수 있으므로 WAL과 잠금 대기를 켠다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, "schema.sql");
const BUSY_MS = 5000;

let configuredPath: string | null | undefined;
const opened = new Map<string, DatabaseSync>();

export function configureDatabase(opts: { path?: string | null }): void {
  if (opts.path !== undefined) configuredPath = opts.path === null ? null : path.resolve(opts.path);
}

/** 정해진 파일 경로. 없으면 null이다. */
export function databasePath(): string | null {
  if (configuredPath !== undefined) return configuredPath;
  const fromEnv = process.env.AETHER_DB_PATH;
  return fromEnv ? path.resolve(fromEnv) : null;
}

/** 정해진 파일을 열고 스키마를 적용한다. 같은 경로는 한 번만 연다. */
export function database(): DatabaseSync {
  const file = databasePath();
  if (!file) throw new Error("AETHER_DB_PATH 없음");
  return openDatabaseAt(file);
}

/** 경로를 직접 받아 연다. 시험과 오류 수집기가 따로 정한 파일을 쓸 때만 부른다. */
export function openDatabaseAt(target: string): DatabaseSync {
  const file = path.resolve(target);
  const found = opened.get(file);
  if (found) return found;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: BUSY_MS, enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    // 커밋이 돌아오면 디스크에 남아 있어야 한다. Postgres의 커밋 보장과 맞춘다.
    db.exec("PRAGMA synchronous = FULL");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  } catch (err) {
    db.close();
    throw err;
  }
  opened.set(file, db);
  return db;
}

/** 쓰기 잠금을 먼저 잡는 트랜잭션. fn 안에서 await하지 않는다. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) throw new Error("트랜잭션 안에서 다시 트랜잭션을 열지 않는다");
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

/** 열린 연결을 닫는다. 시험과 종료 경로가 쓴다. */
export function closeDatabases(): void {
  for (const db of opened.values()) {
    try {
      db.close();
    } catch {
      /* 이미 닫힌 연결은 무시한다. */
    }
  }
  opened.clear();
}

export function __resetDatabaseForTest(): void {
  closeDatabases();
  configuredPath = undefined;
}

/** 검색용 소문자 사본. Postgres lower()처럼 유니코드 대소문자를 접는다. */
export function foldCase(text: string): string {
  return text.toLowerCase();
}
