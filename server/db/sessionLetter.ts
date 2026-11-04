/**
 * 세션 글자 색인. 사람 찾기와 세션 검색이 채널을 고르지 않았을 때 이 표를 읽는다.
 * 낱말이 글 안에 들어 있으면 찾는다(소문자 사본에서 instr). 맞은 수가 먼저고 점수는 FTS5 bm25다.
 * 글의 원천은 세션 사건 표다. 칠판 글 표와 그림자 색인은 여기 없다.
 * 표는 sqlite.ts가 연 파일에 있다. 쓰기는 동기 트랜잭션 하나로 끝난다.
 */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { configureDatabase, database, foldCase, transaction } from "./sqlite";

const MAX_INDEX_CHARS = 100_000;
const MAX_TOKENS = 12;
const PART_SPAN = 100_000;
const BOOL_OPS = new Set(["AND", "OR", "NOT"]);
const HL_OPEN = String.fromCharCode(1);
const HL_CLOSE = String.fromCharCode(2);

const PROMOTE_SQL = `
UPDATE session_letter SET role = 'assistant'
 WHERE session_id = ?1 AND role = 'assistant_interim'
   AND seq = (
     SELECT MAX(seq) FROM session_letter
      WHERE session_id = ?1 AND role = 'assistant_interim' AND seq <= ?2
        AND seq > COALESCE((
          SELECT MAX(seq) FROM session_letter
           WHERE session_id = ?1 AND role IN ('user','assistant') AND seq <= ?2
        ), 0))
`;

const INSERT_SQL = `
INSERT INTO session_letter (session_id, seq, part, role, ts, content, content_fold)
VALUES (?, ?, ?, ?, ?, ?, ?)
`;

export type LetterRole = "user" | "assistant" | "assistant_interim" | "tool";

export type LetterDoc = {
  seq: number;
  part: number;
  role: LetterRole;
  ts: number;
  content: string;
};

export type LetterSessionMeta = {
  displayName: string | null;
  cwd: string | null;
  model: string | null;
  createdAt: number | null;
  lineageId: string;
};

export type LetterProgress = { highSeq: number; rulesVersion: string };

export type LetterSearchOpts = {
  query: string;
  sessionId?: string;
  limit?: number;
  sort?: "newest" | "oldest";
  chatOnly?: boolean;
  role?: "user" | "assistant" | "tool";
  fromTs?: number;
  toTs?: number;
  preferCwd?: string;
  /** 있으면 색인 폴더(끝 슬래시 제거)가 이 값과 같은 세션만. 검색 SQL의 조건이다. */
  projectCwd?: string;
  /** 참이면 낱말이 모두 든 글만. 자동 회상용. */
  requireAll?: boolean;
  /** 그 세션과 같은 이어가기 묶음(lineage) 세션을 뺀다. */
  excludeSessionId?: string;
};

export type LetterSessionRow = {
  displayName: string | null;
  cwd: string | null;
  model: string | null;
  createdAt: number | null;
  lineageId: string | null;
};

export type LetterSearchHit = {
  id: number;
  sessionId: string;
  seq: number;
  part: number;
  role: string;
  ts: number;
  snippet: string;
  session: LetterSessionRow;
};

export type LetterCtxRow = {
  id: number;
  seq: number;
  part: number;
  role: string;
  ts: number;
  content: string;
};

export type LetterContextHit = {
  sessionId: string;
  session: LetterSessionRow;
  anchor: LetterSearchHit;
  window: LetterCtxRow[];
  bookendStart: LetterCtxRow[];
  bookendEnd: LetterCtxRow[];
};

export type LiveLetterInput = {
  sessionId: string;
  seq: number;
  ts: number;
  turnEnded: boolean;
  items: { part: number; role: LetterRole; content: string }[];
  displayName: string | null;
  cwd: string | null;
  model: string | null;
  createdAt: number | null;
  lineageId: string;
};

type SqlHit = {
  session_id: string;
  seq: number;
  part: number;
  role: string;
  ts: number;
  content: string;
  display_name: string | null;
  cwd: string | null;
  model: string | null;
  created_at: number | null;
  lineage_id: string | null;
};

type SqlCtx = {
  seq: number;
  part: number;
  role: string;
  ts: number;
  content: string;
};

type Built = {
  sql: string;
  params: unknown[];
  needle: string;
};

