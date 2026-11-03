/** 별도 프로세스로 띄운 서버가 SQLite에 남긴 사건 줄을 읽기 전용으로 꺼낸다. */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function sessionEventLines(dbFile: string, sessionId: string): string[] {
  if (!fs.existsSync(dbFile)) return [];
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT line_text FROM session_event WHERE session_id = ? ORDER BY byte_offset").all(sessionId) as { line_text: string }[];
    return rows.map((row) => row.line_text);
  } finally {
    db.close();
  }
}
