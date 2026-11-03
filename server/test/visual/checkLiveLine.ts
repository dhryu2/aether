/**
 * 작업 중 알림(모델이 일하는 도중에 하는 말) 화면 확인 — 단위 테스트는 조각의 값이 맞는지 보지만,
 * "값은 맞는데 글자가 잘린다" 또는 "최종 답변과 생김새가 구별이 안 된다" 같은 건 실제로 그려 봐야 안다.
 *
 * 실행:
 *   CDP_PORT=9222 node --import tsx server/test/visual/checkLiveLine.ts http://127.0.0.1:8899 390 844
 *
 * 준비물은 server/test/visual/README.md와 같다(fixture 서버 + 헤드리스 Chrome + CDP).
 * 이 스크립트가 쓰는 fixture 세션:
 *   - fixture-live    : 아직 돌고 있는 턴(모델이 도중에 세 번 말했다)
 *   - fixture-cut     : 답을 못 내고 끊긴 턴
 *   - fixture-codex   : 정상으로 끝난 턴
 */
export {}; // 이 파일은 import가 없다 — 모듈로 만들어야 최상위 await가 허용된다.

const [base, widthArg, heightArg] = process.argv.slice(2);
if (!base) {
  console.error("Usage: checkLiveLine.ts <baseUrl> [width] [height]");
  process.exit(2);
}

const width = Number(widthArg || 390);
const height = Number(heightArg || 844);
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
  const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
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

/** 화면에 그려진 조각의 종류를 순서대로 + 작업 중 알림·답변 말풍선의 실제 모양. */
const SNAPSHOT = `(() => {
  const notes = [...document.querySelectorAll('.work-note')];
  const last = notes[notes.length - 1] || null;
  const lastBox = last ? last.getBoundingClientRect() : null;
  const lastCss = last ? getComputedStyle(last) : null;
  /** 글꼴·색은 마크다운 본문 컨테이너가 정한다 — 알림과 말풍선이 같은 값인지 여기서 대조한다. */
  const face = (el) => { const m = el ? el.querySelector('.md') : null; if (!m) return null; const c = getComputedStyle(m); return { size: c.fontSize, color: c.color }; };
  /** 생김새 — 재설계 4단계: 알림은 왼쪽 세로줄, 최종 답변은 줄도 바탕도 없는 글이어야 한다(둘을 눈으로 갈라내는 유일한 단서).
   *  글이 시작하는 세로선(textLeft)은 둘이 같아야 한다 — 알림이 답으로 바뀔 때 글자가 옆으로 튀지 않는다. */
  const box = (el) => { if (!el) return null; const c = getComputedStyle(el); const m = el.querySelector('.md'); return { left: c.borderLeftStyle, leftWidth: c.borderLeftWidth, topWidth: c.borderTopWidth, bg: c.backgroundColor, textLeft: m ? Math.round(m.getBoundingClientRect().left) : null }; };
  return {
    noteBox: box(last),
    answerBox: box(document.querySelector('.bubble-assistant')),
    order: [...document.querySelectorAll('[data-seg]')].map((n) => n.dataset.seg),
    noteCount: notes.length,
    noteTexts: notes.map((n) => n.innerText.trim()),
    bubbles: [...document.querySelectorAll('.bubble-assistant')].map((n) => n.textContent.trim()),
    // 잘라내지 않는다 = 담긴 글 전체 높이·폭이 보이는 상자를 안 넘는다.
    lastNoteClipped: last ? (last.scrollHeight > last.clientHeight + 1 || last.scrollWidth > last.clientWidth + 1) : false,
    lastNoteLines: last && lastCss ? Math.round(lastBox.height / parseFloat(lastCss.lineHeight)) : 0,
    noteFace: face(last),
    bubbleFace: face(document.querySelector('.bubble-assistant')),
    bodyText: document.body.innerText,
  };
})()`;

type Face = { size: string; color: string } | null;
type Box = { left: string; leftWidth: string; topWidth: string; bg: string; textLeft: number | null } | null;
type Snapshot = {
  noteBox: Box;
  answerBox: Box;
  order: string[];
  noteCount: number;
  noteTexts: string[];
  bubbles: string[];
  lastNoteClipped: boolean;
  lastNoteLines: number;
  noteFace: Face;
  bubbleFace: Face;
  bodyText: string;
};