type ExtraClause = (add: (value: unknown) => string) => string;

type SqlParam = string | number | null;

let ready = false;
let blocked = false;
let chain: Promise<void> = Promise.resolve();

export function __resetSessionLetterForTest(): void {
  ready = false;
  blocked = false;
  chain = Promise.resolve();
}

export function sessionLetterReady(): boolean {
  return ready && !blocked;
}

export function sessionLetterBlocked(): boolean {
  return blocked;
}

export function blockSessionLetter(): void {
  blocked = true;
  ready = false;
}

export function letterDocId(seq: number, part: number): number {
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error("글자 순번이 범위 밖이다");
  if (!Number.isSafeInteger(part) || part < 0 || part >= PART_SPAN) throw new Error("글자 조각이 범위 밖이다");
  const id = seq * PART_SPAN + part;
  if (!Number.isSafeInteger(id)) throw new Error("글자 좌표가 안전한 정수가 아니다");
  return id;
}

export async function openSessionLetter(opts?: { path?: string | null }): Promise<void> {
  if (opts) configureDatabase(opts);
  database();
  ready = true;
  blocked = false;
}

export async function searchSessionLetters(opts: LetterSearchOpts): Promise<LetterSearchHit[]> {
  assertOpen();
  const built = buildSearch(opts);
  if (!built) return [];
  return runBuilt(built);
}

/** path.resolve 뒤 끝 슬래시를 뗀다. SQL rtrim과 같은 문자열을 만든다. */
function normalizeProjectCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/]+$/, "");
}

/** 세션 하나의 색인 폴더가 인자 폴더와 같은지. 세션이 없으면 거짓. realpath는 쓰지 않는다. */
export async function hasLetterSession(sessionId: string): Promise<boolean> {
  assertOpen();
  assertSessionId(sessionId);
  return database().prepare("SELECT 1 AS ok FROM session_letter_session WHERE session_id = ? LIMIT 1").get(sessionId) !== undefined;
}

/** 마지막 재생성 기록. 없으면 null(한 번도 안 만들었거나 실시간 색인이 무효화했다). */
export async function readLetterProgress(sessionId: string): Promise<LetterProgress | null> {
  assertOpen();
  assertSessionId(sessionId);
  const row = database()
    .prepare("SELECT high_seq, rules_version FROM session_letter_progress WHERE session_id = ?")
    .get(sessionId) as { high_seq: number | bigint; rules_version: string } | undefined;
  return row ? { highSeq: asInt(row.high_seq), rulesVersion: row.rules_version } : null;
}

export async function letterSessionInProject(sessionId: string, cwd: string): Promise<boolean> {
  assertOpen();
  assertSessionId(sessionId);
  const normalized = normalizeProjectCwd(cwd);
  return (
    database()
      .prepare(`SELECT 1 AS ok FROM session_letter_session WHERE session_id = ? AND rtrim(cwd, '/\\') = ? LIMIT 1`)
      .get(sessionId, normalized) !== undefined
  );
}

function projectCwdClause(cwd: string): ExtraClause {
  const normalized = normalizeProjectCwd(cwd);
  return (add) => `rtrim(s.cwd, '/\\') = ${add(normalized)}`;
}

export async function explainSessionLetter(opts: LetterSearchOpts): Promise<string> {
  assertOpen();
  const built = buildSearch({ ...opts, limit: opts.limit ?? 5 });
  if (!built) return "";
  try {
    const rows = database().prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...(built.params as SqlParam[])) as { detail: string }[];
    return rows.map((row) => row.detail).join("\n");
  } catch (err) {
    const code = typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
    throw new Error(`세션 글자 색인 계획을 읽지 못했다${code ? ` (${code})` : ""}`, { cause: err });
  }
}

export async function searchLettersWithContext(
  opts: LetterSearchOpts,
  ctx: { window?: number; bookend?: number } = {},
): Promise<LetterContextHit[]> {
  const want = clamp(opts.limit, 5, 20);
  const { preferCwd, ...rest } = opts;
  const scan = await searchSessionLetters({ ...rest, limit: Math.min(want * 8, 120) });
  const ranked = preferCwd
    ? [...scan].sort((a, b) => (a.session.cwd === preferCwd ? 0 : 1) - (b.session.cwd === preferCwd ? 0 : 1))
    : scan;
  const seen = new Set<string>();
  const out: LetterContextHit[] = [];
  for (const hit of ranked) {
    const lineage = hit.session.lineageId || hit.sessionId;
    if (seen.has(lineage)) continue;
    seen.add(lineage);
    const around = await getLetterContext(hit.sessionId, hit.id, ctx.window ?? 4, ctx.bookend ?? 3);
    out.push({ sessionId: hit.sessionId, session: hit.session, anchor: hit, ...around });
    if (out.length >= want) break;
  }
  return out;
}

