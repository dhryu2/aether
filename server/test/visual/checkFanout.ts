/**
 * Phase 13c — 같은 일을 여러 장으로 시작하는 새 작업 창.
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkFanout.ts http://127.0.0.1:8899 1440 900
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkFanout.ts http://127.0.0.1:8899 390 844
 */
export {};

const [baseArg, widthArg, heightArg] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkFanout.ts <서버 주소> [너비] [높이]");
  process.exit(2);
}

const base = baseArg.replace(/\/$/, "");
const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const mobile = width < 700;
const port = Number(process.env.CDP_PORT || 9222);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CreatedRow = { id: string; provider: string; lastMessage: string; isolated: boolean };

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
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else failures.push(detail === undefined ? name : `${name} — ${JSON.stringify(detail)}`);
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});
let loadDone = false;
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { method?: string };
  if (message.method === "Page.loadEventFired") loadDone = true;
});
await send("Page.navigate", { url: `${base}/?s=dm:fixture-claude` });
await evaluate(`navigator.serviceWorker?.getRegistrations?.().then((rs) => Promise.all(rs.map((r) => r.unregister()))).catch(() => {})`);
for (let attempt = 0; attempt < 50 && !loadDone; attempt += 1) await sleep(100);
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (await evaluate<boolean>(`!!document.querySelector('[data-session-id="dm:fixture-claude"]') || !!document.querySelector('[aria-label="세션 목록 열기"]')`)) break;
  await sleep(100);
}

async function openList() {
  if (!mobile) return;
  const openedList = await evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="세션 목록 열기"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("모바일에서 세션 목록을 열었다", openedList);
  await sleep(400);
}

async function openModal() {
  await openList();
  const opened = await evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-session-opt="new-work"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("새 작업 창을 열었다", opened);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await evaluate<{ modal: boolean; chips: number }>(`(() => ({
      modal: !!document.querySelector('[data-modal="new-session"]'),
      chips: document.querySelectorAll('[data-modal="new-session"] button[data-provider-id]').length,
    }))()`);
    if (ready.modal && ready.chips >= 2) return;
    await sleep(100);
  }
}

async function created(): Promise<CreatedRow[]> {
  const r = (await (await fetch(`${base}/api/debug/created`)).json()) as { sessions: CreatedRow[] };
  return r.sessions;
}

await fetch(`${base}/api/debug/fail-create`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "" }),
});

console.log(`\n── 새 작업 창 ${width}×${height} ──`);
await openModal();

const idle = await evaluate<{ fanout: boolean; prompt: boolean; team: boolean; mains: number; isolate: boolean; chips: number }>(`(() => {
  const card = document.querySelector('[data-modal="new-session"]');
  return {
    fanout: card instanceof HTMLElement && card.getAttribute("data-fanout") === "1",
    prompt: !!document.querySelector('[data-session-opt="fanout-prompt"]'),
    team: !!(card && card.querySelector('[data-team-run]')),
    mains: document.querySelectorAll("main").length,
    isolate: !!document.querySelector('[data-session-opt="isolate-workspace"]'),
    chips: document.querySelectorAll('[data-modal="new-session"] button[data-provider-id]').length,
  };
})()`);
check("묶음 시작은 기본 꺼짐", idle.fanout === false && idle.prompt === false, idle);
check("복사본 토글이 있다", idle.isolate, idle);
check("서비스 칩이 둘 이상이다", idle.chips >= 2, idle);
check("팀 카드와 섞이지 않는다", idle.team === false, idle);
check("대화 칸은 하나다", idle.mains === 1, idle);

check("Grok 칩을 고른다", await evaluate<boolean>(`(() => {
  const grok = document.querySelector('[data-modal="new-session"] button[data-provider-id="grok"]');
  if (!(grok instanceof HTMLElement)) return false;
  grok.click();
  return true;
})()`));
await sleep(200);
const radio = await evaluate<{ selected: string[] }>(`(() => ({
  selected: [...document.querySelectorAll('[data-modal="new-session"] button[data-provider-selected="1"]')]
    .map((el) => el.getAttribute("data-provider-id") || ""),
}))()`);
check("꺼진 상태의 칩은 하나만 고른다", radio.selected.length === 1 && radio.selected[0] === "grok", radio);

