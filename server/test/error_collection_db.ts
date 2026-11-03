import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ErrorJournal } from '../observability/journal';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SqliteErrorSink, storableText } from '../observability/database';
import { makeErrorEvent } from '../observability/event';
import { openDatabaseAt } from '../db/sqlite';
import { useTempDatabase } from './support/tempDb';
const temp = useTempDatabase('errors');
const db = openDatabaseAt(temp.file);
const sink = new SqliteErrorSink(temp.file);
const count = (sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);
/** 전송 계층의 실패를 흉내 낸다. 쓰기 트랜잭션 시작이 실패하면 저장 경로 전체가 실패한다. */
const exec = DatabaseSync.prototype.exec;
const breakWrites = (message: string) => {
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') throw new Error(message);
    return exec.call(this, sql);
  };
};
const healWrites = () => { DatabaseSync.prototype.exec = exec; };
try {
  const event = makeErrorEvent(new Error('원문\u0000문자'), { component: 'test', operation: 'db.write', context: { text: 'a\u0000b' } }, 'test');
  assert((await sink.write([event])).has(event.id));
  const first = db.prepare('select * from error_event where id=?').get(event.id) as Record<string, unknown>;
  assert.equal(first.message, storableText(event.message)); assert.deepEqual(JSON.parse(first.context as string), { text: 'a\\u0000b' });
  assert.equal(first.stack, storableText(event.stack!));
  await sink.write([event]);
  const again = db.prepare('select * from error_event where id=?').all(event.id) as Record<string, unknown>[];
  assert.equal(again.length,1); assert.equal(again[0].received_at,first.received_at);
  const bad = { ...event, id: randomUUID(), session_seq: 1.5 }, good = { ...event, id: randomUUID(), message: '다음 정상 행' };
  const result = await sink.write([bad, good]); assert(!result.has(bad.id)); assert(result.has(good.id)); assert(result.rejected?.has(bad.id));
  {
    const directory = await fs.mkdtemp('/private/tmp/aether-error-db-rejected-');
    let now = Date.now(), calls = 0, closed = false;
    const journal = new ErrorJournal({directory, now: () => now, sink:{
      async write(events) { calls++; return sink.write(events); }, async prune() {},
    }});
    try {
      const malformed = await journal.record('DB 형식 위반', {component:'test',operation:'db.reject',session_seq:1.5});
      const constraint = await journal.record('DB 제약 위반', {component:'test',operation:'db.reject',severity:'invalid' as 'error'});
      const valid = await journal.record('같은 배치 정상 행', {component:'test',operation:'db.reject'});
      await journal.deliver();
      assert.equal((await journal.status()).pending,0);
      assert.equal((await journal.status()).undeliverable,2);
      assert.equal(count('select count(*) as n from error_event where id in (?,?,?)',malformed.id,constraint.id,valid.id),1);
      assert.equal(await journal.deliver(),false); assert.equal(calls,1);
      await journal.close(); closed = true;
      const restored = new ErrorJournal({directory, now: () => now});
      try {
        assert.equal((await restored.status()).undeliverable,2);
        now += 31 * 86_400_000;
        await restored.cleanup();
        assert.equal((await restored.status()).lost.count,0);
        assert.equal((await restored.status()).undeliverable,2);
        assert.equal((await fs.readdir(directory)).filter(n => n.endsWith('.jsonl')).length,0);
      } finally { await restored.close(); }
      db.prepare('delete from error_event where id=?').run(valid.id);
    } finally { if (!closed) await journal.close(); await fs.rm(directory,{recursive:true,force:true}); }
  }
  // 달력 3개월: 경계 1초 전 행은 지우고 1시간 남은 행은 남긴다.
  const cut = new Date(); cut.setMonth(cut.getMonth() - 3);
  db.prepare('update error_event set received_at=? where id=?').run(cut.getTime() - 1000, event.id);
  db.prepare('update error_event set received_at=? where id=?').run(cut.getTime() + 3_600_000, good.id);
  await sink.prune(); assert.equal(count('select count(*) as n from error_event'),1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-error-crash-'));
  const childId = randomUUID();
  try {
    await new Promise<void>((resolve,reject) => {
      const child = spawn(process.execPath, ['--import','tsx',fileURLToPath(new URL('./support/errorJournalChild.ts', import.meta.url))], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore',
        env: {...process.env, ERROR_TEST_DIR: directory, ERROR_TEST_FILE: temp.file, ERROR_TEST_ID: childId},
      });
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('시험 자식 종료 실패')));
    });
    assert.equal(count('select count(*) as n from error_event where id=?',childId),1);
    const restored = new ErrorJournal({ directory, sink: { write: e => sink.write(e), prune: () => sink.prune() } });
    await restored.deliver();
    assert.equal((await restored.status()).pending,0);
    assert.equal(count('select count(*) as n from error_event where id=?',childId),1);
    // 파일 아래 경로는 열 수 없어 저장 장애가 된다.
    const blocker = path.join(temp.dir,'blocker'); syncFs.writeFileSync(blocker,'');
    const unavailable = new SqliteErrorSink(path.join(blocker,'aether.sqlite'));
    let down=true;
    const wrapper = { write: (events: Parameters<SqliteErrorSink['write']>[0]) => (down?unavailable:sink).write(events), prune: async()=>{} };
    const offline = new ErrorJournal({directory: directory+'-offline',sink:wrapper});
    const r = await offline.record(new Error('접속 장애 중 기록'),{component:'test',operation:'offline'});
    await offline.deliver();assert(r.durable);assert((await offline.status()).pending >= 1);
    down=false;while(await offline.deliver());
    assert.equal((await offline.status()).pending,0);
    assert.equal((db.prepare('select message from error_event where id=?').get(r.id) as { message: string }).message,'접속 장애 중 기록');
    await offline.close();await fs.rm(directory+'-offline',{recursive:true,force:true});
    await restored.close();
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
  // 조회 wrapper가 메시지를 유지하면서 원래 DB 오류와 상위 수집 기록을 보존한다.
  {
    const letter = await import('../db/sessionLetter');
    const { reportError, setErrorJournal } = await import('../observability/report');
    await letter.openSessionLetter();
    const prepare = DatabaseSync.prototype.prepare;
    const original = Object.assign(new Error('시험 DB 조회 위치'),{code:'XX001',detail:'자동 수집하지 않을 DB 부가 정보'});
    const directory = await fs.mkdtemp('/private/tmp/aether-letter-cause-');
    const journal = new ErrorJournal({directory}); setErrorJournal(journal);
    try {
      for(const explain of [false,true]) {
        DatabaseSync.prototype.prepare = (function(this:DatabaseSync, sql: string, ...args: unknown[]) {
          if(sql.includes('FROM session_letter l')) throw original;
          return (prepare as any).call(this,sql,...args);
        }) as typeof prepare;
        let caught: Error | undefined;
        try {
          if(explain) await letter.explainSessionLetter({query:'원인 보존'});
          else await letter.searchSessionLetters({query:'원인 보존'});
        } catch(error) {caught=error as Error;}
        finally {DatabaseSync.prototype.prepare=prepare;}
        assert(caught);
        assert.equal(caught.message,explain?'세션 글자 색인 계획을 읽지 못했다 (XX001)':'세션 글자 색인 조회에 실패했다');
        assert.equal(caught.cause,original);
        await reportError(caught,{component:'test',operation:'letter.search.fail'});
      }
      await journal.status();
      const names=(await fs.readdir(directory)).filter(n=>n.endsWith('.jsonl'));
      const rows=(await Promise.all(names.map(n=>fs.readFile(path.join(directory,n),'utf8')))).join('').trim().split('\n').map(l=>JSON.parse(l));
      assert.equal(rows.length,2);
      for(const row of rows) {
        assert.deepEqual(row.context.causes,[{message:original.message,stack:original.stack,code:'XX001'}]);
        assert(!JSON.stringify(row).includes(original.detail), '원인 Error의 임의 필드·요청 원문은 자동 수집하지 않는다');
      }
    } finally {DatabaseSync.prototype.prepare=prepare;setErrorJournal(undefined);await journal.close();letter.__resetSessionLetterForTest();await fs.rm(directory,{recursive:true,force:true});}
  }
  // 실제 시험 DB의 성공과 저장 실패를 교대로 주입한다. 운영 파일은 사용하지 않는다.
  {
    const diary = await import('../db/sessionDiary');
    const { SessionEventLog } = await import('../sessions/eventLog');
    const { setErrorJournal } = await import('../observability/report');
    const recorded: import('../../shared/errors').ErrorEvent[] = [];
    await diary.openSessionDiary();
    const log = new SessionEventLog('append-repetition');
    setErrorJournal({record: async (error: unknown, details: import('../observability/event').ErrorDetails) => {
      const row = makeErrorEvent(error, details, 'test'); recorded.push(row); return {id:row.id,durable:true};
    }} as unknown as ErrorJournal);
    const write = async () => {
      log.write({kind:'status',status:'completed'}, ev=>ev);
      await new Promise(resolve=>setImmediate(resolve));
    };
    try {
      breakWrites('시험 저장 실패');
      for (let i=0; i<4; i++) await write();
      assert.equal(recorded.length,1,'연속 저장 실패는 한 번만 수집한다');
      assert.equal(recorded[0].session_id,'append-repetition'); assert.equal(recorded[0].session_seq,1);
      healWrites();
      await write();
      breakWrites('시험 저장 실패'); await write();
      assert.equal(recorded.length,2,'저장 성공 뒤 실패는 다시 수집한다');
    } finally {healWrites(); log.abandon(); setErrorJournal(undefined); diary.__resetSessionDiaryForTest();}
  }
  // 기다리지 않는 일기 저장도 DB 실패를 삼키기 전에 세션별 첫 원인을 남긴다.
  {
    const diary=await import('../db/sessionDiary');
    const { setErrorJournal }=await import('../observability/report');
    const rows: import('../../shared/errors').ErrorEvent[]=[];
    await diary.openSessionDiary();
    setErrorJournal({record:async(error:unknown,details:import('../observability/event').ErrorDetails)=>{const row=makeErrorEvent(error,details,'h2-db');rows.push(row);return {id:row.id,durable:true};}} as unknown as ErrorJournal);
    let seq=0;
    const append=async()=>{diary.appendDiaryBestEffort('h2-best-effort',{kind:'status',seq:++seq,ts:seq,status:'completed'});await new Promise(r=>setImmediate(r));};
    try {
      breakWrites('H2 비동기 일기 DB 실패');for(let i=0;i<4;i++)await append();
      assert.equal(rows.length,1);assert.equal(rows[0].severity,'error');assert.equal(rows[0].session_id,'h2-best-effort');
      healWrites();await append();breakWrites('H2 비동기 일기 DB 실패');await append();assert.equal(rows.length,2);
    } finally {healWrites();setErrorJournal(undefined);diary.__resetSessionDiaryForTest();}
  }
  console.log('✅ 격리 SQLite 내용·문자·중복·최초저장시각·행실패격리·달력 3개월');
} finally { healWrites(); temp.dispose(); }