async function open(session: string): Promise<Snapshot> {
  await send("Page.navigate", { url: `${base}/?s=${session}` });
  await sleep(3000);
  return evaluate<Snapshot>(SNAPSHOT);
}

await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 700 });
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});

// ── 1. 진행 중인 턴: 확정된 알림 → 명령 요약 줄 → 지금 하는 말 ──
console.log("\n[1] 진행 중인 턴 (fixture-live)");
const live = await open("fixture-live");
check(JSON.stringify(live.order) === JSON.stringify(["user", "live", "tools", "live"]), "사람 말풍선 → 알림 → 명령 요약 줄 → 지금 하는 말 순서", live.order);
check(live.noteCount === 2, "화면에 남는 알림은 둘뿐이다(앞의 것은 갈아끼워졌다)", live.noteCount);
check(live.noteTexts[0]?.startsWith("이제 Agent Brain 오버레이와") === true, "알림 자리엔 가장 최근에 확정된 말만 있다", live.noteTexts[0]);
check(live.noteTexts[1]?.startsWith("마지막으로 스트림 목록의 간격을") === true, "꼬리엔 방금 한 말이 있다", live.noteTexts[1]);
check(!live.bodyText.includes("이제 모달 껍데기를 고치겠습니다"), "더 앞서 한 말은 갈아끼워져 화면에 안 남는다");
check(live.bubbles.length === 0, "턴이 끝나기 전엔 답변 말풍선이 안 생긴다", live.bubbles);

// ── 잘리지 않고 전부 보이는가(모바일 폭에서 여러 줄로 접혀야 한다) ──
check(!live.lastNoteClipped, "긴 말도 잘리지 않고 전부 보인다", live.lastNoteClipped);
check(live.lastNoteLines >= 2, "폭을 넘는 말은 다음 줄로 접힌다", live.lastNoteLines);

// ── 교체 애니메이션이 실제로 정의돼 있는가(CSS 키프레임 + 클래스) ──
const anim = await evaluate<{ name: string; duration: string }>(`(() => {
  const probe = document.createElement('div');
  probe.className = 'work-note-in';
  document.body.append(probe);
  const c = getComputedStyle(probe);
  const out = { name: c.animationName, duration: c.animationDuration };
  probe.remove();
  return out;
})()`);
check(anim.name === "work-note-in", "새 말이 들어오는 교체 애니메이션이 걸려 있다", anim);
check(anim.duration === "0.18s", "교체는 160~200ms 안에 끝난다", anim.duration);

// ── 2·3. 끝난 턴을 다시 열었을 때: 알림 → 명령 요약 → 최종 답변이 그대로 재현된다 ──
console.log("\n[2·3] 끝난 턴 (fixture-codex)");
const ended = await open("fixture-codex");
check(ended.bubbles.length === 1, "답변 말풍선은 하나뿐이다", ended.bubbles);
check(ended.bubbles[0]?.includes("37개"), "말풍선에 든 것은 도구 없이 턴을 끝낸 마지막 말이다", ended.bubbles[0]);
check(ended.noteCount === 1 && ended.noteTexts[0]?.includes("테스트를 실행하겠습니다") === true, "마지막 알림은 다시 열어도 남는다", ended.noteTexts);
const endedTurn = ended.order.filter((k) => k === "live" || k === "tools" || k === "text" || k === "result");
check(JSON.stringify(endedTurn) === JSON.stringify(["live", "tools", "text", "result"]), "알림 → 명령 요약 줄 → 최종 답변 → 결과 푸터 순서", ended.order);
// 사용자 결정: 글자는 최종 답변과 똑같이 읽히되, 상자의 생김새로만 갈라진다.
check(
  !!ended.noteFace && !!ended.bubbleFace && ended.noteFace.size === ended.bubbleFace.size && ended.noteFace.color === ended.bubbleFace.color,
  "알림 글꼴·색이 최종 답변과 같다",
  { 알림: ended.noteFace, 답변: ended.bubbleFace },
);
// 여기가 둘을 눈으로 갈라내는 유일한 단서다 — 같아지면 "이게 답인가 진행 보고인가"를 알 수 없게 된다.
//   재설계 4단계(사용자 결정 2026-09-27): 답은 상자 없는 글, 알림은 왼쪽 세로줄 하나.
check(ended.noteBox?.left === "solid" && ended.noteBox?.leftWidth === "2px", "알림 왼쪽에 세로줄이 있다", ended.noteBox);
// 테두리 모양(style)은 Tailwind 기본값이 모든 요소에 solid를 깔아서 믿을 수 없다 — 굵기로 잰다.
check(ended.noteBox?.topWidth === "0px", "알림은 상자가 아니다(위 테두리 없음)", ended.noteBox);
check(ended.answerBox?.leftWidth === "0px" && ended.answerBox?.topWidth === "0px", "최종 답변은 테두리 없는 글이다", ended.answerBox);
check(ended.answerBox?.bg === "rgba(0, 0, 0, 0)", "최종 답변은 바탕이 없다", ended.answerBox);
check(
  ended.noteBox?.textLeft != null && ended.noteBox.textLeft === ended.answerBox?.textLeft,
  "알림과 답의 글이 같은 세로선에서 시작한다",
  { 알림: ended.noteBox?.textLeft, 답변: ended.answerBox?.textLeft },
);