const toggled = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-opt="fanout-start"]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("묶음 시작을 켰다", toggled);
await sleep(200);

const on = await evaluate<{ fanout: boolean; prompt: boolean; selected: string[]; start: string; team: boolean }>(`(() => {
  const card = document.querySelector('[data-modal="new-session"]');
  const start = [...document.querySelectorAll('[data-modal="new-session"] button')]
    .map((el) => (el.textContent || "").replace(/\\s+/g, " ").trim())
    .find((t) => t.includes("장으로 시작") || t.includes("Start")) || "";
  return {
    fanout: card instanceof HTMLElement && card.getAttribute("data-fanout") === "1",
    prompt: !!document.querySelector('[data-session-opt="fanout-prompt"]'),
    selected: [...document.querySelectorAll('[data-modal="new-session"] button[data-provider-selected="1"]')]
      .map((el) => el.getAttribute("data-provider-id") || ""),
    start,
    team: !!(card && card.querySelector('[data-team-run]')),
  };
})()`);
check("켜면 첫 글 칸이 생긴다", on.fanout && on.prompt, on);
check("켜면 지금 고른 서비스가 남는다", on.selected.includes("grok"), on);
check("팀 카드는 여전히 없다", on.team === false, on);

check("Claude 칩을 더한다", await evaluate<boolean>(`(() => {
  const claude = document.querySelector('[data-modal="new-session"] button[data-provider-id="claude"]');
  if (!(claude instanceof HTMLElement)) return false;
  claude.click();
  return true;
})()`));
await sleep(200);
const multi = await evaluate<{ selected: string[] }>(`(() => ({
  selected: [...document.querySelectorAll('[data-modal="new-session"] button[data-provider-selected="1"]')]
    .map((el) => el.getAttribute("data-provider-id") || ""),
}))()`);
check("서비스를 둘 고를 수 있다", multi.selected.includes("claude") && multi.selected.includes("grok"), multi);

const focused = await evaluate<boolean>(`(() => {
  const ta = document.querySelector('[data-session-opt="fanout-prompt"]');
  if (!(ta instanceof HTMLTextAreaElement)) return false;
  ta.focus();
  ta.value = "";
  return document.activeElement === ta;
})()`);
check("첫 글 칸에 포커스했다", focused);
await send("Input.insertText", { text: "같은 일을 두 장으로" });
await sleep(250);
const filled = await evaluate<string>(`(() => {
  const ta = document.querySelector('[data-session-opt="fanout-prompt"]');
  return ta instanceof HTMLTextAreaElement ? ta.value : "";
})()`);
check("첫 글을 적었다", filled === "같은 일을 두 장으로", filled);
const idsOnStart = await evaluate<string>(`document.querySelector('[data-session-opt="new-session-start"]')?.getAttribute("data-fanout-ids") || ""`);
check("시작 버튼에 서비스 둘이 실려 있다", idsOnStart.includes("claude") && idsOnStart.includes("grok"), idsOnStart);

