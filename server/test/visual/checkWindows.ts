/**
 * 창 회귀 검사. Chrome과 fixture 서버는 띄우지 않고, 이미 떠 있는 CDP에 붙는다.
 *
 *   CDP_PORT=9222 node --import tsx test/visual/checkWindows.ts \
 *     "http://127.0.0.1:8899/?s=fixture-claude" 390 844
 *
 * 인자: <서버 주소> <폭> <높이>. 폭과 높이는 따로 넘긴다.
 * COLOR_SCHEME=light|dark, CDP_PORT 기본 9222.
 * 키 입력은 brainCdp.key만 쓴다. nativeVirtualKeyCode는 넣지 않는다.
 */
import { connectBrain, sleep } from "./brainCdp";

const [url, widthArg, heightArg] = process.argv.slice(2);
const width = Number(widthArg);
const height = Number(heightArg);
if (!url || !Number.isFinite(width) || !Number.isFinite(height)) {
  console.error("사용: checkWindows.ts <서버 주소> <폭> <높이>");
  process.exit(2);
}

const port = Number(process.env.CDP_PORT || 9222);
const phone = width < 760;
const colorScheme = process.env.COLOR_SCHEME === "light" || process.env.COLOR_SCHEME === "dark"
  ? process.env.COLOR_SCHEME
  : "";

type Page = Awaited<ReturnType<typeof connectBrain>>;
type Facts = {
  role: string | null;
  modal: string | null;
  titled: boolean;
  described: boolean;
  activeLabel: string;
  overflow: boolean;
  onScreen: boolean;
  phoneTop: boolean;
  infinite: number;
  small: string[];
};

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures += 1;
  const extra = ok || detail == null ? "" : " " + JSON.stringify(detail);
  console.log(`${ok ? "통과" : "실패"} ${name}${extra}`);
}

function factsExpr(sel: string): string {
  return `(() => {
    const box = document.querySelector(${JSON.stringify(sel)});
    if (!(box instanceof HTMLElement)) return null;
    const labelledBy = box.getAttribute("aria-labelledby");
    const describedBy = box.getAttribute("aria-describedby");
    const title = labelledBy ? document.getElementById(labelledBy) : null;
    const desc = describedBy ? document.getElementById(describedBy) : null;
    const rect = box.getBoundingClientRect();
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
    const safeTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    const active = document.activeElement;
    const activeLabel = active instanceof HTMLElement
      ? (active.getAttribute("aria-label") || (active.textContent || "").split(/\\s+/).join(" ").trim()).slice(0, 80)
      : "";
    const overflows = (el) => el.scrollWidth > el.clientWidth + 1;
    const scroller = box.querySelector(".scroll-area");
    let infinite = 0;
    for (const el of [box, ...box.querySelectorAll("*")]) {
      if (!(el instanceof Element)) continue;
      const cs = getComputedStyle(el);
      const names = cs.animationName.split(",");
      const counts = cs.animationIterationCount.split(",");
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i].trim().toLowerCase();
        const count = (counts[i] || counts[0] || "").trim();
        if (!name || name === "none" || count !== "infinite") continue;
        const cls = String(el.className || "").toLowerCase();
        if (name.includes("chamding") || cls.includes("chamding")) continue;
        infinite += 1;
      }
    }
    const small = [];
    if (${phone ? "true" : "false"}) {
      const measure = (el) => {
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, "::after");
        const aw = parseFloat(after.width);
        const ah = parseFloat(after.height);
        return {
          w: Math.max(r.width, Number.isFinite(aw) ? aw : 0),
          h: Math.max(r.height, Number.isFinite(ah) ? ah : 0),
        };
      };
      for (const el of box.querySelectorAll("button, a[href], input, select, textarea, [tabindex='0']")) {
        if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) continue;
        const b = measure(el);
        if (b.w < 43.5 || b.h < 43.5) {
          const label = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40);
          small.push(label + " " + Math.round(b.w) + "x" + Math.round(b.h));
        }
      }
    }
    const sheet = box.classList.contains("window-phone");
    return {
      role: box.getAttribute("role"),
      modal: box.getAttribute("aria-modal"),
      titled: !!title && !!(title.textContent || "").trim(),
      described: box.getAttribute("role") !== "alertdialog" || !!desc,
      activeLabel,
      overflow: overflows(box) || (scroller instanceof HTMLElement && overflows(scroller)),
      onScreen: rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
      phoneTop: !sheet || rect.top >= safeTop + 56 - 1,
      infinite,
      small,
    };
  })()`;
}

async function openPage(): Promise<Page> {
  const page = await connectBrain(port, phone);
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: phone,
  });
  const features: { name: string; value: string }[] = [
    { name: "prefers-reduced-motion", value: "no-preference" },
  ];
  if (colorScheme) features.unshift({ name: "prefers-color-scheme", value: colorScheme });
  await page.send("Emulation.setEmulatedMedia", { features });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try { localStorage.removeItem('aether.panes.v1'); localStorage.removeItem('aether.projectCollapsed.v1'); } catch (e) {}",
  });
  await page.send("Page.navigate", { url });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ready = await page.evaluate<boolean>(`!!document.querySelector('[aria-label="설정"], [aria-label="Settings"]')`);
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error("설정 버튼이 나타나지 않았다");
  return page;
}

