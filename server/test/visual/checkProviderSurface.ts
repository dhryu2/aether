/**
 * 세 번째 서비스가 카탈로그에 있을 때 화면이 따라오는지 본다 (Phase 10f).
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkProviderSurface.ts \
 *     http://127.0.0.1:8899 1440 900 /tmp/aether-10f
 *
 * 준비물은 README와 같다(fixture 서버 + 헤드리스 Chrome + CDP). 어둡게는 COLOR_SCHEME=dark.
 * 이름 분기가 아니라 GET /api/providers 목록을 읽어 칩·재로그인·한도 창을 대조한다.
 */
export {};

const [baseArg, widthArg, heightArg, shotDir] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkProviderSurface.ts <baseUrl> [너비] [높이] [스크린샷 폴더]");
  process.exit(2);
}

const base = baseArg.replace(/\/$/, "");
const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const port = Number(process.env.CDP_PORT || 9222);
const mobile = width < 700;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CatalogEntry = { id: string; displayName: string; authSupported: boolean; workspaceIsolation?: boolean };
type SessionRow = { id: string; provider: string; displayName: string; isolated?: boolean };

const catalogRes = (await (await fetch(`${base}/api/providers`)).json()) as { providers: CatalogEntry[] };
const sessionsRes = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: SessionRow[] };
const catalog = catalogRes.providers;
const third = catalog[2];
const grok = catalog.find((p) => p.id === "grok") ?? third;
const grokSession = sessionsRes.sessions.find((s) => s.provider === grok.id);
const claudeSession = sessionsRes.sessions.find((s) => s.provider === "claude" && s.id === "fixture-claude");

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

// 조건식이 참이 될 때까지 기다린다. 사용량·기기 코드처럼 요청이 끝나야 그려지는 것을 한 번만 보면
//   빠른 기계에서만 통과하는 시험이 된다(2026-10-01 — 0.6초·0.8초 한 번 보기가 늘 실패했다).
async function waitFor(expression: string, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate<boolean>(expression)) return true;
    await sleep(200);
  }
  return false;
}

async function click(sel: string): Promise<boolean> {
  return evaluate<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
}

