/**
 * 헤드리스 브라우저 스크린샷 (Phase 8d-3 완료 게이트 ③의 도구).
 *   실행: npx tsx server/test/visual/shoot.ts <url> <출력.png> [너비] [높이] [대기ms] [클릭할 CSS 선택자]
 *   선택자는 ` >> `로 이어 붙이면 차례로 누른다(모달을 연 뒤 그 안의 칩을 고르는 식).
 *
 * `fixtureServer.ts`가 띄운 화면을 실제 브라우저로 찍는다. 단위 테스트가 조각의 *값*을 보는 것과 달리,
 * 이건 "예전과 같은 모양으로 그려지는가"를 사람이 눈으로 대조하기 위한 것이다(퇴화도 변화다).
 *
 * Chrome 150부터 `--screenshot`·`--dump-dom` 같은 명령줄 플래그가 사라져서(실측 — 빈 결과가 나온다)
 * DevTools 프로토콜로 직접 찍는다. Node 24에 WebSocket이 내장이라 의존성은 추가하지 않았다.
 *
 * 브라우저는 미리 띄워 둔다:
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
 *     --no-first-run --user-data-dir=/tmp/chrome-cdp --remote-debugging-port=9222 about:blank &
 */
import fs from "node:fs";

const [url, out, wArg, hArg, waitArg, clickSel] = process.argv.slice(2);
if (!url || !out) {
  console.error("사용: shoot.ts <url> <출력.png> [너비] [높이] [대기ms] [클릭할 CSS 선택자( >> 로 여러 개)]");
  process.exit(2);
}
const width = Number(wArg || 1440);
const height = Number(hArg || 900);
const waitMs = Number(waitArg || 3500);
const PORT = Number(process.env.CDP_PORT || 9222);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 새 탭을 열고 그 탭의 디버거 주소를 받는다. */
const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json()) as {
  id: string;
  webSocketDebuggerUrl: string;
};

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res(), { once: true });
  ws.addEventListener("error", () => rej(new Error("CDP 연결 실패 — 브라우저가 --remote-debugging-port로 떠 있나?")), { once: true });
});

let msgId = 0;
const waiters = new Map<number, (v: any) => void>();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id != null && waiters.has(m.id)) {
    waiters.get(m.id)!(m.result);
    waiters.delete(m.id);
  }
});
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++msgId;
  return new Promise((res) => {
    waiters.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// 뷰포트를 정확히 고정한다 — 창 크기가 아니라 렌더 크기를 지정해야 모바일/데스크톱 레이아웃이 갈린다.
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 700 });
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});
await send("Page.navigate", { url });
await sleep(waitMs); // 부팅 → 세션 목록 → SSE replay → caught_up 까지

// 모달 안쪽처럼 한 번 눌러야 보이는 화면을 찍으려면 선택자를 넘긴다(설정·지식 패널 등).
// 여러 번 눌러야 보이는 화면이 있다(모달을 연 뒤 그 안의 칩을 고르는 식) → ` >> `로 이어 붙인다.
for (const sel of (clickSel ?? "").split(" >> ").map((x) => x.trim()).filter(Boolean)) {
  const r = await send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`,
    returnByValue: true,
  });
  if (r?.result?.value !== "clicked") {
    console.error(`클릭 대상을 못 찾았다: ${sel}`);
    process.exit(1);
  }
  await sleep(1200);
}

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
ws.close();
await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
console.log(`${out} (${width}×${height})`);
process.exit(0);
