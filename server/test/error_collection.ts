import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ErrorJournal } from '../observability/journal';
import { makeErrorEvent, isExpectedError } from '../observability/event';
import { reportError, setErrorJournal } from '../observability/report';
import type { ErrorSink } from '../observability/database';
import type { ErrorEvent } from '../../shared/errors';
class Sink implements ErrorSink {
  rows = new Map<string, ErrorEvent>(); fail = false; bad = ''; batches: number[] = [];
  async write(events: ErrorEvent[]) {
    this.batches.push(events.length);
    if (this.fail) throw new Error('test DB unavailable');
    const ok = new Set<string>();
    for (const e of events) if (e.id !== this.bad) { this.rows.set(e.id, e); ok.add(e.id); }
    return ok;
  }
  async prune() {}
}
const dirs: string[] = [];
async function dir() { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-errors-test-')); dirs.push(d); return d; }
const details = { component: 'test', operation: 'test.failure' };
const files = async (d: string) => (await fs.readdir(d)).filter(n => n.endsWith('.jsonl'));
const count = async (j: ErrorJournal) => (await j.status()).pending;
async function drain(j: ErrorJournal) { for (let i = 0; i < 20 && await j.deliver(); i++); }
try {
  assert(isExpectedError(Object.assign(new Error('cancel'), { name: 'AbortError' })));
  assert(!isExpectedError({ status: 403 })); assert(!isExpectedError({ status: 400 }));
  assert(isExpectedError({ errorOrigin: 'external_environment' }));
  assert(isExpectedError({ errorOrigin: 'user_action' }));
  assert(!isExpectedError({ errorOrigin: 'aether_defect', status: 400 }));
  assert.equal(makeErrorEvent('기능 축소', { ...details, severity: 'warning' }, 'test').severity, 'warning'); assert(!isExpectedError({ status: 500 }));
  const a = makeErrorEvent(new Error('request 1'), details, 'test'), b = makeErrorEvent(new Error('request 2'), details, 'test');
  assert.notEqual(a.id, b.id);
  const circular: Record<string, unknown> = { big: 1n }; circular.self = circular;
  assert.deepEqual(makeErrorEvent('json', { ...details, context: circular }, 'test').context, { big: '1', self: '[Circular]' });
  assert.equal(makeErrorEvent('one', details, 'test').fingerprint, makeErrorEvent('two', details, 'test').fingerprint);
  // 순환 cause도 유한하게 직렬화하며 원인 Error의 임의 필드는 가져오지 않는다.
  const root = Object.assign(new Error('원래 위치'), {code:'EIO',requestBody:'자동 수집 금지'});
  const wrapped = new Error('기존 표시 문구', {cause:root}); root.cause=wrapped;
  const caused = makeErrorEvent(wrapped, {...details,context:{attempt:1}}, 'test');
  assert.deepEqual(caused.context, {attempt:1,causes:[{message:root.message,stack:root.stack,code:'EIO'}]});
  const d = await dir(), sink = new Sink(), j = new ErrorJournal({ directory: d, sink });
  setErrorJournal(j);
  const error = new Error('원문\u0000보존');
  const [r1, r2] = await Promise.all([reportError(error, details), reportError(error, details)]);
  assert.equal(r1.id, r2.id); assert(r1.durable); assert.equal(await count(j), 1);
  sink.fail = true;
  await j.deliver(); await j.deliver(); await j.deliver();
  assert.equal(await count(j), 2, '기능 오류 1건 + 전달 장애 최초 1건');
  const r3 = await j.record(new Error('장애 중 두 번째 기능 오류'), details); assert(r3.durable);
  sink.fail = false; await drain(j);
  assert.equal(sink.rows.get(r1.id)?.message, error.message);
  assert.equal(await count(j), 0);
  assert.equal([...sink.rows.values()].filter(e => e.operation === 'delivery.failed').length, 1);
  assert.equal([...sink.rows.values()].filter(e => e.operation === 'delivery.recovered').length, 1);
  assert.equal([...sink.rows.values()].find(e => e.operation === 'delivery.recovered')?.severity, 'warning');
  await j.close(); setErrorJournal(undefined);

  const crashDir = await dir(), crashSink = new Sink(); let crash = true;
  const jc = new ErrorJournal({ directory: crashDir, sink: crashSink, afterCommit: () => { if (crash) throw new Error('crash after commit'); } });
  const cr = await jc.record(new Error('commit 시험'), details); await jc.deliver();
  assert(crashSink.rows.has(cr.id)); assert((await count(jc)) >= 1);
  crash = false; await drain(jc); assert.equal([...crashSink.rows.keys()].filter(id => id === cr.id).length, 1);
  await jc.close();
  await fs.writeFile(path.join(crashDir, 'delivery-state.json'), '{broken');
  const recovered = new ErrorJournal({ directory: crashDir, sink: crashSink }); await drain(recovered);
  assert.equal(await count(recovered), 0); await recovered.close();

  const brokenDir = await dir(), brokenSink = new Sink();
  const event = makeErrorEvent('정상', details, 'test'), bad = makeErrorEvent('행 거절', details, 'test'); brokenSink.bad = bad.id;
  await fs.writeFile(path.join(brokenDir, `events-2026-10-16-0-${randomUUID()}.jsonl`), JSON.stringify(bad)+'\n{broken}\n'+JSON.stringify(event)+'\n{"partial"');
  const jb = new ErrorJournal({ directory: brokenDir, sink: brokenSink }); await drain(jb);
  assert(brokenSink.rows.has(event.id)); assert.equal(await count(jb), 1);
  assert.equal((await jb.status()).undeliverable, 2);
  brokenSink.bad = ''; await jb.deliver(); assert.equal(await count(jb), 0); await jb.close();

  const failureDir = await dir(), direct = new Sink(); await fs.writeFile(path.join(failureDir, 'not-directory'), 'x');
  const jf = new ErrorJournal({ directory: path.join(failureDir, 'not-directory'), sink: direct });
  const fallback = await jf.record(new Error('파일 저장 실패'), details);
  assert(!fallback.durable); assert(fallback.recorded); assert(direct.rows.has(fallback.id));

  let now = Date.parse('2026-10-16T14:59:59Z'); const rotateDir = await dir();
  const jr = new ErrorJournal({ directory: rotateDir, now: () => now, fileBytes: 1200 });
  await jr.record('가'.repeat(250), details); await jr.record('나'.repeat(250), details);
  assert.equal((await files(rotateDir)).length, 2);
  now += 2000; await jr.record('자정', details); assert((await files(rotateDir)).some(n => n.startsWith('events-2026-10-17')));
  await jr.close();
  now += 30 * 86_400_000;
  const retention = new ErrorJournal({ directory: rotateDir, now: () => now }); await retention.cleanup();
  assert.equal((await files(rotateDir)).length, 0); assert.equal((await retention.status()).lost.count, 3); await retention.close();

  const deliveredDir = await dir(); const deliveredSink = new Sink(); now = Date.now();
  const jd = new ErrorJournal({ directory: deliveredDir, now: () => now, sink: deliveredSink });
  await jd.record('전달 완료', details); await drain(jd); await jd.close();
  now += 14 * 86_400_000;
  const jd2 = new ErrorJournal({ directory: deliveredDir, now: () => now }); await jd2.cleanup();
  assert.equal((await files(deliveredDir)).length, 0); assert.equal((await jd2.status()).lost.count, 0); await jd2.close();

  const concurrentDir = await dir(), sharedSink = new Sink();
  const ja = new ErrorJournal({ directory: concurrentDir, sink: sharedSink }), jz = new ErrorJournal({ directory: concurrentDir, sink: sharedSink });
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? ja : jz).record(`parallel ${i}`, details)));
  assert.equal(await count(ja), 30); await Promise.all([drain(ja), drain(jz)]);
  assert.equal(sharedSink.rows.size, 30); assert(sharedSink.batches.every(n => n <= 100));
  for (let i = 0; i < 205; i++) await ja.record('batch ' + i, details);
  const beforeBatch = sharedSink.batches.length;
  await drain(ja);
  assert.equal(sharedSink.rows.size, 235);
  assert.deepEqual(sharedSink.batches.slice(beforeBatch), [100,100,5]);
  await ja.close(); await jz.close();

  const capDir = await dir(), capSink = new Sink();
  const capWrite = new ErrorJournal({ directory: capDir, sink: capSink, fileBytes: 1500 });
  for (let i=0;i<8;i++) await capWrite.record('x'.repeat(700), details);
  await capWrite.deliver(); await capWrite.close();
  const capPending = new ErrorJournal({ directory: capDir, fileBytes: 1500 });
  for (let i=0;i<8;i++) await capPending.record('y'.repeat(700), details);
  await capPending.close();
  const capped = new ErrorJournal({ directory: capDir, maxBytes: 12_000 }); await capped.cleanup();
  assert((await capped.status()).lost.count > 0);
  let size = 0; for(const n of await fs.readdir(capDir)) size += (await fs.stat(path.join(capDir,n))).size;
  assert(size <= 12_000); await capped.close();
  console.log('✅ 오류 분류·중복·장애복구·commit 재전송·손상행·파일폴백·회전·보존·용량·동시기록');
} finally { setErrorJournal(undefined); for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); }

