/**
 * 일회용: 이미 지운 세션의 사건 원본을 정리한다. 검색 글자는 지우지 않고, 모자라면 원본에서 채운 뒤에만 원본을 지운다.
 * 사용: npm run db:purge-deleted                         (미리 보기. 읽기 전용이라 서버가 떠 있어도 된다)
 *       npm run db:purge-deleted -- --apply --backup <백업 파일> --expect-fingerprint <미리 보기가 출력한 지문>
 * 대상은 세션 폴더가 없고, 원본에서 만든 검색 글자(사용자 말·답변·도구 줄 수)가 저장된 글자와 같거나 채워서 같게 만들 수 있는 세션뿐이다.
 * 글자를 채울 수 없거나 색인할 내용이 없는 세션은 원본을 남기고 이유를 알린다.
 * --apply는 서버가 떠 있으면 거부한다(서버 잠금). 경로는 서버 설정(AETHER_DATA_DIR, AETHER_DB_PATH)만 따른다.
 * 되돌리기는 백업 복원(server/db/restore.ts의 복원 예약)이다.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config";
import { acquireServerLock } from "../db/serverLock";
import type { LetterSessionMeta } from "../db/sessionLetter";
import { deleteSessionRows, iterateSessionRows } from "../db/sessionEvents";
import { openDatabaseAt, transaction } from "../db/sqlite";
import { applyRecover, checkLetters, detectCodec, type LetterCheck, type RoleCounts, type RowSource } from "../search/letterBuild";

type Row = { id: string; name: string; rows: number; bytes: number; lastTs: number; firstUser: string };
type Target = Row & { check: LetterCheck & { state: "match" | "recover" }; provider: string };
type Kept = Row & { reason: string };

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
const RECENT_MS = 7 * 24 * 3600_000;
const when = (ts: number) => (ts > 0 ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "-");
/** 대상 세션 id 목록의 지문. 미리 보기와 한 개라도 다르면 지문이 달라진다. */
const fingerprint = (ids: string[]) => createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16);
const fmt = (c: RoleCounts) => `사용자 ${c.user}/답변 ${c.assistant}/도구 ${c.tool}`;

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? "") : undefined;
}

function firstText(line: string | null): string {
  try {
    const text = (JSON.parse(line ?? "") as { text?: unknown }).text;
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  } catch {
    return "";
  }
}

/** 사건이 있는 세션을 폴더 유무와 글자 일치로 나눈다. DB에는 쓰지 않는다. */
function plan(db: DatabaseSync): { targets: Target[]; alive: number; kept: Kept[] } {
  const sessions = db
    .prepare(
      `SELECT e.session_id AS id, count(*) AS rows, sum(e.byte_length) AS bytes,
              max(e.ts) AS last_ts,
              (SELECT display_name FROM session_letter_session s WHERE s.session_id = e.session_id) AS name,
              (SELECT line_text FROM session_event u WHERE u.session_id = e.session_id AND u.kind = 'user_msg' ORDER BY u.byte_offset LIMIT 1) AS first_line
         FROM session_event e GROUP BY e.session_id ORDER BY bytes DESC`,
    )
    .all() as { id: string; rows: number | bigint; bytes: number | bigint; last_ts: number | bigint; name: string | null; first_line: string | null }[];
  const out = { targets: [] as Target[], alive: 0, kept: [] as Kept[] };
  for (const s of sessions) {
    const row: Row = { id: s.id, name: s.name ?? "", rows: Number(s.rows), bytes: Number(s.bytes), lastTs: Number(s.last_ts), firstUser: firstText(s.first_line) };
    if (fs.existsSync(path.join(config.dataDir, s.id))) {
      out.alive++;
      continue;
    }
    const source: RowSource = (visit) => iterateSessionRows(db, s.id, (r) => visit({ seq: r.seq, ts: r.ts, line: r.line }));
    const codec = detectCodec(source);
    const check = checkLetters(db, s.id, source, codec);
    if (check.state === "keep") out.kept.push({ ...row, reason: check.reason });
    else if (check.want.user + check.want.assistant + check.want.tool === 0) out.kept.push({ ...row, reason: "색인할 내용이 없다" });
    else out.targets.push({ ...row, check, provider: codec.provider });
  }
  return out;
}

/** 백업이 열리고 무결성이 ok이며, 모든 세션의 사건 행이 지금 이상 들어 있어야 한다(살아 있는 세션 포함). */
function checkBackup(file: string, db: DatabaseSync): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`백업 파일이 없다: ${file}`);
  if (path.resolve(file) === path.resolve(config.dbPath)) throw new Error("백업 파일이 운영 DB 자신이다");
  const backup = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = backup.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error("백업 무결성 검사 실패");
    const count = backup.prepare("SELECT count(*) AS n FROM session_event WHERE session_id = ?");
    const now = db.prepare("SELECT session_id AS id, count(*) AS n FROM session_event GROUP BY session_id").all() as { id: string; n: number | bigint }[];
    for (const s of now) {
      const n = Number((count.get(s.id) as { n: number | bigint }).n);
      if (n < Number(s.n)) throw new Error(`백업에 사건이 모자란다: ${s.id} (백업 ${n}행, 지금 ${s.n}행)`);
    }
  } finally {
    backup.close();
  }
}

