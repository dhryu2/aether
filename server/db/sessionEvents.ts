/**
 * 세션 사건 표의 읽기·쓰기 조각. 일기(sessionDiary.ts)가 쓴다.
 * 모든 함수는 호출자가 연 트랜잭션 안에서 동기로 돈다.
 * 검색 파일은 여기 없다.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AetherEvent } from "../types";
import { database } from "./sqlite";

/**
 * 한 행은 일기 파일의 한 줄이다.
 * 순번이 같아도 파일 위치가 다르면 둘 다 남긴다. 화면은 파일 순서로 다시 그리기 때문이다.
 * 깨진 줄과, 아직 줄바꿈으로 닫히지 않은 끝은 행이 아니다. 커서가 어디까지 읽었는지 기억한다.
 */
export type StoredSessionEvent = {
  sessionId: string;
  seq: number;
  ts: number;
  kind: string;
  byteOffset: number;
  byteLength: number;
  line: string;
};

export type SessionEventCursor = {
  consumedByte: number;
  sourceSha256: string;
};

export type SessionEventInsert = StoredSessionEvent;

type EventSql = {
  seq: number;
  ts: number;
  kind: string;
  byte_offset: number;
  byte_length: number;
  line_text: string;
};

type CursorSql = {
  consumed_byte: number;
  source_sha256: string;
};

/**
 * 화면이 처음부터 다시 그릴 때 순번이 0보다 큰 줄만 쓴다.
 * 정수가 아닌 순번은 좌표로 저장하지 않는다.
 * 종류나 시각이 없으면 줄 원문은 그대로 두고, 칸만 비어 있는 값으로 채운다.
 */
export function screenEventMeta(value: unknown): { seq: number; ts: number; kind: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq <= 0) return null;
  const ts = typeof row.ts === "number" && Number.isSafeInteger(row.ts) && row.ts >= 0 ? row.ts : 0;
  const kind = typeof row.kind === "string" ? row.kind : "";
  return { seq: row.seq, ts, kind };
}

export function readStoredSessionEvents(sessionId: string): StoredSessionEvent[] {
  assertSessionId(sessionId);
  return readSessionRows(database(), sessionId);
}

export function readSessionCursor(db: DatabaseSync, sessionId: string): SessionEventCursor | null {
  const row = db
    .prepare("SELECT consumed_byte, source_sha256 FROM session_event_cursor WHERE session_id = ?")
    .get(sessionId) as CursorSql | undefined;
  if (!row) return null;
  return { consumedByte: asInt(row.consumed_byte), sourceSha256: row.source_sha256 };
}

