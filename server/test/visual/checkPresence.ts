/**
 * Phase 13b/1d2/2b — 점·필터·손길 칩이 방 id로 맞는지 본다.
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkPresence.ts http://127.0.0.1:8899 1440 900
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkPresence.ts http://127.0.0.1:8899 390 844
 *
 * 손길: actions waiting · cut failed · plan waiting · unread done · team waiting = 5.
 * 안 본 완료를 연 뒤 4, grok를 waiting으로 올리면 5.
 */
export {};

const [baseArg, widthArg, heightArg] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkPresence.ts <서버 주소> [너비] [높이]");
  process.exit(2);
}

const base = baseArg.replace(/\/$/, "");
const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const mobile = width < 700;
const port = Number(process.env.CDP_PORT || 9222);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

await fetch(`${base}/api/debug/presence`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "fixture-grok", attention: "idle" }),
});
await fetch(`${base}/api/debug/presence`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "fixture-done-unread",
    attention: "done",
    attentionKind: "done",
    attentionPreview: "작업이 끝났습니다",
  }),
});
await fetch(`${base}/api/debug/presence`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "fixture-plan",
    attention: "waiting",
    attentionKind: "plan",
    attentionPreview: "계획을 확인해 주세요",
  }),
});
await fetch(`${base}/api/debug/presence`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "fixture-actions",
    attention: "waiting",
    attentionKind: "question",
    attentionPreview: "질문에 답해 주세요",
  }),
});
await fetch(`${base}/api/debug/presence`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "fixture-cut",
    attention: "failed",
    attentionKind: "failed",
    attentionPreview: "작업이 실패했습니다",
  }),
});

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
  source: "try { localStorage.removeItem('aether.sidebar.openProjects'); localStorage.removeItem('aether.sidebar.openBuckets'); localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});
let loadDone = false;
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { method?: string };
  if (message.method === "Page.loadEventFired") loadDone = true;
});
await send("Page.navigate", { url: `${base}/?s=dm:fixture-claude` });
for (let attempt = 0; attempt < 50 && !loadDone; attempt += 1) await sleep(100);
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (await evaluate<boolean>(`!!document.querySelector('[data-attention-chip]')`)) break;
  await sleep(100);
}

console.log(`\n── 손길 칩·점 ${width}×${height} ──`);

const chip = await evaluate<{ count: string | null; mains: number }>(`(() => {
  const el = document.querySelector('[data-attention-chip]');
  return {
    count: el instanceof HTMLElement ? el.getAttribute('data-attention-count') : null,
    mains: document.querySelectorAll('main').length,
  };
})()`);
check("손길 칩이 있다", chip.count != null, chip);
check("손길 4건", chip.count === "4", chip);
check("대화 칸은 하나다", chip.mains === 1, chip);

const opened = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-attention-chip]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("손길 칩을 눌렀다", opened);
await sleep(200);
const list = await evaluate<{ n: number; ids: string[] }>(`(() => {
  const items = [...document.querySelectorAll('[data-attention-jump]')];
  return { n: items.length, ids: items.map((el) => el.getAttribute('data-attention-jump') || '') };
})()`);
check("목록이 4건이다", list.n === 4, list);
check("대기 dm이 목록에 있다", list.ids.includes("dm:fixture-actions"), list);
check("계획 방이 목록에 있다", list.ids.includes("dm:fixture-plan"), list);
check("안 본 완료가 목록에 있다", list.ids.includes("dm:fixture-done-unread"), list);

const planJump = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-attention-jump="dm:fixture-plan"]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("계획 방으로 점프했다", planJump);
await sleep(900);
const planCard = await evaluate<{ hasPlan: boolean; title: string; mains: number }>(`(() => {
  const title = document.querySelector('.top-bar')?.textContent || '';
  const hasPlan = !!document.querySelector('[data-kind="plan_request"], [data-card-kind="plan"], .plan-card, [aria-label*="계획"], [aria-label*="Plan"]')
    || [...document.querySelectorAll('*')].some((el) => (el.textContent || '').includes('인증 방식을 고른다'));
  return { hasPlan, title, mains: document.querySelectorAll('main').length };
})()`);
check("계획 카드가 보인다", planCard.hasPlan, planCard);
check("점프 뒤에도 대화 칸은 하나다", planCard.mains === 1, planCard);

