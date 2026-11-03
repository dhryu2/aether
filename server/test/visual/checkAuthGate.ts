/**
 * 3b — password 픽스처에서 AuthGate → 비번 입력 → 방 목록 + Bearer SSE.
 * 라이브 8787 금지. 픽스처 전용 포트.
 *
 *   AETHER_FIXTURE_AUTH=password CDP_PORT=9222 \
 *     node --import tsx server/test/visual/checkAuthGate.ts http://127.0.0.1:8899
 */
export {};

const [baseArg] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkAuthGate.ts <픽스처 서버 주소>");
  process.exit(2);
}

const base = baseArg.replace(/\/$/, "");
if (base.includes("8787")) {
  console.error("라이브 8787 금지");
  process.exit(1);
}

const port = Number(process.env.CDP_PORT || 9222);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const target = (await (
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
).json()) as { id: string; webSocketDebuggerUrl: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("CDP 연결 실패")), { once: true });
});

let messageId = 0;
const waiters = new Map<number, (value: unknown) => void>();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
  if (message.id != null && waiters.has(message.id)) {
    waiters.get(message.id)!(message.result);
    waiters.delete(message.id);
  }
});
function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++messageId;
  return new Promise<Record<string, unknown>>((resolve) => {
    waiters.set(id, resolve as (v: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate<T>(expression: string): Promise<T> {
  const result = (await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { exceptionDetails?: { text: string }; result?: { value?: T } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value as T;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});

const bearerReqs: string[] = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    method?: string;
    params?: { request?: { url?: string; headers?: Record<string, string> } };
  };
  if (message.method !== "Network.requestWillBeSent") return;
  const req = message.params?.request;
  if (!req?.url) return;
  const headers = req.headers || {};
  const auth = headers.Authorization || headers.authorization || "";
  if (/\/api\/(?:sessions|presence).*stream/.test(req.url) && /^Bearer\s+/i.test(auth)) {
    bearerReqs.push(req.url);
  }
});

let loadDone = false;
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { method?: string };
  if (message.method === "Page.loadEventFired") loadDone = true;
});
await send("Page.navigate", { url: `${base}/` });
for (let attempt = 0; attempt < 50 && !loadDone; attempt += 1) await sleep(100);

// 비번 칸이 보일 때까지
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (await evaluate<boolean>(`!!document.querySelector('[data-auth-password]')`)) break;
  await sleep(100);
}
const hasLogin = await evaluate<boolean>(`!!document.querySelector('[data-auth-password]')`);
check("password 픽스처에서 비번 칸이 보인다", hasLogin);

await evaluate(`(() => {
  const input = document.querySelector('[data-auth-password]');
  if (!(input instanceof HTMLInputElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, 'fixture');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const form = input.closest('form');
  if (form) form.requestSubmit();
  else document.querySelector('[data-auth-submit]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
})()`);

for (let attempt = 0; attempt < 100; attempt += 1) {
  const n = await evaluate<number>(`document.querySelectorAll('[data-room-id]').length`);
  if (n >= 1) break;
  await sleep(100);
}
const rooms = await evaluate<number>(`document.querySelectorAll('[data-room-id]').length`);
check("로그인 후 방 목록 DOM이 보인다", rooms >= 1, { rooms });

// SSE가 붙을 시간
await sleep(1500);
check("Bearer SSE 요청이 있다", bearerReqs.length >= 1, { bearerReqs: bearerReqs.slice(0, 3) });

console.log(`\n${fail === 0 ? "✅" : "❌"} checkAuthGate: ${pass} PASS / ${fail} FAIL`);
try {
  ws.close();
} catch {
  /* */
}
process.exit(fail === 0 ? 0 : 1);