export async function getLetterContext(
  sessionId: string,
  anchorId: number,
  window = 4,
  bookend = 3,
): Promise<{ window: LetterCtxRow[]; bookendStart: LetterCtxRow[]; bookendEnd: LetterCtxRow[] }> {
  assertOpen();
  assertSessionId(sessionId);
  const empty = { window: [], bookendStart: [], bookendEnd: [] };
  if (!Number.isSafeInteger(anchorId) || anchorId < 0) return empty;
  const span = clamp(window, 4, 50);
  const edge = Math.max(0, Math.min(bookend, 20));
  const db = database();
  const ctx = (sql: string, ...params: SqlParam[]) => db.prepare(sql).all(...params) as SqlCtx[];
  const before = ctx(
    `SELECT seq, part, role, ts, content
     FROM session_letter
     WHERE session_id = ? AND ${idExpr()} <= ? AND role IN ('user','assistant','tool')
     ORDER BY seq DESC, part DESC
     LIMIT ?`,
    sessionId,
    anchorId,
    span + 1,
  );
  const after = ctx(
    `SELECT seq, part, role, ts, content
     FROM session_letter
     WHERE session_id = ? AND ${idExpr()} > ? AND role IN ('user','assistant','tool')
     ORDER BY seq ASC, part ASC
     LIMIT ?`,
    sessionId,
    anchorId,
    span,
  );
  const win = [...before.reverse(), ...after].map(mapCtx);
  if (!win.length || edge === 0) return { window: win, bookendStart: [], bookendEnd: [] };
  const minId = win[0].id;
  const maxId = win[win.length - 1].id;
  const start = ctx(
    `SELECT seq, part, role, ts, content
     FROM session_letter
     WHERE session_id = ? AND ${idExpr()} < ? AND role IN ('user','assistant') AND length(content) > 0
     ORDER BY seq ASC, part ASC
     LIMIT ?`,
    sessionId,
    minId,
    edge,
  );
  const end = ctx(
    `SELECT seq, part, role, ts, content
     FROM session_letter
     WHERE session_id = ? AND ${idExpr()} > ? AND role IN ('user','assistant') AND length(content) > 0
     ORDER BY seq DESC, part DESC
     LIMIT ?`,
    sessionId,
    maxId,
    edge,
  );
  return { window: win, bookendStart: start.map(mapCtx), bookendEnd: end.reverse().map(mapCtx) };
}

export async function getLetterSessionPage(
  sessionId: string,
  afterId = 0,
  limit = 40,
  role?: LetterSearchOpts["role"],
): Promise<LetterCtxRow[]> {
  assertOpen();
  assertSessionId(sessionId);
  const after = Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
  const size = clamp(limit, 40, 100);
  const picked = cleanRole(role);
  const params: SqlParam[] = [sessionId, after];
  const where = [`session_id = ?`, `${idExpr()} > ?`, `role IN ('user','assistant','tool')`];
  if (picked) {
    params.push(picked);
    where.push(`role = ?`);
  }
  params.push(size);
  const found = database()
    .prepare(
      `SELECT seq, part, role, ts, content
       FROM session_letter
       WHERE ${where.join(" AND ")}
       ORDER BY seq ASC, part ASC
       LIMIT ?`,
    )
    .all(...params) as SqlCtx[];
  return found.map(mapCtx);
}

export async function replaceSessionLetter(
  sessionId: string,
  docs: LetterDoc[],
  turnSeqs: number[],
  meta: LetterSessionMeta,
  /** 있으면 같은 트랜잭션에서 진행 기록을 쓴다. 재생성이 실패하면 기록도 남지 않는다. */
  progress?: LetterProgress,
): Promise<number> {
  assertOpen();
  assertSessionId(sessionId);
  return enqueue(async () => replaceLetterRows(database(), sessionId, docs, turnSeqs, meta, progress));
}

