/** provider 어휘 검증은 공통 저장 계약 시험과 분리한다. 외부 모델 호출은 없다. */
import assert from 'node:assert/strict';
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeTurnFailure } from '../providers/claude/turnFailure';
// 푸시 구독은 password 모드에서 로그인 자격 지문을 쓰므로 시험용 시크릿(실제 값 아님)이 필요하다.
process.env.AETHER_JWT_SECRET ??= 'test-only-mock-secret-do-not-use-in-prod-xxxxxxxx';
process.env.AETHER_PASSWORD_HASH ??= 'test-only-hash-placeholder';
const result = (extra: Record<string, unknown>) => ({type:'result', subtype:'success', is_error:false, result:'ok', ...extra}) as SDKMessage;
assert.equal(claudeTurnFailure(result({})),null);
assert.equal(claudeTurnFailure(result({is_error:true, terminal_reason:'aborted_streaming'})),null);
assert.equal(claudeTurnFailure(result({is_error:true, terminal_reason:'aborted_tools'})),null);
assert.equal(claudeTurnFailure(result({is_error:true,result:'원문 실패'}))?.message,'원문 실패');
assert.equal(claudeTurnFailure(result({subtype:'error_during_execution',errors:['a','b']}))?.message,'a\nb');
assert.equal(claudeTurnFailure({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'x',is_error:true,content:'command failed'}]}} as SDKMessage),null);
console.log('✅ provider 어댑터: 턴 실패·중단·일반 명령 실패 구분');

// 결과에 상태 번호가 없는 턴도 마지막 주 어시스턴트의 구조화 원인을 따른다.
{
  const { createClaudeTurnFailureTracker } = await import('../providers/claude/turnFailure');
  const { isExpectedError } = await import('../observability/event');
  const assistant = (error?: SDKAssistantMessageError, parent: string | null = null) =>
    ({type:'assistant',parent_tool_use_id:parent,message:{content:[]},...(error?{error}:{})}) as unknown as SDKMessage;
  for(const kind of ['authentication_failed','oauth_org_not_allowed','billing_error','rate_limit','overloaded','server_error','invalid_request','model_not_found','unknown','max_output_tokens'] as const) {
    const track=createClaudeTurnFailureTracker();
    assert.equal(track(assistant(kind)),null);
    const failure=track(result({is_error:true,result:'설명 문구가 바뀌어도 원인은 같다'}));
    assert.equal(isExpectedError(failure),['authentication_failed','oauth_org_not_allowed','billing_error','rate_limit','overloaded','server_error'].includes(kind),kind);
    assert(!isExpectedError(track(result({is_error:true,result:'다음 턴의 해석 실패'}))), '결과 뒤에는 원인이 남지 않는다');
  }
  const track=createClaudeTurnFailureTracker();
  track(assistant('rate_limit'));track(assistant());
  assert(!isExpectedError(track(result({is_error:true,result:'마지막 응답은 원인 불명'}))), '성공한 assistant가 이전 오류를 지운다');
  track(assistant('rate_limit','subagent-tool'));
  assert(!isExpectedError(track(result({is_error:true,result:'주 턴의 해석 실패'}))), '하위 작업 오류가 주 턴을 제외하지 않는다');
  track({type:'system',subtype:'api_retry',error:'rate_limit',error_status:429,attempt:1,max_retries:2,retry_delay_ms:1} as SDKMessage);
  assert.equal(track(result({})),null,'재시도 뒤 성공은 정상이다');
  assert(!isExpectedError(track(result({is_error:true,result:'별개 내부 실패'}))), '재시도 신호만으로 최종 원인을 단정하지 않는다');
  track(assistant('invalid_request'));
  assert(!isExpectedError(track(result({is_error:true,result:'rate limit exceeded',api_error_status:429}))), '구조화된 내부 원인을 상태나 문구로 덮지 않는다');
  track(assistant('rate_limit'));
  assert(!isExpectedError(track(result({subtype:'error_during_execution',errors:['failed to parse response']}))), '명시적인 해석 실패가 섞이면 수집한다');
  track(assistant('rate_limit'));track(result({is_error:true,terminal_reason:'aborted_tools'}));
  assert(!isExpectedError(track(result({is_error:true,result:'중단 다음 턴 실패'}))));
}

process.env.AETHER_CODEX_MAX_LINE_BYTES = String(64 * 1024);
process.env.AETHER_GROK_MAX_LINE_BYTES = String(64 * 1024);

const { isExpectedError } = await import('../observability/event');
for (const [status, expected] of [[undefined, false], [400, false], [429, true]] as const) {
  const error = claudeTurnFailure(result({is_error:true,subtype:'success',result:'Claude AI usage limit reached|1700000000',api_error_status:status}));
  assert.equal(isExpectedError(error), expected, `사용 한도 문구의 수집 제외는 상위 상태 ${status}를 따른다`);
}
const { CodexRpcError } = await import('../codex/appServer');
const { GrokRpcError } = await import('../providers/grok/transport');
for (const message of ["You're out of usage credits", 'Authentication token expired. Please login again', 'Service overloaded', 'Request timed out']) {
  assert(isExpectedError(claudeTurnFailure(result({is_error:true,result:message}))), message);
  assert(isExpectedError(new CodexRpcError(-32000, message)), message);
  assert(isExpectedError(new GrokRpcError(-32603, message)), message);
}
for (const message of ['invalid request payload', 'failed to parse response', 'unknown failure']) {
  assert(!isExpectedError(claudeTurnFailure(result({is_error:true,result:message}))));
  assert(!isExpectedError(new CodexRpcError(-32602, message)));
  assert(!isExpectedError(new GrokRpcError(-32603, message)));
}