async function waitFor(page: Page, sel: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
    await sleep(50);
  }
  return false;
}

async function readFacts(page: Page, sel: string): Promise<Facts | null> {
  return page.evaluate<Facts | null>(factsExpr(sel));
}

function withItems(sel: string, body: string): string {
  return `(() => {
    const box = document.querySelector(${JSON.stringify(sel)});
    if (!(box instanceof HTMLElement)) return false;
    const items = [...box.querySelectorAll("button, a[href], input, select, textarea, [tabindex='0']")].filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.hasAttribute("disabled") || el.tabIndex < 0) return false;
      if (getComputedStyle(el).visibility === "hidden") return false;
      return el.getClientRects().length > 0;
    });
    ${body}
  })()`;
}

// 마지막 누름 요소에서 Tab은 첫 요소로, 첫 요소에서 Shift+Tab은 마지막 요소로 가야 한다.
// Shift+Tab을 한 번만 누르면 역방향 가두기가 없어도 통과하므로, 끝을 짚고 각각 확인한다.
async function wraps(page: Page, sel: string, from: "first" | "last", modifiers: number, to: "first" | "last"): Promise<boolean> {
  const fromExpr = from === "last" ? "items[items.length - 1]" : "items[0]";
  const toExpr = to === "last" ? "items[items.length - 1]" : "items[0]";
  const focused = await page.evaluate<boolean>(withItems(sel, `
    const el = ${fromExpr};
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    return document.activeElement === el;
  `));
  if (!focused) return false;
  await page.key("Tab", modifiers);
  await sleep(30);
  return page.evaluate<boolean>(withItems(sel, `
    const el = ${toExpr};
    return el instanceof HTMLElement && document.activeElement === el;
  `));
}

async function restored(page: Page): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate<{ ok: boolean; detail: string }>(`(() => {
    const opener = window.__aetherOpener;
    const active = document.activeElement;
    const blurred = active == null || active === document.body || active === document.documentElement;
    const labelOf = (el) => {
      if (!(el instanceof HTMLElement)) return "";
      return (el.getAttribute("aria-label") || (el.textContent || "").split(/\\s+/).join(" ").trim()).slice(0, 40);
    };
    const onScreen = (el) => {
      if (!(el instanceof HTMLElement) || !el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    };
    // 여는 버튼이 화면 안에 있으면(컴퓨터 폭의 설정·재시작 버튼) 그 버튼만 통과다.
    // 초점만 풀린 상태는 그때 통과가 아니다. 버튼이 사라졌거나 화면 밖일 때만 초점 풀림을 통과로 친다.
    if (onScreen(opener)) {
      const ok = active === opener;
      return { ok, detail: ok ? "" : "초점=" + labelOf(active) + " 여는버튼=" + labelOf(opener) };
    }
    return { ok: blurred, detail: blurred ? "" : "화면 밖 여는 버튼인데 초점이 남아 있음" };
  })()`);
}

async function checkRestored(page: Page, name: string) {
  const back = await restored(page);
  check(name, back.ok, back.detail || undefined);
}

async function expectWindow(page: Page, sel: string, role: string, focusLabels: string[]) {
  const opened = await waitFor(page, sel);
  check(`${sel} 열림`, opened);
  if (!opened) return;
  await page.waitForAnimations();
  let facts = await readFacts(page, sel);
  for (let attempt = 0; attempt < 20 && facts && !focusLabels.includes(facts.activeLabel); attempt += 1) {
    await sleep(50);
    facts = await readFacts(page, sel);
  }
  check(
    `${sel} 역할·모달·제목`,
    !!facts && facts.role === role && facts.modal === "true" && facts.titled && facts.described,
    facts && { role: facts.role, modal: facts.modal, titled: facts.titled, described: facts.described },
  );
  check(`${sel} 처음 초점`, !!facts && focusLabels.includes(facts.activeLabel), facts?.activeLabel);
  check(`${sel} Tab 순방향 가두기`, await wraps(page, sel, "last", 0, "first"));
  check(`${sel} Tab 역방향 가두기`, await wraps(page, sel, "first", 8, "last"));
  facts = await readFacts(page, sel);
  check(`${sel} 가로 넘침 0`, !!facts && !facts.overflow);
  check(`${sel} 화면 안`, !!facts && facts.onScreen && facts.phoneTop, facts && { onScreen: facts.onScreen, phoneTop: facts.phoneTop });
  if (phone) check(`${sel} 누름 44`, !!facts && facts.small.length === 0, facts?.small);
  check(`${sel} 끝없는 움직임 0`, !!facts && facts.infinite === 0, facts?.infinite);
}

async function scenario(name: string, run: (page: Page) => Promise<void>) {
  let page: Page | null = null;
  try {
    page = await openPage();
    await run(page);
  } catch (error) {
    check(`${name} 도중 오류`, false, error instanceof Error ? error.message : String(error));
  } finally {
    await page?.close();
  }
}

