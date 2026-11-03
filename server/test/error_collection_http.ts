import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorJournal } from '../observability/journal';
import { rejectRequest, errorRequestContext, errorsRouter } from '../observability/http';
import { errorContext, reportError, setErrorJournal } from '../observability/report';
import { errorHandler } from '../middleware/hardening';
import { classifyError } from '../observability/event';
import { createAuthMiddleware } from '../middleware/auth';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-error-http-'));
const journal = new ErrorJournal({ directory: dir }); setErrorJournal(journal);
const app = express();app.use(errorRequestContext);app.use(express.json({limit:'256kb'}));
app.use('/api/errors', createAuthMiddleware({authenticate: async req => req.get('authorization') === 'test' ? {login:'test',via:'off'} : null}), errorsRouter);
app.get('/fail', async () => {const error=new Error('원래 실패');void reportError(error,{component:'test',operation:'feature.fail'});throw error;});
app.get('/caught', (_req,res) => res.status(500).json({error:'잡아서 응답한 실패'}));
app.get('/bad', (_req,res) => res.status(400).json({error:'정상 입력 거절'}));
app.get('/unsupported', (_req,res) => rejectRequest(res, 501, {error:'지원하지 않음'}));
app.get('/defect400', () => { throw Object.assign(new Error('요청 구성 결함'), {status:400}); });
app.get('/external', (_req,res) => {
  res.locals.errorOrigin = 'external_environment';
  void reportError(classifyError(new Error('외부 서비스 장애'), 'external_environment'), {component:'test',operation:'external'});
  res.status(503).json({error:'기존 오류 표시'});
});
app.get('/double', (_req,res) => {
  res.status(500).json({error:'첫 응답'});
  res.status(200).json({ok:true});
  res.send('뒤 응답');
  res.end();
});
app.use(errorHandler);
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));
const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
try {
  const fail=await fetch(url+'/fail');assert.equal(fail.status,500);assert.equal(fail.headers.get('X-Aether-Error-Recorded'),'1');
  assert.equal((await journal.status()).pending,1,'재던짐 중복 없음');
  const caught=await fetch(url+'/caught');assert.equal(caught.headers.get('X-Aether-Error-Recorded'),'1');
  await fetch(url+'/bad');assert.equal((await journal.status()).pending,2);
  await fetch(url+'/unsupported'); assert.equal((await journal.status()).pending,2);
  await fetch(url+'/defect400'); assert.equal((await journal.status()).pending,3);
  const external = await fetch(url+'/external');
  assert.equal(external.headers.get('X-Aether-Error-Origin'),'external_environment','잡아서 응답한 외부 환경 실패를 웹이 다시 수집하지 않는다');
  assert.deepEqual(await external.json(),{error:'기존 오류 표시'});
  assert.equal((await journal.status()).pending,3);
  const double = await fetch(url+'/double');
  assert.equal(double.status,500,'기록을 기다리는 첫 실패 응답이 뒤따른 성공 응답보다 먼저 전송된다');
  assert.deepEqual(await double.json(),{error:'첫 응답'});
  const record={id:randomUUID(),occurred_at:new Date().toISOString(),component:'ui',operation:'render',release:'web-build-test',message:'화면 실패'};
  const post=(body:unknown,authorization='test')=>fetch(url+'/api/errors',{method:'POST',headers:{'Content-Type':'application/json',authorization},body:JSON.stringify(body)});
  assert.equal((await post(record,'')).status,401);
  assert.equal((await post({...record,source:'server'})).status,400);
  assert.equal((await post({...record,id:'bad'})).status,400);
  const result=await post(record);assert.equal(result.status,200);assert.equal((await result.json()).durable,true);
  // 웹이 보내는 등급은 warning과 error만 허용한다. fatal과 모르는 값은 거절하고 없으면 error다.
  const warningRecord={...record,id:randomUUID(),severity:'warning'};
  assert.equal((await post(warningRecord)).status,200);
  for(const severity of ['fatal','critical','',null,1]) assert.equal((await post({...record,id:randomUUID(),severity})).status,400,`severity ${String(severity)}`);
  const names=(await fs.readdir(dir)).filter(n=>n.endsWith('.jsonl'));
  const rows=(await Promise.all(names.map(n=>fs.readFile(path.join(dir,n),'utf8')))).join('').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.find(e=>e.operation==='feature.fail').request_id,fail.headers.get('X-Request-Id'));
  assert.equal(rows.find(e=>e.id===record.id).source,'web');
  assert.equal(rows.find(e=>e.id===record.id).severity,'error','등급이 없으면 error');
  assert.equal(rows.find(e=>e.id===warningRecord.id).severity,'warning');
  assert.equal(rows.find(e=>e.id===warningRecord.id).source,'web','등급을 받아도 출처는 서버가 정한다');
  assert.equal(rows.find(e=>e.id===record.id).release,'web-build-test');
  console.log('✅ HTTP 인증·출처 검증·형식 제한·fsync 응답·요청 연결·서버 중복 방지');
} finally { await new Promise<void>(r=>server.close(()=>r()));await journal.close();setErrorJournal(undefined);await fs.rm(dir,{recursive:true,force:true}); }