for (const message of ['API Error: 401', 'API Error: 529 overloaded', 'Failed to authenticate', '{"error":{"type":"invalid_grant"}}']) {
  assert(isExpectedError(claudeTurnFailure(result({is_error:true,result:message}))), message);
}
assert(!isExpectedError(claudeTurnFailure(result({subtype:'error_during_execution',errors:['rate limit exceeded','failed to parse response']}))), '여러 원인 중 해석 실패가 있으면 수집한다');
const { classifyServiceError: classifyClaude } = await import('../providers/claude/errorOrigin');
const { classifyServiceError: classifyCodex } = await import('../providers/codex/errorOrigin');
const { classifyServiceError: classifyGrok } = await import('../providers/grok/errorOrigin');
for (const classify of [classifyClaude, classifyCodex, classifyGrok]) {
  assert(isExpectedError(classify(Object.assign(new Error('서비스가 돌려준 인증 실패'), {status:401}), true)));
  assert(!isExpectedError(classify(new SyntaxError('failed to parse rate_limit_error response'))));
}

// 내부 상태 번호와 문구 일부만으로 외부 환경이라고 단정하지 않는다.
for (const classify of [classifyClaude, classifyCodex, classifyGrok]) {
  for (const status of [401,403,429,500]) {
    assert(!isExpectedError(classify(Object.assign(new Error('Aether 내부 라우트 실패'), {status}))), `출처 없는 ${status}는 수집한다`);
  }
  for (const message of ['unauthorized field in Aether request', 'rate limit counter invariant failed', 'usage limit parsing failed', 'failed to parse authentication_error', 'Aether request timeout handler crashed', 'Request timed out', 'Service overloaded', 'rate limit exceeded']) {
    assert(!isExpectedError(classify(new Error(message))), message);
  }
}
for (const RpcError of [CodexRpcError, GrokRpcError]) {
  assert(!isExpectedError(new RpcError(-32602, 'Authentication token expired. Please login again')), '잘못 만든 RPC 요청은 인증 문구로 감추지 않는다');
}
const { codexTurnError } = await import('../providers/codex/errorOrigin');
for (const codexErrorInfo of ['usageLimitExceeded','unauthorized','serverOverloaded',{httpConnectionFailed:{httpStatusCode:503}}]) {
  assert(isExpectedError(codexTurnError({message:'서비스 응답',codexErrorInfo})));
}
assert(!isExpectedError(codexTurnError({message:'잘못 만든 요청',codexErrorInfo:'badRequest'})));
assert(!isExpectedError(codexTurnError({message:'invalid request: unauthorized field',codexErrorInfo:'badRequest'})), '구조화된 요청 결함을 오류 문구로 덮어쓰지 않는다');
assert(!isExpectedError(codexTurnError({message:'해석 실패',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:400}}})));
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');
const { ErrorJournal } = await import('../observability/journal');
const directory = await fs.mkdtemp(path.join(os.tmpdir(),'aether-adapter-origin-'));
const journal = new ErrorJournal({directory});
try {
  for (const message of ['rate limit exceeded','Authentication token expired. Please login again']) {
    for (const error of [claudeTurnFailure(result({is_error:true,result:message})),new CodexRpcError(-32000,message),new GrokRpcError(-32603,message)]) {
      assert.equal((await journal.record(error,{component:'test',operation:'adapter.failure'})).id,'');
    }
  }
  for (const error of [claudeTurnFailure(result({is_error:true,result:'해석 실패'})),new CodexRpcError(-32603,'해석 실패'),new GrokRpcError(-32603,'해석 실패')]) {
    assert((await journal.record(error,{component:'test',operation:'adapter.failure'})).durable);
  }
  assert.equal((await journal.status()).pending,3);
} finally {await journal.close();await fs.rm(directory,{recursive:true,force:true});}