const closeLabels = ["닫기", "Close"];
const cancelLabels = ["취소", "Cancel"];

await scenario("설정", async (page) => {
  const opened = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    window.__aetherOpener = el;
    el.click();
    return true;
  })()`);
  check("설정 버튼으로 열기", opened);
  if (!opened) return;
  await expectWindow(page, '[data-window="settings"]', "dialog", closeLabels);
  await page.key("Escape");
  await sleep(150);
  const gone = await page.evaluate<boolean>(`!document.querySelector('[data-window="settings"]')`);
  check("설정 Esc로 닫힘", gone);
  await checkRestored(page, "설정 초점 복귀");
});

await scenario("재시작 확인", async (page) => {
  const openedSettings = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("재시작 확인 전에 설정 열림", openedSettings);
  if (!openedSettings) return;
  if (!(await waitFor(page, '[data-window="settings"]'))) {
    check("재시작 확인용 설정 창", false);
    return;
  }
  await page.waitForAnimations();
  // 서버 재시작은 설정의 '점검' 탭에 있다.
  await page.evaluate(`document.getElementById('settings-tab-diagnostics')?.click()`);
  await sleep(150);
  const clicked = await page.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('[data-window="settings"] button')].find((el) => {
      const text = (el.textContent || "").split(/\\s+/).join(" ").trim();
      return text === "재시작" || text === "Restart" || text === "서버 재시작" || text === "Restart server";
    });
    if (!(btn instanceof HTMLElement)) return false;
    btn.focus();
    window.__aetherOpener = btn;
    btn.click();
    return true;
  })()`);
  check("재시작 버튼으로 확인 열기", clicked);
  if (!clicked) return;
  await expectWindow(page, '[data-window="confirm"]', "alertdialog", cancelLabels);
  await page.key("Escape");
  await sleep(150);
  const left = await page.evaluate<{ confirm: boolean; settings: boolean }>(`(() => ({
    confirm: !!document.querySelector('[data-window="confirm"]'),
    settings: !!document.querySelector('[data-window="settings"]'),
  }))()`);
  check("설정 위 확인에서 Esc는 확인만 닫음", !left.confirm && left.settings, left);
  await checkRestored(page, "재시작 확인 초점 복귀");
});

await scenario("삭제 확인", async (page) => {
  let menuReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    menuReady = await page.evaluate<boolean>(`!!document.querySelector('[data-session-opt="work-menu"]')`);
    if (menuReady) break;
    await sleep(100);
  }
  const openedMenu = menuReady && await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-session-opt="work-menu"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("작업 메뉴 열기", openedMenu);
  if (!openedMenu) return;
  await sleep(200);
  const clicked = await page.evaluate<boolean>(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => {
      const text = (el.textContent || "").trim();
      return text === "세션 삭제" || text === "Delete work";
    });
    if (!(item instanceof HTMLElement)) return false;
    window.__aetherOpener = item;
    item.click();
    return true;
  })()`);
  check("작업 삭제로 확인 열기", clicked);
  if (!clicked) return;
  await expectWindow(page, '[data-window="delete"]', "alertdialog", cancelLabels);
  await page.key("Escape");
  await sleep(150);
  const gone = await page.evaluate<boolean>(`!document.querySelector('[data-window="delete"]')`);
  check("삭제 확인 Esc로 닫힘", gone);
  // 메뉴 항목은 누르면 메뉴가 닫혀 사라진다. 그 요소가 없으면 초점만 거둔다.
  await checkRestored(page, "삭제 확인 초점 복귀");
});

await scenario("단축키", async (page) => {
  await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (el instanceof HTMLElement) {
      el.focus();
      window.__aetherOpener = el;
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    return true;
  })()`);
  await page.key("?");
  await expectWindow(page, '[data-window="shortcuts"]', "dialog", closeLabels);
  await page.key("Escape");
  await sleep(150);
  const gone = await page.evaluate<boolean>(`!document.querySelector('[data-window="shortcuts"]')`);
  check("단축키 Esc로 닫힘", gone);
  await checkRestored(page, "단축키 초점 복귀");
});