const before = await created();
const started = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-opt="new-session-start"]');
  if (!(el instanceof HTMLElement) || (el instanceof HTMLButtonElement && el.disabled)) return false;
  el.click();
  return true;
})()`);
check("두 장 시작을 눌렀다", started);

const wantText = "같은 일을 두 장으로";
let after: CreatedRow[] = before;
for (let attempt = 0; attempt < 40; attempt += 1) {
  after = await created();
  const freshNow = after.filter((s) => !before.some((b) => b.id === s.id));
  if (freshNow.length >= 2 && freshNow.every((s) => s.lastMessage === wantText)) break;
  await sleep(150);
}
const fresh = after.filter((s) => !before.some((b) => b.id === s.id));
check("세션 두 장이 생겼다", fresh.length === 2, { before: before.length, after: after.length, fresh });
check(
  "고른 서비스마다 한 장이다",
  fresh.some((s) => s.provider === "claude") && fresh.some((s) => s.provider === "grok"),
  fresh,
);
check(
  "같은 글이 간다",
  fresh.length === 2 && fresh.every((s) => s.lastMessage === "같은 일을 두 장으로"),
  fresh,
);
check("복사본이 켜져 있다", fresh.every((s) => s.isolated), fresh);

await sleep(500);
const afterStart = await evaluate<{ open: boolean; mains: number; active: string | null }>(`(() => {
  return {
    open: !!document.querySelector('[data-modal="new-session"]'),
    mains: document.querySelectorAll("main").length,
    active: document.querySelector('.session-row[aria-current="true"]')?.getAttribute("data-session-id")
      || document.querySelector('[data-session-id][data-split-role="primary"]')?.getAttribute("data-session-id")
      || null,
  };
})()`);
check("만든 뒤 창을 닫는다", afterStart.open === false, afterStart);
check("만든 뒤에도 대화 칸은 하나다", afterStart.mains === 1, afterStart);
check("연 것이 공유 채널이 아니다", !(afterStart.active||"").startsWith("ch-"), afterStart);
const firstCreated = fresh.find((s) => s.provider === "claude") ?? fresh[0];
if (firstCreated) {
  const title = await evaluate<string>(`document.querySelector('.top-bar')?.textContent || ''`);
  check("첫 장을 연다", title.includes("Claude") || title.includes(firstCreated.id) || afterStart.active === firstCreated.id || afterStart.active === `dm:${firstCreated.id}`, {
    title: title.slice(0, 80),
    active: afterStart.active,
    first: firstCreated.id,
  });
}

console.log("\n── 한 장 실패 ──");
await fetch(`${base}/api/debug/fail-create`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "grok" }),
});
await openModal();
const failToggle = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-opt="fanout-start"]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("실패 확인용 묶음을 켰다", failToggle);
await sleep(200);
await evaluate(`(() => {
  for (const id of ["claude", "grok"]) {
    const el = document.querySelector('[data-modal="new-session"] button[data-provider-id="' + id + '"]');
    if (el instanceof HTMLElement && el.getAttribute("data-provider-selected") !== "1") el.click();
  }
})()`);
await sleep(200);
await evaluate(`(() => {
  const ta = document.querySelector('[data-session-opt="fanout-prompt"]');
  if (ta instanceof HTMLTextAreaElement) ta.focus();
})()`);
await send("Input.insertText", { text: "실패해도 남긴다" });
await sleep(250);
const mid = await created();
await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-opt="new-session-start"]');
  if (!(el instanceof HTMLElement) || (el instanceof HTMLButtonElement && el.disabled)) return false;
  el.click();
  return true;
})()`);
const wantFailText = "실패해도 남긴다";
let afterFail: CreatedRow[] = mid;
for (let attempt = 0; attempt < 40; attempt += 1) {
  afterFail = await created();
  const freshNow = afterFail.filter((s) => !mid.some((b) => b.id === s.id));
  if (freshNow.length >= 1 && freshNow.every((s) => s.lastMessage === wantFailText || s.provider !== "claude")) break;
  await sleep(150);
}
const failFresh = afterFail.filter((s) => !mid.some((b) => b.id === s.id));
check("실패한 장만 빠지고 나머지는 남긴다", failFresh.length === 1 && failFresh[0]?.provider === "claude", failFresh);
check("이전에 만든 장도 그대로다", mid.every((s) => afterFail.some((a) => a.id === s.id)), { mid: mid.length, after: afterFail.length });
check("성공한 장에만 글이 간다", failFresh[0]?.lastMessage === wantFailText, failFresh);

console.log(`\n${failures.length === 0 ? "✅" : "❌"} checkFanout: ${pass} PASS / ${failures.length} FAIL`);
for (const f of failures) console.log(`  - ${f}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