/** 세션 하나의 글자를 통째로 갈아끼운다. 동기 트랜잭션 하나. */
function replaceLetterRows(
  db: DatabaseSync,
  sessionId: string,
  docs: LetterDoc[],
  turnSeqs: number[],
  meta: LetterSessionMeta,
  progress?: LetterProgress,
): number {
  assertSessionId(sessionId);
  const clean = sanitizeDocs(docs);
  const turns = [...new Set(turnSeqs.filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
  return transaction(db, () => {
    db.prepare("DELETE FROM session_letter WHERE session_id = ?").run(sessionId);
    insertDocs(db, sessionId, clean);
    const promote = db.prepare(PROMOTE_SQL);
    for (const turn of turns) promote.run(sessionId, turn);
    upsertMeta(db, sessionId, meta);
    if (progress) {
      db.prepare(
        `INSERT INTO session_letter_progress (session_id, high_seq, rules_version) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET high_seq = excluded.high_seq, rules_version = excluded.rules_version`,
      ).run(sessionId, progress.highSeq, progress.rulesVersion);
    } else db.prepare("DELETE FROM session_letter_progress WHERE session_id = ?").run(sessionId);
    return clean.length;
  });
}

/**
 * 저장된 글자는 그대로 두고, 없는 (seq, part)만 채운다. 동기 트랜잭션 하나. 삭제 직전 글자 확인과 정리 도구가 부른다.
 * 갈아끼우지 않는 까닭: 정제 규칙이 달라도 이미 검색되던 글이 줄어들면 안 된다.
 */
export function fillMissingLetterRows(db: DatabaseSync, sessionId: string, docs: LetterDoc[], turnSeqs: number[], meta: LetterSessionMeta): number {
  assertSessionId(sessionId);
  const turns = [...new Set(turnSeqs.filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
  return transaction(db, () => {
    const have = new Set((db.prepare("SELECT seq, part FROM session_letter WHERE session_id = ?").all(sessionId) as { seq: number | bigint; part: number | bigint }[]).map((r) => `${r.seq}:${r.part}`));
    const missing = sanitizeDocs(docs).filter((d) => !have.has(`${d.seq}:${d.part}`));
    insertDocs(db, sessionId, missing);
    const promote = db.prepare(PROMOTE_SQL);
    for (const turn of turns) promote.run(sessionId, turn);
    upsertMeta(db, sessionId, meta);
    return missing.length;
  });
}

export function projectLiveLetter(input: LiveLetterInput): Promise<void> {
  if (!sessionLetterReady()) return Promise.resolve();
  return enqueue(() => writeLive(input));
}

/** 세션 이름·폴더만 글자 색인에 남긴다. 색인이 닫혀 있으면 아무 것도 하지 않는다. */
export function touchLetterSession(meta: LetterSessionMeta & { sessionId: string }): Promise<void> {
  if (!sessionLetterReady()) return Promise.resolve();
  const sessionId = meta.sessionId;
  return enqueue(async () => {
    assertSessionId(sessionId);
    const db = database();
    transaction(db, () => upsertMeta(db, sessionId, meta));
  });
}

/** 세션 하나의 글자 색인(글·FTS·세션 정보·재생성 기록)을 지운다. 호출자가 연 트랜잭션 안에서 돈다. */
export function deleteLetterRows(db: DatabaseSync, sessionId: string): void {
  assertSessionId(sessionId);
  db.prepare("DELETE FROM session_letter WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM session_letter_session WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM session_letter_progress WHERE session_id = ?").run(sessionId);
}

/** 이미 줄 선 실시간 색인 쓰기가 지운 뒤에 되살리지 못하게, 그 뒤에 한 번 더 지운다. */
export function deleteLetterSession(sessionId: string): Promise<void> {
  if (!sessionLetterReady()) return Promise.resolve();
  return enqueue(async () => {
    const db = database();
    transaction(db, () => deleteLetterRows(db, sessionId));
  });
}

/**
 * 되돌려 숨긴 순번 범위의 글을 색인에서 지운다(범위는 `after < seq <= until`).
 * enqueue를 타므로 이미 줄 선 실시간 쓰기보다 뒤에 돈다. FTS 표는 삭제 트리거가 맞춘다.
 */
export function deleteLetterRanges(sessionId: string, ranges: readonly { after: number; until: number }[]): Promise<void> {
  if (!sessionLetterReady() || !ranges.length) return Promise.resolve();
  return enqueue(async () => {
    assertSessionId(sessionId);
    const db = database();
    transaction(db, () => {
      const del = db.prepare("DELETE FROM session_letter WHERE session_id = ? AND seq > ? AND seq <= ?");
      for (const range of ranges) del.run(sessionId, range.after, range.until);
    });
  });
}

async function writeLive(input: LiveLetterInput): Promise<void> {
  assertSessionId(input.sessionId);
  if (!Number.isSafeInteger(input.seq) || input.seq <= 0) return;
  const docs = sanitizeDocs(
    input.items.map((item) => ({
      seq: input.seq,
      part: item.part,
      role: item.role,
      ts: input.ts,
      content: item.content,
    })),
  );
  const db = database();
  transaction(db, () => {
    // 중간 순번이 빠졌을 수 있어 최대 순번만 올리면 빈틈이 영영 안 메워진다. 기록을 지워 다음 부팅이 이 세션을 다시 만들게 한다.
    db.prepare("DELETE FROM session_letter_progress WHERE session_id = ?").run(input.sessionId);
    db.prepare("DELETE FROM session_letter WHERE session_id = ? AND seq = ?").run(input.sessionId, input.seq);
    insertDocs(db, input.sessionId, docs);
    if (input.turnEnded) db.prepare(PROMOTE_SQL).run(input.sessionId, input.seq);
    upsertMeta(db, input.sessionId, {
      displayName: input.displayName,
      cwd: input.cwd,
      model: input.model,
      createdAt: input.createdAt,
      lineageId: input.lineageId,
    });
  });
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, () => job());
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runBuilt(built: Built): Promise<LetterSearchHit[]> {
  let rows: SqlHit[];
  try {
    rows = database().prepare(built.sql).all(...(built.params as SqlParam[])) as SqlHit[];
  } catch (err) {
    const code = typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
    console.error("[aether] 세션 글자 색인 조회 실패", code || "unknown");
    throw new Error("세션 글자 색인 조회에 실패했다", { cause: err });
  }
  return rows.map((row) => mapHit(row, built.needle));
}

function buildSearch(opts: LetterSearchOpts, extra: ExtraClause[] = []): Built | null {
  const choice = splitTerms(opts.query ?? "");
  if (choice.phrases.length + choice.words.length === 0) return null;
  const needle = needleOf(opts.query ?? "");
  const params: unknown[] = [];
  // 번호 매개변수(?N)라 SQL 안의 위치와 넣은 순서가 달라도 된다.
  const add = (value: unknown): string => {
    params.push(value);
    return `?${params.length}`;
  };
  const where: string[] = [];
  const matched: string[] = [];
  const phraseConds: string[] = [];
  const wordConds: string[] = [];
  const pushTerm = (term: string, into: string[]) => {
    const cond = `(instr(l.content_fold, ${add(foldCase(term))}) > 0)`;
    matched.push(cond);
    into.push(cond);
  };
  for (const phrase of choice.phrases) pushTerm(phrase, phraseConds);
  for (const word of choice.words) pushTerm(word, wordConds);
  if (phraseConds.length > 0) where.push(phraseConds.join(" AND "));
  if (wordConds.length > 0) where.push(opts.requireAll ? wordConds.join(" AND ") : `(${wordConds.join(" OR ")})`);
  // bm25는 작을수록 잘 맞는다. 낱말이 색인 토큰을 하나도 만들지 못하면 점수 없이 0이다.
  const ftsQuery = [...choice.phrases, ...choice.words].map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
  const scoreExpr = "COALESCE(f.score, 0)";
  const sessionId = opts.sessionId?.trim();
  if (sessionId) where.push(`l.session_id = ${add(sessionId)}`);
  where.push(opts.chatOnly ? "l.role IN ('user','assistant')" : "l.role IN ('user','assistant','tool')");
  const role = cleanRole(opts.role);
  if (role) where.push(`l.role = ${add(role)}`);
  if (typeof opts.fromTs === "number" && Number.isFinite(opts.fromTs)) where.push(`l.ts >= ${add(Math.trunc(opts.fromTs))}`);
  if (typeof opts.toTs === "number" && Number.isFinite(opts.toTs)) where.push(`l.ts <= ${add(Math.trunc(opts.toTs))}`);
  // projectCwd가 없고 추가 조건도 없으면 기존 검색의 WHERE와 같다.
  const clauses = opts.projectCwd === undefined ? extra : [...extra, projectCwdClause(opts.projectCwd)];
  for (const clause of clauses) where.push(clause(add));
  const excludeId = opts.excludeSessionId?.trim();
  if (excludeId) {
    const cur = add(excludeId);
    where.push(
      `l.session_id <> ${cur} AND COALESCE(s.lineage_id, s.session_id) IS NOT COALESCE((SELECT x.lineage_id FROM session_letter_session x WHERE x.session_id = ${cur}), ${cur})`,
    );
  }
  const exact = `(instr(l.content_fold, ${add(foldCase(needle))}) > 0)`;
  const matchedExpr = `(${matched.join(" + ")})`;
  const order =
    opts.sort === "newest"
      ? `l.ts DESC, ${exact} DESC, ${scoreExpr} ASC, l.seq DESC, l.part DESC`
      : opts.sort === "oldest"
        ? `l.ts ASC, ${exact} DESC, ${scoreExpr} ASC, l.seq ASC, l.part ASC`
        : `${matchedExpr} DESC, ${exact} DESC, ${scoreExpr} ASC, l.ts DESC, l.seq DESC, l.part DESC`;
  const fts = add(ftsQuery);
  const limit = add(clamp(opts.limit, 20, 200));
  // 점수 표를 먼저 한 번 만든다. 하위 질의로 붙이면 행마다 FTS를 다시 돌아 열 배쯤 느리다.
  const sql = `WITH f AS MATERIALIZED (
      SELECT rowid AS id, bm25(session_letter_fts) AS score FROM session_letter_fts WHERE session_letter_fts MATCH ${fts}
    )
    SELECT l.session_id, l.seq, l.part, l.role, l.ts, l.content,
      s.display_name, s.cwd, s.model, s.created_at, s.lineage_id
    FROM session_letter l
    JOIN session_letter_session s ON s.session_id = l.session_id
    LEFT JOIN f ON f.id = l.id
    WHERE ${where.join(" AND ")}
    ORDER BY ${order}
    LIMIT ${limit}`;
  return { sql, params, needle };
}

/** 제어 문자를 공백으로 바꾼 뒤 구절과 낱말로 자른다. 두 글자 미만과 기호만 있는 것은 버린다. 구절은 모두 필요하고 낱말은 하나면 된다. */
function splitTerms(query: string): { phrases: string[]; words: string[] } {
  const cleaned = query.replace(/[\u0000-\u001f\u007f]/g, " ");
  const phrases: string[] = [];
  const words: string[] = [];
  const seen = new Set<string>();
  const push = (token: string, bucket: string[], dropOp: boolean) => {
    const trimmed = token.trim();
    if ([...trimmed].length < 2) return;
    // 글자나 숫자가 하나도 없는 기호 묶음은 거의 모든 코드 글에 들어 있어 버린다.
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return;
    if (dropOp && BOOL_OPS.has(trimmed.toUpperCase())) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (phrases.length + words.length >= MAX_TOKENS) return;
    seen.add(key);
    bucket.push(trimmed);
  };
  const rest = cleaned.replace(/"([^"]*)"/g, (_all, inner: string) => {
    push(inner, phrases, false);
    return " ";
  });
  for (const token of rest.replace(/"/g, " ").split(/\s+/)) push(token, words, true);
  return { phrases, words };
}

function needleOf(query: string): string {
  const cleaned = query.replace(/[\u0000-\u001f\u007f]/g, " ");
  const quoted = cleaned.match(/"([^"]+)"/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  return cleaned.trim();
}

function cleanRole(role: string | undefined): "user" | "assistant" | "tool" | undefined {
  if (role === "user" || role === "assistant" || role === "tool") return role;
  return undefined;
}

export function sanitizeDocs(docs: LetterDoc[]): LetterDoc[] {
  const byKey = new Map<string, LetterDoc>();
  for (const doc of docs) {
    if (!Number.isSafeInteger(doc.seq) || doc.seq <= 0) continue;
    if (!Number.isSafeInteger(doc.part) || doc.part < 0) continue;
    if (doc.part >= PART_SPAN) throw new Error("글자 조각이 범위 밖이다");
    if (!Number.isSafeInteger(doc.ts) || doc.ts < 0) continue;
    if (doc.role !== "user" && doc.role !== "assistant" && doc.role !== "assistant_interim" && doc.role !== "tool") continue;
    const cleaned = doc.content.replace(/\u0000/g, " ");
    const content = cleaned.length > MAX_INDEX_CHARS ? cleaned.slice(0, MAX_INDEX_CHARS) : cleaned;
    if (!content) continue;
    byKey.set(`${doc.seq}:${doc.part}`, { ...doc, content });
  }
  return [...byKey.values()];
}

function insertDocs(db: DatabaseSync, sessionId: string, docs: LetterDoc[]): void {
  const insert = db.prepare(INSERT_SQL);
  for (const doc of docs) insert.run(sessionId, doc.seq, doc.part, doc.role, doc.ts, doc.content, foldCase(doc.content));
}

function upsertMeta(db: DatabaseSync, sessionId: string, meta: LetterSessionMeta): void {
  const created =
    meta.createdAt !== null && Number.isSafeInteger(meta.createdAt) && meta.createdAt >= 0 ? meta.createdAt : null;
  db.prepare(
    `INSERT INTO session_letter_session (session_id, display_name, cwd, model, created_at, lineage_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       display_name = excluded.display_name,
       cwd = excluded.cwd,
       model = excluded.model,
       created_at = excluded.created_at,
       lineage_id = excluded.lineage_id`,
  ).run(sessionId, plainOrNull(meta.displayName), plainOrNull(meta.cwd), plainOrNull(meta.model), created, plainOrNull(meta.lineageId) ?? sessionId);
}

function plainOrNull(rawValue: string | null): string | null {
  if (!rawValue) return null;
  // 이름·폴더에 널 문자가 있으면 글과 마찬가지로 삽입이 거절되어 세션 전체가 실패한다.
  const value = rawValue.replace(/\u0000/g, " ");
  return value || null;
}

function mapHit(row: SqlHit, needle: string): LetterSearchHit {
  const seq = asInt(row.seq);
  const part = asInt(row.part);
  return {
    id: letterDocId(seq, part),
    sessionId: row.session_id,
    seq,
    part,
    role: row.role,
    ts: asInt(row.ts),
    snippet: makeSnippet(row.content, needle),
    session: {
      displayName: row.display_name,
      cwd: row.cwd,
      model: row.model,
      createdAt: asIntOrNull(row.created_at),
      lineageId: row.lineage_id,
    },
  };
}

function mapCtx(row: SqlCtx): LetterCtxRow {
  const seq = asInt(row.seq);
  const part = asInt(row.part);
  return { id: letterDocId(seq, part), seq, part, role: row.role, ts: asInt(row.ts), content: row.content };
}

function makeSnippet(content: string, needle: string): string {
  const lower = content.toLowerCase();
  const candidates = [needle.trim(), ...needle.trim().split(/\s+/)].filter((token) => token.length >= 2);
  let at = -1;
  let len = 0;
  for (const token of candidates) {
    const found = lower.indexOf(token.toLowerCase());
    if (found >= 0) {
      at = found;
      len = token.length;
      break;
    }
  }
  const start = at < 0 ? 0 : Math.max(0, at - 40);
  const end = at < 0 ? Math.min(content.length, 120) : Math.min(content.length, at + len + 80);
  let slice = content.slice(start, end);
  if (at >= 0) {
    const local = at - start;
    slice = slice.slice(0, local) + HL_OPEN + slice.slice(local, local + len) + HL_CLOSE + slice.slice(local + len);
  }
  if (start > 0) slice = `…${slice}`;
  if (end < content.length) slice = `${slice}…`;
  return slice;
}

function idExpr(): string {
  return `(seq * ${PART_SPAN} + part)`;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function asInt(value: number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("글자 좌표를 읽지 못했다");
  return n;
}

function asIntOrNull(value: number | bigint | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function assertOpen(): void {
  if (!sessionLetterReady()) throw new Error("세션 글자 색인이 열려 있지 않다");
}

function assertSessionId(id: string): void {
  if (!id || id !== id.trim()) throw new Error("세션 id가 비어 있다");
}