await scenario("겹친 확인 단축키", async (page) => {
  const openedSettings = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("겹침 전에 설정 열림", openedSettings);
  if (!openedSettings) return;
  if (!(await waitFor(page, '[data-window="settings"]'))) {
    check("겹침용 설정 창", false);
    return;
  }
  await page.waitForAnimations();
  // 서버 재시작은 설정의 '점검' 탭에 있다.
  await page.evaluate(`document.getElementById('settings-tab-diagnostics')?.click()`);
  await sleep(150);
  const clicked = await page.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('[data-window="settings"] button')].find((el) => {
      const text = (el.textContent || "").split(/\\s+/).join(" ").trim();
      return text === "재시작" || text === "Restart" || text === "서버 재시작" || text === "Restart server";
    });
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    return true;
  })()`);
  check("겹침용 재시작 확인 열기", clicked);
  if (!clicked) return;
  if (!(await waitFor(page, '[data-window="confirm"]'))) {
    check("겹침용 확인 창", false);
    return;
  }
  await page.waitForAnimations();
  // Meta=4, Control=2. brainCdp.key는 nativeVirtualKeyCode를 넣지 않는다.
  // 두 키를 모두 보낸 뒤에만 보면, 첫 키가 닫고 둘째 키가 다시 연 경우를 놓친다.
  for (const [label, modifiers] of [
    ["Meta+,", 4],
    ["Control+,", 2],
  ] as const) {
    await page.key(",", modifiers);
    await sleep(80);
    const still = await page.evaluate<{ confirm: boolean; settings: boolean; focus: boolean }>(`(() => {
      const confirm = document.querySelector('[data-window="confirm"]');
      const settings = document.querySelector('[data-window="settings"]');
      return {
        confirm: !!confirm,
        settings: !!settings,
        focus: !!confirm && confirm.contains(document.activeElement),
      };
    })()`);
    check(`${label} 직후 설정 창과 확인 창이 남음`, still.confirm && still.settings, still);
    check(`${label} 직후 초점이 확인 창 안`, still.focus, still);
  }
  let inside = true;
  for (let index = 0; index < 6; index += 1) {
    await page.key("Tab");
    await sleep(30);
    const ok = await page.evaluate<boolean>(`(() => {
      const box = document.querySelector('[data-window="confirm"]');
      return !!box && box.contains(document.activeElement);
    })()`);
    if (!ok) inside = false;
  }
  check("겹친 확인 창에 Tab이 남음", inside);
});

await scenario("재인증 위 Brain 단축키", async (page) => {
  const openedSettings = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("재인증 단축키 전에 설정 열림", openedSettings);
  if (!openedSettings) return;
  if (!(await waitFor(page, '[data-window="settings"]'))) {
    check("재인증 단축키용 설정 창", false);
    return;
  }
  await page.waitForAnimations();
  // 2바퀴에서 설정 모양이 바뀌어도, 계정 줄 버튼은 두 선택자 중 하나로 남는다.
  const clicked = await page.evaluate<boolean>(`(() => {
    const btn = document.querySelector('[data-provider-id="claude"] button, button[data-provider-id="claude"]');
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    return true;
  })()`);
  check("계정 줄에서 재인증 열기", clicked);
  if (!clicked) return;
  if (!(await waitFor(page, '[data-window="provider-auth"]'))) {
    check("재인증 창", false);
    return;
  }
  await page.waitForAnimations();
  // Meta=4, Control=2. 키 입력에 nativeVirtualKeyCode를 넣지 않는다.
  for (const [label, modifiers] of [
    ["Meta+/", 4],
    ["Control+/", 2],
  ] as const) {
    await page.key("/", modifiers);
    await sleep(80);
    const brain = await page.evaluate<boolean>(`!!document.querySelector('[data-brain]')`);
    check(`${label}는 재인증 위에서 Brain을 열지 않음`, !brain);
  }
});

await scenario("설정 내용", async (page) => {
  const opened = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("설정 내용 열기", opened);
  if (!opened || !(await waitFor(page, '[data-window="settings"]'))) {
    check("설정 내용 창", false);
    return;
  }
  // 스위치·세그먼트는 '일반' 탭, 사용량 막대는 '사용량' 탭에 있다. 먼저 일반 탭 모양을 잰다.
  const general = await page.evaluate<{ switches: number; segments: number; compact: number }>(`(() => {
    const root = document.querySelector('[data-window="settings"]');
    if (!(root instanceof HTMLElement)) return { switches: -1, segments: -1, compact: -1 };
    const parents = new Set();
    for (const btn of root.querySelectorAll('[role="tabpanel"] button[aria-pressed]')) {
      if (btn.parentElement) parents.add(btn.parentElement);
    }
    return {
      switches: root.querySelectorAll('[role="switch"]').length,
      segments: parents.size,
      compact: root.querySelectorAll("[data-compact-engine]").length,
    };
  })()`);
  // 탭: 세 개, 선택은 하나, 화살표로 옮기면 선택과 초점이 함께 간다.
  await page.waitForAnimations();
  const tabs = await page.evaluate<{ count: number; selected: string; stops: number }>(`(() => {
    const all = [...document.querySelectorAll('[data-window="settings"] [role="tab"]')];
    return { count: all.length, selected: all.filter((el) => el.getAttribute("aria-selected") === "true").map((el) => el.id).join(), stops: all.filter((el) => el.tabIndex === 0).length };
  })()`);
  check("설정 탭 세 개와 선택 하나", tabs.count === 3 && tabs.selected === "settings-tab-general" && tabs.stops === 1, tabs);
  await page.evaluate(`document.getElementById('settings-tab-general')?.focus()`);
  await page.key("ArrowRight");
  await sleep(150);
  const moved = await page.evaluate<{ focus: string; selected: string }>(`({ focus: document.activeElement?.id || document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("aria-label") ?? ""), selected: document.querySelector('[data-window="settings"] [role="tab"][aria-selected="true"]')?.id ?? "" })`);
  check("설정 탭 화살표 이동", moved.focus === "settings-tab-usage" && moved.selected === "settings-tab-usage", moved);
  await page.evaluate(`document.getElementById('settings-tab-usage')?.click()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const meters = await page.evaluate<number>(`document.querySelectorAll('[data-window="settings"] [role="meter"]').length`);
    if (meters >= 1) break;
    await sleep(100);
  }
  const shape = await page.evaluate<{ meters: number }>(`(() => {
    const root = document.querySelector('[data-window="settings"]');
    if (!(root instanceof HTMLElement)) return { meters: -1 };
    return { meters: root.querySelectorAll('[role="meter"]').length };
  })()`);
  check("설정 스위치 하나", general.switches === 1, general);
  check("설정 세그먼트 두 묶음", general.segments === 2, general);
  check("설정에 기억 압축 줄 없음", general.compact === 0, general);
  check("설정 사용량 막대", shape.meters >= 1, shape);
});

