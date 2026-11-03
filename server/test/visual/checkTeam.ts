/**
 * 팀 작업 카드·실행 가능 명령 화면 확인 (Phase 10i).
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkTeam.ts http://127.0.0.1:8899 1440 900
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkTeam.ts http://127.0.0.1:8899 390 844
 */
export {};

const [base, widthArg, heightArg] = process.argv.slice(2);
if (!base) {
  console.error("Usage: checkTeam.ts <baseUrl> [width] [height]");
  process.exit(2);
}

const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const port = Number(process.env.CDP_PORT || 9222);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as {
  id: string;
  webSocketDebuggerUrl: string;
};
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP 연결 실패")), { once: true });
});

let messageId = 0;
const waiters = new Map<number, (result: unknown) => void>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id != null && waiters.has(message.id)) {
    waiters.get(message.id)!(message.result);
    waiters.delete(message.id);
  }
});
function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++messageId;
  return new Promise((resolve) => {
    waiters.set(id, resolve as (r: unknown) => void);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate<T>(expression: string): Promise<T> {
  const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })) as {
    exceptionDetails?: { text: string };
    result: { value: T };
  };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

let pass = 0;
const failures: string[] = [];
const check = (condition: unknown, message: string, detail?: unknown) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${message}`);
  } else {
    failures.push(detail === undefined ? message : `${message} — ${JSON.stringify(detail)}`);
    console.log(`  ✗ ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 700 });
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});

async function open(session: string) {
  await send("Page.navigate", { url: `${base}/?s=${session}` });
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const ready = await evaluate<{ ta: number; segs: number }>(`({
      ta: document.querySelectorAll('textarea').length,
      segs: document.querySelectorAll('[data-seg]').length,
    })`);
    if (ready.ta > 0 || ready.segs > 0) break;
    await sleep(250);
  }
  await sleep(600);
}

async function waitForComposer(): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const n = await evaluate<number>(`document.querySelectorAll('.aether-composer textarea, textarea').length`);
    if (n > 0) return true;
    await sleep(250);
  }
  return false;
}

async function typeSlash() {
  await waitForComposer();
  await send("Page.bringToFront");
  await evaluate(`(() => {
    const el = document.querySelector('.aether-composer textarea') || document.querySelector('textarea');
    el?.scrollIntoView({ block: 'end', inline: 'nearest' });
  })()`);
  await sleep(200);
  const box = await evaluate<{ x: number; y: number }>(`(() => {
    const el = document.querySelector('.aether-composer textarea') || document.querySelector('.composer-box textarea') || document.querySelector('textarea');
    const r = el?.getBoundingClientRect();
    return { x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 };
  })()`);
  if (box.x > 0 && box.y > 0) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: box.x, y: box.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: box.x, y: box.y });
  }
  await sleep(200);
  await evaluate(`(() => {
    const ta = document.querySelector('.aether-composer textarea') || document.querySelector('textarea');
    if (!(ta instanceof HTMLTextAreaElement)) return false;
    ta.focus();
    const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    desc?.set?.call(ta, '/');
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: '/', inputType: 'insertText' }));
    return true;
  })()`);
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const n = await evaluate<number>(`document.querySelectorAll('[data-slash-name]').length`);
    if (n > 0) return;
    await sleep(200);
  }
  await send("Input.insertText", { text: "/" });
  const again = Date.now();
  while (Date.now() - again < 2000) {
    const n = await evaluate<number>(`document.querySelectorAll('[data-slash-name]').length`);
    if (n > 0) return;
    await sleep(200);
  }
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "/", code: "Slash", text: "/", unmodifiedText: "/", windowsVirtualKeyCode: 191 });
  await send("Input.dispatchKeyEvent", { type: "char", key: "/", text: "/", unmodifiedText: "/" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "/", code: "Slash", windowsVirtualKeyCode: 191 });
  const last = Date.now();
  while (Date.now() - last < 2000) {
    const n = await evaluate<number>(`document.querySelectorAll('[data-slash-name]').length`);
    if (n > 0) return;
    await sleep(200);
  }
}

