import { FailureTracker } from "../providers/failureTracking";
import { reportError } from "../observability/report";
/**
 * 세션 일기의 운영 정본. 화면 복원과 새 저장은 이 표만 쓴다.
 * 파일 경로는 sqlite.ts가 정한다. 여기에서는 일기 파일을 지우지 않는다.
 * 데이터베이스가 실패하면 파일로 되돌리지 않는다.
 */
import fs from "node:fs";
import type { AetherEvent } from "../types";
import { configureCanonical, sessionDiaryMode } from "./canonical";
import { configureDatabase, database, transaction } from "./sqlite";
import {
  insertSessionRows,
  readSessionCursor,
  readSessionRows,
  iterateSessionRows,
  type SessionEventCursor,
  type StoredSessionEvent,
} from "./sessionEvents";

const failures = new FailureTracker();

/** nextOffset은 이 세션 기록기가 다음 행에 붙일 byte_offset이다. 기존 행의 끝 다음부터 정수 하나로 잇는다. highSeq는 저장에 실패해 빈 번호로 남긴 순번이다. */
type Cursor = { nextOffset: number; highSeq: number };

/** 기록기 한 세대. 닫힘은 세션 ID가 아니라 이 표지에 붙는다. */
export type DiaryGeneration = {
  readonly token: number;
  closed: boolean;
};

let globalHold = 0;
let nextToken = 1;
const held = new Set<string>();
const sealed = new Set<string>();
const current = new Map<string, DiaryGeneration>();
const cursor = new Map<string, Cursor>();
export function __resetSessionDiaryForTest(): void {
  globalHold = 0;
  nextToken = 1;
  for (const id of cursor.keys()) failures.clear(`append:${id}`);
  held.clear();
  sealed.clear();
  current.clear();
  cursor.clear();
  configureCanonical({ diary: "blocked" });
}

export function diaryAcceptsInput(sessionId?: string): boolean {
  if (sessionDiaryMode() === "blocked") return false;
  if (globalHold > 0) return false;
  if (sessionId && held.has(sessionId)) return false;
  return true;
}

export function holdDiaryInput(sessionId?: string): void {
  if (sessionId) held.add(sessionId);
  else globalHold += 1;
}

export function releaseDiaryInput(sessionId?: string): void {
  if (sessionId) held.delete(sessionId);
  else globalHold = Math.max(0, globalHold - 1);
}

export async function openSessionDiary(opts?: { path?: string | null }): Promise<void> {
  if (opts) configureDatabase(opts);
  try {
    database();
    configureCanonical({ diary: "sqlite" });
  } catch (err) {
    configureCanonical({ diary: "blocked" });
    throw err;
  }
}

/** 부팅 때 세션마다 이어 쓸 자리를 잡고 옛 일기 파일이 남았는지 본다. 사건 행은 메모리에 올리지 않는다. 옛 일기 파일은 읽지도 지우지도 않는다. */
export async function loadSessionDiaries(sources: { id: string; jsonlPath: string }[]): Promise<void> {
  if (sessionDiaryMode() !== "sqlite") throw new Error("일기 데이터베이스가 열려 있지 않다");
  holdDiaryInput();
  try {
    for (const source of sources) {
      try {
        await loadSessionDiary(source.id, source.jsonlPath);
      } catch (err) {
        held.add(source.id);
        void reportError(err, { component: "database", operation: "session.diary.load", session_id: source.id }); console.error(
          `[aether] 세션 일기를 읽지 못했다. 파일로 되돌리지 않는다: ${source.id}`,
          err instanceof Error ? err.message : "unknown",
        );
      }
    }
  } finally {
    releaseDiaryInput();
  }
}

export async function loadSessionDiary(sessionId: string, jsonlPath: string): Promise<void> {
  if (sessionDiaryMode() !== "sqlite") throw new Error("일기 데이터베이스가 열려 있지 않다");
  held.add(sessionId);
  try {
    const db = database();
    const stored = transaction(db, () => {
      const kept = cursor.get(sessionId);
      cursor.delete(sessionId);
      const fresh = readCursor(sessionId);
      if (kept) {
        fresh.nextOffset = Math.max(fresh.nextOffset, kept.nextOffset);
        fresh.highSeq = kept.highSeq;
      }
      return diaryMaxSeq(sessionId) > 0 || readSessionCursor(db, sessionId) !== null;
    });
    // 데이터베이스에 사건이 없는데 옛 일기 파일에 내용이 남았다면 사용자 대화다. 지우지 않고 알리기만 한다.
    if (!stored && fs.existsSync(jsonlPath) && fs.statSync(jsonlPath).size > 0) {
      void reportError(new Error("데이터베이스에 없는 옛 일기 파일이 남아 있다"), { component: "database", operation: "session.diary.leftover_file", session_id: sessionId });
    }
  } finally {
    held.delete(sessionId);
  }
}

/** 사건 표에 남아 있는 세션 id. 글자 색인을 다시 만들 때 이 목록이 정본이다. */
export async function listDiarySessionIds(): Promise<string[]> {
  if (sessionDiaryMode() !== "sqlite") throw new Error("일기 데이터베이스가 열려 있지 않다");
  const rows = database().prepare("SELECT DISTINCT session_id FROM session_event ORDER BY session_id").all() as { session_id: string }[];
  return rows.map((row) => row.session_id);
}

export async function readSessionDiaryStore(sessionId: string): Promise<{ cursor: SessionEventCursor | null; rows: StoredSessionEvent[] }> {
  if (sessionDiaryMode() !== "sqlite") throw new Error("일기 데이터베이스가 열려 있지 않다");
  const db = database();
  return transaction(db, () => ({ cursor: readSessionCursor(db, sessionId), rows: readSessionRows(db, sessionId) }));
}

