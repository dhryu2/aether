/**
 * 워크스페이스(Agent Brain 코드 이름 brain) 창 회귀 검사. 탭이 하나뿐이라 탭 막대가 없어야 한다.
 *
 * 실행 전 fixtureServer와 CDP Chrome을 띄운다.
 * CDP_PORT=9444 node --import tsx test/visual/checkBrain.ts \
 *   "http://127.0.0.1:8899/?s=fixture-claude" 390 844 [capture-dir]
 */
import fs from "node:fs";
import path from "node:path";
import { assert, connectBrain, HIT_SCRIPT, sleep } from "./brainCdp";

const [url, widthArg, heightArg, captureDir] = process.argv.slice(2);
if (!url) {
  console.error("Usage: checkBrain.ts <url> [width] [height] [capture-dir]");
  process.exit(2);
}

const width = Number(widthArg || 1440);
const height = Number(heightArg || 900);
const port = Number(process.env.CDP_PORT || 9222);
const phone = width < 760;
const colorScheme = process.env.COLOR_SCHEME === "light" || process.env.COLOR_SCHEME === "dark"
  ? process.env.COLOR_SCHEME
  : "";
function mediaFeatures(reduced: boolean): { name: string; value: string }[] {
  const features: { name: string; value: string }[] = [];
  if (colorScheme) features.push({ name: "prefers-color-scheme", value: colorScheme });
  // 기기 설정과 상관없이 첫 검사는 일반 움직임, 뒤 검사는 움직임 줄이기로 고정한다.
  features.push({ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" });
  return features;
}
const { send, evaluate, key, waitForAnimations, openBrain, assertTabTrapped, assertEscapeClosed, close } = await connectBrain(port, phone);

await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: phone,
});
await send("Emulation.setEmulatedMedia", { features: mediaFeatures(false) });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); localStorage.removeItem('aether.projectCollapsed.v1'); } catch (e) {}",
});
await send("Page.navigate", { url });
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (await evaluate<boolean>(`!!document.querySelector('[role="combobox"]:not([disabled])')`)) break;
  await sleep(100);
}

await openBrain();