await scenario("재인증", async (page) => {
  const opened = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="설정"], [aria-label="Settings"]');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    window.__aetherOpener = el;
    el.click();
    return true;
  })()`);
  check("재인증용 설정 열기", opened);
  if (!opened || !(await waitFor(page, '[data-window="settings"]'))) {
    check("재인증용 설정 창", false);
    return;
  }
  const clicked = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-window="settings"]');
    const row = root?.querySelector('[data-provider-id="claude"]');
    const el = row instanceof HTMLButtonElement ? row : row?.querySelector("button");
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`);
  check("계정 줄에서 재인증 열기", clicked);
  if (!clicked || !(await waitFor(page, '[data-window="provider-auth"]'))) {
    check("재인증 창", false);
    return;
  }
  await expectWindow(page, '[data-window="provider-auth"]', "dialog", closeLabels);
  const started = await page.evaluate<boolean>(`(() => {
    const box = document.querySelector('[data-window="provider-auth"]');
    const btn = [...(box?.querySelectorAll("button") ?? [])].find((el) => {
      const text = (el.textContent || "").trim();
      return text === "로그인 시작" || text === "Start login";
    });
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    return true;
  })()`);
  check("로그인 시작", started);
  if (!started) return;
  let device: { code: boolean; link: boolean; text: string } | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    device = await page.evaluate<{ code: boolean; link: boolean; text: string }>(`(() => {
      const box = document.querySelector('[data-window="provider-auth"]');
      const text = (box?.textContent || "").replace(/\\s+/g, " ");
      return {
        code: text.includes("WDTE-XTJK"),
        link: text.includes("로그인 페이지 열기") || text.includes("Open login page"),
        text: text.slice(0, 300),
      };
    })()`);
    if (device?.code && device.link) break;
    await sleep(100);
  }
  check("재인증 기기 코드", !!device && device.code && device.link, device);
  const facts = await readFacts(page, '[data-window="provider-auth"]');
  check("재인증 끝없는 움직임은 참딩뿐", !!facts && facts.infinite === 0, facts?.infinite);
  if (device?.code && device.link) {
    check("재인증 기기 코드 가로 넘침 0", !!facts && !facts.overflow);
    check("재인증 기기 코드 화면 안", !!facts && facts.onScreen && facts.phoneTop, facts && { onScreen: facts.onScreen, phoneTop: facts.phoneTop });
    if (phone) check("재인증 기기 코드 누름 44", !!facts && facts.small.length === 0, facts?.small);
  }
  await page.key("Escape");
  await sleep(150);
  const gone = await page.evaluate<boolean>(`!document.querySelector('[data-window="provider-auth"]')`);
  check("재인증 Esc로 닫힘", gone);
  await checkRestored(page, "재인증 초점 복귀");
});

function commandClearExpr(): string {
  return `(() => {
    const root = document.querySelector('[data-window="new-session"]');
    const scroller = root instanceof HTMLElement ? root.querySelector(":scope > .scroll-area") : null;
    const line = root instanceof HTMLElement ? root.querySelector("[data-command-preview]") : null;
    if (!(scroller instanceof HTMLElement) || !(line instanceof HTMLElement)) return { ok: false, hit: "없음" };
    scroller.scrollTop = scroller.scrollHeight;
    const r = line.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const self = hit === line || (hit instanceof Node && line.contains(hit));
    const hitName = hit instanceof HTMLElement
      ? (hit.hasAttribute("data-command-preview") ? "command-preview" : (hit.getAttribute("role") || hit.tagName || "").slice(0, 40))
      : "";
    return { ok: self, hit: hitName };
  })()`;
}

function startOnScreenExpr(): string {
  return `(() => {
    const el = document.querySelector('[data-session-opt="new-session-start"]');
    if (!(el instanceof HTMLElement)) return { ok: false, reason: "없음" };
    const r = el.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
    if (!inView) return { ok: false, inView: false, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const open = hit === el || (hit instanceof Node && el.contains(hit));
    const hitName = hit instanceof HTMLElement ? (hit.getAttribute("data-session-opt") || hit.getAttribute("aria-label") || hit.tagName) : "";
    return { ok: open, inView: true, hit: hitName };
  })()`;
}