export function readSessionRows(db: DatabaseSync, sessionId: string): StoredSessionEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, ts, kind, byte_offset, byte_length, line_text
       FROM session_event
       WHERE session_id = ?
       ORDER BY byte_offset ASC`,
    )
    .all(sessionId) as EventSql[];
  return rows.map((row) => ({
    sessionId,
    seq: asInt(row.seq),
    ts: asInt(row.ts),
    kind: row.kind,
    byteOffset: asInt(row.byte_offset),
    byteLength: asInt(row.byte_length),
    line: row.line_text,
  }));
}

export function iterateSessionRows(db: DatabaseSync, sessionId: string, visit: (row: StoredSessionEvent) => void): void {
  const rows = db
    .prepare(
      `SELECT seq, ts, kind, byte_offset, byte_length, line_text
       FROM session_event
       WHERE session_id = ?
       ORDER BY byte_offset ASC`,
    )
    .iterate(sessionId) as Iterable<EventSql>;
  for (const row of rows) {
    visit({
      sessionId,
      seq: asInt(row.seq),
      ts: asInt(row.ts),
      kind: row.kind,
      byteOffset: asInt(row.byte_offset),
      byteLength: asInt(row.byte_length),
      line: row.line_text,
    });
  }
}

const COLUMNS = "seq, ts, kind, byte_offset, byte_length, line_text";

function* queryRows(sessionId: string, where: string, order: "ASC" | "DESC", ...params: (string | number)[]): Generator<StoredSessionEvent> {
  const rows = database()
    .prepare(`SELECT ${COLUMNS} FROM session_event WHERE session_id = ? ${where} ORDER BY byte_offset ${order}`)
    .iterate(sessionId, ...params) as Iterable<EventSql>;
  for (const row of rows) {
    yield {
      sessionId,
      seq: asInt(row.seq),
      ts: asInt(row.ts),
      kind: row.kind,
      byteOffset: asInt(row.byte_offset),
      byteLength: asInt(row.byte_length),
      line: row.line_text,
    };
  }
}

/** 순번이 from 이상 before 미만인 행을 파일 순서로 하나씩 넘긴다. 색인(session_id, seq)을 쓴다. */
export function eventRowsInSeqRange(sessionId: string, from: number, before = Number.MAX_SAFE_INTEGER): Generator<StoredSessionEvent> {
  return queryRows(sessionId, "AND seq >= ? AND seq < ?", "ASC", from, before);
}

/** 최신 행부터 거꾸로(+seq는 색인을 못 쓰게 막아 기본키 역순으로 읽게 한다. 색인을 쓰면 앞 행을 전부 읽고 정렬한다) 하나씩 넘긴다. 호출부가 필요한 만큼 읽고 멈추면 나머지는 읽지 않는다. before가 있으면 그 순번 미만만. */
export function eventRowsNewestFirst(sessionId: string, before?: number): Generator<StoredSessionEvent> {
  return before === undefined ? queryRows(sessionId, "", "DESC") : queryRows(sessionId, "AND +seq < ?", "DESC", before);
}

/** 지정한 종류의 행만 파일 순서로 넘긴다. */
export function eventRowsOfKinds(sessionId: string, kinds: readonly string[]): Generator<StoredSessionEvent> {
  return queryRows(sessionId, `AND kind IN (${kinds.map(() => "?").join(",")})`, "ASC", ...kinds);
}

/** 파일 순서로 맨 앞 행의 순번. 행이 없으면 null. */
export function firstEventSeq(sessionId: string): number | null {
  const row = database().prepare("SELECT seq FROM session_event WHERE session_id = ? ORDER BY byte_offset ASC LIMIT 1").get(sessionId) as { seq: number | bigint } | undefined;
  return row ? asInt(row.seq) : null;
}

/** 저장한 줄을 사건 객체로 푼다. */
export function storedRowEvent(row: StoredSessionEvent): AetherEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.line) as unknown;
  } catch (cause) {
    throw new Error("저장한 사건 줄을 읽지 못했다", { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("저장한 사건 줄이 객체가 아니다");
  return parsed as AetherEvent;
}

export function insertSessionRows(db: DatabaseSync, rows: SessionEventInsert[]): void {
  const insert = db.prepare(
    `INSERT INTO session_event (session_id, seq, ts, kind, byte_offset, byte_length, line_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    assertWritable(row);
    insert.run(row.sessionId, row.seq, row.ts, row.kind, row.byteOffset, row.byteLength, row.line);
  }
}

/** 세션 하나의 사건 행과 커서를 지운다. 세션을 지울 때만 부른다. 지운 행 수를 돌려준다. */
export function deleteSessionRows(db: DatabaseSync, sessionId: string): number {
  assertSessionId(sessionId);
  const n = Number(db.prepare("DELETE FROM session_event WHERE session_id = ?").run(sessionId).changes);
  db.prepare("DELETE FROM session_event_cursor WHERE session_id = ?").run(sessionId);
  return n;
}

function assertWritable(row: SessionEventInsert): void {
  assertSessionId(row.sessionId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.line) as unknown;
  } catch (cause) {
    throw new Error("사건 줄이 깨졌다", { cause });
  }
  const meta = screenEventMeta(parsed);
  if (!meta || meta.seq !== row.seq || meta.ts !== row.ts || meta.kind !== row.kind) {
    throw new Error("사건 좌표가 줄과 다르다");
  }
  if (Buffer.byteLength(row.line) !== row.byteLength || row.byteOffset < 0) {
    throw new Error("사건 줄 길이가 다르다");
  }
}

function assertSessionId(id: string): void {
  if (id.trim() === "" || id !== id.trim()) throw new Error("세션 id가 비어 있다");
}

function asInt(value: number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("사건 좌표를 읽지 못했다");
  return n;
}
