const PORT = 9222;
const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res(), { once: true }); ws.addEventListener("error", () => rej(new Error("cdp")), { once: true }); });
let msgId = 0; const waiters = new Map<number, (v: unknown) => void>();
const nets: string[] = [];
const logs: string[] = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (String(r.url).includes("/api/")) nets.push(`${r.status} ${r.url}`);
  }
  if (m.method === "Network.loadingFailed") nets.push("FAIL " + JSON.stringify(m.params).slice(0, 250));
  if (m.method === "Runtime.exceptionThrown") logs.push(String(m.params.exceptionDetails?.exception?.description || "").slice(0, 500));
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
    logs.push("CON " + (m.params.args||[]).map((a:any)=>a.value??a.description??"").join(" ").slice(0,400));
  }
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)!(m.result); waiters.delete(m.id); }
});
function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++msgId; return new Promise((res) => { waiters.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
await send("Runtime.enable"); await send("Console.enable"); await send("Page.enable"); await send("Network.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});
await send("Network.setBypassServiceWorker", { bypass: true });
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: "http://127.0.0.1:8899/?s=dm:fixture-claude" });
await new Promise(r => setTimeout(r, 10000));
const r = await send("Runtime.evaluate", {
  expression: `(() => ({
    text: (document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,400),
    rootLen: (document.getElementById('root')?.innerHTML||'').length,
    loading: !!document.body?.innerText?.includes('불러오는'),
    chip: document.querySelector('[data-attention-chip]')?.getAttribute('data-attention-count'),
    roomN: document.querySelectorAll('[data-room-id]').length,
  }))()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("EVAL", JSON.stringify(r?.result?.value, null, 2));
console.log("NET");
for (const n of nets) console.log(n);
console.log("LOGS");
for (const l of logs.slice(0, 15)) console.log(l);
ws.close();
process.exit(0);