// ── 4. 끊긴 턴: 마지막에 하던 말이 중단 배너 위에 남는다 ──
console.log("\n[4] 끊긴 턴 (fixture-cut)");
const cut = await open("fixture-cut");
check(cut.noteTexts[cut.noteCount - 1] === "이제 오래된 로그를 골라내는 중입니다", "남은 마지막 말은 멈추기 직전에 하던 것이다", cut.noteTexts);
check(cut.bubbles.length === 0, "끊긴 턴은 최종 답변이 없다", cut.bubbles);
check(JSON.stringify(cut.order) === JSON.stringify(["user", "live", "tools", "live", "banner"]), "알림 → 명령 요약 줄 → 하던 말 → 중단 배너 순서", cut.order);

// ── 5. 찾기: 화면에 남는 말은 전부 걸리고, 걸린 결과는 그 자리로 점프한다 ──
console.log("\n[5] 세션 내 찾기 (fixture-codex)");
await open("fixture-codex");
/** 찾기 바를 열고(이미 열려 있으면 그대로) 검색어를 넣는다 — Ctrl+K는 토글이라 두 번 누르면 닫힌다. */
async function find(term: string) {
  const opened = await evaluate<boolean>(`(async () => {
    const bar = () => [...document.querySelectorAll('input')].find((n) => n.placeholder && n.getClientRects().length);
    if (!bar()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }
    const input = bar();
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(term)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  return {
    opened,
    ...(await evaluate<{ counter: string; flashed: string | null }>(`(() => {
      const input = [...document.querySelectorAll('input')].find((n) => n.placeholder && n.getClientRects().length);
      const bar = input ? input.closest('.card-in') : null;
      const flashed = document.querySelector('.seg-flash');
      return { counter: bar ? (bar.innerText || '').trim() : '', flashed: flashed ? flashed.dataset.seg : null };
    })()`)),
  };
}
const hitNote = await find("테스트를 실행하겠습니다");
check(hitNote.opened, "찾기 바가 열리고 입력을 받는다");
check(hitNote.counter === "1/1", "화면에 남은 알림도 찾기에 걸린다", hitNote.counter);
check(hitNote.flashed === "live", "걸린 결과를 누르면 그 알림 자리로 이동한다", hitNote.flashed);
const hitFinal = await find("37개");
check(hitFinal.counter === "1/1", "최종 답변은 찾기에 걸린다", hitFinal.counter);
check(hitFinal.flashed === "text", "걸린 결과를 누르면 그 최종 답변 자리로 이동한다", hitFinal.flashed);
const hitNone = await find("존재하지 않는 문장입니다");
check(hitNone.counter.includes("결과 없음"), "화면에 없는 말은 안 걸린다", hitNone.counter);

console.log(`\n${failures.length === 0 ? "✅" : "❌"} checkLiveLine: ${pass} PASS / ${failures.length} FAIL`);
if (failures.length) for (const f of failures) console.log(`   - ${f}`);
socket.close();
process.exit(failures.length === 0 ? 0 : 1);
