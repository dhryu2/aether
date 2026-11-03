/** 격리 fixture 서버와 전용 Chrome에서만 실행한다. 실서버·실모델을 사용하지 않는다. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const origin = process.argv[2] ?? 'http://127.0.0.1:18991';
const port = Number(process.env.CDP_PORT ?? 19291);
let online = false;
const received: { id: string; message: string }[] = [];
const status = { delivery:'retrying',pending:3,lastSuccess:'2026-10-16T09:00:00Z',retryCount:2,fileFailures:0,lost:{count:2,from:'2026-10-01',to:'2026-10-02',reason:'capacity'} };
async function tab() {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>(r=>ws.addEventListener('open',()=>r(),{once:true}));
  let id=0;const pending=new Map<number,(v:any)=>void>();
  const send=(method:string,params:any={})=>new Promise<any>(r=>{pending.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
  ws.addEventListener('message',async e=>{
    const m=JSON.parse(String(e.data));if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);return;}
    if(m.method==='Fetch.requestPaused') {
      const p=m.params,isStatus=p.request.url.endsWith('/status');
      if(p.request.method==='GET'&&!isStatus){
        // 오류 기록 조회(GET /api/errors?…)는 빈 목록으로 답한다.
        await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],
          body:Buffer.from(JSON.stringify({groups:[],nextCursor:null,total:0})).toString('base64')});
        return;
      }
      const value = isStatus ? status : JSON.parse(p.request.postData);
      if(!isStatus) received.push(value);
      await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:isStatus||online?200:503,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(isStatus?status:{id:value.id,durable:online})).toString('base64')});
    }
  });
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*/api/errors*'}]});
  await send('Page.navigate',{url:origin+'/?s=fixture-claude'});
  const evaluate=async(expression:string)=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  return {send,evaluate,close:async()=>{ws.close();await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);}};
}
const wait=async(fn:()=>Promise<boolean>)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('browser wait timed out');};
const read = `(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('aether-errors',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});return await new Promise(resolve=>{const t=db.transaction('queue');const r=t.objectStore('queue').get('state');r.onsuccess=()=>{resolve(r.result);db.close()}})})()`;
const a=await tab(), b=await tab();
try {
  await wait(async()=>Boolean(await a.evaluate(`document.querySelector('[aria-label="설정"]') !== null`)));
  await wait(async()=>Boolean(await b.evaluate(`document.querySelector('[aria-label="설정"]') !== null`)));
  await a.evaluate(`window.dispatchEvent(new ErrorEvent('error',{error:new Error('browser offline A'),message:'browser offline A'}))`);
  await b.evaluate(`window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{promise:Promise.resolve(),reason:new Error('browser offline B')}))`);
  await wait(async()=>((await a.evaluate(read))?.rows?.length??0)>=2);
  const before=await a.evaluate(read);const ids=before.rows.map((r:any)=>r.event.id);
  online=true;
  await Promise.all([a.evaluate(`window.dispatchEvent(new Event('online'))`),b.evaluate(`window.dispatchEvent(new Event('online'))`)]);
  await wait(async()=>((await a.evaluate(read))?.rows?.length??1)===0);
  assert(ids.every((id:string)=>received.some(r=>r.id===id)));
  // IndexedDB 실패 때 메모리 보관 후 저장소가 돌아오면 같은 id로 보낸다.
  online=false;
  await a.evaluate(`window.__tx=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new Error('quota test')};window.dispatchEvent(new ErrorEvent('error',{error:new Error('quota fallback')}))`);
  await new Promise(r=>setTimeout(r,250));
  await a.evaluate(`IDBDatabase.prototype.transaction=window.__tx`);online=true;
  await a.evaluate(`window.dispatchEvent(new Event('online'))`);
  await wait(async()=>received.some(r=>r.message==='quota fallback'));
  await a.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await a.evaluate(`document.querySelector('[aria-label="설정"]').click()`);
  // 오류 기록은 설정의 '점검' 탭 안에 있다.
  await wait(async()=>Boolean(await a.evaluate(`document.getElementById('settings-tab-diagnostics') !== null`)));
  await a.evaluate(`document.getElementById('settings-tab-diagnostics').click()`);
  // 「오류 기록 ›」 줄이 보이고, 누르면 하위 화면에 빈 상태 문구가 나온다.
  await wait(async()=>String(await a.evaluate('document.body.innerText')).includes('오류 기록'));
  await a.evaluate(`Array.from(document.querySelectorAll('section button')).find(e=>e.innerText.startsWith('오류 기록')).click()`);
  await wait(async()=>String(await a.evaluate('document.body.innerText')).includes('기록된 오류가 없습니다'));
  const shot=await a.send('Page.captureScreenshot',{format:'png'});await fs.writeFile('/private/tmp/aether-errors-settings.png',Buffer.from(shot.data,'base64'));
  assert.equal(await a.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  console.log('✅ 실제 브라우저 IndexedDB·오프라인·두 탭·저장소실패·재전송 ID·설정 상태·폰 너비');
} finally {await a.close();await b.close();}
