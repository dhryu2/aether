/**
 * 입력창 팝오버가 상단 섬에 가리는지 재는 시험.
 * Chrome과 fixture 서버는 여기서 띄우지 않는다. 이미 떠 있는 CDP에 붙는다.
 *
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkPopoverClear.ts http://127.0.0.1:8899
 *
 * 1440×800은 칸 넷(2×2)의 아래 칸, 390×500은 칸 하나.
 * 슬래시 목록, 입력창 ＋ 메뉴, 그리고 폭 1100 미만일 때만 입력창 위 모델 목록을 연다.
 * 목록 윗변이 자기 칸 윗변 이상인지, 내용이 넘치면 목록 안이 스크롤되는지도 본다.
 * 폭과 높이는 주소 인자가 아니라 이 파일이 CDP에 따로 넘긴다.
 */
import { connectBrain, sleep } from "./brainCdp";

const [baseArg] = process.argv.slice(2);
if (!baseArg) {
  console.error("사용: checkPopoverClear.ts <픽스처 서버 주소>");
  process.exit(2);
}
const base = baseArg.replace(/\/$/, "");
if (base.includes("8787")) {
  console.error("라이브 8787 금지");
  process.exit(1);
}

const port = Number(process.env.CDP_PORT || 9222);
const SESSION = "dm:fixture-claude";
const PANES = {
  ids: ["dm:fixture-codex", "dm:fixture-grok", "dm:fixture-claude", "dm:fixture-actions"],
  focusedId: "dm:fixture-claude",
};

type Page = Awaited<ReturnType<typeof connectBrain>>;
type Measure = {
  ok: boolean;
  reason?: string;
  below?: boolean;
  hitOk?: boolean;
  inPane?: boolean;
  scrollOk?: boolean;
  top?: number;
  paneTop?: number | null;
  islandBottom?: number;
  height?: number;
  hit?: string | null;
};
type Ready = {
  panes: number;
  top: string | null;
  ready: boolean;
  main: { w: number; h: number } | null;
  inner: { w: number; h: number };
};

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures += 1;
  const extra = ok || detail == null ? "" : " " + JSON.stringify(detail);
  console.log(`${ok ? "통과" : "실패"} ${name}${extra}`);
}

function seedScript(panes: boolean): string {
  const stored = JSON.stringify(JSON.stringify(PANES));
  const panesLine = panes
    ? `localStorage.setItem("aether.panes.v1", ${stored});`
    : `localStorage.removeItem("aether.panes.v1");`;
  return `try { ${panesLine} localStorage.removeItem("aether.projectCollapsed.v1"); } catch (e) {}`;
}

function measureExpr(popExpr: string): string {
  return `(() => {
    const pop = ${popExpr};
    if (!(pop instanceof HTMLElement)) return { ok: false, reason: "no-popover" };
    const islands = [...document.querySelectorAll(".top-bar .glass")];
    if (islands.length === 0) return { ok: false, reason: "no-island" };
    let islandBottom = 0;
    for (const el of islands) islandBottom = Math.max(islandBottom, el.getBoundingClientRect().bottom);
    const rect = pop.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + 6, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const hitOk = !!hit && (hit === pop || pop.contains(hit));
    const below = rect.top >= islandBottom - 0.5;
    const pane = pop.closest(".session-pane");
    const paneRect = pane instanceof HTMLElement ? pane.getBoundingClientRect() : null;
    const inPane = !!paneRect && rect.top >= paneRect.top - 0.5;
    const scrollers = [pop, ...pop.querySelectorAll(".scroll-area")].filter((el) => el instanceof HTMLElement);
    const scrollOk = scrollers.every((el) => {
      if (el.scrollHeight <= el.clientHeight + 1) return true;
      const oy = getComputedStyle(el).overflowY;
      return oy === "auto" || oy === "scroll";
    });
    return {
      ok: below && hitOk,
      below,
      hitOk,
      inPane,
      scrollOk,
      top: Math.round(rect.top * 10) / 10,
      paneTop: paneRect ? Math.round(paneRect.top * 10) / 10 : null,
      islandBottom: Math.round(islandBottom * 10) / 10,
      height: Math.round(rect.height),
      hit: hit instanceof Element ? (hit.getAttribute("class") || hit.tagName).slice(0, 80) : null,
    };
  })()`;
}

const paneExpr = `document.querySelector('[data-split-session="${SESSION}"]')`;

async function openPage(width: number, height: number, url: string, panes: boolean): Promise<Page> {
  const phone = width < 760;
  const page = await connectBrain(port, phone);
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: phone,
  });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: seedScript(panes) });
  await page.send("Page.navigate", { url });
  return page;
}

