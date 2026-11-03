import type { DatabaseSync } from 'node:sqlite';
import type { ErrorEvent } from '../../shared/errors';
import { database, openDatabaseAt } from '../db/sqlite';
export interface ErrorWriteResult extends Set<string> {
  /** 재시도해도 바뀌지 않는 데이터 거절. 없는 ID는 임시 실패로 재시도한다. */
  rejected?: ReadonlySet<string>;
}
export interface ErrorSink {
  /** 성공한 id는 COMMIT이 끝난 것만 반환한다. 행별 실패는 다른 행을 막지 않는다. */
  write(events: ErrorEvent[]): Promise<ErrorWriteResult>;
  prune(): Promise<void>;
  close?(): Promise<void>;
}
// NUL·단독 surrogate는 SQLite 글자 함수와 UTF-8 변환에서 깨지므로 문자 표기로 보존한다. 마스킹이 아니다.
export function storableText(s: string): string {
  return s.replace(/\u0000/g, '\\u0000').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function storableValue(v: unknown): unknown {
  if (typeof v === 'string') return storableText(v);
  if (Array.isArray(v)) return v.map(storableValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [storableText(k), storableValue(x)]));
  return v;
}
// 키는 공통 계약의 고정 목록으로 제한한다.
const COLUMNS = ['id','occurred_at','severity','source','component','operation','code','message','stack','fingerprint','request_id','session_id','session_seq','environment','release','instance_id','provider','model','context'] as const;
// 제약 위반(19), 형식 불일치(20), 너무 큰 값(18)만 행 데이터 문제다. 나머지는 전체 재시도다.
const ROW_ERRORS = new Set([18, 19, 20]);
function rowError(e: unknown): boolean {
  const code = (e as { errcode?: unknown }).errcode;
  return typeof code === 'number' && ROW_ERRORS.has(code & 0xff);
}
/** 3개월 전(달력 기준) 밀리초. */
function threeMonthsAgo(now: number): number {
  const d = new Date(now);
  d.setMonth(d.getMonth() - 3);
  return d.getTime();
}
export class SqliteErrorSink implements ErrorSink {
  /** file이 없으면 서버가 정한 Aether DB 파일을 쓴다. */
  constructor(private readonly file?: string, private readonly now: () => number = Date.now) {}
  private db(): DatabaseSync { return this.file ? openDatabaseAt(this.file) : database(); }
  async write(events: ErrorEvent[]): Promise<ErrorWriteResult> {
    const db = this.db();
    const rejected = new Set<string>();
    const saved: ErrorWriteResult = Object.assign(new Set<string>(), { rejected });
    const insert = db.prepare(`INSERT INTO error_event (${COLUMNS.join(',')}, received_at) VALUES (${COLUMNS.map(() => '?').join(',')}, ?) ON CONFLICT (id) DO NOTHING`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        db.exec('SAVEPOINT error_row');
        try {
          insert.run(...COLUMNS.map(k => {
            if (k === 'context') return JSON.stringify(storableValue(event[k]));
            const v = storableValue(event[k]);
            return v === undefined ? null : v as string | number | null;
          }), this.now());
          saved.add(event.id);
        } catch (e) {
          db.exec('ROLLBACK TO SAVEPOINT error_row');
          if (!rowError(e)) throw e;
          rejected.add(event.id);
        }
        db.exec('RELEASE SAVEPOINT error_row');
      }
      db.exec('COMMIT');
      return saved;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }
  async prune(): Promise<void> {
    // 작은 묶음으로 쓰기 잠금 시간을 제한한다. 오래 밀린 정리는 다음 주기에도 계속된다.
    this.db().prepare('DELETE FROM error_event WHERE id IN (SELECT id FROM error_event WHERE received_at < ? ORDER BY received_at LIMIT 1000)').run(threeMonthsAgo(this.now()));
  }
}