await scenario("새 작업", async (page) => {
  if (phone) {
    const listed = await page.evaluate<boolean>(`(() => {
      const el = document.querySelector('[aria-label="세션 목록 열기"], [aria-label="Open work list"]');
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`);
    check("새 작업 전에 목록을 연다", listed);
    await sleep(400);
  }
  const opened = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[aria-label="새 세션"], [aria-label="New work"], [data-session-opt="new-work"]');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    window.__aetherOpener = el;
    el.click();
    return true;
  })()`);
  check("새 작업 버튼으로 열기", opened);
  await expectWindow(page, '[data-window="new-session"]', "dialog", phone ? closeLabels : ["이름", "Name"]);
  const start = await page.evaluate<{ ok: boolean }>(startOnScreenExpr());
  check("처음 연 순간 작업 시작이 보인다", start.ok, start);
  // 모든 권한 허용은 켠 채로 열린다. 그래서 경고와 실행 명령 줄이 처음부터 보여야 하고, 그래도 시작 버튼은 첫 화면에 있다.
  const allowed = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-window="new-session"]');
    const el = [...(root?.querySelectorAll('[role="switch"]') ?? [])].find((node) => {
      const name = node.getAttribute("aria-label") || "";
      return name.includes("모든 권한") || name.includes("Allow all");
    });
    return el instanceof HTMLElement && el.getAttribute("aria-checked") === "true";
  })()`);
  check("모든 권한이 처음부터 켜져 있다", allowed);
  const after = await readFacts(page, '[data-window="new-session"]');
  check("새 작업 처음 화면 가로 넘침 0", !!after && !after.overflow);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const n = await page.evaluate<number>(`document.querySelectorAll('[data-window="new-session"] [data-folder-choices] [role="radio"]').length`);
    if (n >= 1) break;
    await sleep(100);
  }
  const seeded = await page.evaluate<boolean>(`!!document.querySelector('[data-window="new-session"] [data-folder-choices] [role="radio"][aria-checked="true"]')`);
  check("처음 연 순간 최근 폴더 하나가 골라져 있다", seeded);
  // 이름 칸에서 Tab을 보낸다. 고른 폴더 줄에 닿을 때까지 최대 4번이다.
  const nameFocused = await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-window="new-session"] input.sheet-field');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  let reached = false;
  for (let step = 0; step < 4 && nameFocused && !reached; step += 1) {
    await page.key("Tab");
    await sleep(40);
    reached = await page.evaluate<boolean>(`(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.getAttribute("role") === "radio" && !!el.closest("[data-folder-choices]");
    })()`);
  }
  check("Tab으로 최근 폴더 묶음에 들어간다", nameFocused && reached);
  // brainCdp.key의 Enter는 글자 없이 보내서 기본 버튼을 누르지 못한다. 버튼은 click으로 누른다.
  const openBrowse = `(() => {
    const el = document.querySelector('[data-window="new-session"] [data-folder-browse]');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    el.click();
    return true;
  })()`;
  // 사이드바(폰은 위치 화면)의 위치 줄을 눌러 그 폴더로 간다.
  const clickPlace = (p: string) => `(() => {
    const el = document.querySelector('[data-window="new-session"] [data-folder-place="${p}"]');
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  })()`;
  // 목록 줄은 터치(폰)면 한 번에 들어가고, 마우스면 한 번 선택 뒤 두 번 눌러 들어간다.
  const enterEntry = (p: string) => `(() => {
    const el = document.querySelector('[data-window="new-session"] [data-folder-opt="${p}"]');
    if (!(el instanceof HTMLElement)) return false;
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: ${phone ? '"touch"' : '"mouse"'}, bubbles: true }));
    el.click();
    ${phone ? "" : 'el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));'}
    return true;
  })()`;
  const browseOpened = await page.evaluate<boolean>(openBrowse);
  await sleep(300);
  const browsing = await page.evaluate<{ ok: boolean; back: boolean; close: boolean; side: boolean; list: boolean; listFocus: boolean }>(`(() => {
    const root = document.querySelector('[data-window="new-session"]');
    return {
      ok: root?.getAttribute("data-folder-browsing") === "1",
      back: !!root?.querySelector("[data-modal-back]"),
      close: !!root?.querySelector('[aria-label="닫기"], [aria-label="Close"]'),
      side: !!root?.querySelector("[data-folder-place]"),
      list: !!root?.querySelector("[data-folder-list]"),
      listFocus: document.activeElement?.hasAttribute("data-folder-list") ?? false,
    };
  })()`);
  check("다른 폴더 고르기로 탐색 화면이 열리고 위치 목록이 보인다", browseOpened && browsing.ok && browsing.side, browsing);
  check(
    phone ? "폰은 위치 화면으로 시작해 폴더 목록이 아직 없다" : "넓은 화면은 폴더 목록이 키 초점을 받는다",
    phone ? !browsing.list : browsing.list && browsing.listFocus,
    browsing,
  );
  check("탐색 화면 머리에는 뒤로만 있고 닫기는 없다", browsing.back && !browsing.close, browsing);
  const wentHome = await page.evaluate<boolean>(clickPlace("/fixture/home"));
  await sleep(300);
  const homeList = await page.evaluate<{ names: string[]; target: string }>(`(() => {
    const root = document.querySelector('[data-window="new-session"]');
    return {
      names: [...(root?.querySelectorAll("[data-folder-opt]") ?? [])].map((el) => el.getAttribute("data-folder-opt") || ""),
      target: (root?.querySelector("[data-folder-target]")?.textContent || "").trim(),
    };
  })()`);
  check(
    "홈 위치를 누르면 홈 안의 폴더가 나오고 숨김 폴더는 빠진다",
    wentHome && homeList.names.includes("/fixture/home/project") && !homeList.names.some((n) => n.endsWith("/.cache")) && homeList.target === "/fixture/home",
    homeList,
  );
  const entered0 = await page.evaluate<boolean>(enterEntry("/fixture/home/project"));
  await sleep(300);
  const inside = await page.evaluate<{ here: string; empty: boolean; target: string }>(`(() => {
    const root = document.querySelector('[data-window="new-session"]');
    const here = root?.querySelector('[data-folder-crumbs] [aria-current="location"]');
    return {
      here: (here?.textContent || "").trim(),
      empty: !root?.querySelector("[data-folder-opt]"),
      target: (root?.querySelector("[data-folder-target]")?.textContent || "").trim(),
    };
  })()`);
  check(
    "project 줄로 들어가면 경로 막대 끝이 project이고 고를 폴더 경로가 그 폴더다",
    entered0 && inside.here === "project" && inside.empty && inside.target === "/fixture/home/project",
    inside,
  );
  await page.key("Escape");
  await sleep(200);
  const backOnEsc = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-window="new-session"]');
    return !!root && root.getAttribute("data-folder-browsing") !== "1";
  })()`);
  check("탐색 화면의 Esc는 창을 닫지 않고 새 작업으로 돌아간다", backOnEsc);
  const targetOf = `(document.querySelector('[data-window="new-session"] [data-folder-target]')?.textContent || "").trim()`;
  if (!phone) {
    // 숨김 폴더를 작업 폴더로 고른 채 탐색을 열면 그 폴더 줄이 그대로 선택되어 있다(부모로 바뀌지 않는다).
    const picked = await page.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-window="new-session"] [data-folder-rel="/fixture/home/.hidden-work"]');
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`);
    await sleep(100);
    await page.evaluate<boolean>(openBrowse);
    await sleep(500);
    const hiddenOpen = await page.evaluate<{ target: string; on: boolean }>(`({
      target: ${targetOf},
      on: document.querySelector('[data-window="new-session"] [data-folder-opt="/fixture/home/.hidden-work"]')?.getAttribute("aria-selected") === "true",
    })`);
    check("숨김 폴더를 고른 채 열면 그 폴더 줄이 선택되어 있다", picked && hiddenOpen.on && hiddenOpen.target === "/fixture/home/.hidden-work", hiddenOpen);
  } else {
    await page.evaluate<boolean>(openBrowse);
    await sleep(400);
  }
  // 열 수 없는 폴더(403)를 열면 고를 폴더가 없어 "이 폴더 선택"이 꺼진다.
  const deniedOpened = await page.evaluate<boolean>(clickPlace("/fixture/denied"));
  await sleep(400);
  const deniedState = await page.evaluate<{ disabled: boolean; target: string }>(`({
    disabled: document.querySelector('[data-window="new-session"] [data-folder-choose]')?.hasAttribute("disabled") ?? false,
    target: ${targetOf},
  })`);
  check("열 수 없는 폴더를 열면 이 폴더 선택이 꺼진다", deniedOpened && deniedState.disabled && deniedState.target === "—", deniedState);
  await page.key("Escape");
  await sleep(200);
  const reopened = await page.evaluate<boolean>(openBrowse);
  await sleep(300);
  const entered = reopened && (await page.evaluate<boolean>(clickPlace("/fixture/home")));
  await sleep(300);
  const enteredProject = entered && (await page.evaluate<boolean>(enterEntry("/fixture/home/project")));
  await sleep(300);
  const chose = enteredProject && await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('[data-window="new-session"] [data-folder-choose]');
    if (!(el instanceof HTMLElement) || el.hasAttribute("disabled")) return false;
    el.click();
    return true;
  })()`);
  await sleep(250);
  const selected = await page.evaluate<{ checked: boolean; focused: boolean }>(`(() => {
    const row = document.querySelector('[data-window="new-session"] [data-folder-rel="/fixture/home/project"]');
    return { checked: row?.getAttribute("aria-checked") === "true", focused: !!row && document.activeElement === row };
  })()`);
  check("이 폴더 선택으로 project가 골라지고 초점이 그 줄로 돌아온다", chose && selected.checked && selected.focused, selected);
  const providerId = await page.evaluate<string>(`(() => {
    const el = document.querySelector('[data-window="new-session"] button[data-provider-selected="1"]');
    return el instanceof HTMLElement ? (el.getAttribute("data-provider-id") || "") : "";
  })()`);
  let armed = false;
  try {
    if (providerId) {
      try {
        const res = await fetch(`${new URL(url).origin}/api/debug/fail-create`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: providerId }),
        });
        armed = res.ok;
      } catch {
        armed = false;
      }
    }
    check("다음 만들기를 한 번 거절한다", armed, { providerId });
    const pressed = armed && await page.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-session-opt="new-session-start"]');
      if (!(el instanceof HTMLElement) || el.hasAttribute("disabled")) return false;
      el.click();
      return true;
    })()`);
    check("거절될 작업 시작을 누른다", pressed);
    let alertOn = false;
    for (let attempt = 0; attempt < 40 && pressed; attempt += 1) {
      alertOn = await page.evaluate<boolean>(`!!document.querySelector('[data-window="new-session"] [role="alert"]')`);
      if (alertOn) break;
      await sleep(50);
    }
    check("발 위에 오류 줄이 뜬다", alertOn);
    const clear = alertOn
      ? await page.evaluate<{ ok: boolean; hit: string }>(commandClearExpr())
      : { ok: false, hit: "오류 없음" };
    check("맨 아래 명령 줄이 발에 가리지 않는다", clear.ok, clear);
    await page.key("Escape");
    await sleep(150);
    const gone = await page.evaluate<boolean>(`!document.querySelector('[data-window="new-session"]')`);
    check("새 작업 Esc로 닫힘", gone);
    await checkRestored(page, "새 작업 초점 복귀");
  } finally {
    // 거절 요청을 보냈으면 응답을 못 받았어도 비운다. 서버에는 닿았을 수 있다.
    if (providerId) {
      let cleared = false;
      try {
        const res = await fetch(`${new URL(url).origin}/api/debug/fail-create`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "" }),
        });
        cleared = res.ok;
      } catch {
        cleared = false;
      }
      check("거절 표시를 비운다", cleared);
    }
  }
});