let focusedClose = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  focusedClose = await evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === '닫기'`);
  if (focusedClose) break;
  await sleep(50);
}

const shell = await evaluate<{
  title: string;
  modal: string | null;
  orientation: string | null;
  tabs: { id: string | null; selected: string | null; text: string }[];
  width: number;
  overflow: boolean;
}>(`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const sheet = document.querySelector('[data-brain-sheet]');
  const doc = document.documentElement;
  return {
    title: document.querySelector('#brain-overlay-title')?.textContent?.trim() || '',
    modal: dialog?.getAttribute('aria-modal') || null,
    orientation: document.querySelector('[role="tablist"]')?.getAttribute('aria-orientation') || null,
    tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
      id: tab.getAttribute('data-brain-tab'),
      selected: tab.getAttribute('aria-selected'),
      text: (tab.textContent || '').replace(/\\s+/g, ' ').trim(),
    })),
    width: sheet?.getBoundingClientRect().width || 0,
    overflow: doc.scrollWidth > doc.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1 || (!!sheet && sheet.scrollWidth > sheet.clientWidth + 1),
  };
})()`);
assert(shell.modal === "true" && shell.title === "워크스페이스", `Dialog contract missing: ${JSON.stringify(shell)}`);
assert(focusedClose, "Initial focus is not the close action");
assert(shell.tabs.length === 0 && shell.orientation == null, `Tab bar must be hidden with a single tab: ${JSON.stringify(shell)}`);
assert(!shell.overflow, "Workspace has horizontal overflow");
if (width >= 1000) {
  assert(shell.width <= 1041 && shell.width >= 900, `Unexpected desktop sheet width ${shell.width}`);
} else if (width >= 760) {
  assert(shell.width <= width * 0.95 && shell.width >= width * 0.85, `Unexpected compact desktop sheet width ${shell.width}`);
} else {
  assert(shell.width >= width - 8 && shell.width <= width, `Mobile sheet width ${shell.width} != ${width}`);
}

// 끝없는 움직임은 홈의 참딩만 허용한다. 움직임 줄이기를 켜기 전에 본다.
const infinite = await evaluate<string[]>(`(() => {
  const root = document.querySelector('[data-brain]');
  if (!root) return ['missing-root'];
  const bad = [];
  for (const el of root.querySelectorAll('*')) {
    if (!(el instanceof Element)) continue;
    if (el.closest('.chamding-key, .chamding-quiet, .chamding-key-stage, .chamding-down, .chamding-up')) continue;
    const className = el.getAttribute('class') || '';
    if (/(^|\\s)chamding-/.test(className)) continue;
    const style = getComputedStyle(el);
    const counts = style.animationIterationCount.split(',');
    const names = style.animationName.split(',');
    counts.forEach((count, index) => {
      const name = (names[index] || names[0] || '').trim();
      if (count.trim() === 'infinite' && name !== 'none') bad.push(name + ' ' + className);
    });
  }
  return bad;
})()`);
assert(infinite.length === 0, `Infinite animation besides chamding: ${infinite.join(", ")}`);

await assertTabTrapped();

if (phone) {
  await waitForAnimations();
  assert(await evaluate<boolean>(`!document.querySelector('[data-brain-tabbar]')`), "Phone tab bar must be absent with a single tab");
  const small = await evaluate<string[]>(HIT_SCRIPT);
  assert(small.length === 0, `Phone hit target below 44: ${small.join(", ")}`);
}

if (captureDir) {
  fs.mkdirSync(captureDir, { recursive: true });
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(captureDir, `brain-${width}x${height}.png`),
    Buffer.from(screenshot.data, "base64"),
  );
}

await assertEscapeClosed(true);

// ── 검색 팝업: 세션 목록 머리의 검색 아이콘과 Cmd/Ctrl+K ──
// 맥은 ⌘, 그 밖은 Ctrl만 본다.
const mac = await evaluate<boolean>(`/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)`);
const modK = mac ? 4 : 2;
const palette = `!!document.querySelector('[data-window="search"]')`;
async function paletteOpen(): Promise<boolean> {
  await sleep(250);
  return evaluate<boolean>(palette);
}
// 이름 바꾸기 창 위에서는 Cmd/Ctrl+K가 팝업을 열지 않는다(데스크톱: 세션 줄 우클릭 메뉴로 연다).
if (!phone) {
  const renameOpen = await evaluate<boolean>(`(async () => {
    const row = document.querySelector('[data-session-id]');
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 200 }));
    await new Promise((r) => setTimeout(r, 200));
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent || '').includes('이름'));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    return !!document.querySelector('input[aria-label="세션 이름"]');
  })()`);
  assert(renameOpen, "Rename dialog did not open");
  await key("k", modK);
  assert(!(await paletteOpen()), "Cmd/Ctrl+K opened the search palette over the rename dialog");
  await key("Escape");
  await sleep(500);
}
// 아이콘으로 열기. 빈 입력이면 최근 세션이 보이고, 입력창에 초점이 있다.
const openedSearch = await evaluate<boolean>(`(() => {
  if (${phone}) document.querySelector('button[aria-label="세션 목록 열기"]')?.click();
  return true;
})()`);
assert(openedSearch, "unreachable");
await sleep(400);
const iconSize = await evaluate<{ w: number; h: number } | null>(`(() => {
  const el = document.querySelector('button[aria-label="지난 대화 검색"]');
  if (!(el instanceof HTMLElement)) return null;
  const rect = el.getBoundingClientRect();
  const after = getComputedStyle(el, '::after');
  return { w: Math.max(rect.width, parseFloat(after.width) || 0), h: Math.max(rect.height, parseFloat(after.height) || 0) };
})()`);
assert(iconSize !== null, "Search icon not found");
if (phone) assert(iconSize!.w >= 43.5 && iconSize!.h >= 43.5, `Phone search icon hit target below 44: ${JSON.stringify(iconSize)}`);
await evaluate(`(() => { const el = document.querySelector('button[aria-label="지난 대화 검색"]'); el.focus(); el.click(); })()`);
assert(await paletteOpen(), "Search icon did not open the palette");
const recentCount = await evaluate<number>(`document.querySelectorAll('[data-window="search"] [role="option"]').length`);
assert(recentCount > 0 && recentCount <= 8, `Recent sessions count ${recentCount}`);
assert(await evaluate<boolean>(`document.activeElement?.getAttribute('role') === 'combobox'`), "Palette input is not focused");
if (phone) {
  const small = await evaluate<string[]>(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-window="search"] button')) {
      if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) continue;
      const rect = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const w = Math.max(rect.width, parseFloat(after.width) || 0);
      const h = Math.max(rect.height, parseFloat(after.height) || 0);
      if (w < 43.5 || h < 43.5) out.push((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20) + ' ' + Math.round(w) + 'x' + Math.round(h));
    }
    return out;
  })()`);
  assert(small.length === 0, `Phone palette hit target below 44: ${small.join(", ")}`);
}
// 아래로 한 번 옮기면 둘째 행이 현재 행이다. Enter가 그 세션으로 간다.
await key("ArrowDown");
await sleep(80);
const secondId = await evaluate<string | null>(`(() => {
  const id = document.activeElement?.getAttribute('aria-activedescendant');
  const el = id ? document.getElementById(id) : null;
  return el && el.getAttribute('aria-selected') === 'true' ? el.textContent : null;
})()`);
assert(secondId !== null, "ArrowDown did not select a row");
await key("Enter");
await sleep(500);
assert(!(await paletteOpen()), "Enter did not close the palette");
// Esc로 닫고 열기 전 초점으로 돌아간다(컴퓨터).
if (!phone) {
  await evaluate(`(() => { const el = document.querySelector('button[aria-label="지난 대화 검색"]'); el.focus(); el.click(); })()`);
  assert(await paletteOpen(), "Palette did not reopen");
  await key("Escape");
  await sleep(600);
  assert(!(await paletteOpen()), "Escape did not close the palette");
  assert(await evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === '지난 대화 검색'`), "Focus was not restored to the search icon");
  // Cmd/Ctrl+K로 열고 다시 눌러 닫는다.
  await key("k", modK);
  assert(await paletteOpen(), "Cmd/Ctrl+K did not open the palette");
  await key("k", modK);
  await sleep(500);
  assert(!(await paletteOpen()), "Cmd/Ctrl+K did not close the palette");
}

await openBrain();

await send("Emulation.setEmulatedMedia", {
  features: mediaFeatures(true),
});
await sleep(80);
const reduced = await evaluate<{ sheet: number; content: number }>(`(() => {
  const dur = (el) => {
    if (!(el instanceof Element)) return 99;
    const raw = getComputedStyle(el).animationDuration || '0s';
    return Math.max(...raw.split(',').map((part) => parseFloat(part) || 0));
  };
  return {
    sheet: dur(document.querySelector('[data-brain-sheet]')),
    content: dur(document.querySelector('.tab-in-r, .tab-in-l')),
  };
})()`);
assert(reduced.sheet <= 0.01 && reduced.content <= 0.01, `Reduced motion not respected: ${JSON.stringify(reduced)}`);
await assertEscapeClosed(false);

await close();
console.log(`Workspace checks passed (${width}×${height})`);
process.exit(0);
