/**
 * 오류 기록 조회 HTTP 시험(GET /api/errors, GET /api/errors/:fingerprint).
 * 라이브 DB를 열지 않도록 데이터 폴더를 임시로 덮어쓰고 DB 경로도 임시 파일에 고정한다.
 * 정적 import는 아래 환경 설정보다 먼저 실행되므로 나머지 모듈은 동적 import로 부른다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-errlog-data-'));
process.env.AETHER_DATA_DIR = dataDir;
delete process.env.AETHER_DB_PATH;
const JWT_MARK = 'jwt-secret-mark-7f3a';
const HASH_MARK = 'password-hash-mark-91bc';
process.env.AETHER_JWT_SECRET = JWT_MARK;
process.env.AETHER_PASSWORD_HASH = HASH_MARK;

const { default: express } = await import('express');
const { useTempDatabase } = await import('./support/tempDb');
const { databasePath, configureDatabase } = await import('../db/sqlite');
const { SqliteErrorSink } = await import('../observability/database');
const { makeErrorEvent } = await import('../observability/event');
const { errorsRouter, errorRequestContext } = await import('../observability/http');
const { createAuthMiddleware } = await import('../middleware/auth');

const temp = useTempDatabase('errorlog');
assert.equal(databasePath(), temp.file, '시험 DB는 임시 파일이어야 한다');
assert.ok(temp.file.startsWith(os.tmpdir()), '라이브 DB 경로가 아니다');

const sink = new SqliteErrorSink(temp.file);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 3_600_000, D = 86_400_000;
async function put(operation: string, opts: { at: string; message: string; source?: string; session?: string; context?: Record<string, unknown> }) {
  const err = new Error(opts.message);
  await sink.write([makeErrorEvent(err, {
    component: 'session', operation, occurred_at: opts.at, source: opts.source ?? 'server', session_id: opts.session, context: opts.context,
  }, 'test')]);
}

// 묶음 A: 24시간 안 2건 + 3일 전 1건(메시지가 서로 다름), 묶음 B: 웹 출처 1시간 전 1건.
await put('opA', { at: ago(3 * D), message: '옛 A', session: 's-old' });
await put('opA', { at: ago(2 * H), message: 'A 중간', session: 's-1' });
await put('opA', { at: ago(1 * H), message: 'A 최근 ' + 'x'.repeat(600), session: 's-2', context: { key: 'value' } });
// 같은 밀리초면 지문 순서로 정렬이 뒤집히므로 B를 1초 더 최근으로 둔다.
await put('opB', { at: ago(1 * H - 1000), message: 'B 웹', source: 'web' });

const app = express();
app.use(errorRequestContext);
app.use('/api/errors', createAuthMiddleware({ authenticate: async req => req.get('authorization') === 'test' ? { login: 'test', via: 'off' } : null }), errorsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(r => server.on('listening', r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const bodies: string[] = [];
const get = async (p: string, auth = true) => {
  const res = await fetch(url + p, { headers: auth ? { authorization: 'test' } : {} });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

try {
  // 1. 인증
  assert.equal((await get('/api/errors', false)).status, 401);
  assert.equal((await get('/api/errors/' + 'a'.repeat(64), false)).status, 401);

  // 3. 묶음
  const list = (await get('/api/errors')).json;
  assert.equal(list.groups.length, 2);
  const [first, second] = list.groups;
  assert.equal(first.count, 1); assert.equal(second.count, 2);
  assert.equal(list.total, 3);
  assert.ok(first.lastAt >= second.lastAt || first.lastAt === second.lastAt, '최근 것이 먼저');
  const a = list.groups.find((g: { operation: string }) => g.operation === 'opA');
  const b = list.groups.find((g: { operation: string }) => g.operation === 'opB');
  assert.equal(a.count, 2); assert.equal(b.count, 1);
  assert.ok(a.message.startsWith('A 최근'), '묶음 메시지는 가장 최근 행 것');
  assert.equal(b.source, 'web');
  assert.equal((await get('/api/errors?since=7d')).json.groups.find((g: { operation: string }) => g.operation === 'opA').count, 3);
  assert.equal((await get('/api/errors?since=all')).json.total, 4);
  const web = (await get('/api/errors?source=web')).json;
  assert.deepEqual(web.groups.map((g: { operation: string }) => g.operation), ['opB']);
  const srv = (await get('/api/errors?source=server')).json;
  assert.deepEqual(srv.groups.map((g: { operation: string }) => g.operation), ['opA']);

  // 5. 목록 메시지 500자 제한, 상세는 원문
  assert.equal(a.message.length, 500);
  const detail = (await get('/api/errors/' + a.fingerprint)).json;
  assert.ok(detail.latest.message.length > 600);

  // 6. 상세
  assert.equal(detail.count, 2);
  assert.ok(detail.firstAt < detail.lastAt);
  assert.deepEqual(detail.sessionIds, ['s-2', 's-1']);
  assert.deepEqual(detail.latest.context.key, 'value');
  assert.ok(typeof detail.latest.stack === 'string');
  assert.equal((await get(`/api/errors/${a.fingerprint}?since=7d`)).json.count, 3);
  assert.equal((await get('/api/errors/' + 'b'.repeat(64))).status, 404);

  // 8. 응답 열 목록
  assert.deepEqual(Object.keys(a).sort(), ['component', 'count', 'fingerprint', 'lastAt', 'message', 'operation', 'source']);
  assert.deepEqual(Object.keys(detail).sort(), ['count', 'fingerprint', 'firstAt', 'lastAt', 'latest', 'sessionIds']);
  assert.deepEqual(Object.keys(detail.latest).sort(), [
    'code', 'component', 'context', 'id', 'message', 'model', 'occurred_at', 'operation', 'provider',
    'release', 'request_id', 'session_id', 'severity', 'source', 'stack',
  ]);

  // 2. 잘못된 질의
  for (const q of ['since=1h', 'source=bogus', 'since=24h&since=7d', 'cursor=garbage']) {
    assert.equal((await get('/api/errors?' + q)).status, 400, q);
  }
  assert.equal((await get('/api/errors/xyz')).status, 400);
  assert.equal((await get(`/api/errors/${a.fingerprint}?cursor=x`)).status, 200, '상세는 cursor를 읽지 않는다');


  // 4. 쪽 나누기
  for (let i = 0; i < 120; i++) await put(`bulk${i}`, { at: ago(10_000 + i), message: `대량 ${i}` });
  // 마지막 시각이 같은 묶음 60개: 50개 경계가 이 안에 걸려 지문 순서 커서 분기를 탄다.
  const tieAt = ago(5_000);
  for (let i = 0; i < 60; i++) await put(`tie${i}`, { at: tieAt, message: `동시 ${i}` });
  const seen = new Set<string>();
  let cursor = '';
  const sizes: number[] = [];
  for (let page = 0; page < 5; page++) {
    const r = (await get('/api/errors?since=all&source=server' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''))).json;
    sizes.push(r.groups.length);
    for (const g of r.groups) seen.add(g.fingerprint);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  assert.deepEqual(sizes, [50, 50, 50, 31], '묶음 181개(opA 포함)가 50·50·50·31로 나뉜다');
  assert.equal(seen.size, 181, '중복·누락 없음');

  // 8. 비밀값
  for (const text of bodies) {
    assert.ok(!text.includes(JWT_MARK) && !text.includes(HASH_MARK), '응답에 비밀값이 없다');
  }

  // 9. DB 없음
  configureDatabase({ path: null });
  assert.equal((await get('/api/errors')).status, 503);
  console.log('✅ 오류 기록 조회: 인증·검증·묶음·쪽 나누기·상세·열 목록·DB 없음');
} finally {
  await new Promise<void>(r => server.close(() => r()));
  temp.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
