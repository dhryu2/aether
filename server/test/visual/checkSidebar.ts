/**
 * 사이드바가 1대1 / 채널 두 묶음이고, 줄 id가 방 id인지 본다.
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkSidebar.ts http://127.0.0.1:8899 1440 900
 */
export {};

const [baseArg, widthArg, heightArg] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkSidebar.ts <서버 주소> [너비] [높이]");
  process.exit(2);
}

const base = baseArg.replace(/\/$/, "");
const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const mobile = width < 700;
const port = Number(process.env.CDP_PORT || 9222);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type RoomRow = { id: string; kind: string; title: string };

const listed = (await (await fetch(`${base}/api/sessions`)).json()) as {
  rooms: RoomRow[];
  sessions: Array<{ id: string; model?: string }>;
};
const rooms = listed.rooms ?? [];
const dms = rooms.filter((r) => r.kind === "dm");
const claude = rooms.find((r) => r.id === "dm:fixture-claude");

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
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(detail === undefined ? name : `${name} — ${JSON.stringify(detail)}`);
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
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

async function waitForSidebarRooms() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate<boolean>(`(() => {
      const head = document.querySelector('[data-project-key]');
      const row = document.querySelector('.session-row');
      return !!(head && row);
    })()`);
    if (ready) return true;
    await sleep(100);
  }
  return false;
}

async function expandProjects() {
  for (let i = 0; i < 6; i += 1) {
    const n = await evaluate<number>(`(() => {
      const closed = [...document.querySelectorAll('button[aria-expanded="false"][aria-controls]')];
      for (const el of closed) {
        if (el instanceof HTMLElement) el.click();
      }
      return closed.length;
    })()`);
    if (n === 0) break;
    await sleep(150);
  }
}

async function openSession(id: string) {
  loadDone = false;
  await send("Page.navigate", { url: `${base}/?s=${id}` });
  for (let attempt = 0; attempt < 50 && !loadDone; attempt += 1) await sleep(100);
  if (mobile) {
    const opened = await evaluate<boolean>(`(() => {
      const el = document.querySelector('[aria-label="세션 목록 열기"]');
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`);
    check("모바일에서 세션 목록을 열었다", opened);
    await sleep(200);
  }
  const ready = await waitForSidebarRooms();
  check("방 목록이 그려졌다", ready);
}

function snapshotExpr(): string {
  return `(() => {
    const rows = [...document.querySelectorAll('.session-row')];
    const claudeModelLine = document.querySelector('[data-session-id="dm:fixture-claude"] [data-session-model]')?.getAttribute('data-session-model') || '';
    return {
      buckets: document.querySelectorAll('[data-room-bucket]').length,
      cards: rows.length,
      ids: rows.map((el) => el.getAttribute('data-session-id') || ''),
      search: !!document.querySelector('[data-sidebar-search]'),
      projectHeads: document.querySelectorAll('[data-project-key]').length,
      expanded: document.querySelectorAll('[data-project-head][aria-expanded="true"]').length,
      claudeModelLine,
    };
  })()`;
}

type Snap = {
  buckets: number;
  cards: number;
  ids: string[];
  search: boolean;
  projectHeads: number;
  expanded: number;
  claudeModelLine: string;
};

console.log(`\n── 사이드바 프로젝트 묶음 ${width}×${height} ──`);
check("rooms에 dm이 있다", dms.length >= 1, { dms: dms.length });
check("호환 sessions id에 dm: 접두 없음", listed.sessions.every((s) => !s.id.startsWith("dm:")), listed.sessions.slice(0, 3));
check("픽스처 dm:fixture-claude가 있다", !!claude, claude);

await openSession("dm:fixture-claude");
{
  const bg = await evaluate<{ has: boolean; text: string; animated: boolean }>(`(() => {
    const row = document.querySelector('[data-session-id="dm:fixture-background"]');
    return { has: !!row, text: row ? row.textContent || '' : '', animated: !!row && !!row.querySelector('.spin, [class*="animate-spin"]') };
  })()`);
  check("백그라운드 작업 중 줄이 있다", bg.has);
  check("둘째 줄에 '백그라운드 작업 중 · 2개'가 보인다", bg.text.includes("백그라운드 작업 중 · 2개"), bg.text.slice(0, 80));
  check("백그라운드 작업 중 아이콘은 돌지 않는다", !bg.animated);
}
await expandProjects();
const first = await evaluate<Snap>(snapshotExpr());
const claudeModel = listed.sessions.find((s) => s.id === "fixture-claude")?.model?.trim() ?? "";
check("1대1·채널 묶음이 없다", first.buckets === 0, first.buckets);
check("프로젝트 머리가 있다", first.projectHeads > 0 && first.expanded > 0, first);
check("방 줄이 보인다", first.cards > 0, { cards: first.cards });
check("줄 id는 방 id다", first.ids.every((id) => id.startsWith("dm:")), first.ids.slice(0, 5));
check("dm:fixture-claude 줄이 있다", first.ids.includes("dm:fixture-claude"), first.ids);
check("검색 칸이 있다", first.search, first);
check("호환 sessions로 줄을 고르지 않는다", !first.ids.includes("fixture-claude"), first.ids);
check(
  "모델이 있으면 세 번째 줄에 보인다",
  !claudeModel || first.claudeModelLine.length > 0,
  { claudeModel, line: first.claudeModelLine },
);

const pickedDm = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-id="dm:fixture-claude"]');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`);
check("1대1 줄을 골랐다", pickedDm);
await sleep(600);
const afterDm = await evaluate<{ title: string; active: string | null }>(`(() => ({
  title: document.querySelector('.top-bar')?.textContent || '',
  active: document.querySelector('.session-row-current')?.getAttribute('data-session-id') || null,
}))()`);
check("1대1 제목에 claude가 있다", /claude/i.test(afterDm.title), { title: afterDm.title.slice(0, 80) });
check("고른 줄이 dm:fixture-claude다", afterDm.active === "dm:fixture-claude", afterDm);

console.log(`\n${failures.length === 0 ? "✅" : "❌"} checkSidebar: ${pass} PASS / ${failures.length} FAIL`);
for (const f of failures) console.log(`  - ${f}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