const reopen = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-attention-chip]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("손길 칩을 다시 열었다", reopen);
await sleep(200);
const doneJump = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-attention-jump="dm:fixture-done-unread"]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("안 본 완료로 점프했다", doneJump);
await sleep(900);
const afterDone = await evaluate<{ ids: string[]; count: string | null }>(`(() => {
  const chip = document.querySelector('[data-attention-chip]');
  const open = chip instanceof HTMLElement;
  if (open) chip.click();
  const items = [...document.querySelectorAll('[data-attention-jump]')];
  return {
    ids: items.map((el) => el.getAttribute('data-attention-jump') || ''),
    count: chip instanceof HTMLElement ? chip.getAttribute('data-attention-count') : null,
  };
})()`);
check(
  "안 본 완료를 열면 손길에서 빠진다",
  !afterDone.ids.includes("dm:fixture-done-unread"),
  afterDone,
);

const jumped = await evaluate<boolean>(`(() => {
  const chip = document.querySelector('[data-attention-chip]');
  if (chip instanceof HTMLElement) chip.click();
  const el = document.querySelector('[data-attention-jump="dm:fixture-actions"]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("대기 방으로 점프했다", jumped);
await sleep(800);
const afterJump = await evaluate<{ title: string; mains: number; drawer: boolean }>(`(() => {
  const title = document.querySelector('.top-bar')?.textContent || '';
  return {
    title,
    mains: document.querySelectorAll('main').length,
    drawer: document.querySelector('[data-drawer-open="1"]') != null,
  };
})()`);
check("제목이 그 방이다", afterJump.title.includes("actions"), { title: afterJump.title.slice(0, 80) });
check("점프 뒤에도 대화 칸은 하나다", afterJump.mains === 1, afterJump);
if (mobile) check("좁은 화면에서 옆 목록이 안 남는다", afterJump.drawer === false, afterJump);

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
await openList();

// 상태 필터 탭은 없앴다 — 목록 하나에 줄마다 상태 표시가 붙는다.
const listed = await evaluate<{ cards: string[]; ids: string[] }>(`(() => {
  const cards = [...document.querySelectorAll('.session-row')];
  return {
    cards: cards.map((el) => el.getAttribute('data-attention') || ''),
    ids: cards.map((el) => el.getAttribute('data-session-id') || ''),
  };
})()`);
check("상태 필터 탭이 없다", (await evaluate<boolean>(`document.querySelector('[data-attention-filters]') == null`)) === true);
check("대기 카드가 목록에 보인다", listed.cards.includes("waiting"), listed);
check(
  "목록 줄 id는 방 id다",
  listed.ids.length > 0 && listed.ids.every((id) => id.startsWith("dm:") || id.startsWith("ch-")),
  listed.ids,
);

const live = await fetch(`${base}/api/debug/presence`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "fixture-grok",
    attention: "waiting",
    attentionKind: "question",
    attentionPreview: "방금 질문이 왔습니다",
  }),
});
check("픽스처가 주의 갱신을 받았다", live.ok);
await sleep(600);
const afterLive = await evaluate<{ count: string | null; grok: string | null }>(`(() => {
  const chip = document.querySelector('[data-attention-chip]');
  const grok = document.querySelector('[data-session-id="dm:fixture-grok"]');
  return {
    count: chip instanceof HTMLElement ? chip.getAttribute('data-attention-count') : null,
    grok: grok instanceof HTMLElement ? grok.getAttribute('data-attention') : null,
  };
})()`);
check("안 고른 세션의 점이 실시간으로 바뀐다", afterLive.count === "5" && afterLive.grok === "waiting", afterLive);

console.log(`\n${failures.length === 0 ? "✅" : "❌"} checkPresence: ${pass} PASS / ${failures.length} FAIL`);
for (const f of failures) console.log(`  - ${f}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