// 파일 접근과 전달 소유권의 실패 주입 시험. 기존 수집 시험과 같은 진입점에서 실행한다.
{
const details = { component: 'test', operation: 'stability' };
const sink = { async write(events: {id: string}[]) { return new Set(events.map(e => e.id)); }, async prune() {} };
const names = async (directory: string) => (await fs.readdir(directory)).filter(n => n.endsWith('.jsonl')).sort();
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'aether-error-stability-'));

await test('1MiB 초과 이벤트 뒤에도 정상 파일을 유지한다', async () => {
  const dir = await directory(), journal = new ErrorJournal({ directory: dir, sink });
  try {
    await journal.record('첫 기록', details);
    const before = await names(dir);
    assert.equal((await journal.record('x'.repeat(1024 * 1024), details)).durable, false);
    await journal.record('큰 오류 뒤 기록', details);
    assert.deepEqual(await names(dir), before);
  } finally { await journal.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

await test('잠금 대기 초과 뒤에도 정상 파일을 유지한다', async () => {
  const dir = await directory(), journal = new ErrorJournal({ directory: dir, sink });
  try {
    await journal.record('첫 기록', details);
    const before = await names(dir);
    const lock = new DatabaseSync(path.join(dir, 'coordination.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    try { assert.equal((await journal.record('잠금 경합', details)).durable, false); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
    // 파일 쓰기 실패와 잠금 획득 실패를 상태에서도 구분한다.
    assert.equal((await journal.status()).fileFailures, 0);
    await Promise.all(Array.from({length: 8}, (_, i) => journal.record(`경합 뒤 기록 ${i}`, details)));
    assert.deepEqual(await names(dir), before);
  } finally { await journal.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

await test('새 파일 열기 실패 뒤에는 다시 파일을 만들 수 있다', async () => {
  const dir = await directory(), journal = new ErrorJournal({directory: dir, sink});
  const open = fs.open;
  let failOnce = true;
  fs.open = async (...args) => {
    if (failOnce && args[1] === 'wx') { failOnce = false; throw new Error('시험: 새 파일 열기 실패'); }
    return open(...args);
  };
  try {
    assert.equal((await journal.record('파일 열기 실패', details)).durable, false);
    assert.equal((await journal.record('다음 파일 기록', details)).durable, true);
  } finally { fs.open = open; await journal.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

await test('실제 부분 쓰기 실패 뒤에는 손상 파일에 이어 쓰지 않는다', async () => {
  const dir = await directory(), journal = new ErrorJournal({directory: dir, sink});
  const open = fs.open;
  try {
    await journal.record('정상 첫 행', details);
    fs.open = async (...args) => {
      const fd = await open(...args);
      if (args[1] === 'a' && String(args[0]).endsWith('.jsonl')) {
        const write = fd.writeFile.bind(fd);
        fd.writeFile = async () => { await write('{"잘린 행":'); throw new Error('시험: 부분 쓰기 실패'); };
      }
      return fd;
    };
    assert.equal((await journal.record('부분 실패', details)).durable, false);
    fs.open = open;
    assert.equal((await journal.record('복구 뒤 행', details)).durable, true);
    assert.equal((await names(dir)).length, 2);
  } finally { fs.open = open; await journal.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

await test('lease 삭제 실패를 표시하고 같은 프로세스에서 전달을 재개한다', async () => {
  const dir = await directory(), journal = new ErrorJournal({ directory: dir, sink });
  const rename = fs.rename;
  let failRelease = false;
  fs.rename = async (...args) => {
    if (failRelease && String(args[1]) === path.join(dir, 'delivery-state.json')) throw new Error('시험: 상태 저장 불가');
    return rename(...args);
  };
  try {
    await journal.record('첫 기록', details);
    failRelease = true;
    await journal.deliver().catch(() => {});
    failRelease = false;
    assert.equal((await journal.status()).delivery, 'retrying');
    for (let i = 0; i < 10 && await journal.deliver(); i++);
    assert.equal((await journal.status()).pending, 0);
    assert.equal((await journal.status()).delivery, 'ok');
  } finally {
    failRelease = false; fs.rename = rename;
    await journal.close(); await fs.rm(dir, {recursive: true, force: true});
  }
});

await test('유효한 토큰은 보호하고 만료한 토큰만 회수한다', async () => {
  const dir = await directory();
  let now = Date.now(), release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const heldSink = {...sink, async write(events: {id: string}[]) { entered(); await gate; return sink.write(events); }};
  const first = new ErrorJournal({directory: dir, sink: heldSink, now: () => now});
  const second = new ErrorJournal({directory: dir, sink, now: () => now});
  try {
    await first.record('기한 회수 시험', details);
    const inFlight = first.deliver(); await started;
    assert.equal(await second.deliver(), false, '같은 PID라도 다른 수집기의 유효한 토큰은 보호한다');
    now += 60_001;
    assert.equal((await second.status()).delivery, 'retrying');
    assert(await second.deliver());
    release();
    assert.equal(await inFlight, false, '만료한 작업은 새 토큰이 저장한 전달 위치를 갱신하지 못한다');
    for (let i = 0; i < 10 && await second.deliver(); i++);
    assert.equal((await second.status()).pending, 0);
  } finally { release(); await first.close(); await second.close(); await fs.rm(dir, {recursive: true, force: true}); }
});
}

// 영구 실패는 대기·보존 유실과 분리하고 이전 상태 파일도 이어 읽는다.
await test('손상 행만 있는 파일은 DB를 부르지 않고 전달 불가로 확정한다', async () => {
  const directory = await fs.mkdtemp('/private/tmp/aether-error-rejected-');
  let now = Date.now(), calls = 0;
  const sink = { async write() { calls++; throw new Error('접속 불가'); }, async prune() {} };
  const journal = new ErrorJournal({directory, sink, now: () => now});
  const file = `events-2026-10-16-0-${randomUUID()}.jsonl`;
  try {
    await fs.writeFile(path.join(directory, file), '{broken}\n{"id":1}\n{"partial"');
    await journal.deliver();
    for (let i = 0; i < 3; i++) assert.equal(await journal.deliver(), false);
    assert.equal(calls, 0);
    assert.equal((await journal.status()).pending, 0);
    assert.equal((await journal.status()).undeliverable, 3);
    now += 31 * 86_400_000;
    await journal.cleanup();
    assert.equal((await journal.status()).lost.count, 0);
    assert.equal((await journal.status()).undeliverable, 3);
    assert.equal((await fs.readdir(directory)).filter(n => n.endsWith('.jsonl')).length, 0);
  } finally { await journal.close(); await fs.rm(directory, {recursive:true, force:true}); }
});

await test('기존 상태의 실패 위치를 보존하고 전달 불가 기본값을 0으로 읽는다', async () => {
  const directory = await fs.mkdtemp('/private/tmp/aether-error-old-state-');
  const file = `events-2026-10-16-0-${randomUUID()}.jsonl`;
  const event = makeErrorEvent('이전 실패 행', details, 'test');
  const data = JSON.stringify(event) + '\n';
  const payload = {version:1, files:{[file]:{offset:Buffer.byteLength(data),failed:[0],closed:Date.now(),pid:0}},
    lost:{count:2,from:null,to:null,reason:'capacity'}};
  const sink = new Sink(), journal = new ErrorJournal({directory, sink});
  try {
    await fs.writeFile(path.join(directory,file),data);
    await fs.writeFile(path.join(directory,'delivery-state.json'),JSON.stringify({...payload,
      checksum:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}));
    assert.equal((await journal.status()).undeliverable,0);
    assert.equal((await journal.status()).pending,1);
    await journal.deliver();
    assert(sink.rows.has(event.id));
    assert.equal((await journal.status()).pending,0);
    assert.equal((await journal.status()).lost.count,2);
  } finally { await journal.close(); await fs.rm(directory,{recursive:true,force:true}); }
});

await test('손상 행과 접속 실패가 섞여도 정상 행은 재시도하고 손상 행은 한 번만 센다', async () => {
  const directory = await fs.mkdtemp('/private/tmp/aether-error-mixed-outage-');
  const sink = new Sink(), journal = new ErrorJournal({directory, sink});
  const event = makeErrorEvent('복구 후 전달할 행', details, 'test');
  try {
    await fs.writeFile(path.join(directory,`events-2026-10-16-0-${randomUUID()}.jsonl`),
      '{broken}\n' + JSON.stringify(event) + '\n');
    sink.fail = true;
    for (let i = 0; i < 3; i++) await journal.deliver();
    assert.equal((await journal.status()).undeliverable,1);
    assert.equal((await journal.status()).pending,2,'정상 행과 최초 전달 장애를 남긴다');
    assert.equal((await journal.status()).delivery,'retrying');
    assert.equal(sink.batches.length,3,'임시 실패는 계속 재시도한다');
    sink.fail = false;
    await drain(journal);
    assert(sink.rows.has(event.id));
    assert.equal((await journal.status()).pending,0);
    assert.equal((await journal.status()).undeliverable,1);
    assert.equal((await journal.status()).lost.count,0);
  } finally { await journal.close(); await fs.rm(directory,{recursive:true,force:true}); }
});

{
/** 수집 작업 이름은 로그 문구와 가변 값에 따라 달라지지 않아야 한다. */
const fs = (await import('node:fs')).default;
const { fileURLToPath } = await import('node:url');
const root = fileURLToPath(new URL('../../', import.meta.url));
function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'test', 'spikes', 'dist'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
const violations: string[] = [];
let count = 0;
for (const file of [...sources(path.join(root, 'server')), ...sources(path.join(root, 'web/src'))]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\boperation:\s*([^\n]+)/g)) {
    const expression = match[1];
    // 공통 타입 선언과 외부 입력 검증 스키마는 호출부의 작업 이름이 아니다.
    if (/^(?:string\b|RuntimeCommandOperation\b|z\.string\()/.test(expression)) continue;
    count++;
    const literal = expression.match(/^(['"])([a-z0-9_]+(?:\.[a-z0-9_]+)+)\1\s*[,}]/);
    if (!literal) violations.push(`${path.relative(root, file)}:${source.slice(0, match.index).split('\n').length}: ${expression}`);
  }
}
assert.ok(count > 100, '서버와 웹의 실제 수집 호출을 검사한다');
assert.deepEqual(violations, [], 'operation은 점으로 구분한 고정 영문 소문자 이름이어야 한다');
console.log(`✅ 서버·웹 operation 고정 이름 ${count}곳 검사`);
}

{
/** 시작할 때 한 번 버전을 결정하며 Git 실패는 부팅을 막지 않는다. */
const childProcess = (await import('node:child_process')).default;
const { detectRelease, currentRelease } = await import('../observability/release');
const original = childProcess.spawnSync;
let calls = 0;
let dirty = false;
childProcess.spawnSync = ((_command: unknown, args: string[]) => {
  calls++;
  if (args[0] === 'status') assert.deepEqual(args, ['status', '--porcelain', '--untracked-files=no']);
  return { status: 0, stdout: args[0] === 'rev-parse' ? 'abc1234\n' : dirty ? ' M server/index.ts\n' : '' };
}) as unknown as typeof original;
try {
  assert.equal(detectRelease('deployment-1'), 'deployment-1');
  assert.equal(calls, 0, '명시 버전은 Git보다 우선한다');
  assert.equal(detectRelease(undefined), 'abc1234');
  dirty = true;
  assert.equal(detectRelease(undefined), 'abc1234-dirty');
  const before = calls;
  for (let i = 0; i < 3; i++) assert.equal(makeErrorEvent('시험', {component:'test', operation:'release.check'}, 'test').release, currentRelease);
  assert.equal(calls, before, '오류마다 Git을 실행하지 않는다');
  childProcess.spawnSync = (() => ({ status: null, error: new Error('git 없음') })) as unknown as typeof original;
  assert.equal(detectRelease(undefined), null);
  childProcess.spawnSync = (() => ({ status: 128, stdout: '' })) as unknown as typeof original;
  assert.equal(detectRelease(undefined), null, '저장소가 아니어도 정상적으로 계속한다');
} finally { childProcess.spawnSync = original; }
console.log('✅ release 명시값·깨끗한 Git·수정된 Git·Git 실패·한 번 결정');
}

{
/** 쉬는 동안(전달할 것이 없을 때) delivery-state.json을 다시 쓰지 않는다. */
const d = await dir(), j = new ErrorJournal({ directory: d, sink: new Sink() });
await j.record(new Error('쉼 시험'), details);
await drain(j);
await j.status();
const state = path.join(d, 'delivery-state.json');
const before = (await fs.stat(state)).mtimeMs, content = await fs.readFile(state, 'utf8');
for (let i = 0; i < 5; i++) { await j.deliver(); await j.status(); await new Promise(r => setTimeout(r, 15)); }
assert.equal((await fs.stat(state)).mtimeMs, before, '쉬는 동안 파일 수정 횟수는 0');
assert.equal(await fs.readFile(state, 'utf8'), content);
await j.record(new Error('새 오류'), details);
assert.equal((await j.status()).pending, 1, '새 오류는 쉬고 난 뒤에도 전달 대기로 잡힌다');
await j.close();
console.log('✅ 쉬는 동안 delivery-state.json 수정 0회');
}