function existingMeta(db: DatabaseSync, id: string): LetterSessionMeta {
  const r = db.prepare("SELECT display_name, cwd, model, created_at, lineage_id FROM session_letter_session WHERE session_id = ?").get(id) as
    | { display_name: string | null; cwd: string | null; model: string | null; created_at: number | bigint | null; lineage_id: string | null }
    | undefined;
  return { displayName: r?.display_name ?? null, cwd: r?.cwd ?? null, model: r?.model ?? null, createdAt: r?.created_at == null ? null : Number(r.created_at), lineageId: r?.lineage_id || id };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const backup = flag("--backup");
  const expect = flag("--expect-fingerprint");
  if (apply && !backup) throw new Error("--apply에는 --backup <백업 파일>이 필요하다");
  if (apply && !expect) throw new Error("--apply에는 --expect-fingerprint <미리 보기가 출력한 지문>이 필요하다");
  if (!fs.existsSync(config.dbPath)) throw new Error(`DB 파일이 없다: ${config.dbPath}`);
  if (!fs.existsSync(config.dataDir) || !fs.statSync(config.dataDir).isDirectory()) throw new Error(`세션 데이터 폴더가 없다: ${config.dataDir}`);
  // 미리 보기는 읽기 전용이라 서버가 떠 있어도 된다. 지우는 쪽만 서버 잠금을 잡는다.
  if (apply) await acquireServerLock(config.dbPath, 0);

  const db = apply ? openDatabaseAt(config.dbPath) : new DatabaseSync(config.dbPath, { readOnly: true });
  const { targets, alive, kept } = plan(db);
  // 데이터 폴더를 잘못 가리키면 살아 있는 세션이 지운 것으로 보여 원본이 지워진다.
  if (alive === 0) throw new Error(`데이터 폴더에서 살아 있는 세션을 하나도 찾지 못했다. 경로를 확인하라: ${config.dataDir}`);
  const rows = targets.reduce((a, t) => a + t.rows, 0);
  const bytes = targets.reduce((a, t) => a + t.bytes, 0);
  const recover = targets.filter((t) => t.check.state === "recover");
  console.log(`DB: ${config.dbPath} (${mb(fs.statSync(config.dbPath).size)})  데이터 폴더: ${config.dataDir}`);
  console.log(`대상 세션 ${targets.length}개, 사건 ${rows}행, ${mb(bytes)} (글자 채우기 ${recover.length}개)`);
  const print = fingerprint(targets.map((t) => t.id));
  console.log(`대상 지문: ${print}`);
  let recent = 0;
  for (const t of targets) {
    const c = t.check;
    const state = c.state === "recover" ? `채우기 ${c.missing}행` : "일치";
    const warn = Date.now() - t.lastTs < RECENT_MS ? "  [경고: 최근 7일 안에 활동]" : "";
    if (warn) recent++;
    console.log(`  ${t.id}  ${t.provider}  마지막 ${when(t.lastTs)}  ${t.rows}행  ${mb(t.bytes)}  글자 ${state}(${fmt(c.want)}, 저장에만 있는 글 ${c.extra}행, 정제 전 도구 글 ${c.unrefined}행)  "${t.firstUser}"${warn}`);
  }
  if (recent > 0) console.log(`경고: 최근 7일 안에 활동한 대상이 ${recent}개 있다. 폴더가 잠깐 안 보인 것은 아닌지 확인하라.`);
  console.log(`빠지는 세션: 살아 있는 세션 ${alive}개, 원본을 남기는 지운 세션 ${kept.length}개`);
  for (const k of kept) console.log(`  ${k.id}  마지막 ${when(k.lastTs)}  ${k.rows}행  ${mb(k.bytes)}  남김: ${k.reason}  "${k.firstUser}"`);
  if (!apply) {
    console.log(`미리 보기만 했다. 지우려면 --apply --backup <백업 파일> --expect-fingerprint ${print}을 붙인다.`);
    db.close();
    return;
  }

  if (expect !== print) throw new Error(`대상이 미리 보기와 다르다: 기대 지문 ${expect}, 지금 ${print}. 미리 보기를 다시 확인하라`);
  checkBackup(path.resolve(backup!), db);
  const before = fs.statSync(config.dbPath).size;
  const free = fs.statfsSync(path.dirname(config.dbPath));
  if (free.bavail * free.bsize < before) throw new Error(`빈 디스크 공간이 DB 크기(${mb(before)})보다 작다`);
  const lettersBefore = Number((db.prepare("SELECT count(*) AS n FROM session_letter").get() as { n: number | bigint }).n);
  // 글자를 먼저 채운다(추가만 한다). 채운 뒤 다시 세어 같지 않으면 그 세션의 원본은 남긴다.
  const okIds = new Set<string>();
  for (const t of targets) {
    if (t.check.state === "match" || applyRecover(db, t.id, t.check, existingMeta(db, t.id))) okIds.add(t.id);
    else console.error(`글자를 채운 뒤 검증에 실패해 원본을 남긴다: ${t.id}`);
  }
  let deleted = 0;
  transaction(db, () => {
    for (const t of targets) if (okIds.has(t.id)) deleted += deleteSessionRows(db, t.id);
  });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  const lettersAfter = Number((db.prepare("SELECT count(*) AS n FROM session_letter").get() as { n: number | bigint }).n);
  if (lettersAfter < lettersBefore) throw new Error(`검색 글자 행 수가 줄었다: ${lettersBefore} -> ${lettersAfter}`);
  db.close();
  console.log(`글자를 채운 세션 ${recover.length}개. 지운 사건 ${deleted}행. DB ${mb(before)} -> ${mb(fs.statSync(config.dbPath).size)}. 검색 글자 ${lettersBefore}행 -> ${lettersAfter}행.`);
}

main().catch((err) => {
  console.error("[purge-deleted] 실패:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