type FindFacts = {
  onScreen: boolean;
  overlap: boolean;
  hasAside: boolean;
  leftOk: boolean;
  rightOk: boolean;
  left: number;
  rightGap: number;
  expectLeft: number;
  expectRight: number;
  asideRight: number | null;
};

// 폭 800·1000·1440과 폰에서만 연다. 다른 폭은 막대를 띄우지 않는다.
if (phone || width === 800 || width === 1000 || width === 1440) {
  await scenario("찾기 막대", async (page) => {
    let opened = false;
    for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
      const clicked = await page.evaluate<boolean>(`(() => {
        const btn = document.querySelector("[data-find-toggle]");
        if (!(btn instanceof HTMLElement)) return false;
        btn.click();
        return true;
      })()`);
      if (!clicked) {
        await sleep(100);
        continue;
      }
      for (let tick = 0; tick < 8 && !opened; tick += 1) {
        opened = await page.evaluate<boolean>(`!!document.querySelector('[role="search"]')`);
        if (!opened) await sleep(40);
      }
    }
    check("찾기 막대 열림", opened);
    if (!opened) return;
    await page.waitForAnimations();
    const facts = await page.evaluate<FindFacts | null>(`(() => {
      const bar = document.querySelector('[role="search"]');
      if (!(bar instanceof HTMLElement)) return null;
      const rect = bar.getBoundingClientRect();
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)";
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const safeLeft = parseFloat(style.paddingLeft) || 0;
      const safeRight = parseFloat(style.paddingRight) || 0;
      probe.remove();
      const aside = document.querySelector("aside.glass");
      const asideRect = aside instanceof HTMLElement ? aside.getBoundingClientRect() : null;
      const overlap = !!asideRect && rect.left < asideRect.right - 1 && rect.right > asideRect.left + 1 && rect.top < asideRect.bottom - 1 && rect.bottom > asideRect.top + 1;
      const expectLeft = Math.max(12, safeLeft);
      const expectRight = Math.max(12, safeRight);
      const rightGap = window.innerWidth - rect.right;
      return {
        onScreen: rect.width > 0 && rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
        overlap,
        hasAside: !!asideRect,
        leftOk: Math.abs(rect.left - expectLeft) <= 1.5,
        rightOk: Math.abs(rightGap - expectRight) <= 1.5,
        left: Math.round(rect.left * 10) / 10,
        rightGap: Math.round(rightGap * 10) / 10,
        expectLeft,
        expectRight,
        asideRight: asideRect ? Math.round(asideRect.right) : null,
      };
    })()`);
    if (phone) {
      check("찾기 막대 화면 안", !!facts && facts.onScreen, facts);
      check("찾기 막대 좌우 12", !!facts && facts.leftOk && facts.rightOk, facts);
      return;
    }
    check("찾기 막대 화면 안", !!facts && facts.onScreen, facts);
    check("찾기 막대 목록 기둥과 안 겹침", !!facts && facts.hasAside && !facts.overlap, facts);
  });
}

console.log(`\n${failures === 0 ? "통과" : "실패"} 창 ${width}×${height}: 실패 ${failures}`);
process.exit(failures === 0 ? 0 : 1);
