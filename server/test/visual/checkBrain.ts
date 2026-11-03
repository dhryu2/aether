/**
 * Phase F Agent Brain 회귀 검사.
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
const { send, evaluate, key, clickTab, waitForAnimations, openBrain, assertTabTrapped, assertEscapeClosed, close } = await connectBrain(port, phone);

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
assert(shell.modal === "true" && shell.title === "Agent Brain", `Dialog contract missing: ${JSON.stringify(shell)}`);
assert(focusedClose, "Initial focus is not the close action");
assert(shell.tabs.length === 2 && shell.tabs[0]?.id === "hub" && shell.tabs[0]?.selected === "true" && shell.tabs[0]?.text.includes("홈"), `Home tab contract missing: ${JSON.stringify(shell.tabs)}`);
assert(shell.tabs.map((tab) => tab.id).join(",") === "hub,search", `Tab order changed: ${JSON.stringify(shell.tabs)}`);
if (phone) assert(shell.orientation == null, `Phone tab list should not be vertical: ${shell.orientation}`);
else assert(shell.orientation === "vertical", `Desktop tab list is not vertical: ${shell.orientation}`);
assert(!shell.overflow, "Agent Brain has horizontal overflow");
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
  const bar = await evaluate<{ inside: boolean; top: number; bottom: number; left: number; right: number }>(`(() => {
    const el = document.querySelector('[data-brain-tabbar]');
    if (!(el instanceof HTMLElement)) return { inside: false, top: -1, bottom: -1, left: -1, right: -1 };
    const rect = el.getBoundingClientRect();
    return {
      inside: rect.top >= 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1 && rect.bottom > window.innerHeight - 120,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    };
  })()`);
  assert(bar.inside, `Phone tab bar is outside the screen: ${JSON.stringify(bar)}`);
  const small = await evaluate<string[]>(HIT_SCRIPT);
  assert(small.length === 0, `Phone hit target below 44: ${small.join(", ")}`);
}

// 컴퓨터는 아래 화살표, 폰은 오른쪽 화살표. 화살표는 초점만 옮기고 Enter가 고른다.
await clickTab("search");
await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.focus()`);
await key(phone ? "ArrowRight" : "ArrowDown");
await sleep(120);
const moved = await evaluate<{ focus: string | null; selected: string | null }>(`(() => ({
  focus: document.activeElement?.getAttribute('data-brain-tab') || null,
  selected: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-brain-tab') || null,
}))()`);
assert(moved.focus === "hub" && moved.selected === "search", `Arrow did not wrap focus to Home: ${JSON.stringify(moved)}`);
await key("Enter");
await sleep(120);
const selectedHome = await evaluate<string | null>(`document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-brain-tab') || null`);
assert(selectedHome === "hub", `Enter did not select Home: ${selectedHome}`);

if (captureDir) {
  fs.mkdirSync(captureDir, { recursive: true });
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(captureDir, `brain-${width}x${height}.png`),
    Buffer.from(screenshot.data, "base64"),
  );
}

if (phone) {
  await clickTab("search");
  const searchTargets = await evaluate<string[]>(HIT_SCRIPT);
  assert(searchTargets.length === 0, `Phone search hit target below 44: ${searchTargets.join(", ")}`);
  const hidden = await evaluate<boolean>(`(() => {
    const input = document.querySelector('#brain-tabpanel input.brain-input');
    const bar = document.querySelector('[data-brain-tabbar]');
    if (!(input instanceof HTMLElement) || !(bar instanceof HTMLElement)) return false;
    input.focus();
    return getComputedStyle(bar).display === 'none';
  })()`);
  assert(hidden, "Phone tab bar stays visible while the search field is focused");
}

await assertEscapeClosed(true);
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
    content: dur(document.querySelector('#brain-tabpanel')),
  };
})()`);
assert(reduced.sheet <= 0.01 && reduced.content <= 0.01, `Reduced motion not respected: ${JSON.stringify(reduced)}`);
await assertEscapeClosed(false);

await close();
console.log(`Agent Brain checks passed (${width}×${height})`);
process.exit(0);