// 응답 함수와 기록 Promise의 실패를 소켓 없이도 주입한다.
{
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-error-http-unit-'));
const journal = new ErrorJournal({directory});
setErrorJournal(journal);
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on('unhandledRejection', onUnhandled);
function response() {
  const emitter = new EventEmitter();
  const r = Object.assign(emitter, {
    statusCode:200, headersSent:false, locals:{}, body:undefined as unknown, headers:new Map<string,unknown>(),
    setHeader(name:string,value:unknown) { if(this.headersSent) throw new Error('headers sent'); this.headers.set(name,value); return this; },
    status(code:number) { this.statusCode=code; return this; },
    send(body:unknown) { this.body=body; this.headersSent=true; emitter.emit('finish'); return this; },
    end() { this.headersSent=true; emitter.emit('finish'); return this; },
    json(body:unknown) { this.body=body; this.headersSent=true; emitter.emit('finish'); return this; },
  });
  return r as unknown as Response & {body:unknown};
}
try {
  const req = {method:'GET', originalUrl:'/unsupported', path:'/unsupported'} as Request;
  const res = response();
  errorRequestContext(req,res,() => { rejectRequest(res,501,{error:'지원 안 함'}); });
  assert.equal(res.statusCode,501);
  assert.equal((await journal.status()).pending,0);
  const errors: unknown[] = [];
  const double = response();
  errorRequestContext(req,double,() => {
    double.status(500).json({error:'먼저 선택한 실패'});
    double.status(200).json({ok:true});
    double.send('뒤따른 응답');
    double.end();
  });
  await new Promise(r=>setTimeout(r,80));
  assert.equal(double.statusCode,500);
  assert.deepEqual(double.body,{error:'먼저 선택한 실패'});
  const throws = response();
  throws.setHeader = ((name:string) => {if(name === 'X-Aether-Error-Recorded') throw new Error('시험 헤더 실패'); return throws;}) as typeof throws.setHeader;
  errorRequestContext(req,throws,(e?:unknown) => {
    if(e) errors.push(e);
    else throws.status(500).json({error:'응답 전송 예외'});
  });
  await new Promise(r=>setTimeout(r,80));
  assert.equal(errors.length,1,'지연 응답 예외는 Express 오류 경로로 넘긴다');
  const badJson = response();
  badJson.json = (() => { throw new Error('시험 JSON 전송 실패'); }) as typeof badJson.json;
  errorRequestContext(req,badJson,(e?:unknown) => {
    if(e) errors.push(e);
    else badJson.status(500).json({error:'JSON 전송 예외'});
  });
  await new Promise(r=>setTimeout(r,80));
  assert.equal(errors.length,2,'원래 json 함수가 던져도 Express 오류 경로로 넘긴다');
  const record = journal.record.bind(journal);
  journal.record = () => Promise.reject(new Error('시험 수집 Promise 실패'));
  try {
    const failedReceipt = response();
    errorRequestContext(req,failedReceipt,() => failedReceipt.status(503).json({error:'기록 실패 뒤에도 응답한다'}));
    await new Promise(r=>setTimeout(r,30));
    assert.equal(failedReceipt.statusCode,503);
    assert.deepEqual(failedReceipt.body,{error:'기록 실패 뒤에도 응답한다'});
  } finally { journal.record = record; }
  const self = response();
  errorRequestContext({method:'POST',originalUrl:'/api/errors?source=test',path:'/'} as Request,self,()=>self.status(503).json({error:'수집기 장애'}));
  await new Promise(r=>setTimeout(r,30));
  assert.equal((await journal.status()).pending,3,'수집 경로 자신의 실패를 다시 수집하지 않는다');
  for (const error of [
    Object.assign(new Error('잘못된 입력 JSON'), {status:400,type:'entity.parse.failed'}),
    classifyError(Object.assign(new Error('서비스 과부하'), {status:503}), 'external_environment'),
  ]) {
    const expected = response();
    errorRequestContext(req,expected,()=>errorHandler(error,req,expected,()=>{}));
    assert.equal((expected as unknown as {headers:Map<string,string>}).headers.get('X-Aether-Error-Origin'), 'errorOrigin' in error ? error.errorOrigin : 'user_action');
  }
  await new Promise(r=>setTimeout(r,30));
  assert.equal((await journal.status()).pending,3,'중앙 처리기의 입력 거절·외부 환경은 응답 보완에서도 제외한다');
  const defect = response();
  errorRequestContext(req,defect,()=>errorHandler(Object.assign(new Error('Aether 요청 구성 결함'),{status:400}),req,defect,()=>{}));
  await new Promise(r=>setTimeout(r,30));
  assert.equal((await journal.status()).pending,4,'상태가 400이어도 원인 불명·결함은 수집한다');
  const explicitDefect = response();
  explicitDefect.locals.errorOrigin = 'aether_defect';
  errorRequestContext(req,explicitDefect,() => explicitDefect.status(500).send('결함 때문에 실패'));
  await new Promise(r=>setTimeout(r,30));
  assert.equal((await journal.status()).pending,5,'결함 원인은 JSON 외 응답 보완에서도 수집한다');
  assert.deepEqual(unhandled,[],'응답 전송과 기록 실패가 처리 안 된 거절로 남지 않는다');
  console.log('✅ HTTP 정상 거절·응답 순서·지연 전송 예외·수집 경로의 자기 응답 제외');
} finally { process.off('unhandledRejection',onUnhandled); setErrorJournal(undefined); await journal.close(); await fs.rm(directory,{recursive:true,force:true}); }
}