/** 콘솔 전용 실패: 소유 파일·가짜 provider 결과와 어댑터 수신 경계를 각각 검증한다. */
{
const { test } = await import('node:test');
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const { StringDecoder } = await import('node:string_decoder');
type ErrorEvent = import('../../shared/errors').ErrorEvent;
const { config } = await import('../config');
const { ErrorJournal } = await import('../observability/journal');
const { setErrorJournal } = await import('../observability/report');
const { makeErrorEvent, classifyError } = await import('../observability/event');
const { SessionEventLog } = await import('../sessions/eventLog');
const { __registerProviderForTest } = await import('../providers/registry');
const mock = await import('./support/mockProvider');
const { sessionManager } = await import('../sessions/SessionManager');
await (await import('./support/tempDb')).useTempDiary("error_collection_adapters"); // 임시 SQLite 일기
const rows: ErrorEvent[] = [];
const journal = new ErrorJournal({ directory: path.join(config.dataDir, 'errors') });
journal.record = async (error, details) => {
  const event = makeErrorEvent(error, details, 'test'); rows.push(event);
  return { id: event.id, durable: true };
};
setErrorJournal(journal);
const unregister = __registerProviderForTest(mock.mockEntry);
try {
  await test('H1 사용자 실행기 규칙 목록·읽기의 권한 거부는 제외하고 예상 밖 예외는 warning이다', async () => {
    const { countAllowRules } = await import('../providers/codex/permissionPolicy');
    const home = fs.mkdtempSync('/private/tmp/aether-user-rules-');
    const dir = path.join(home, 'rules'), file = path.join(dir, 'user.rules');
    fs.mkdirSync(dir); fs.writeFileSync(file, 'prefix_rule(pattern=["git"], decision="allow")');
    const list = fs.readdirSync, read = fs.readFileSync;
    try {
      for (const stage of ['list', 'read']) for (const code of ['EACCES', 'EPERM', 'EIO', 'TypeError', 'SyntaxError']) {
        assert.equal(countAllowRules(home), 1); rows.length = 0;
        const error = code === 'TypeError' ? new TypeError('규칙 읽기 결함') : code === 'SyntaxError' ? new SyntaxError('규칙 읽기 결함') : Object.assign(new Error('규칙 읽기 실패'), { code });
        if (stage === 'list') fs.readdirSync = ((p: any, ...args: any[]) => { if (p === dir) throw error; return (list as any)(p, ...args); }) as typeof list;
        else fs.readFileSync = ((p: any, ...args: any[]) => { if (p === file) throw error; return (read as any)(p, ...args); }) as typeof read;
        assert.equal(countAllowRules(home), null);
        fs.readdirSync = list; fs.readFileSync = read;
        const expected = code === 'EIO' || code === 'TypeError' || code === 'SyntaxError';
        assert.equal(rows.length, expected ? 1 : 0, `${stage}:${code}`);
        if (expected) assert.equal(rows[0].severity, 'warning');
      }
    } finally { fs.readdirSync = list; fs.readFileSync = read; fs.rmSync(home, { recursive: true, force: true }); }
  });
  await test('H1 작업 경로의 사용자 권한 거부는 제외하고 Aether 작업 복사본과 원인 불명은 warning이다', async () => {
    const workspace = await import('../sessions/isolatedWorkspace');
    const { applyRestore, checkpointsForApproval } = await import('../sessions/rewind');
    const { resolveFileUnderCwd } = await import('../sessions/safePath');
    const root = fs.mkdtempSync('/private/tmp/aether-path-owner-');
    // 가짜 git: 보호 확인용 config 호출에는 표식만, 나머지는 빈 성공으로 답한다.
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n[ "$1" = config ] && printf \'command\\0aether.guard\\0\'\nexit 0\n', { mode: 0o755 });
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    const oldRoot = process.env.AETHER_WORKTREE_DIR;
    process.env.AETHER_WORKTREE_DIR = path.join(root, 'owned');
    const stat = fs.statSync, realpath = fs.realpathSync;
    try {
      // startsWith로 소유 경계를 판정하면 owned-sibling도 소유 경로로 잘못 본다.
      for (const owner of ['owned', 'owned-sibling']) for (const code of ['EACCES', 'EPERM', 'EIO', 'TypeError']) {
        const error = () => code === 'TypeError' ? new TypeError('경로 확인 결함') : Object.assign(new Error('경로 확인 실패'), { code });
        const expected = owner === 'owned' || code === 'EIO' || code === 'TypeError';
        for (const operation of ['linked', 'exists', 'same', 'approval', 'restore', 'parent']) {
          const cwd = path.join(root, owner, code, operation); fs.mkdirSync(cwd, { recursive: true });
          fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: unused');
          fs.writeFileSync(path.join(cwd, 'file.txt'), '이전 내용');
          const copy = path.join(root, 'owned', code, 'copy'); fs.mkdirSync(copy, { recursive: true });
          fs.writeFileSync(path.join(copy, '.git'), 'gitdir: unused');
          rows.length = 0;
          const marker = path.join(cwd, '.git'), parent = path.join(cwd, 'missing');
          if (operation === 'parent') fs.mkdirSync(parent);
          fs.statSync = ((p: any, ...args: any[]) => { if ((operation === 'linked' && p === marker) || (operation === 'exists' && p === cwd)) throw error(); return (stat as any)(p, ...args); }) as typeof stat;
          fs.realpathSync = ((p: any, ...args: any[]) => {
            if ((['same', 'approval', 'restore'].includes(operation) && p === cwd) || (operation === 'parent' && p === parent)) throw error();
            return (realpath as any)(p, ...args);
          }) as typeof realpath;
          if (operation === 'linked') assert.equal(workspace.isLinkedWorktree(cwd), false);
          if (operation === 'exists') assert.equal(workspace.isolatedWorkspaceExists(cwd), false);
          // samePath에서 두 번째 인자의 소유도 판정한다.
          if (operation === 'same') assert.equal((await workspace.workspaceCopyState(copy, cwd)).needsApply, false);
          if (operation === 'approval') assert.equal(checkpointsForApproval(1, { kind: 'edit', path: 'file.txt', files: [{ path: 'file.txt' }] }, cwd)[0].ok, true);
          if (operation === 'restore') assert.deepEqual(applyRestore(cwd, []), { restored: [], failed: [] });
          if (operation === 'parent') assert.throws(() => resolveFileUnderCwd(cwd, 'missing/new.txt'));
          fs.statSync = stat; fs.realpathSync = realpath;
          assert.equal(rows.length, expected ? 1 : 0, `${owner}:${code}:${operation}`);
          if (rows.length) assert.equal(rows[0].severity, 'warning');
        }
      }
      const alias = path.join(root, 'alias'); fs.symlinkSync(path.join(root, 'owned'), alias);
      process.env.AETHER_WORKTREE_DIR = alias;
      assert(workspace.isManagedWorkspacePath(path.join(alias, 'copy')));
      assert(workspace.isManagedWorkspacePath(path.join(root, 'owned', 'copy')));
      assert(!workspace.isManagedWorkspacePath(path.join(root, 'owned-sibling', 'copy')));
    } finally {
      fs.statSync = stat; fs.realpathSync = realpath;
      process.env.PATH = oldPath;
      if (oldRoot === undefined) delete process.env.AETHER_WORKTREE_DIR; else process.env.AETHER_WORKTREE_DIR = oldRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  await test('H1 저장 모델 손상은 provider별 첫 건만 기록하고 파일 변경·정상 복구 뒤 다시 기록한다', async () => {
    const dm = await import('../providers/distillModel');
    const file=path.join(config.dataDir, `distill-model-${mock.MOCK_PROVIDER}.json`);
    try {
      fs.writeFileSync(file,'{broken-h1'); rows.length=0;
      for(let i=0;i<4;i++) dm.cachedModel(mock.MOCK_PROVIDER);
      assert.equal(rows.length,1);
      fs.writeFileSync(file,'{changed-h1'); dm.cachedModel(mock.MOCK_PROVIDER);
      assert.equal(rows.length,2);
      fs.writeFileSync(file,JSON.stringify({model:'small'})); dm.cachedModel(mock.MOCK_PROVIDER);
      fs.writeFileSync(file,'{broken-h1'); dm.cachedModel(mock.MOCK_PROVIDER);
      assert.equal(rows.length,3);
    } finally {fs.rmSync(file,{force:true});}
  });
  await test('H1 선택적 소유 파일은 부재를 제외하고 손상·I/O를 반복 억제한 error로 남긴다', async () => {
    const {loadCheckpoints}=await import('../sessions/rewind');
    const id='33333333-3333-4333-8333-333333333333';
    fs.mkdirSync(path.join(config.dataDir,id),{recursive:true});
    const cases: [string,()=>unknown][]=[
      [path.join(config.dataDir,id,'checkpoints.json'),()=>loadCheckpoints(id)],
    ];
    for(const [file,read] of cases) {
      fs.rmSync(file,{force:true}); rows.length=0; read(); assert.equal(rows.length,0,file);
      fs.writeFileSync(file,'{broken'); read(); read();
      assert.equal(rows.length,1,file);assert.equal(rows[0].severity,'error');
      fs.rmSync(file); read();
      const original=fs.readFileSync;
      fs.readFileSync=((p:any,...args:any[])=>{if(p===file) throw Object.assign(new Error('H1 I/O'),{code:'EIO'});return (original as any)(p,...args);}) as typeof original;
      rows.length=0;
      try {read();read();} finally {fs.readFileSync=original;}
      assert.equal(rows.length,1,file);assert.equal(rows[0].code,'EIO');
    }
  });
  await test('H1 사건 해석 실패는 미리보기를 줄인 warning이며 같은 codec의 반복 실패를 억제한다', async () => {
    const {lastWorkPreview}=await import('../sessions/workPreview');
    let broken=true;
    const codec={normalize:(ev:any)=>{if(broken && ev.seq===2)throw new Error('H1 codec');return [];}} as any;
    const events=[{seq:1,ts:1,kind:'status',status:'completed'},{seq:2,ts:2,kind:'status',status:'completed'}] as any;
    rows.length=0;for(let i=0;i<4;i++)lastWorkPreview(events,codec);
    assert.equal(rows.length,1);assert.equal(rows[0].severity,'warning');
    broken=false;lastWorkPreview(events,codec);broken=true;lastWorkPreview(events,codec);assert.equal(rows.length,2);
  });
  await test('H1 통신 JSON 손상은 통신선별 warning이며 정상 메시지 뒤 재발을 기록한다', async () => {
    for(const [module,name] of [['../codex/appServer','CodexAppServer'],['../providers/grok/transport','GrokStdio']] as const) {
      const Transport=(await import(module))[name];const t=Object.create(Transport.prototype) as any;
      Object.assign(t,{pending:new Map(),opts:{onNotification:()=>{}},malformedLines:0}); rows.length=0;
      for(let i=0;i<4;i++)t.handleLine('{broken');
      assert.equal(rows.length,1,name);assert.equal(rows[0].severity,'warning');
      t.handleLine('{"jsonrpc":"2.0","method":"h1/notification"}');t.handleLine('{broken');assert.equal(rows.length,2,name);
    }
  });
  await test('H1 인증 조회의 해석 결함은 warning이며 정상 미인증은 수집하지 않는다', async () => {
    const {tailscaleResolver}=await import('../auth/tailscale');
    const cli=path.join(config.dataDir,'h1-whois');const original=config.tailscaleCli;
    try {
      config.tailscaleCli=cli;rows.length=0;
      fs.writeFileSync(cli,'#!/bin/sh\nprintf \'%s\' \'{}\'\n',{mode:0o700});
      assert.equal(await tailscaleResolver('192.0.2.1',1),null);assert.equal(rows.length,0);
      fs.writeFileSync(cli,'#!/bin/sh\nprintf \'%s\' \'{broken\'\n');
      for(let i=0;i<3;i++)assert.equal(await tailscaleResolver(`192.0.2.${i+2}`,1),null); // 조회 결과는 ip별로 기억되므로 매번 다른 ip
      assert.equal(rows.length,1);assert.equal(rows[0].severity,'warning');
    } finally {config.tailscaleCli=original;fs.rmSync(cli,{force:true});}
  });
  await test('H1 JWT 설정 결함은 error로 수집하고 변조 토큰의 정상 거절은 수집하지 않는다', async () => {
    const {verifySession}=await import('../auth/jwt');
    const original=process.env.AETHER_JWT_SECRET;
    try {
      delete process.env.AETHER_JWT_SECRET; rows.length=0;
      for(let i=0;i<3;i++) assert.equal(await verifySession('invalid'),false);
      assert.equal(rows.length,1);assert.equal(rows[0].severity,'error');
      process.env.AETHER_JWT_SECRET='h1-test-only-secret-32-characters-long';
      assert.equal(await verifySession('invalid'),false);rows.length=0;
      assert.equal(await verifySession('invalid'),false);assert.equal(rows.length,0);
    } finally {if(original===undefined)delete process.env.AETHER_JWT_SECRET;else process.env.AETHER_JWT_SECRET=original;}
  });
  await test('H1 Ollama 어댑터는 연결 실패만 제외하고 해석·분류 불명의 원인을 유지한다', async () => {
    const {fetchOllamaModels,ollamaModelWindow}=await import('../providers/ollama/models');
    const original=globalThis.fetch;
    try {
      for(const [source,expected] of [[new TypeError('fetch failed'),true],[Object.assign(new Error('시간 초과'),{name:'TimeoutError'}),true],[new SyntaxError('잘못된 JSON'),false],[new Error('내부 요청 결함'),false]] as const) {
        globalThis.fetch=async()=>{throw source;};
        await assert.rejects(fetchOllamaModels(),error=>{assert(error instanceof Error);assert.equal(error.cause,source);assert.equal(isExpectedError(error),expected);return true;});
      }
      rows.length=0;globalThis.fetch=async()=>new Response('{broken');
      for(let i=0;i<3;i++)await ollamaModelWindow('h1-window');
      assert.equal(rows.length,1);assert.equal(rows[0].severity,'warning');
      globalThis.fetch=async()=>new Response('{"parameters":"num_ctx 8192"}');
      assert.equal(await ollamaModelWindow('h1-window'),8192);
      globalThis.fetch=async()=>new Response('{broken');await ollamaModelWindow('h1-window');assert.equal(rows.length,2);
    } finally {globalThis.fetch=original;}
  });
  await test('Claude 실제 수신 루프는 상태 없는 assistant 오류를 연결하고 다음 턴에 누수하지 않는다', async () => {
    const { ClaudeRuntime } = await import('../sessions/runtimes/claude');
    const runtime=Object.create(ClaudeRuntime.prototype) as any;
    runtime.opts={sessionId:'claude-signals',onResumeKey:()=>{}};
    runtime.qh=(async function*(){
      yield {type:'assistant',parent_tool_use_id:null,error:'rate_limit',message:{content:[]}};
      yield result({is_error:true,result:'새로운 사용 한도 문구'});
      yield result({is_error:true,result:'다음 턴 해석 실패'});
    })();
    rows.length=0;
    let count=0;for await(const _event of runtime.events()) count++;
    assert.equal(count,3,'기존 사건은 모두 그대로 전달한다');
    assert.equal(rows.length,1);assert.equal(rows[0].message,'다음 턴 해석 실패');
  });
  await test('Claude 배경 작업도 구조화 원인을 보존하고 기존 실패 메시지를 유지한다', async () => {
    const { runDistill, setClaudeDistillSpawnForTest } = await import('../providers/claude/distill');
    for(const kind of ['rate_limit','invalid_request','max_output_tokens'] as const) {
      setClaudeDistillSpawnForTest((_cwd,input)=>({
        supportedModels:async()=>[],setModel:async()=>{},applyFlagSettings:async()=>{},interrupt:async()=>{},close:()=>input.close(),
        async *[Symbol.asyncIterator]() {
          for await(const _input of input.stream()) {
            yield {type:'assistant',parent_tool_use_id:null,error:kind,message:{content:[]}};
            yield result({is_error:true,result:'rate limit exceeded'});
          }
        },
      }));
      try {
        await assert.rejects(runDistill('입력',config.dataDir,{use:'account_default'}),error=>{
          assert(error instanceof Error);assert.equal(error.name,'TurnFailedError');
          assert.equal(error.message,'rate limit exceeded');
          assert.equal(isExpectedError(error),kind==='rate_limit',kind);
          return true;
        });
      } finally {setClaudeDistillSpawnForTest(null);}
    }
  });
  await test('Claude 모델 선택 질문의 구조화 외부 오류도 삼키는 catch 전에 분류한다', async () => {
    const { runDistill, setClaudeDistillSpawnForTest } = await import('../providers/claude/distill');
    const dm=await import('../providers/distillModel');
    dm.forgetModel('claude');dm.resetDistillModelMemory('claude');
    setClaudeDistillSpawnForTest((_cwd,input)=>({
      supportedModels:async()=>[{value:'small',displayName:'Small',description:''}],setModel:async()=>{},applyFlagSettings:async()=>{},interrupt:async()=>{},close:()=>input.close(),
      async *[Symbol.asyncIterator]() {
        let n=0;for await(const _input of input.stream()) {
          if(n++===0) {
            yield {type:'assistant',parent_tool_use_id:null,error:'rate_limit',message:{content:[]}};
            yield result({is_error:true,result:'새 서비스 한도 문구'});
          } else yield result({result:'기존 작업 답'});
        }
      },
    }));
    rows.length=0;
    try {assert.equal(await runDistill('입력',config.dataDir),'기존 작업 답');assert.equal(rows.length,0);}
    finally {setClaudeDistillSpawnForTest(null);dm.resetDistillModelMemory('claude');}
  });
  await test('저장 모델의 정상 부재·옛 default 호환과 손상·I/O 실패를 구분한다', async () => {
    const dm = await import('../providers/distillModel');
    const file = path.join(config.dataDir, `distill-model-${mock.MOCK_PROVIDER}.json`);
    fs.rmSync(file, {force:true}); rows.length = 0;
    assert.equal(dm.cachedModel(mock.MOCK_PROVIDER), undefined);
    fs.writeFileSync(file, JSON.stringify({model:'default',rule:dm.PICK_RULE}));
    assert.equal(dm.cachedModel(mock.MOCK_PROVIDER), undefined);
    assert.equal(rows.length, 0);
    for (const value of ['{broken', 'null', '{}', '{"model":42}', '{"model":""}']) {
      fs.writeFileSync(file, value); rows.length = 0;
      assert.equal(dm.cachedModel(mock.MOCK_PROVIDER), undefined);
      assert.equal(rows.length, 1, value);
      assert.equal(rows[0].severity, 'error');
    }
    fs.writeFileSync(file, JSON.stringify({model:"small",rule:dm.PICK_RULE})); dm.cachedModel(mock.MOCK_PROVIDER);
    const read = fs.readFileSync;
    const error = Object.assign(new Error('시험 선택 파일 I/O'), {code:'EIO'});
    fs.readFileSync = ((p: any, ...args: any[]) => {if(p===file) throw error; return (read as any)(p,...args);}) as typeof read;
    rows.length = 0;
    try {assert.equal(dm.cachedModel(mock.MOCK_PROVIDER), undefined);} finally {fs.readFileSync=read; fs.rmSync(file);}
    assert.equal(rows[0].stack, error.stack);
    assert.equal(rows[0].code, 'EIO');
  });
  await test('모델의 명시적인 선택 포기만 정상이며 해석 불명과 잘못된 후보는 warning이다', async () => {
    const dm = await import('../providers/distillModel');
    for (const [answer, models, collected] of [
      ['NONE', [{value:'small'}], false],
      ['가장 싼 것은 small입니다', [{value:'small'}], true],
      ['old-model', [{value:'small'}], true],
      ['-invalid', [{value:'-invalid'}], true],
    ] as const) {
      dm.resetDistillModelMemory(mock.MOCK_PROVIDER); rows.length = 0;
      assert.equal(await dm.pickCheapest(mock.MOCK_PROVIDER, models, async()=>answer), undefined);
      assert.equal(rows.length, collected ? 1 : 0, answer);
      if(collected) assert.equal(rows[0].severity, 'warning');
    }
  });
  await test('사용자 지정 이름 거절과 저장값 적용 실패는 출처와 어댑터 원인을 따른다', async () => {
    const dm = await import('../providers/distillModel');
    const file = path.join(config.dataDir, `distill-model-${mock.MOCK_PROVIDER}.json`);
    try {
      for(const [pinned, external, collected] of [[true,false,false],[false,true,false],[false,false,true]] as const) {
        dm.bindDistillPinLookup(()=>pinned ? {model:'old'} : undefined);
        fs.rmSync(file,{force:true}); if(!pinned) fs.writeFileSync(file, JSON.stringify({model:'old',rule:dm.PICK_RULE}));
        dm.resetDistillModelMemory(mock.MOCK_PROVIDER); rows.length=0;
        await dm.resolveAndApply(mock.MOCK_PROVIDER, [{value:"old"}], async()=>{
          const e = new dm.UnknownModelNameError('old');
          throw external ? classifyError(e,'external_environment') : e;
        }, async()=> 'NONE');
        assert.equal(rows.length,collected ? 1 : 0);
        if(collected) assert.equal(rows[0].severity,'warning');
      }
    } finally {dm.bindDistillPinLookup(()=>undefined); fs.rmSync(file,{force:true});}
  });
  await test('Claude 모델 거절 문구는 어댑터에서 중립 오류로 바꾸고 원래 오류를 보존한다', async () => {
    const { modelSelectionError } = await import('../providers/claude/errorOrigin');
    const { isUnknownNameError } = await import('../providers/distillModel');
    const raw = new Error('Model "old" is not a recognized model id.');
    assert(!isUnknownNameError(raw), '공통 계층은 서비스 문구를 해석하지 않는다');
    const converted = modelSelectionError(raw,'old') as Error;
    assert(isUnknownNameError(converted)); assert(isExpectedError(converted));
    assert.equal(converted.cause,raw);
    const io=new Error('제어 요청 해석 실패'); assert.equal(modelSelectionError(io,'old'),io);
  });
  await test('Codex 스킬 오류는 원인 코드가 없어 사용자 파일 여부를 추정하지 않고 warning으로 수집한다', async () => {
    const { CodexRuntime } = await import('../sessions/runtimes/codex');
    const runtime = Object.create(CodexRuntime.prototype) as any;
    runtime.opts={sessionId:'skills-test',cwd:config.dataDir};
    runtime.server={request:async()=>({data:[{cwd:config.dataDir,skills:[],errors:[{path:'/test/user/SKILL.md',message:'읽기 또는 해석 실패'}]}]})};
    rows.length=0; await runtime.refreshSkills();
    assert.equal(rows.length,1); assert.equal(rows[0].severity,'warning');
    assert.equal(rows[0].session_id,'skills-test');
  });
  await test('사건 저장 실패는 session_id와 원래 stack을 error로 남긴다', async () => {
    const diary = await import('../db/sessionDiary');
    const id = '11111111-1111-4111-8111-111111111111';
    fs.mkdirSync(path.join(config.dataDir, id), { recursive: true });
    const log = new SessionEventLog(id);
    const settle = async () => { await new Promise(r => setImmediate(r)); };
    const { DatabaseSync } = await import('node:sqlite');
    const exec = DatabaseSync.prototype.exec;
    const breakWrites = (message: string) => { DatabaseSync.prototype.exec = function (this: InstanceType<typeof DatabaseSync>, sql: string) { if (sql === 'BEGIN IMMEDIATE') throw new Error(message); return exec.call(this, sql); }; };
    const failing = () => breakWrites('시험 저장 장애');
    try {
      failing();
      rows.length = 0;
      log.write({ kind: 'status', status: 'completed' }, ev => ev);
      await settle();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].severity, 'error');
      assert.equal(rows[0].session_id, id);
      assert.match(rows[0].stack!, /시험 저장 장애/);
      for (let i = 0; i < 4; i++) log.write({ kind: 'status', status: 'completed' }, ev => ev);
      await settle();
      assert.equal(rows.length, 1, '같은 세션의 연속 저장 실패는 처음 한 번만 수집한다');
      assert.equal(rows[0].session_seq, 1);
      DatabaseSync.prototype.exec = exec;
      log.write({ kind: 'status', status: 'completed' }, ev => ev);
      await settle();
      failing();
      log.write({ kind: 'status', status: 'completed' }, ev => ev);
      await settle();
      assert.equal(rows.length, 2, '성공 뒤 재발한 실패는 다시 수집한다');
    } finally { DatabaseSync.prototype.exec = exec; log.abandon(); }
  });
  await test('디스크 장애 때 사건 저장과 순번 파일의 반복 실패를 각각 한 번만 수집한다', async () => {
    const diary = await import('../db/sessionDiary');
    const id = '22222222-2222-4222-8222-222222222222';
    fs.mkdirSync(path.join(config.dataDir, id), { recursive: true });
    const log = new SessionEventLog(id);
    const open = fs.openSync;
    const { DatabaseSync } = await import('node:sqlite');
    const exec = DatabaseSync.prototype.exec;
    const settle = async () => { await new Promise(r => setImmediate(r)); };
    const block = () => {
      DatabaseSync.prototype.exec = function (this: InstanceType<typeof DatabaseSync>, sql: string) { if (sql === 'BEGIN IMMEDIATE') throw new Error('시험 디스크 장애'); return exec.call(this, sql); };
      fs.openSync = ((file: any, ...args: any[]) => {
        if (file === path.join(config.dataDir, id, 'seq-high.tmp')) throw new Error('시험 디스크 장애');
        return (open as any)(file, ...args);
      }) as typeof open;
    };
    const unblock = () => { DatabaseSync.prototype.exec = exec; fs.openSync = open; };
    const write = () => log.write({kind:'status',status:'completed'}, ev=>ev);
    rows.length = 0;
    try {
      block(); for (let i=0; i<4; i++) write(); await settle();
      assert.equal(rows.filter(r=>r.operation==='session.event_log.append').length,1);
      assert.equal(rows.filter(r=>r.operation==='session.sequence.persist').length,1);
      unblock();
      // 순번 파일과 사건 저장 모두 한 번 성공한 뒤 다시 실패시킨다.
      const store = await import('../sessions/persistence'); store.noteHighSeq(id, log.lastAssigned()); write(); await settle();
      block(); write(); await settle();
      assert.equal(rows.filter(r=>r.operation==='session.event_log.append').length,2);
      assert.equal(rows.filter(r=>r.operation==='session.sequence.persist').length,2);
    } finally {unblock(); log.abandon();}
  });
  await test('회상 준비 실패는 warning이며 외부 환경이면 미수집이다', async () => {
    const { CodexRuntime } = await import('../sessions/runtimes/codex');
    const runtime = Object.create(CodexRuntime.prototype) as any;
    runtime.threadId = 'test';
    runtime.opts = { sessionId: 'test', turnContext: async () => { throw new Error('시험 회상 결함'); } };
    rows.length = 0;
    await runtime.injectTurnContext({ prompt: '시험 입력' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, 'warning');
    assert.equal(rows[0].session_id, 'test');
    runtime.opts.turnContext = async () => { throw classifyError(new Error('시험 외부 지연'), 'external_environment'); };
    await runtime.injectTurnContext({ prompt: '시험 입력' });
    assert.equal(rows.length, 1);
  });
  await test('선택적 푸시 파일 부재는 정상이고 실제 저장 실패는 error다', async () => {
    const { addSubscription } = await import('../push');
    rows.length = 0;
    const original = fs.renameSync;
    const error = new Error('시험 구독 저장 실패');
    fs.renameSync = (() => { throw new Error(error.message); }) as typeof original;
    try {
      for (let i = 0; i < 4; i++) addSubscription({ endpoint: `https://example.invalid/test-${i}`, keys: { p256dh: 'test', auth: 'test' } });
    }
    finally { fs.renameSync = original; }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, 'error');
    assert.equal(rows[0].message, error.message);
    addSubscription({ endpoint: 'https://example.invalid/recovered', keys: { p256dh: 'test', auth: 'test' } });
    fs.renameSync = (() => { throw new Error(error.message); }) as typeof original;
    try { addSubscription({ endpoint: 'https://example.invalid/again', keys: { p256dh: 'test', auth: 'test' } }); }
    finally { fs.renameSync = original; }
    assert.equal(rows.length, 2, '구독 저장 성공 뒤 재발한 실패도 다시 수집한다');
  });
  await test('승인 정책 응답 해석 실패는 축소된 정책 표시를 warning으로 남긴다', async () => {
    const { codexPermissionPolicy } = await import('../providers/codex/permissionPolicy');
    rows.length = 0;
    const policy = await codexPermissionPolicy(config.dataDir, false, async () => ({config:{unexpected:true} as any}));
    assert.equal(policy.autoApproveMode, 'unknown');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, 'warning');
  });
  await test('승인 설정 읽기 결함은 warning이며 외부 원인은 수집하지 않는다', async () => {
    const { codexPermissionPolicy } = await import('../providers/codex/permissionPolicy');
    rows.length = 0;
    await codexPermissionPolicy(config.dataDir, false, async () => { throw new Error('시험 승인 설정 읽기 결함'); });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, 'warning');
    await codexPermissionPolicy(config.dataDir, false, async () => { throw classifyError(new Error('시험 외부 설정 조회 지연'), 'external_environment'); });
    assert.equal(rows.length, 1);
  });
  await test('미등록 번역 키와 데스크톱 구독자 결함은 warning으로 수집한다', async () => {
    const { st } = await import('../i18n');
    const { subscribeDesktopNotify, emitDesktopNotify } = await import('../notify/desktop');
    rows.length = 0;
    assert.equal(st('test.missing.key'), 'test.missing.key');
    const unsub = subscribeDesktopNotify(() => { throw new Error('시험 알림 구독자'); });
    try { emitDesktopNotify({} as any); } finally { unsub(); }
    assert.equal(rows.length, 2);
    assert(rows.every(r => r.severity === 'warning'));
  });
} finally { unregister(); setErrorJournal(undefined); await journal.close(); }