/** 사건 표에 있는 세션의 최대 순번. 없으면 0. */
export function diaryMaxSeq(sessionId: string): number {
  if (sessionDiaryMode() !== "sqlite") throw new Error("일기 데이터베이스가 열려 있지 않다");
  const row = database().prepare("SELECT MAX(seq) AS m FROM session_event WHERE session_id = ?").get(sessionId) as { m: number | bigint | null };
  return Number(row.m ?? 0);
}

/** 한 세션의 일기 행을 파일 순서대로 하나씩 넘긴다. 행 전체를 메모리에 올리지 않는다. */
export function forEachDiaryRow(sessionId: string, visit: (row: StoredSessionEvent) => void): void {
  if (sessionDiaryMode() !== "sqlite") throw new Error("일기 데이터베이스가 열려 있지 않다");
  iterateSessionRows(database(), sessionId, visit);
}

export function appendDiaryBestEffort(sessionId: string, ev: AetherEvent): void {
  assertWritable(sessionId);
  if (sealed.has(sessionId)) throw new Error("세션 일기를 닫았다");
  try {
    insertDiary(sessionId, ev);
    failures.clear(`append:${sessionId}`);
  } catch (err) {
    failures.report(err, { component: "database", operation: "session.diary.append", session_id: sessionId, session_seq: ev.seq }, `append:${sessionId}`);
    // 실패한 순번은 빈 번호로 남겨 다음 사건이 다시 쓰지 못하게 한다.
    noteDiaryHighSeq(sessionId, ev.seq);
  }
}

export async function appendDiaryDurable(sessionId: string, ev: AetherEvent): Promise<void> {
  insertDiary(sessionId, ev);
}

/**
 * 데이터베이스에 동기로 쓴다. 읽기는 이 표를 그대로 조회한다.
 * 실패하면 byte_offset을 올리지 않으므로 빈 자리가 생기지 않는다.
 */
export function insertDiary(sessionId: string, ev: AetherEvent, gen?: DiaryGeneration): void {
  assertWritable(sessionId);
  if (generationRejected(sessionId, gen)) throw new Error(gen ? "세션 사건 기록기를 닫았다" : "세션 일기를 닫았다");
  const line = JSON.stringify(ev);
  const length = Buffer.byteLength(line);
  const cur = readCursor(sessionId);
  const db = database();
  transaction(db, () => {
    insertSessionRows(db, [{ sessionId, seq: ev.seq, ts: ev.ts, kind: ev.kind, byteOffset: cur.nextOffset, byteLength: length, line }]);
  });
  cur.nextOffset += length + 1;
}

/** 새 기록기 세대. 옛 세대의 진행 중 쓰기는 무효가 된 뒤의 오프셋을 잇는다. */
export function openDiaryGeneration(sessionId: string): DiaryGeneration {
  const prev = current.get(sessionId);
  if (prev && !prev.closed) {
    prev.closed = true;
  }
  const gen: DiaryGeneration = { token: nextToken++, closed: false };
  current.set(sessionId, gen);
  sealed.delete(sessionId);
  readCursor(sessionId);
  return gen;
}

/** 이 세대를 닫는다. 세션 ID를 영구히 막지는 않는다. */
export function closeDiaryGeneration(sessionId: string, gen: DiaryGeneration): void {
  if (!gen.closed) gen.closed = true;
  if (current.get(sessionId)?.token === gen.token) current.delete(sessionId);
  if (!current.has(sessionId)) sealed.add(sessionId);
}

/** 저장에 실패한 순번을 기억한다. 다음 사건이 이 번호를 다시 쓰지 못한다. */
export function noteDiaryHighSeq(sessionId: string, seq: number): void {
  if (!Number.isSafeInteger(seq) || seq <= 0) return;
  const cur = readCursor(sessionId);
  if (seq > cur.highSeq) cur.highSeq = seq;
}

/** 저장된 최대 순번과 저장에 실패해 비워 둔 순번 중 큰 값. */
export function diaryHighSeq(sessionId: string): number {
  return Math.max(cursor.get(sessionId)?.highSeq ?? 0, diaryMaxSeq(sessionId));
}

/** 세션을 지운 뒤의 늦은 저장을 막는다. */
export function retireDiary(sessionId: string): void {
  const gen = current.get(sessionId);
  if (gen) {
    closeDiaryGeneration(sessionId, gen);
    return;
  }
  sealed.add(sessionId);
}

function assertWritable(sessionId: string): void {
  if (!diaryAcceptsInput(sessionId)) {
    throw new Error("일기 전환 중이거나 데이터베이스를 쓸 수 없다. 파일로 되돌리지 않는다");
  }
}

function readCursor(sessionId: string): Cursor {
  const found = cursor.get(sessionId);
  if (found) return found;
  const created = { nextOffset: storedEnd(sessionId), highSeq: 0 };
  cursor.set(sessionId, created);
  return created;
}

/** 이 세션의 기존 행이 끝나는 자리 다음. 행이 없거나 데이터베이스가 닫혀 있으면 0. 기본키 충돌을 막는다. */
function storedEnd(sessionId: string): number {
  if (sessionDiaryMode() !== "sqlite") return 0;
  const row = database()
    .prepare("SELECT byte_offset, byte_length FROM session_event WHERE session_id = ? ORDER BY byte_offset DESC LIMIT 1")
    .get(sessionId) as { byte_offset: number | bigint; byte_length: number | bigint } | undefined;
  return row ? Number(row.byte_offset) + Number(row.byte_length) + 1 : 0;
}

function generationRejected(sessionId: string, gen?: DiaryGeneration): boolean {
  if (gen) return gen.closed || current.get(sessionId)?.token !== gen.token;
  return sealed.has(sessionId) && !current.has(sessionId);
}
