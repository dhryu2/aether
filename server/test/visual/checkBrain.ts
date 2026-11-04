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
let focusedList = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  focusedClose = await evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === '닫기' || document.activeElement?.hasAttribute('data-review-list') === true`);
  if (focusedClose) {
    // 넓은 화면에서 검토할 작업이 있으면 닫기 버튼에서 목록으로 초점이 옮겨 간다. 잠깐 기다려 본다.
    for (let wait = 0; wait < 20 && !focusedList && !phone && !url.includes('reviewEmpty=1'); wait += 1) {
      focusedList = await evaluate<boolean>(`document.activeElement?.hasAttribute('data-review-list') === true`);
      if (!focusedList) await sleep(50);
    }
    break;
  }
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

// 끝없는 움직임은 참딩과 불러오는 동안의 뼈대만 허용한다. 움직임 줄이기를 켜기 전에 본다.
const infinite = await evaluate<string[]>(`(() => {
  const root = document.querySelector('[data-brain]');
  if (!root) return ['missing-root'];
  const bad = [];
  for (const el of root.querySelectorAll('*')) {
    if (!(el instanceof Element)) continue;
    if (el.closest('.chamding-key, .chamding-quiet, .chamding-key-stage, .chamding-down, .chamding-up')) continue;
    if (el.classList.contains('skeleton')) continue; // 불러오는 동안의 회색 뼈대는 움직임 줄이기에서 꺼진다
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

// ── 검토함: 목록·상세·완료와 되돌리기·키보드·빈 상태. url에 reviewEmpty=1을 주면 빈 상태만 본다. ──
async function shot(name: string) {
  if (!captureDir) return;
  fs.mkdirSync(captureDir, { recursive: true });
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(captureDir, `review-${name}-${width}x${height}.png`), Buffer.from(screenshot.data, "base64"));
}
async function waitFor(expression: string, what: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate<boolean>(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const optionCount = () => evaluate<number>(`document.querySelectorAll('[data-review-opt]').length`);
const clickButton = (label: string) => evaluate<boolean>(`(() => {
  const b = [...document.querySelectorAll('[data-review] button')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)});
  if (!(b instanceof HTMLElement)) return false;
  b.click();
  return true;
})()`);
const clickNoticeAction = (label: string) => evaluate<boolean>(`(() => {
  const b = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)} && !el.closest('[data-review]'));
  if (!(b instanceof HTMLElement)) return false;
  b.click();
  return true;
})()`);
const emptyMode = new URL(url).searchParams.get("reviewEmpty") === "1";
if (emptyMode) {
  await waitFor(`document.body.innerText.includes('검토할 작업이 없어요')`, "review empty state");
  assert(await evaluate<boolean>(`document.body.innerText.includes('세션이 파일을 바꾸거나 할 일을 남기거나 실패한 채 끝나면 여기에 모여요.')`), "Empty description missing");
  assert(await evaluate<boolean>(`!document.querySelector('[data-review] button')`), "Empty state must not have action buttons");
  assert(await evaluate<boolean>(`document.querySelector('h1')?.textContent?.trim() === '검토함' || !!document.querySelector('#brain-overlay-title')`), "Panel title missing");
  await shot("empty");
} else {
  await waitFor(`document.querySelectorAll('[data-review-opt]').length === 3`, "three review rows");
  assert(await evaluate<boolean>(`document.querySelector('h1')?.textContent?.trim() === '검토함'`), "Panel title 검토함 missing on the list");
  const headings = await evaluate<string[]>(`[...document.querySelectorAll('[role="group"] > [id^="review-group-"]')].map((el) => el.textContent.trim())`);
  assert(JSON.stringify(headings) === JSON.stringify(["먼저 볼 것", "변경만 있음"]), `Group headings: ${JSON.stringify(headings)}`);
  const rowInfo = await evaluate<{ titles: string[]; failIcon: boolean; failText: boolean; truncated: boolean; third: unknown; minH: number; tabular: boolean; role: string | null }>(`(() => {
    const rows = [...document.querySelectorAll('[data-review-opt]')];
    const first = rows[0];
    const third = rows[2].querySelector('.truncate');
    return {
      titles: rows.map((el) => el.querySelector('.truncate')?.textContent || ''),
      failIcon: !!first.querySelector('svg'),
      failText: (first.textContent || '').includes('실패 1개'),
      truncated: !!third && third.scrollWidth > third.clientWidth && third.getAttribute('title') === third.textContent,
      third: third ? [third.scrollWidth, third.clientWidth, third.textContent, third.getAttribute('title')] : null,
      minH: Math.min(...rows.map((el) => el.getBoundingClientRect().height)),
      tabular: !!first.querySelector('.tabular-nums'),
      role: document.querySelector('[data-review-list]')?.getAttribute('role') || null,
    };
  })()`);
  assert(rowInfo.titles[0] === "fixture · claude" && rowInfo.titles[1] === "fixture · second provider", `Row order: ${JSON.stringify(rowInfo.titles)}`);
  assert(rowInfo.failIcon && rowInfo.failText, "Failed row must show an icon together with the text");
  assert(rowInfo.truncated, `Long title is not truncated with a title tooltip: ${JSON.stringify(rowInfo)}`);
  assert(rowInfo.minH >= 44, `Row height below 44: ${rowInfo.minH}`);
  if (!phone) {
    // 넓은 화면에서는 목록이 뜨면 선택된 행(목록)에 초점이 있어 E·Z·위아래가 바로 된다. 탭이 하나라 왼쪽 기둥은 없다.
    assert(focusedList, "Wide workspace did not move the initial focus to the review list");
    assert(await evaluate<boolean>(`!document.body.innerText.includes('현재 프로젝트') && !!document.querySelector('[data-brain-sheet] #brain-overlay-title')`), "Single-tab workspace still draws the left pillar");
  } else {
    const aligned = await evaluate<{ h1: number; row: number; group: number }>(`(() => {
      const left = (el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft || '0');
      return { h1: left(document.querySelector('h1')), row: left(document.querySelector('[data-review-opt] .truncate')), group: left(document.querySelector('[id^="review-group-"]')) };
    })()`);
    assert(Math.abs(aligned.h1 - aligned.row) <= 1 && Math.abs(aligned.h1 - aligned.group) <= 1, `Phone list left edge is misaligned: ${JSON.stringify(aligned)}`);
  }
  assert(rowInfo.tabular && rowInfo.role === "listbox", `List contract: ${JSON.stringify(rowInfo)}`);

  const detailSections = () => evaluate<string[]>(`[...document.querySelectorAll('[data-review] section > h3')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim())`);
  if (phone) {
    assert(await evaluate<boolean>(`![...document.querySelectorAll('[data-review] button')].some((b) => (b.textContent || '').trim() === '검토 완료')`), "Phone list must not show the detail");
    await shot("list");
    const smallList = await evaluate<string[]>(HIT_SCRIPT);
    assert(smallList.length === 0, `Phone review list hit target below 44: ${smallList.join(", ")}`);
    await evaluate(`document.querySelector('[data-review-opt]').click()`);
    await waitFor(`[...document.querySelectorAll('[data-review] button')].some((b) => (b.textContent || '').trim() === '검토 완료')`, "phone detail");
    assert(await evaluate<boolean>(`[...document.querySelectorAll('[data-brain-sheet] button')].some((b) => (b.textContent || '').trim() === '검토함')`), "Phone detail has no back button");
    assert(await evaluate<boolean>(`!document.querySelector('[data-review-list]')`), "Phone detail must replace the list");
  } else {
    assert(await evaluate<boolean>(`document.querySelector('[data-review-opt]').getAttribute('aria-selected') === 'true'`), "First row is not selected on wide screens");
  }
  await waitFor(`document.body.innerText.includes('커밋 안 됨')`, "file git state");
  const sections = await detailSections();
  assert(sections[0].startsWith("실패한 채 끝난 명령") && sections[1].startsWith("바뀐 파일"), `Detail sections: ${JSON.stringify(sections)}`);
  const labels = await evaluate<number>(`[...document.querySelectorAll('[data-review] section span')].filter((el) => ['커밋 안 됨', '지금은 변경 없음'].includes((el.textContent || '').trim())).length`);
  assert(labels === 3, `Four files, one unknown: expected 3 state labels, got ${labels}`);
  assert(await evaluate<boolean>(`document.body.innerText.includes('도중에 실패한 명령 2개')`), "Other failures fold missing");
  await evaluate(`[...document.querySelectorAll('[data-review] button')].find((b) => (b.textContent || '').includes('도중에 실패한 명령')).click()`);
  await waitFor(`document.body.innerText.includes('뒤에 다른 명령이 성공했어요. 문제가 없는지는 세션에서 확인해 주세요.')`, "other failures hint");
  const detailInfo = await evaluate<{ foot: boolean; unrecorded: boolean; wrap: boolean; actions: string[]; barInView: boolean; overflow: boolean }>(`(() => {
    const panel = document.querySelector('[data-review]');
    const text = panel.innerText;
    const buttons = [...panel.querySelectorAll('button')].filter((b) => ['세션 열기', '검토 완료'].includes((b.textContent || '').trim()));
    const bar = buttons[0]?.getBoundingClientRect();
    const mono = [...panel.querySelectorAll('section button span')].filter((el) => getComputedStyle(el).overflowWrap === 'anywhere');
    return {
      foot: text.includes('기록에서 모은 내용이에요. 결과가 맞는지는 직접 확인해 주세요.'),
      unrecorded: text.includes('기록에 없는 변경 2개'),
      wrap: mono.length > 0,
      actions: buttons.map((b) => (b.textContent || '').trim()),
      barInView: !!bar && bar.bottom <= window.innerHeight && bar.top >= 0,
      overflow: panel.scrollWidth > panel.clientWidth + 1,
    };
  })()`);
  assert(detailInfo.foot && detailInfo.unrecorded && detailInfo.wrap, `Detail content: ${JSON.stringify(detailInfo)}`);
  assert(detailInfo.actions.join() === "세션 열기,검토 완료" && detailInfo.barInView && !detailInfo.overflow, `Detail actions: ${JSON.stringify(detailInfo)}`);
  await evaluate(`[...document.querySelectorAll('[data-review] button')].find((b) => (b.textContent || '').includes('기록에 없는 변경')).click()`);
  await waitFor(`document.body.innerText.includes('다른 세션이나 명령이 만든 변경일 수 있어요')`, "unrecorded hint");
  await waitForAnimations();
  await shot("detail");
  if (phone) {
    const smallDetail = await evaluate<string[]>(HIT_SCRIPT);
    assert(smallDetail.length === 0, `Phone review detail hit target below 44: ${smallDetail.join(", ")}`);
  }

  // 검토 완료 → 알림 줄의 되돌리기. 폰은 목록으로 돌아온다.
  assert(await clickButton("검토 완료"), "Done button not found");
  await waitFor(`document.querySelectorAll('[data-review-opt]').length === 2`, "row removed after done");
  await waitFor(`!![...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '되돌리기')`, "undo action in the notice");
  assert(await evaluate<boolean>(`document.querySelector('.brain-sr[role="status"]')?.textContent?.includes('검토 완료')`), "Live region did not announce the review");
  if (phone) assert(await evaluate<boolean>(`!!document.querySelector('[data-review-list]')`), "Phone did not return to the list after done");
  else assert(await evaluate<boolean>(`document.querySelector('[data-review-opt][aria-selected="true"]')?.textContent?.includes('second provider')`), "Selection did not move to the next row");
  assert(await clickNoticeAction("되돌리기"), "Undo action not found");
  await waitFor(`document.querySelectorAll('[data-review-opt]').length === 3`, "row restored after undo");
  if (!phone) assert(await evaluate<boolean>(`document.querySelector('[data-review-opt][aria-selected="true"]')?.textContent?.includes('fixture · claude')`), "Undo did not reselect the row");

  if (!phone) {
    // 턴이 중단으로 끝난 세션은 그 사실을 상세에서 알린다.
    await evaluate(`document.querySelectorAll('[data-review-opt]')[1].click()`);
    await waitFor(`document.body.innerText.includes('마지막 턴이 중단됐어요')`, "turn interrupted note");
    assert(await evaluate<boolean>(`document.querySelectorAll('[data-review-opt]')[1].textContent.includes('턴 중단')`), "Row subtitle lacks the interrupted turn");
    await evaluate(`document.querySelectorAll('[data-review-opt]')[0].click()`);
  }
  if (!phone) {
    // 목록에 초점이 있을 때만 키가 먹는다: 아래로 이동, E 완료, Z 되돌리기.
    await evaluate(`document.querySelector('[data-review-list]').focus()`);
    await key("ArrowDown");
    await sleep(120);
    assert(await evaluate<boolean>(`(() => { const l = document.querySelector('[data-review-list]'); return document.getElementById(l.getAttribute('aria-activedescendant') || '')?.textContent?.includes('second provider') === true; })()`), "ArrowDown did not move the selection");
    await key("e");
    await waitFor(`document.querySelectorAll('[data-review-opt]').length === 2`, "E marks the selected row reviewed");
    await key("z");
    await waitFor(`document.querySelectorAll('[data-review-opt]').length === 3`, "Z undoes the last review");
    // 다른 입력칸에 쓰는 글자는 목록이 받지 않는다.
    await evaluate(`(() => { const i = document.createElement('input'); i.id = 'review-probe'; document.querySelector('[data-review]').appendChild(i); i.focus(); })()`);
    await key("e");
    await sleep(250);
    assert((await optionCount()) === 3, "E typed in an input marked a row reviewed");
    await evaluate(`document.getElementById('review-probe').remove()`);
  }
  await shot("list-after");

  // 항목을 누르면 세션의 그 지점으로 간다: 창이 닫히고 그 세션이 열린다. 다시 열어 남은 검사를 잇는다.
  if (!phone) {
    await evaluate(`document.querySelector('[data-review] section button').click()`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await evaluate<boolean>(`!document.querySelector('[role="dialog"]')`)) break;
      await sleep(100);
    }
    assert(await evaluate<boolean>(`!document.querySelector('[role="dialog"]')`), "Detail item did not close the workspace");
    await sleep(500);
    await openBrain();
  }
}

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