async function clickText(text: string): Promise<boolean> {
  return evaluate<boolean>(`(() => {
    const want = ${JSON.stringify(text)};
    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    const el = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().includes(want));
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
}

async function shot(name: string) {
  if (!shotDir) return;
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.mkdirSync(shotDir, { recursive: true });
  const png = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir, `${name}-${width}x${height}.png`), Buffer.from(String(png.data), "base64"));
}

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(detail === undefined ? name : `${name} — ${JSON.stringify(detail)}`);
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 2,
  mobile,
});
// COLOR_SCHEME=light|dark. 없으면 Chrome 기본을 따른다(checkWindows와 같은 스위치).
if (process.env.COLOR_SCHEME === "light" || process.env.COLOR_SCHEME === "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.COLOR_SCHEME }] });
}
await send("Page.enable");
// unload 듣개는 앞 화면을 뒤로 가기 캐시에 남기지 않게 한다. 남으면 그 화면의 실시간 연결이 열린 채로 쌓여
//   다섯 번째 이동쯤 같은 서버로 가는 연결 6개가 다 차고, 사용량·로그인 요청이 끝나지 않는다(2026-10-01 확인).
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {} addEventListener('unload', () => {});",
});

async function openSession(id: string) {
  await send("Page.navigate", { url: `${base}/?s=${id}` });
  // 정해진 시간만 기다리면 느린 적재에서 빈 화면을 누르게 된다(바꾸기 전 커밋도 같았다).
  //   앱이 그려질 때까지 기다린 뒤 자료가 올 시간을 준다.
  await sleep(500);
  await waitFor(`document.readyState === 'complete' && (document.getElementById('root')?.childElementCount ?? 0) > 0`, 15000);
  await sleep(2500);
  if (mobile) {
    await click('[aria-label="세션 목록 열기"], [aria-label="Open work list"]');
    await sleep(500);
  }
}

console.log(`\n[카탈로그] ${catalog.map((p) => p.displayName).join(" / ")}  (${width}×${height})`);
check("카탈로그에 서비스가 셋 이상", catalog.length >= 3, catalog.map((p) => p.id));
check("세 번째 표시 이름이 비어 있지 않다", !!grok?.displayName, grok);
check("세 번째 세션이 목록에 있다", !!grokSession, sessionsRes.sessions.map((s) => s.id));

console.log("\n[세 번째 세션 목록·상단바]");
await openSession(grokSession?.id || "fixture-grok");
const listChip = await evaluate<{ count: number; text: string | null; top: string | null }>(`(() => {
  const chips = [...document.querySelectorAll('[data-provider-id=${JSON.stringify(grok.id)}]')]
    .map((el) => (el.textContent || '').trim());
  return { count: chips.length, text: chips[0] ?? null, top: chips.find(Boolean) ?? null };
})()`);
check("목록·상단바에 카탈로그 표시 이름이 있다", listChip.count >= 1 && listChip.text === grok.displayName, listChip);
const bodyText = await evaluate<string>("document.body.innerText");
check("기본 세 번째 세션에 계획 승인 카드가 없다", !/승인하고 진행|수정 요청/.test(bodyText));
check("생각 과정 줄이 있다", bodyText.includes("생각 과정") || bodyText.includes("Thinking"));
await shot("session-third");

console.log("\n[계획 카드·분리 표시]");
await openSession("fixture-plan");
const planText = await evaluate<string>("document.body.innerText");
check("계획 검토 카드가 있다", /계획 검토|Plan review/.test(planText) && /승인하고 진행|Approve and continue/.test(planText), planText.slice(0, 400));
check("계획 카드에 권한 승인 문구가 없다", !/파일 작성 승인|Approve file write/.test(planText));
await shot("plan-card");
await openSession("fixture-iso");
const isoText = await evaluate<string>("document.body.innerText");
check("복사본 표시가 있다", /복사본|Copy/.test(isoText), isoText.slice(0, 300));
check("반영 필요가 있다", /반영 필요|Needs apply/.test(isoText), isoText.slice(0, 300));
check("작업 메뉴를 연다", await click('[data-session-id="fixture-iso"] [data-session-opt="work-menu"]'));
await sleep(200);
const menuText = await evaluate<string>("document.body.innerText");
check("원 폴더에 반영이 작업 메뉴에 있다", /원본 폴더에 반영|Apply to original/.test(menuText), menuText.slice(0, 400));
check("반영 버튼이 메뉴 안에 있다", await evaluate<boolean>(`!!document.querySelector('[data-session-opt="workspace-apply"]')`));
await shot("isolated-session");

console.log("\n[복사본이 아닌 Claude 카드]");
await openSession(claudeSession?.id || "fixture-claude");
check("Claude 작업 메뉴를 연다", await click('[data-session-id="fixture-claude"] [data-session-opt="work-menu"]'));
await sleep(200);
check(
  "복사본이 아닌 Claude 카드에는 반영이 없다",
  await evaluate<boolean>(`!document.querySelector('[data-session-opt="workspace-apply"]')`),
);

console.log("\n[새 작업 창]");
check("새 작업 버튼", await click('[aria-label="새 세션"], [data-session-opt="new-work"]'));
await sleep(800);
const chips = await evaluate<{ ids: string[]; names: string[] }>(`(() => {
  const buttons = [...document.querySelectorAll('[data-modal="new-session"] button[data-provider-id]')];
  return {
    ids: buttons.map((el) => el.getAttribute('data-provider-id') || ''),
    names: buttons.map((el) => (el.textContent || '').trim()),
  };
})()`);
check("새 작업 서비스 줄 수가 카탈로그와 같다", chips.ids.length === catalog.length, chips);
check(
  "서비스 줄 글자가 표시 이름이다",
  catalog.every((p) => chips.names.includes(p.displayName)),
  { want: catalog.map((p) => p.displayName), got: chips.names },
);
check("세 번째 서비스를 고른다", await click(`[data-modal="new-session"] button[data-provider-id=${JSON.stringify(grok.id)}]`));
await sleep(400);
const isoToggle = await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-opt="isolate-workspace"]');
  return el instanceof HTMLElement && el.getAttribute("role") === "switch" && el.hasAttribute("aria-checked");
})()`);
check("복사본에서 작업 스위치가 있다", isoToggle);
check("Claude 서비스를 고른다", await click('[data-modal="new-session"] button[data-provider-id="claude"]'));
await sleep(300);
check("Claude를 골라도 복사본 스위치가 있다", await evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-session-opt="isolate-workspace"]');
  return el instanceof HTMLElement && el.getAttribute("role") === "switch";
})()`));
check("세 번째 서비스를 다시 고른다", await click(`[data-modal="new-session"] button[data-provider-id=${JSON.stringify(grok.id)}]`));
await sleep(300);
// 새 작업 창에는 권한 스위치도 명령 미리보기 줄도 없다. 새 세션은 자동(없으면 수동)으로 시작한다.
check("새 작업 창에 권한 스위치가 없다", await evaluate<boolean>(`(() => {
  const root = document.querySelector('[data-modal="new-session"]');
  return ![...(root?.querySelectorAll('[role="switch"]') ?? [])].some((node) => {
    const name = node.getAttribute("aria-label") || "";
    return name.includes("모든 권한") || name.includes("Allow all");
  });
})()`));
check("명령 미리보기 줄이 없다", await evaluate<boolean>(`!document.querySelector('[data-modal="new-session"] [data-command-preview]')`));
await sleep(300);
await shot("new-session-third");
check("새 작업 창을 닫는다", await click('[aria-label="닫기"]') || await evaluate<boolean>(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '닫기');
  if (!(btn instanceof HTMLElement)) return false;
  btn.click();
  return true;
})()`));
await sleep(400);

