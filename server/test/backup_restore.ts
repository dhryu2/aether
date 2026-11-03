/**
 * DB 백업·복원 시험(GET/POST /api/system/backups, 복원 예약과 적용).
 * 데이터 폴더를 임시로 덮어써 운영 DB(server/data)를 열지 않는다. 정적 import는 환경 설정보다 먼저 실행되므로 동적 import를 쓴다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-backup-data-'));
process.env.AETHER_DATA_DIR = dataDir;
process.env.AETHER_BACKUP_KEEP = '2';
delete process.env.AETHER_DB_PATH;
delete process.env.AETHER_BACKUP_DIR;

const { default: express } = await import('express');
const { config } = await import('../config');
const { configureDatabase, database, closeDatabases } = await import('../db/sqlite');
const { createBackup, listBackups, BackupBusyError } = await import('../db/backups');
const { applyPendingRestore, scheduleRestore, cancelRestore, restoreStatus } = await import('../db/restore');
const { systemRouter } = await import('../routes/system');

assert.ok(config.dbPath.startsWith(os.tmpdir()) && config.backupDir.startsWith(os.tmpdir()), '운영 경로가 아니다');
configureDatabase({ path: config.dbPath });
const dbPath = config.dbPath;
const dir = config.backupDir;
const db = () => database();
let seqNo = 0;
const addRow = (session = 's1') => db().prepare(
  "INSERT INTO session_event (session_id, seq, ts, kind, byte_offset, byte_length, line_text) VALUES (?, ?, 0, 'x', ?, 1, 'x')",
).run(session, ++seqNo, seqNo);
const count = (file: string) => {
  const c = new DatabaseSync(file, { readOnly: true });
  try { return (c.prepare('SELECT count(*) AS n FROM session_event').get() as { n: number }).n; } finally { c.close(); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// 이름이 초 단위 시각이라 같은 초에 두 번 만들면 겹친다.
const nextSecond = () => sleep(1100);

const app = express();
app.use(express.json());
app.use('/api/system', systemRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(r => server.on('listening', r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system`;
const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const snapshot = (d: string) => JSON.stringify(fs.readdirSync(d).sort());

try {
  // 1. 기본 백업
  addRow(); addRow();
  const made = await call('POST', '/backups');
  assert.equal(made.status, 201);
  const first = made.json.item;
  assert.equal(first.kind, 'manual');
  assert.equal(count(path.join(dir, first.id)), 2, '행이 들어 있다');
  const chk = new DatabaseSync(path.join(dir, first.id), { readOnly: true });
  assert.equal((chk.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  chk.close();
  assert.ok(!fs.readdirSync(dir).some(n => n.endsWith('.partial')), '.partial 없음');
  assert.equal((await call('GET', '/backups')).json.items.length, 1);

  // 2. 백업 도중 같은 연결의 쓰기
  await nextSecond();
  const during = createBackup(db(), { dir, kind: 'manual', keep: 2 });
  addRow();
  const writeDuring = await during;
  assert.ok(writeDuring.id);

  // 3. 동시 백업
  await nextSecond();
  db().exec('CREATE TABLE IF NOT EXISTS junk (b BLOB)'); // 백업이 한참 걸리도록 부피를 만든다
  db().exec('INSERT INTO junk VALUES (zeroblob(60000000))');
  const a = createBackup(db(), { dir, kind: 'manual', keep: 2 });
  await assert.rejects(createBackup(db(), { dir, kind: 'manual' }), BackupBusyError);
  assert.equal((await call('POST', '/backups')).status, 409);
  await a;
  db().exec('DROP TABLE junk');

  // 4. 보관 정리: 수동 4 + 복원 전 2 + 사람 파일
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-backup-clean-'));
  const human = path.join(cleanDir, 'aether-before-test-cleanup-20261030.sqlite');
  fs.writeFileSync(human, 'x'); fs.mkdirSync(path.join(cleanDir, 'test-junk-20261030'));
  for (const n of ['aether-20260101T000000Z', 'aether-20260102T000000Z', 'aether-20260103T000000Z', 'aether-before-restore-20260101T000000Z', 'aether-before-restore-20260102T000000Z']) fs.writeFileSync(path.join(cleanDir, n + '.sqlite'), 'x');
  await createBackup(db(), { dir: cleanDir, kind: 'manual', keep: 2 });
  const left = listBackups(cleanDir);
  assert.equal(left.filter(b => b.kind === 'manual').length, 2);
  assert.equal(left.filter(b => b.kind === 'beforeRestore').length, 2, '복원 전 백업 유지');
  assert.ok(fs.existsSync(human) && fs.existsSync(path.join(cleanDir, 'test-junk-20261030')), '사람 파일 유지');
  assert.ok(!left.some(b => b.id.includes('cleanup')), '사람 파일 목록 제외');
  fs.rmSync(cleanDir, { recursive: true, force: true });

  // 5. 예약된 파일 보호
  const protDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-backup-prot-'));
  for (const n of ['aether-20260101T000000Z', 'aether-20260102T000000Z', 'aether-20260103T000000Z']) fs.writeFileSync(path.join(protDir, n + '.sqlite'), 'x');
  await createBackup(db(), { dir: protDir, kind: 'manual', keep: 1, protectId: 'aether-20260101T000000Z.sqlite' });
  assert.ok(fs.existsSync(path.join(protDir, 'aether-20260101T000000Z.sqlite')), '예약된 백업은 지우지 않음');
  fs.rmSync(protDir, { recursive: true, force: true });

  // 6. 경로 주입
  const outside = path.join(dataDir, 'outside.txt');
  fs.writeFileSync(outside, 'keep');
  const before = snapshot(dataDir) + snapshot(dir);
  for (const id of ['../x.sqlite', '..\\aether-20261030T000000Z.sqlite', 'C:\\Windows\\aether-20261030T000000Z.sqlite', '/etc/passwd',
    'aether-20261030T000000Z.sqlite/../../a', 'aether-20261030T000000Z.sqlite\0', 123, '', null]) {
    const r = await call('POST', '/backups/restore', { id });
    assert.ok(r.status === 400 || r.status === 404, `거부: ${JSON.stringify(id)} -> ${r.status}`);
  }
  assert.equal((await call('POST', '/backups/restore', { id: 'aether-20261030T000000Z.sqlite' })).status, 404);
  assert.equal(snapshot(dataDir) + snapshot(dir), before, '폴더 밖 변화 없음');
  assert.equal(restoreStatus(dbPath).pending, null);

  // 7. 정상 복원: 백업 뒤 행 추가 -> 예약 -> 적용
  await nextSecond();
  const good = (await call('POST', '/backups')).json.item;
  const rowsAtBackup = count(path.join(dir, good.id));
  addRow(); addRow(); addRow();
  const rowsNow = count(dbPath);
  assert.equal((await call('POST', '/backups/restore', { id: good.id })).status, 200);
  assert.equal(restoreStatus(dbPath).pending?.id, good.id);
  await nextSecond();
  await applyPendingRestore({ dbPath, backupDir: dir });
  const st = restoreStatus(dbPath);
  assert.equal(st.pending, null);
  assert.equal(st.last?.ok, true);
  assert.ok(!fs.existsSync(dbPath + '-wal'), '-wal 없음');
  assert.equal(count(dbPath), rowsAtBackup, '백업 시점 내용');
  const safety = st.last!.safetyId!;
  assert.equal(count(path.join(dir, safety)), rowsNow, '복원 전 백업에 추가 행');
  assert.ok(!fs.existsSync(dbPath + '.restoring'));

  // 8. 손상 파일
  const bad = 'aether-20250101T000000Z.sqlite';
  fs.writeFileSync(path.join(dir, bad), 'not a database'.repeat(100));
  const nSafety = () => listBackups(dir).filter(b => b.kind === 'beforeRestore').length;
  const safetyBefore = nSafety(), rowsBefore = count(dbPath);
  scheduleRestore(dbPath, dir, bad);
  await applyPendingRestore({ dbPath, backupDir: dir });
  assert.equal(restoreStatus(dbPath).last?.code, 'corrupt');
  assert.equal(restoreStatus(dbPath).last?.ok, false);
  assert.equal(restoreStatus(dbPath).pending, null);
  assert.equal(nSafety(), safetyBefore, '복원 전 백업 안 만듦');
  assert.equal(count(dbPath), rowsBefore, '지금 DB 유지');

  // 9. Aether DB 아님
  const other = 'aether-20250102T000000Z.sqlite';
  const o = new DatabaseSync(path.join(dir, other)); o.exec('CREATE TABLE t (a)'); o.close();
  scheduleRestore(dbPath, dir, other);
  await applyPendingRestore({ dbPath, backupDir: dir });
  assert.equal(restoreStatus(dbPath).last?.code, 'corrupt');
  assert.equal(count(dbPath), rowsBefore);

  // 10. 파일 없음
  scheduleRestore(dbPath, dir, bad);
  fs.rmSync(path.join(dir, bad));
  await applyPendingRestore({ dbPath, backupDir: dir });
  assert.equal(restoreStatus(dbPath).last?.code, 'missing');

  // 11. 사용 중: 다른 연결이 열려 있으면 -wal이 남는다
  const keepOpen = new DatabaseSync(dbPath);
  keepOpen.exec('PRAGMA journal_mode = WAL');
  keepOpen.prepare('SELECT count(*) FROM session_event').get();
  scheduleRestore(dbPath, dir, good.id);
  await nextSecond();
  await applyPendingRestore({ dbPath, backupDir: dir });
  assert.equal(restoreStatus(dbPath).last?.code, 'inUse');
  const failSafety = restoreStatus(dbPath).last?.safetyId;
  assert.ok(failSafety && fs.existsSync(path.join(dir, failSafety)), '실패해도 복원 전 백업 id를 알린다');
  keepOpen.close();
  assert.equal(count(dbPath), rowsBefore, '내용 유지');
  assert.ok(!fs.existsSync(dbPath + '.restoring'));

  // 12. 중간에 죽은 흔적 삭제
  for (const s of ['.restoring', '.restoring-wal', '.restoring-shm']) fs.writeFileSync(dbPath + s, 'junk');
  await applyPendingRestore({ dbPath, backupDir: dir });
  for (const s of ['.restoring', '.restoring-wal', '.restoring-shm']) assert.ok(!fs.existsSync(dbPath + s), s + ' 삭제');

  // 12-1. 같은 초 이름 충돌: 덮어쓰지 않고 둘 다 남는다
  const sameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-backup-same-'));
  const x = await createBackup(db(), { dir: sameDir, kind: 'manual' });
  const y = await createBackup(db(), { dir: sameDir, kind: 'manual' });
  assert.notEqual(x.id, y.id);
  assert.equal(listBackups(sameDir).length, 2);

  // 12-2. 오래된 .partial만 정리한다
  const oldP = path.join(sameDir, 'aether-20260101T000000Z.sqlite.999.partial');
  const newP = path.join(sameDir, 'aether-20260102T000000Z.sqlite.998.partial');
  fs.writeFileSync(oldP, 'x'); fs.writeFileSync(newP, 'x');
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(oldP, old, old);
  await createBackup(db(), { dir: sameDir, kind: 'manual', keep: 5 });
  assert.ok(!fs.existsSync(oldP), '1시간 넘은 .partial 삭제');
  assert.ok(fs.existsSync(newP), '최근 .partial 유지');
  fs.rmSync(sameDir, { recursive: true, force: true });

  // 12-3. CLI 정리가 예약된 백업을 지우지 않는다
  const cliData = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-backup-cli-'));
  const cliDb = path.join(cliData, 'aether.sqlite');
  const cliDir = path.join(cliData, 'backups');
  fs.mkdirSync(cliDir);
  new DatabaseSync(cliDb).close();
  for (const n of ['aether-20260101T000000Z', 'aether-20260102T000000Z']) fs.writeFileSync(path.join(cliDir, n + '.sqlite'), 'x');
  fs.writeFileSync(cliDb + '.restore-pending.json', JSON.stringify({ id: 'aether-20260101T000000Z.sqlite', requestedAt: 'x' }));
  const cli = spawnSync('npx', ['tsx', 'db/backup.ts'], { env: { ...process.env, AETHER_DATA_DIR: cliData, AETHER_BACKUP_KEEP: '1' }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(fs.existsSync(path.join(cliDir, 'aether-20260101T000000Z.sqlite')), 'CLI도 예약된 백업을 지우지 않음');
  fs.rmSync(cliData, { recursive: true, force: true });

  // 13. 예약 취소
  scheduleRestore(dbPath, dir, good.id);
  assert.equal((await call('DELETE', '/backups/restore')).json.pending, null);
  cancelRestore(dbPath);
  assert.equal(restoreStatus(dbPath).pending, null);

  console.log('backup_restore: 모두 통과');
} finally {
  server.close();
  closeDatabases();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
