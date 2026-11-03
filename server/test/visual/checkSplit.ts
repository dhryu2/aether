/**
 * Phase 13d — 아주 넓은 창에서만 대화 둘.
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkSplit.ts http://127.0.0.1:8899 1440 900
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkSplit.ts http://127.0.0.1:8899 1099 900
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkSplit.ts http://127.0.0.1:8899 390 844
 */
import { paneCapacity } from "../../../web/src/lib/splitPane";

export {};

const [baseArg, widthArg, heightArg] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkSplit.ts <서버 주소> [너비] [높이]");
  process.exit(2);
}

const base = baseArg.replace(/\/$/, "");
const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const mobile = width < 700;
const wide = width >= 1100;
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
await send("Storage.clearDataForOrigin", { origin: new URL(base).origin, storageTypes: "local_storage" }).catch(() => {});
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

async function expandProjects() {
  for (let i = 0; i < 4; i++) {
    const n = await evaluate<number>(`(() => {
      const closed = [...document.querySelectorAll('button[aria-expanded="false"][aria-controls]')];
      for (const el of closed) {
        if (el instanceof HTMLElement) el.click();
      }
      return closed.length;
    })()`);
    if (n === 0) break;
    await sleep(200);
  }
}

async function paneCount() {
  return evaluate<number>(`document.querySelectorAll('[data-split-pane]').length`);
}
async function openBeside(roomId: string) {
  const openedMenu = await evaluate<boolean>(`(() => {
    const card = document.querySelector('[data-session-id="${roomId}"]');
    const btn = card?.querySelector('[data-session-opt="work-menu"]');
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    return true;
  })()`);
  if (!openedMenu) return false;
  let itemReady = false;
  for (let attempt = 0; attempt < 40 && !itemReady; attempt += 1) {
    itemReady = await evaluate<boolean>(`!!document.querySelector('[data-session-opt="open-beside"]')`);
    if (!itemReady) await sleep(50);
  }
  if (!itemReady) return false;
  return evaluate<boolean>(`(() => {
    const item = document.querySelector('[data-session-opt="open-beside"]');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
}
async function isMarkedWide() {
  return evaluate<boolean>(`document.querySelector('main')?.getAttribute('data-wide') === 'true'`);
}

await openList();
await expandProjects();

const markedWide = await isMarkedWide();
check(wide ? "넓은 창이면 data-wide" : "좁으면 data-wide가 아니다", markedWide === wide, { width, markedWide });

const startPanes = await paneCount();
check("시작은 대화 칸 하나", startPanes === 1, startPanes);
check("작업 탭 줄이 없다", await evaluate<boolean>(`!document.querySelector('[data-workspace-tab]')`));
check(
  "프로젝트 묶음이 있고 1대1·채널 묶음은 없다",
  await evaluate<boolean>(`document.querySelectorAll('[data-project-key]').length > 0 && document.querySelectorAll('[data-room-bucket]').length === 0`),
);

const menuOpened = await evaluate<boolean>(`(() => {
  const card = document.querySelector('[data-session-id="dm:fixture-grok"]');
  const btn = card?.querySelector('[data-session-opt="work-menu"]');
  if (!(btn instanceof HTMLElement)) return false;
  btn.click();
  return true;
})()`);
check("grok 작업 메뉴를 열었다", menuOpened);
if (!wide) {
  await sleep(200);
  const besideInMenu = await evaluate<boolean>(`!!document.querySelector('[data-session-opt="open-beside"]')`);
  check("좁은 창 메뉴에 옆 칸으로가 없다", besideInMenu === false);
  const afterPanes = await paneCount();
  check("좁은 창은 칸이 하나", afterPanes === 1, afterPanes);
} else {
  let besideInMenu = false;
  for (let attempt = 0; attempt < 40 && !besideInMenu; attempt += 1) {
    besideInMenu = await evaluate<boolean>(`!!document.querySelector('[data-session-opt="open-beside"]')`);
    if (!besideInMenu) await sleep(50);
  }
  check("넓은 창 메뉴에 옆 칸으로가 있다", besideInMenu === true);
  const opened = await evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-session-opt="open-beside"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("옆 칸으로를 눌렀다", opened);
  await sleep(400);
  const panes = await paneCount();
  const ids = await evaluate<string[]>(`[...document.querySelectorAll('[data-split-pane]')].map((el) => el.getAttribute('data-split-session') || '')`);
  check("넓은 창에서 칸이 둘", panes === 2, { panes, ids });
  check("연 칸에 grok이 있다", ids.includes("dm:fixture-grok"), ids);
  check("첫 칸은 claude", ids.includes("dm:fixture-claude"), ids);

  const openedFocus = await evaluate<{ focused: string | null; unfocused: number }>(`(() => {
    const on = document.querySelector('[data-split-focused="1"]');
    return {
      focused: on instanceof HTMLElement ? on.getAttribute('data-split-session') : null,
      unfocused: document.querySelectorAll('[data-split-focused="0"]').length,
    };
  })()`);
  check("옆에 연 칸이 포커스다", openedFocus.focused === "dm:fixture-grok", openedFocus);
  check("포커스 없는 칸은 하나다", openedFocus.unfocused === 1, openedFocus);

  const clickedOther = await evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-split-session="dm:fixture-claude"]');
    if (!(el instanceof HTMLElement)) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return true;
  })()`);
  check("다른 칸을 눌렀다", clickedOther);
  await sleep(150);
  const afterClick = await evaluate<{ focused: string | null; unfocusedOn: string | null }>(`(() => {
    const on = document.querySelector('[data-split-focused="1"]');
    const off = document.querySelector('[data-split-focused="0"]');
    return {
      focused: on instanceof HTMLElement ? on.getAttribute('data-split-session') : null,
      unfocusedOn: off instanceof HTMLElement ? off.getAttribute('data-split-session') : null,
    };
  })()`);
  check("누른 칸이 포커스다", afterClick.focused === "dm:fixture-claude", afterClick);
  check("포커스 없는 칸은 grok이다", afterClick.unfocusedOn === "dm:fixture-grok", afterClick);

  const chromeLeft = await evaluate<string>(`document.querySelector('[data-chrome-session]')?.getAttribute('data-chrome-session') || ''`);
  check("포커스 칸의 세션이 상단에 보인다", chromeLeft === "fixture-claude", chromeLeft);
  const onScreen = await evaluate<number>(`document.querySelectorAll('.session-row-on').length`);
  check("화면에 나온 세션은 목록에서 둘 다 켜진다", onScreen === 2, onScreen);
  const modelLine = await evaluate<boolean>(`!!document.querySelector('[data-session-id="dm:fixture-claude"] [data-session-model], [data-pane-model]')`);
  check("모델 줄 또는 칸 머리 모델이 있다", modelLine);

  const grokClickKeepsSplit = await evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-session-id="dm:fixture-grok"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("이미 보이는 세션 목록을 눌렀다", grokClickKeepsSplit);
  await sleep(200);
  check("이미 보이는 세션을 눌러도 칸은 둘", (await paneCount()) === 2);

  await expandProjects();
  // 창 폭 1100 이상이어도 칸 상한은 대화 영역(main)이다. splitPane.paneCapacity와 같은 규칙.
  const box = await evaluate<{ w: number; h: number }>(`(() => {
    const el = document.querySelector('main');
    if (!(el instanceof HTMLElement)) return { w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  const cap = paneCapacity(box.w, box.h);
  const third = await openBeside("dm:fixture-codex");
  check("세 번째를 옆에 열었다", third, { cap, box });
  await sleep(400);
  const afterThird = await paneCount();
  check(
    cap >= 4 ? "칸이 셋" : "대화 영역이 2칸이라 수는 둘이다",
    afterThird === (cap >= 4 ? 3 : 2),
    { afterThird, cap, box },
  );

  if (cap >= 4) {
    const others = await evaluate<string[]>(`(() => {
      const open = new Set([...document.querySelectorAll('[data-split-session]')].map((el) => el.getAttribute('data-split-session') || ''));
      return [...document.querySelectorAll('.session-row')]
        .map((el) => el.getAttribute('data-session-id') || '')
        .filter((id) => id.startsWith('dm:') && !open.has(id));
    })()`);
    if (others[0]) {
      const fourth = await openBeside(others[0]);
      check("네 번째를 옆에 열었다", fourth, others[0]);
      await sleep(400);
      check("칸이 넷", (await paneCount()) === 4, await paneCount());
    } else {
      check("네 번째 세션이 없어 3칸에서 닫기를 확인한다", (await paneCount()) === 3);
    }
  }

  const beforeClose = await paneCount();
  const closed = await evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-split-focused="1"] [data-split-close]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("포커스 칸 닫기를 눌렀다", closed);
  await sleep(200);
  const afterClose = await paneCount();
  check("닫으면 칸이 하나 줄어든다", afterClose === beforeClose - 1, { beforeClose, afterClose });
  const stillFocused = await evaluate<boolean>(`document.querySelectorAll('[data-split-focused="1"]').length === 1`);
  check("남은 칸 중 하나가 포커스다", stillFocused);
  check("작업 탭은 생기지 않는다", await evaluate<boolean>(`!document.querySelector('[data-workspace-tab]')`));
}

ws.close();
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, { method: "GET" }).catch(() => {});

console.log(`\ncheckSplit ${width}x${height}: ${pass} PASS` + (failures.length ? ` / ${failures.length} FAIL` : ""));
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