// 실제 프로세스를 띄우지 않고 바이트 분할 수신과 반복 버림을 주입한다.
for (const [module, className, limit] of [
  ['../codex/appServer', 'CodexAppServer', config.codexMaxLineBytes],
  ['../providers/grok/transport', 'GrokStdio', config.grokMaxLineBytes],
] as const) {
  await test(`${className}: 긴 줄 여러 건을 버려도 통신선당 warning 1건이다`, async () => {
    const Transport = (await import(module))[className];
    const t = Object.create(Transport.prototype) as any;
    Object.assign(t, { decoder: new StringDecoder('utf8'), stdoutBuf: '', skipping: false, droppedLines: 0 });
    rows.length = 0; setErrorJournal(journal);
    try {
      for (let i = 0; i < 5; i++) { t.onStdout(Buffer.from('x'.repeat(limit + 1))); t.onStdout(Buffer.from('\n')); }
      assert.equal(t.droppedLines, 5);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].severity, 'warning');
      assert.match(rows[0].operation, /^provider\.output\.drop$/);
    } finally { setErrorJournal(undefined); }
  });
}

}

/** H2: 소유 파일과 DB 실패, 부분 발행 실패는 정상 부재와 구분한다. */
{
  const { test } = await import('node:test');
  const syncFs = (await import('node:fs')).default;
  const { config } = await import('../config');
  const { probeDatabase } = await import('../db/status');
  const { setErrorJournal } = await import('../observability/report');
  const { makeErrorEvent } = await import('../observability/event');
  const rows: import('../../shared/errors').ErrorEvent[] = [];
  setErrorJournal({ record: async (error: unknown, details: import('../observability/event').ErrorDetails) => {
    const row = makeErrorEvent(error, details, 'h2'); rows.push(row); return {id:row.id,durable:true};
  }} as unknown as import('../observability/journal').ErrorJournal);
  try {
    await test('DB probe도 소유 DB 실패를 수집하고 성공 때 억제를 푼다', async () => {
      const { configureDatabase, __resetDatabaseForTest } = await import('../db/sqlite');
      const dir=syncFs.mkdtempSync(path.join(os.tmpdir(),'aether-h2-probe-'));
      // 파일 아래 경로는 폴더를 만들 수 없어 열기가 실패한다.
      const blocker=path.join(dir,'blocker');syncFs.writeFileSync(blocker,'');
      const bad=path.join(blocker,'aether.sqlite');
      rows.length=0;
      try {
        configureDatabase({path:bad});
        for(let i=0;i<3;i++){assert.equal(probeDatabase(),'down');}
        assert.equal(rows.length,1);assert(rows.every(r=>r.severity==='error'));
        configureDatabase({path:path.join(dir,'aether.sqlite')});assert.equal(probeDatabase(),'up');
        configureDatabase({path:bad});probeDatabase();assert.equal(rows.length,2);
      } finally {__resetDatabaseForTest();syncFs.rmSync(dir,{recursive:true,force:true});}
    });
    await test('푸시 전송은 서비스·네트워크 실패를 제외하고 내부 실패만 반복 억제해 수집한다', async () => {
      const webpush=(await import('web-push')).default;
      const push=await import('../push');
      const send=webpush.sendNotification,setVapid=webpush.setVapidDetails;
      const oldPublic=process.env.AETHER_VAPID_PUBLIC,oldPrivate=process.env.AETHER_VAPID_PRIVATE;
      process.env.AETHER_VAPID_PUBLIC='test-public';process.env.AETHER_VAPID_PRIVATE='test-private';
      webpush.setVapidDetails=()=>{};
      const sub={endpoint:'https://push.example.test/h2',keys:{auth:'test',p256dh:'test'}};
      push.addSubscription(sub);
      rows.length=0;
      let cause: unknown=new Error('H2 푸시 구성 결함');
      webpush.sendNotification=(async()=>{if(cause)throw cause;return {} as any;}) as typeof send;
      const sendOne=async()=>{push.notifyPush({title:'test',body:'',sessionId:'h2-push'});await new Promise(r=>setImmediate(r));};
      try {
        for(let i=0;i<4;i++){cause=new Error('H2 푸시 구성 결함');await sendOne();}
        assert.equal(rows.length,1);assert.equal(rows[0].severity,'error');assert.equal(rows[0].session_id,'h2-push');
        for(const external of [{statusCode:429},{statusCode:503},{code:'ECONNRESET'}]){cause=external;await sendOne();}
        assert.equal(rows.length,1);
        cause=null;await sendOne();cause=new Error('H2 복구 후 푸시 결함');await sendOne();assert.equal(rows.length,2);
      } finally {
        push.removeSubscription(sub.endpoint);webpush.sendNotification=send;webpush.setVapidDetails=setVapid;
        if(oldPublic===undefined)delete process.env.AETHER_VAPID_PUBLIC;else process.env.AETHER_VAPID_PUBLIC=oldPublic;
        if(oldPrivate===undefined)delete process.env.AETHER_VAPID_PRIVATE;else process.env.AETHER_VAPID_PRIVATE=oldPrivate;
      }
    });
  } finally {setErrorJournal(undefined);}
}