console.log("\n[1] 자식 작업이 있는 턴");
await open("fixture-team");
const teamSnap = await evaluate<{
  segs: string[];
  teamCount: number;
  teamText: string;
  toolsText: string;
  jsonDump: boolean;
}>(`(() => {
  const segs = [...document.querySelectorAll('[data-seg]')].map((n) => n.dataset.seg);
  const team = document.querySelector('[data-seg="team"]');
  const tools = document.querySelector('[data-seg="tools"]');
  const teamText = team ? team.innerText : "";
  return {
    segs,
    teamCount: document.querySelectorAll('[data-seg="team"]').length,
    teamText,
    toolsText: tools ? tools.innerText : "",
    jsonDump: /\\{["']subagent_type["']/.test(document.body.innerText),
  };
})()`);
check(teamSnap.teamCount === 1, "팀 카드가 보인다", teamSnap);
check(teamSnap.segs.includes("team") && teamSnap.segs.includes("tools"), "팀 카드와 일반 도구 줄이 갈린다", teamSnap.segs);
check(!/Task/.test(teamSnap.toolsText) && !/로그인 탐색/.test(teamSnap.toolsText), "자식 작업이 일반 도구 줄에 묻히지 않는다", teamSnap.toolsText);
check(/로그인 탐색/.test(teamSnap.teamText) && /탐색/.test(teamSnap.teamText), "팀 카드에 짧은 이름과 역할이 있다", teamSnap.teamText);
check(/끝|실행 중/.test(teamSnap.teamText), "팀 카드에 상태가 있다", teamSnap.teamText);
check(!teamSnap.jsonDump, "원본 JSON 덤프가 없다");

await evaluate(`document.querySelector('[data-seg="team"] button')?.click()`);
await sleep(400);
const expanded = await evaluate<string>(`document.querySelector('[data-seg="team"]')?.innerText ?? ""`);
check(/src\/auth\.ts/.test(expanded) && !/subagent_type/.test(expanded), "펼치면 손댄 파일이 보이고 JSON은 없다", expanded);

console.log("\n[2] 자식 작업이 없는 세션");
await open("fixture-codex");
const noTeam = await evaluate<number>(`document.querySelectorAll('[data-seg="team"]').length`);
check(noTeam === 0, "빈 팀 UI를 그리지 않는다", noTeam);

console.log("\n[3] 실행 가능 명령 메뉴");
await open("fixture-grok");
const grokPage = await evaluate<{ title: string; ta: number; segs: number }>(`({
  title: document.title,
  ta: document.querySelectorAll('textarea').length,
  segs: document.querySelectorAll('[data-seg]').length,
})`);
if (grokPage.ta === 0) console.log(`  grok page ${JSON.stringify(grokPage)}`);
await typeSlash();
const grokMenu = await evaluate<{ names: string[]; hasDashboard: boolean; ta: string | null }>(`(() => {
  const names = [...document.querySelectorAll('[data-slash-name]')].map((n) => n.getAttribute('data-slash-name') || '');
  const ta = document.querySelector('.aether-composer textarea, textarea');
  return { names, hasDashboard: names.some((n) => /dashboard/i.test(n)), ta: ta instanceof HTMLTextAreaElement ? ta.value : null };
})()`);
check(grokMenu.names.includes('compact'), "compact가 메뉴에 있다", grokMenu.names);
check(grokMenu.names.includes('memory'), "memory가 메뉴에 있다", grokMenu.names);
check(!grokMenu.hasDashboard, "터미널 전용 dashboard는 메뉴에 없다", grokMenu);

const memBox = await evaluate<{ x: number; y: number }>(`(() => {
  const el = document.querySelector('[data-slash-name="memory"]');
  const r = el?.getBoundingClientRect();
  return { x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 };
})()`);
if (memBox.x > 0) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: memBox.x, y: memBox.y });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: memBox.x, y: memBox.y });
  await sleep(250);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(500);
}
const brainOpen = await evaluate<boolean>(`!!document.querySelector('[data-brain]')`);
check(brainOpen, "/memory가 Agent Brain을 연다", brainOpen);

await open("fixture-claude");
await typeSlash();
const claudeMenu = await evaluate<string[]>(`[...document.querySelectorAll('[data-slash-name]')].map((n) => n.getAttribute('data-slash-name') || '')`);
check(!claudeMenu.some((n) => /^team$/i.test(n)), "Claude 메뉴에 빈 팀 명령이 없다", claudeMenu);
check(!claudeMenu.some((n) => /dashboard/i.test(n)), "Claude 메뉴가 터미널 전용 명령으로 안 깨진다", claudeMenu);

socket.close();
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
console.log(`\n${failures.length === 0 ? "✅" : "❌"} checkTeam ${width}×${height}: ${pass} PASS / ${failures.length} FAIL`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
