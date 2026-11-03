/**
 * 오류 기록 조회. error_event 표를 지문(fingerprint)별 묶음 목록과 묶음 상세로 읽는다.
 * 화면·전송 방식을 모른다. 응답 열은 손으로 적어 새 열이 저절로 새어 나가지 않게 한다.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ErrorEventView, ErrorGroupDetailResponse, ErrorGroupListResponse, ErrorGroupSummary, ErrorLogSource } from '../../shared/errors';

const PAGE = 50;
const SESSION_LIMIT = 20;
const PERIOD_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const CURSOR = /^([0-9TZ:.\-]{10,40})\|([0-9a-f]{64})$/;

export interface ErrorQuery { sinceIso: string; source: ErrorLogSource; cursor: { lastAt: string; fingerprint: string } | null }

export const isFingerprint = (v: unknown): v is string => typeof v === 'string' && FINGERPRINT.test(v);

/** 질의 문자열 검사. 문자열이 아니거나(같은 이름을 두 번 보내면 배열) 허용 값이 아니면 null. */
export function parseErrorQuery(query: Record<string, unknown>, opts: { cursor: boolean }, now = Date.now()): ErrorQuery | null {
  const since = query.since ?? '24h';
  const source = query.source ?? 'all';
  if (since !== '24h' && since !== '7d' && since !== 'all') return null;
  if (source !== 'all' && source !== 'server' && source !== 'web') return null;
  let cursor: ErrorQuery['cursor'] = null;
  if (opts.cursor && query.cursor !== undefined) {
    const m = typeof query.cursor === 'string' ? CURSOR.exec(query.cursor) : null;
    if (!m || Number.isNaN(Date.parse(m[1]))) return null;
    cursor = { lastAt: m[1], fingerprint: m[2] };
  }
  return { sinceIso: since === 'all' ? '' : new Date(now - PERIOD_MS[since]).toISOString(), source, cursor };
}

/** 기간·출처 조건 절과 바인딩 값. 기간 `all`은 빈 문자열이라 모든 시각이 통과한다. */
function filter(q: ErrorQuery): { where: string; args: string[] } {
  return q.source === 'all'
    ? { where: 'occurred_at >= ?', args: [q.sinceIso] }
    : { where: 'occurred_at >= ? AND source = ?', args: [q.sinceIso, q.source] };
}

export function listErrorGroups(db: DatabaseSync, q: ErrorQuery): ErrorGroupListResponse {
  const { where, args } = filter(q);
  const after = q.cursor ? ' HAVING lastAt < ? OR (lastAt = ? AND fingerprint < ?)' : '';
  const bound = q.cursor ? [q.cursor.lastAt, q.cursor.lastAt, q.cursor.fingerprint] : [];
  // shortcut: 목록은 error_event를 훑는다(3개월 보존이라 작다), 행이 수십만을 넘으면 occurred_at 색인을 더한다.
  // 집계가 max() 하나뿐이면 SQLite는 나머지 열을 그 최댓값 행에서 가져온다. 여기에 min()을 더하면 이 보장이 깨진다.
  const rows = db.prepare(
    `SELECT fingerprint, max(occurred_at) AS lastAt, count(*) AS count, substr(message, 1, 500) AS message, component, operation, source
     FROM error_event WHERE ${where} GROUP BY fingerprint${after} ORDER BY lastAt DESC, fingerprint DESC LIMIT ${PAGE + 1}`,
  ).all(...args, ...bound) as unknown as ErrorGroupSummary[];
  // 열을 이름으로 골라 담아 SELECT가 늘어도 응답에 저절로 새지 않게 한다.
  const groups: ErrorGroupSummary[] = rows.slice(0, PAGE).map(({ fingerprint, message, component, operation, source, count, lastAt }) =>
    ({ fingerprint, message, component, operation, source, count, lastAt }));
  const last = groups[groups.length - 1];
  const { total } = db.prepare(`SELECT count(*) AS total FROM error_event WHERE ${where}`).get(...args) as { total: number };
  return { groups, nextCursor: rows.length > PAGE && last ? `${last.lastAt}|${last.fingerprint}` : null, total };
}

export function errorGroupDetail(db: DatabaseSync, fingerprint: string, q: ErrorQuery): ErrorGroupDetailResponse | null {
  const { where, args } = filter(q);
  const sum = db.prepare(`SELECT count(*) AS count, min(occurred_at) AS firstAt, max(occurred_at) AS lastAt FROM error_event WHERE fingerprint = ? AND ${where}`)
    .get(fingerprint, ...args) as { count: number; firstAt: string | null; lastAt: string | null };
  if (!sum.count || !sum.firstAt || !sum.lastAt) return null;
  const r = db.prepare(
    `SELECT id, occurred_at, severity, source, component, operation, code, message, stack, request_id, session_id, release, provider, model, context
     FROM error_event WHERE fingerprint = ? AND ${where} ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).get(fingerprint, ...args) as unknown as Omit<ErrorEventView, 'context'> & { context: string };
  const sessions = db.prepare(
    `SELECT session_id FROM error_event WHERE fingerprint = ? AND ${where} AND session_id IS NOT NULL
     GROUP BY session_id ORDER BY max(occurred_at) DESC LIMIT ${SESSION_LIMIT}`,
  ).all(fingerprint, ...args) as { session_id: string }[];
  const { id, occurred_at, severity, source, component, operation, code, message, stack, request_id, session_id, release, provider, model } = r;
  const latest: ErrorEventView = {
    id, occurred_at, severity, source, component, operation, code, message, stack, request_id, session_id, release, provider, model,
    context: JSON.parse(r.context) as Record<string, unknown>,
  };
  return { fingerprint, count: sum.count, firstAt: sum.firstAt, lastAt: sum.lastAt, sessionIds: sessions.map(s => s.session_id), latest };
}