async function waitReady(page: Page, minPanes: number, needBottom: boolean): Promise<Ready | null> {
  let last: Ready | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await page.evaluate<Ready>(`(() => {
      const pane = ${paneExpr};
      const ta = pane instanceof HTMLElement ? pane.querySelector("textarea") : null;
      const main = document.querySelector("main");
      const rect = main instanceof HTMLElement ? main.getBoundingClientRect() : null;
      return {
        panes: document.querySelectorAll("[data-split-pane]").length,
        top: pane instanceof HTMLElement ? pane.getAttribute("data-pane-top") : null,
        ready: ta instanceof HTMLTextAreaElement && !ta.disabled,
        main: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        inner: { w: window.innerWidth, h: window.innerHeight },
      };
    })()`);
    if (last.ready && last.panes >= minPanes && (!needBottom || last.top === "0")) return last;
    await sleep(100);
  }
  return last;
}

async function setComposer(page: Page, value: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const pane = ${paneExpr};
    const ta = pane instanceof HTMLElement ? pane.querySelector("textarea") : null;
    if (!(ta instanceof HTMLTextAreaElement) || ta.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(ta, ${JSON.stringify(value)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function clickInPane(page: Page, buttonExpr: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const pane = ${paneExpr};
    if (!(pane instanceof HTMLElement)) return false;
    const btn = ${buttonExpr};
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    return true;
  })()`);
}

async function measure(page: Page, popExpr: string): Promise<Measure> {
  await page.waitForAnimations();
  return page.evaluate<Measure>(measureExpr(popExpr));
}

function checkClear(name: string, label: string, m: Measure) {
  check(`${name} ${label}이 섬 아래`, !!m.ok, m);
  check(`${name} ${label}이 칸 안`, m.inPane === true, m);
  check(`${name} ${label} 넘치면 스크롤`, m.scrollOk === true, m);
}

async function runCase(name: string, width: number, height: number, url: string, panes: boolean, minPanes: number) {
  const page = await openPage(width, height, url, panes);
  try {
    const ready = await waitReady(page, minPanes, minPanes > 1);
    check(`${name} 칸 준비`, !!ready && ready.ready && ready.panes >= minPanes && (minPanes === 1 || ready.top === "0"), ready);
    if (!ready?.ready || ready.panes < minPanes || (minPanes > 1 && ready.top !== "0")) return;

    const slashPop = `${paneExpr}?.querySelector("[data-slash-name]")?.closest(".popover-surface")`;
    let slashOpen = false;
    if (await setComposer(page, "/")) {
      for (let attempt = 0; attempt < 30 && !slashOpen; attempt += 1) {
        slashOpen = await page.evaluate<boolean>(`!!(${slashPop})`);
        if (!slashOpen) await sleep(50);
      }
    }
    check(`${name} 슬래시 목록 열림`, slashOpen);
    if (slashOpen) {
      const slash = await measure(page, slashPop);
      checkClear(name, "슬래시 목록", slash);
    }
    await setComposer(page, "");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const gone = await page.evaluate<boolean>(`!(${slashPop})`);
      if (gone) break;
      await sleep(40);
    }

    const plus = `pane.querySelector('[data-composer-plus]')`;
    const plusPop = `${paneExpr}?.querySelector('.popover-surface[role="menu"]')`;
    let plusOpen = false;
    if (await clickInPane(page, plus)) {
      for (let attempt = 0; attempt < 20 && !plusOpen; attempt += 1) {
        plusOpen = await page.evaluate<boolean>(`!!(${plusPop})`);
        if (!plusOpen) await sleep(50);
      }
    }
    check(`${name} ＋ 메뉴 열림`, plusOpen);
    if (plusOpen) {
      const plusMenu = await measure(page, plusPop);
      checkClear(name, "＋ 메뉴 목록", plusMenu);
      await clickInPane(page, plus);
      await sleep(50);
    }

    if (width >= 1100) return;
    const modelBtn = `[...pane.querySelectorAll("button")].find((b) => /모델 선택|Select model/.test(b.getAttribute("title") || ""))`;
    const listExpr = `${paneExpr}?.querySelector('[role="listbox"]')`;
    let modelOpen = false;
    for (let attempt = 0; attempt < 40 && !modelOpen; attempt += 1) {
      modelOpen = await page.evaluate<boolean>(`!!(${listExpr})`);
      if (modelOpen) break;
      await clickInPane(page, modelBtn);
      await sleep(80);
    }
    check(`${name} 모델 목록 열림`, modelOpen);
    if (modelOpen) {
      const model = await measure(page, listExpr);
      checkClear(name, "모델 목록", model);
    }
  } finally {
    await page.close();
  }
}

try {
  await runCase("1440", 1440, 800, `${base}/`, true, 4);
  await runCase("390", 390, 500, `${base}/?s=${SESSION}`, false, 1);
} catch (error) {
  check("팝오버 시험 도중 오류", false, error instanceof Error ? error.message : String(error));
}

console.log(`\n${failures === 0 ? "통과" : "실패"} 팝오버: 실패 ${failures}`);
process.exit(failures === 0 ? 0 : 1);