console.log("\n[설정 재로그인]");
await openSession(grokSession?.id || "fixture-grok");
check("설정 연다", await click('[aria-label="설정"]'));
await sleep(600);
const reauth = await evaluate<{ titles: string[]; ids: string[] }>(`(() => {
  const root = document.querySelector('[data-window="settings"]');
  const rows = [...(root?.querySelectorAll('[data-provider-id]') ?? [])];
  return {
    ids: rows.map((el) => el.getAttribute('data-provider-id') || ''),
    titles: rows.map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
  };
})()`);
const shouldReauth = catalog.filter((p) => p.authSupported).map((p) => p.id);
check("재로그인 항목이 authSupported만 그린다", shouldReauth.every((id) => reauth.ids.includes(id)), reauth);
check("지원 안 하는 서비스 항목은 없다", catalog.filter((p) => !p.authSupported).every((p) => !reauth.ids.includes(p.id)), reauth);
check("세 번째 재로그인 제목에 표시 이름이 있다", reauth.titles.some((t) => t.includes(grok.displayName)), reauth.titles);
await waitFor(`/최근 7일 한도|Last 7 days/.test(document.querySelector('[data-window="settings"]')?.textContent || '')`);
const usageText = await evaluate<string>("document.body.innerText");
check("한도 창이 없으면 5시간 창을 안 그린다", grokSession ? !usageText.includes("5시간 한도") : true, usageText.slice(0, 500));
check("구독 한도 창이 있다", /최근 7일 한도|Last 7 days/.test(usageText), usageText.slice(0, 500));
check("문맥 사용량이 있다", /컨텍스트|Context window/.test(usageText) && /토큰|tokens/i.test(usageText), usageText.slice(0, 500));
const settingsEngine = await evaluate<boolean>(`!!document.querySelector('[data-window="settings"] [data-compact-engine]')`);
check("설정에 실행기 선택 칸이 없다", !settingsEngine);
await shot("settings-reauth");