/** 같은 요청의 부수 실패가 다음 응답 원인을 오염시키지 않는다. */
{
  const { test } = await import('node:test');
  const syncFs = (await import('node:fs')).default;
  const { config } = await import('../config');
  const { sessionsRouter } = await import('../routes/sessions');
  const { streamRouter } = await import('../routes/stream');
  const { sessionManager } = await import('../sessions/SessionManager');
  await (await import('./support/tempDb')).useTempDiary("error_collection_http"); // 임시 SQLite 일기
  const mock = await import('./support/mockProvider');
  const directory = await fs.mkdtemp('/private/tmp/aether-error-causes-');
  const journal = new ErrorJournal({directory}); setErrorJournal(journal);
  const app = express(); app.use(express.json()); app.use(errorRequestContext);
  for (const text of [false, true]) {
    for (const explicit of [false, true]) {
      app.get(`/origin-${text}-${explicit}`, (_req,res) => {
        void reportError(classifyError(new Error('부수 작업의 외부 오류'), 'external_environment'), {component:'test',operation:'side.failure'});
        if (explicit) res.locals.errorOrigin = 'external_environment';
        if (text) res.status(500).send('원래 본문');
        else res.status(500).json({error:'원래 본문'});
      });
    }
  }
  app.use('/api/sessions', sessionsRouter, streamRouter);
  app.use(errorHandler);
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.on('listening',r));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const originalGet = sessionManager.get, originalHas = sessionManager.hasDiskSession, originalCodec = sessionManager.codecOf;
  let cause: Error = new Error('시험 원인');
  function faultAtSource(): never { throw cause; }
  const fake = {capabilities:{supportedModels:true,usage:true},interrupt:faultAtSource,listModels:faultAtSource,getUsage:faultAtSource,listCommands:faultAtSource,executeCommand:faultAtSource,permissionPolicy:faultAtSource};
  const rows = async () => {
    await journal.status();
    const names = (await fs.readdir(directory)).filter(n=>n.endsWith('.jsonl'));
    return (await Promise.all(names.map(n=>fs.readFile(path.join(directory,n),'utf8')))).join('').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  };
  try {
    for (const text of [false, true]) for (const explicit of [false, true]) {
      await test(`외부 오류 문맥 누수: text=${text}, 응답에 명시=${explicit}`, async () => {
        const before = (await rows()).length;
        const res = await fetch(`${url}/origin-${text}-${explicit}`);
        assert.equal(res.status,500); await res.text();
        assert.equal((await rows()).length-before, explicit ? 0 : 1);
        if (!text) assert.equal(res.headers.get('X-Aether-Error-Origin'), explicit ? 'external_environment' : null);
      });
    }
    await test('세션 조회는 부재·폴더 정책 거절을 제외하고 손상·읽기 실패만 원래 Error로 수집한다', async () => {
      const store = await import('../sessions/persistence');
      const { st } = await import('../i18n');
      const ids: string[] = [];
      const disk = (sessionManager as any).disk as Map<string, unknown>;
      try {
        for(const kind of ['missing','policy','parse','io']) {
          const id=randomUUID(); ids.push(id);
          let source: Error | undefined;
          if(kind!=='missing') {
            // 정책 거절 = 폴더가 아닌 파일 경로(세션 자신의 meta.json)
            const meta={id,cwd:kind==='policy'?path.join(config.dataDir,id,'meta.json'):config.projectRoot,provider:mock.MOCK_PROVIDER,resumeKey:'mock-resume',createdAt:1};
            syncFs.mkdirSync(path.join(config.dataDir,id),{recursive:true});
            syncFs.writeFileSync(path.join(config.dataDir,id,'meta.json'),kind==='parse'?'{broken':JSON.stringify(meta));
            const read=syncFs.readFileSync;
            source=Object.assign(new Error('시험 세션 읽기 실패'),{code:'EIO'});
            syncFs.readFileSync=((p:any,...args:any[])=>{if(kind==='io' && p===path.join(config.dataDir,id,'meta.json')) throw source; return (read as any)(p,...args);}) as typeof read;
            try {sessionManager.restoreFromDisk();} finally {syncFs.readFileSync=read;}
          }
          const before=(await rows()).length;
          for(const action of ['wake','message']) {
            const res=await fetch(`${url}/api/sessions/${id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'입력'})});
            const corrupted=kind!=='missing';
            assert.equal(res.status,corrupted?409:404,kind);
            assert.deepEqual(await res.json(),{error:st(corrupted?'routes.sessions.cannotOpen':'routes.sessions.notFoundAlt')});
          }
          const all=await rows();
          const added=all.slice(before);
          if(kind==='missing'||kind==='policy') assert.equal(added.length,0,kind);
          else {
            const failures=all.filter(r=>r.session_id===id);
            assert(failures.length>0,kind);
            assert(failures.every(r=>r.severity==='error'));
            if(kind==='io') assert(failures.some(r=>r.stack===source!.stack));
            if(kind==='parse') assert(failures.some(r=>r.stack.includes('JSON.parse')));
          }
        }
      } finally {for(const id of ids) {disk.delete(id); await fs.rm(path.join(config.dataDir,id),{recursive:true,force:true});}}
    });
    sessionManager.get = (()=>fake) as unknown as typeof originalGet;
    await test('이미 보고된 같은 오류를 응답 catch에서 재보고해도 보완 기록을 중복하지 않는다', async () => {
      cause = new Error('요청 밖에서 먼저 보고한 원인');
      await reportError(cause,{component:'test',operation:'prior.failure'});
      const before = (await rows()).length;
      const res = await fetch(`${url}/api/sessions/test/interrupt`,{method:'POST'});
      assert.equal(res.status,500); await res.text();
      assert.equal((await rows()).length,before);
      assert.equal(res.headers.get('X-Aether-Error-Recorded'),'1');
    });

    for (const [method,route,body] of [
      ['POST','interrupt',undefined],['GET','models',undefined],
      ['GET','usage',undefined],['GET','commands',undefined],
      ['POST','commands',{command:'test'}],['GET','permission-policy',undefined],
    ] as const) {
      await test(`5xx 원인 보존: ${method} ${route}`, async () => {
        cause = new Error(`원래 ${route} 실패`);
        const before = (await rows()).length;
        const res = await fetch(`${url}/api/sessions/test/${route}`, {method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
        assert.equal(res.status,500);
        assert.deepEqual(await res.json(),{error:cause.message});
        const added = (await rows()).slice(before);
        assert.equal(added.length,1,'응답 보완과 중복하지 않는다');
        assert.equal(added[0].stack,cause.stack,'원래 Error의 생성 위치를 보존한다');
        assert.equal(added[0].session_id, 'test', '세션 라우트의 오류에 대상 세션을 연결한다');
        assert.equal(res.headers.get('X-Aether-Error-Recorded'),'1');
      });
    }
    await test('실제로 500을 만든 외부 환경 오류는 라우트에서 제외한다', async () => {
      cause = classifyError(new Error('원래 외부 실패'), 'external_environment');
      const before = (await rows()).length;
      const res = await fetch(`${url}/api/sessions/test/usage`);
      assert.equal(res.status,500); assert.deepEqual(await res.json(),{error:cause.message});
      assert.equal((await rows()).length,before);
      assert.equal(res.headers.get('X-Aether-Error-Origin'),'external_environment');
    });
    sessionManager.get = (()=>undefined) as typeof originalGet;
    sessionManager.hasDiskSession = ()=>true;
    sessionManager.codecOf = faultAtSource;
    for (const route of ['events?before=100','stream']) {
      await test(`파일 세션 ${route}의 codec 실패 stack 보존`, async () => {
        cause = new Error('원래 codec 오류');
        const before = (await rows()).length;
        const res = await fetch(`${url}/api/sessions/test/${route}`); assert.equal(res.status,500); await res.text();
        const added = (await rows()).slice(before); assert.equal(added.length,1); assert.equal(added[0].stack,cause.stack);
      });
    }
    sessionManager.codecOf = ()=>mock.mockEntry.codec;
    await test('stream 읽기 실패: 빈 재생으로 속이지 않고 503으로 답하며 원인을 한 번 수집한다', async () => {
      const diary = await import('../db/sessionDiary');
      const before = (await rows()).length;
      diary.holdDiaryInput();
      try {
        const res = await fetch(`${url}/api/sessions/test/stream?since=1`);
        assert.equal(res.status,503); await res.text();
        const added = (await rows()).slice(before);
        assert.equal(added.length,1); assert.equal(added[0].operation,'session.stream.replay');
      } finally { diary.releaseDiaryInput(); }
    });
  } finally {
    sessionManager.get=originalGet; sessionManager.hasDiskSession=originalHas; sessionManager.codecOf=originalCodec;
    await new Promise<void>(r=>server.close(()=>r())); setErrorJournal(undefined); await journal.close(); await fs.rm(directory,{recursive:true,force:true});
  }
}

// 응답 전에 시작한 비동기 작업도 응답 종료 뒤에는 요청 번호를 물려받지 않는다.
{
  const recorded: { request_id?: string | null; operation: string }[] = [];
  setErrorJournal({ record: async (_error: unknown, details: { request_id?: string | null; operation: string }) => {
    recorded.push(details); return { id: randomUUID(), durable: true };
  } } as unknown as ErrorJournal);
  try {
    for (const ending of ['finish', 'close']) {
      const res = Object.assign(new EventEmitter(), {
        locals: {}, statusCode: 200, setHeader() {}, json() {}, send() {}, end() {},
      }) as unknown as Response;
      let done!: Promise<void>;
      errorRequestContext({ originalUrl: '/scope', method: 'GET' } as Request, res, () => {
        done = (async () => {
          await reportError(new Error('응답 전'), { component: 'test', operation: 'scope.before' });
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          res.emit(ending);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          try { throw new Error('응답 뒤'); }
          catch (error) { await reportError(error, { component: 'test', operation: 'scope.after' }); }
          assert.equal(errorContext.getStore()?.receipt, undefined, '끝난 문맥의 receipt도 다시 채우지 않는다');
        })();
      });
      await done;
      assert.ok(recorded.at(-2)!.request_id, `${ending} 전에는 요청 번호가 있다`);
      assert.equal(recorded.at(-1)!.request_id, null, `${ending} 뒤 지연 작업에는 요청 번호가 없다`);
    }
  } finally { setErrorJournal(undefined); }
  console.log('✅ 요청 문맥은 finish/close 뒤 지연 작업에 요청 번호를 붙이지 않는다');
}

/** H2: 4xx·200으로 바뀌는 내부 실패도 원인을 남기고 기존 응답을 보존한다. */
{
  const { test } = await import('node:test');
  const syncFs=(await import('node:fs')).default;
  const { config }=await import('../config');
  const { sessionsRouter }=await import('../routes/sessions');
  const { providerAuthRouter }=await import('../routes/providerAuth');
  const { fsRouter }=await import('../routes/fs');
  const { streamRouter }=await import('../routes/stream');
  const { sessionManager }=await import('../sessions/SessionManager');
  const { __registerProviderForTest }=await import('../providers/registry');
  const mock=await import('./support/mockProvider');
  const { makeErrorEvent }=await import('../observability/event');
  const rows: import('../../shared/errors').ErrorEvent[]=[];
  setErrorJournal({record:async(error:unknown,details:import('../observability/event').ErrorDetails)=>{const row=makeErrorEvent(error,details,'h2-http');rows.push(row);return {id:row.id,durable:true};}} as unknown as ErrorJournal);
  let cause: Error=new Error('H2 내부 실패');
  const fault=()=>{throw cause;};
  const unregister=__registerProviderForTest({...mock.mockEntry,services:{...mock.mockEntry.services,auth:{start:fault,submitCode:fault,poll:fault,cancel:()=>{},status:async()=>({loggedIn:false})}}} as any);
  const get=sessionManager.get,resume=sessionManager.getOrResume;
  sessionManager.get=(()=>({setModel:fault,setEffort:fault,changePermissionMode:fault,listPermissionModes:fault,setPermissionMode:fault,push:fault})) as any;
  sessionManager.getOrResume=sessionManager.get as any;
  const app=express();app.use(express.json());app.use(errorRequestContext);
  app.use('/sessions',sessionsRouter);app.use('/auth',providerAuthRouter);app.use('/fs',fsRouter);
  app.use('/gate',createAuthMiddleware({authenticate:async()=>{throw cause;}}));
  app.use(errorHandler);
  const srv=app.listen(0,'127.0.0.1');await new Promise<void>(r=>srv.on('listening',r));
  const base=`http://127.0.0.1:${(srv.address() as {port:number}).port}`;
  const post=(route:string,body:unknown)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    for(const [route,body,status] of [
      ['/sessions/h2-session/model',{model:'valid'},400],
      ['/sessions/h2-session/effort',{effort:'high'},400],
      ['/sessions/h2-session/permissions',{permissionMode:'full'},400],
      ['/sessions/h2-session/message',{text:'hello'},409],
      [`/auth/${mock.MOCK_PROVIDER}/code`,{loginId:'h2',code:'test-code'},409],
      [`/auth/${mock.MOCK_PROVIDER}/poll`,{loginId:'h2'},200],
    ] as const) {
      await test(`${route}: 원인 불명은 수집하고 중립 정상 거절은 제외한다`,async()=>{
        rows.length=0;cause=new Error('H2 요청 원래 실패');const res=await post(route,body);assert.equal(res.status,status);await res.json();
        assert.equal(rows.length,1);assert.equal(rows[0].stack,cause.stack);assert.equal(rows[0].severity,'error');
        if(route.startsWith('/sessions'))assert.equal(rows[0].session_id,'h2-session');
        cause=classifyError(new Error('H2 정상 입력 거절'),'user_action');await (await post(route,body)).json();assert.equal(rows.length,1);
        cause=classifyError(new Error('H2 외부 원인'),'external_environment');await (await post(route,body)).json();assert.equal(rows.length,1);
      });
    }
    await test('세션 스트림의 주기 읽기 실패는 연결별 첫 건만 남기고 성공 후 다시 기록한다',async()=>{
      const diary=await import('../db/sessionDiary');
      let held=false;const fail=(on:boolean)=>{if(on&&!held){diary.holdDiaryInput();held=true;}if(!on&&held){diary.releaseDiaryInput();held=false;}};
      const has=sessionManager.hasDiskSession,codec=sessionManager.codecOf,add=sessionManager.addViewer,drop=sessionManager.dropViewer;
      const getNow=sessionManager.get;
      const interval=globalThis.setInterval,clear=globalThis.clearInterval;
      const timers: {ms:number;fn:()=>void}[]=[];
      sessionManager.get=(()=>undefined) as any;sessionManager.hasDiskSession=()=>true;sessionManager.codecOf=()=>mock.mockEntry.codec;
      sessionManager.addViewer=()=>{};sessionManager.dropViewer=()=>{};
      globalThis.setInterval=((fn:()=>void,ms:number)=>{timers.push({ms,fn});return {} as any;}) as typeof interval;
      globalThis.clearInterval=(()=>{}) as typeof clear;
      const req=Object.assign(new EventEmitter(),{params:{id:'h2-poll'},query:{}});
      const res=Object.assign(new EventEmitter(),{writeHead:()=>{},flushHeaders:()=>{},write:()=>true});
      rows.length=0;
      try {
        const handler=(streamRouter as any).stack.find((layer:any)=>layer.route?.path==='/:id/stream').route.stack[0].handle;
        handler(req,res,()=>{});
        const poll=timers.find(t=>t.ms===1000)!.fn;
        fail(true);for(let i=0;i<4;i++)poll();assert.equal(rows.length,1);assert.equal(rows[0].operation,'session.stream.poll');assert.equal(rows[0].session_id,'h2-poll');
        fail(false);poll();fail(true);poll();assert.equal(rows.length,2);
        req.emit('close');fail(false);rows.length=0;
        sessionManager.addViewer=()=>{throw new Error('H2 관측자 상태 결함');};
        const req2=Object.assign(new EventEmitter(),{params:{id:'h2-poll'},query:{}});
        handler(req2,res,()=>{});assert.equal(rows.length,1);assert.equal(rows[0].operation,'session.viewer.add');req2.emit('close');
        sessionManager.addViewer=()=>{};rows.length=0;
        let emit: (ev:any)=>void=()=>{};
        sessionManager.get=(()=>({subscribe:(fn:any)=>{emit=fn;return()=>{};},replaySince:()=>[],replayNewestFirst:()=>[]})) as any;
        const req3=Object.assign(new EventEmitter(),{params:{id:'h2-poll'},query:{}});
        handler(req3,res,()=>{});
        const cyclic:any={kind:'status',seq:1,ts:1,status:'completed'};cyclic.self=cyclic;
        emit(cyclic);assert.equal(rows.length,1);assert.equal(rows[0].operation,'session.stream.encode');req3.emit('close');
      } finally {
        req.emit('close');globalThis.setInterval=interval;globalThis.clearInterval=clear;
        sessionManager.get=getNow;sessionManager.hasDiskSession=has;sessionManager.codecOf=codec;sessionManager.addViewer=add;sessionManager.dropViewer=drop;
        fail(false);
      }
    });
    await test('인증 전략의 예상 밖 예외는 401 응답을 유지하며 수집한다',async()=>{
      rows.length=0;cause=new Error('H2 인증 결함');const res=await fetch(base+'/gate');assert.equal(res.status,401);await res.json();assert.equal(rows.length,1);
      cause=classifyError(new Error('H2 취소'),'user_action');await (await fetch(base+'/gate')).json();assert.equal(rows.length,1);
    });
    await test('폴더 목록 조회는 권한 거절·부재를 오류 기록 없이 403·404로 돌려주고 I/O 실패만 500·warning으로 남긴다',async()=>{
      const folder=syncFs.realpathSync(syncFs.mkdtempSync(path.join(os.tmpdir(),'aether-h2-fs-')));
      syncFs.mkdirSync(path.join(folder,'child'));
      syncFs.symlinkSync(path.join(folder,'child'),path.join(folder,'link'));
      const readdir=syncFs.promises.readdir;
      const realpath=syncFs.promises.realpath;
      let code='EIO';
      syncFs.promises.readdir=((p:any,...args:any[])=>{
        if(p===folder)return Promise.reject(Object.assign(new Error('H2 자식 탐색 실패'),{code}));
        return (readdir as any)(p,...args);
      }) as typeof readdir;
      rows.length=0;
      try {
        const get=async()=>fetch(base+'/fs/list?path='+encodeURIComponent(folder));
        code='EACCES';{const res=await get();assert.equal(res.status,403);await res.json();assert.equal(rows.length,0);}
        code='ENOENT';{const res=await get();assert.equal(res.status,404);await res.json();assert.equal(rows.length,0);}
        code='EIO';{const res=await get();assert.equal(res.status,500);await res.json();assert.equal(rows.length,1);}
        // 링크 확인이 EIO면 목록은 200이고 그 링크만 빠지며 warning 하나를 남긴다.
        syncFs.promises.readdir=readdir;
        syncFs.promises.realpath=((p:any,...args:any[])=>{
          if(p===path.join(folder,'link'))return Promise.reject(Object.assign(new Error('H2 링크 확인 실패'),{code:'EIO'}));
          return (realpath as any)(p,...args);
        }) as typeof realpath;
        rows.length=0;
        for(let i=0;i<3;i++){const res=await get();assert.equal(res.status,200);assert.deepEqual((await res.json()).entries.map((e:any)=>e.name),['child']);}
        assert.equal(rows.length,1);assert.equal(rows[0].severity,'warning');
      } finally {syncFs.promises.readdir=readdir;syncFs.promises.realpath=realpath;syncFs.rmSync(folder,{recursive:true,force:true});}
    });
  } finally {sessionManager.get=get;sessionManager.getOrResume=resume;unregister();await new Promise<void>(r=>srv.close(()=>r()));setErrorJournal(undefined);}
}