check("재로그인 항목을 연다", await evaluate<boolean>(`(() => {
  const root = document.querySelector('[data-window="settings"]');
  const row = root?.querySelector('[data-provider-id=${JSON.stringify(grok.id)}]');
  const el = row instanceof HTMLButtonElement ? row : row?.querySelector('button');
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
})()`));
await sleep(500);
check("로그인 시작을 누른다", await clickText("로그인 시작"));
await waitFor(`(document.querySelector('[data-window="provider-auth"]')?.textContent || '').includes('WDTE-XTJK')`);
const authModal = await evaluate<{ code: boolean; url: boolean; text: string }>(`(() => {
  const box = document.querySelector('[data-window="provider-auth"]');
  const text = (box?.textContent || '').replace(/\\s+/g, ' ');
  return {
    code: text.includes('WDTE-XTJK'),
    url: !!box?.querySelector('a[href="https://example.test/device"]'),
    text: text.slice(0, 400),
  };
})()`);
check("기기코드 카드가 뜬다", authModal.code && authModal.url, authModal);
await shot("device-code");
await click('[aria-label="닫기"]');
await sleep(300);

console.log("\n[Agent Brain 실행기]");
await evaluate<boolean>(`(() => {
  for (const b of [...document.querySelectorAll('[aria-label="닫기"]')]) {
    if (b instanceof HTMLElement) b.click();
  }
  return true;
})()`);
await sleep(400);
check("워크스페이스 연다", await click('[aria-label="워크스페이스"]'));
await sleep(800);
check("메모리 탭을 누른다", await click('[data-brain-tab="memory"]'));
await sleep(300);
const brainEngine = await evaluate<{ present: boolean; names: string[]; overflow: boolean; tab: string | null }>(`(() => {
  const overlay = document.querySelector('[data-brain]');
  const engine = overlay?.querySelector('[data-compact-engine]');
  if (!(engine instanceof HTMLElement)) return { present: false, names: [], overflow: true, tab: null };
  return {
    present: true,
    names: [...engine.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
    overflow: engine.scrollWidth > engine.clientWidth + 1,
    tab: [...(overlay?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((b) => (b.textContent || '').trim())[0] ?? null,
  };
})()`);
check("메모리 탭에 실행기 선택 칸이 있다", brainEngine.present, brainEngine);
check(
  "메모리 탭 실행기 칸이 카탈로그 표시 이름을 그린다",
  catalog.every((p) => brainEngine.names.includes(p.displayName)),
  { want: catalog.map((p) => p.displayName), got: brainEngine.names },
);
check("메모리 탭 실행기 칸이 가로로 넘치지 않는다", !brainEngine.overflow, brainEngine);
await shot("brain-hub-engine");
await evaluate<boolean>(`(() => {
  const b = document.querySelector('[data-brain] [aria-label="닫기"]');
  if (b instanceof HTMLElement) { b.click(); return true; }
  return false;
})()`);
await sleep(400);

console.log("\n[Claude 화면 퇴화]");
await openSession(claudeSession?.id || "fixture-claude");
const claudeChip = await evaluate<string | null>(`(() => {
  const el = document.querySelector('[data-provider-id="claude"]');
  return el ? (el.textContent || '').trim() : null;
})()`);
check("Claude 세션 칩이 남아 있다", claudeChip === "Claude", claudeChip);
const claudeBody = await evaluate<string>("document.body.innerText");
check("Claude 세션에 계획 카드가 없다", !/승인하고 진행|계획 검토/.test(claudeBody));
check("Claude 세션에 분리 버튼이 없다", !(await evaluate<boolean>(`!!document.querySelector('[data-session-id="fixture-claude"] [data-session-opt="workspace-apply"]')`)));
await click('[aria-label="설정"]');
await sleep(600);
const claudeSettings = await evaluate<string>("document.body.innerText");
check("Claude 다시 로그인 항목이 남아 있다", claudeSettings.includes("Claude") && claudeSettings.includes("다시 로그인"), claudeSettings.slice(0, 300));
check("Claude 한도 창은 그대로 그린다", claudeSettings.includes("5시간 한도") || claudeSettings.includes("5-hour"), claudeSettings.slice(0, 400));
await shot("claude-regression");

ws.close();
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
console.log(`\n${failures.length === 0 ? "✅" : "❌"} provider surface ${width}×${height}: ${pass} PASS / ${failures.length} FAIL`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
