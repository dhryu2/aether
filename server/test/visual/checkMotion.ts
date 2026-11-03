/**
 * 상태가 바뀌는 순간의 움직임을 실제 브라우저에서 확인한다.
 *
 * 여기서 보는 것은 "애니메이션이 예쁜가"가 아니라 **정확한 순간에만 도는가**다. 특히:
 *   · 결정 카드(권한·질문)의 마무리 움직임은 화면에서 결정되는 것을 실제로 본 카드에만 붙어야 한다.
 *     과거 대화를 다시 불러올 때도 붙으면 세션을 열 때마다 지난 카드가 전부 번쩍인다.
 *   · '움직임 줄이기'를 켠 사람에게는 전부 꺼져야 한다.
 *
 * 먼저 fixtureServer와 CDP 크롬을 띄운 뒤 server/ 디렉터리에서:
 *   CDP_PORT=9222 node --import tsx test/visual/checkMotion.ts http://127.0.0.1:8899 1440 900
 *
 * ⚠️ 세션을 스스로 옮겨 다니고 카드에 답까지 하므로 <서버 주소>만 넘긴다(세션 쿼리 붙이지 마라).
 * ⚠️ 카드에 한 번 답하면 fixture 서버가 그 결과를 기록으로 남긴다 — 두 번째 실행부터는 결과가 달라지므로
 *    서버를 새로 띄우고 돌려라.
 */
import fs from 'node:fs'

export {}

const [base, widthArg, heightArg, screenshotDir] = process.argv.slice(2)
if (!base) {
  console.error('사용: checkMotion.ts <서버 주소> [너비] [높이] [스크린샷 폴더]')
  process.exit(2)
}

const width = Number(widthArg || 1440)
const height = Number(heightArg || 900)
const port = Number(process.env.CDP_PORT || 9222)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()) as {
  id: string
  webSocketDebuggerUrl: string
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true })
  ws.addEventListener('error', () => reject(new Error('CDP 연결 실패 — 브라우저가 --remote-debugging-port로 떠 있나?')), { once: true })
})

let messageId = 0
const waiters = new Map<number, (value: unknown) => void>()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
  if (message.id != null && waiters.has(message.id)) {
    waiters.get(message.id)!(message.result)
    waiters.delete(message.id)
  }
})
function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++messageId
  return new Promise<unknown>((resolve) => {
    waiters.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate<T>(expression: string): Promise<T> {
  const result = (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T }
  }
  return result.result?.value as T
}

let failures = 0
function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) failures++
  console.log(`${condition ? '✅' : '❌'} ${name}${condition || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
}

async function open(session: string, waitMs = 3200) {
  await send('Page.navigate', { url: `${base}/?s=${session}` })
  await sleep(waitMs)
}
/** 화면의 버튼을 글자로 찾아 누른다(로케일 무관하게 쓰려고 부분 일치). */
async function clickText(selector: string, text: string): Promise<boolean> {
  return evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`)
}
async function shoot(name: string) {
  if (!screenshotDir) return
  const shotResult = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  const out = `${screenshotDir}/${name}.png`
  fs.writeFileSync(out, Buffer.from(shotResult.data, 'base64'))
  console.log(`   📸 ${out}`)
}

await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 700 })
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try { localStorage.removeItem('aether.sidebar.openProjects'); localStorage.removeItem('aether.sidebar.openBuckets'); localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
})

const label = `${width}×${height}`
console.log(`\n── ${label} · 보통 설정 ──`)

// ── 1. 답을 기다리는 카드는 떠오르기만 하고 숨쉬지 않는다(재설계 4단계 — 끝없이 도는 움직임은 참딩만) ──
await open('fixture-actions')
const pending = await evaluate<{ perm: string; question: string; cards: number }>(`(() => {
  const cards = [...document.querySelectorAll('[data-seg="permission"] > div, [data-seg="question"] > div')];
  const perm = document.querySelector('[data-seg="permission"] > div');
  const q = document.querySelector('[data-seg="question"] > div');
  return {
    perm: perm ? getComputedStyle(perm).animationName : 'none',
    question: q ? getComputedStyle(q).animationName : 'none',
    cards: cards.length,
  };
})()`)
check('답 대기 카드 2장이 보인다', pending.cards === 2, pending)
check('권한 카드가 떠오르고 숨쉬지 않는다', pending.perm === 'card-in', pending.perm)
check('질문 카드가 떠오르고 숨쉬지 않는다', pending.question === 'card-in', pending.question)
await shoot(`motion-${label}-pending`)

// ── 2. 승인을 누른 순간에만 도는 마무리 움직임 ──
const clicked = await clickText('[data-seg="permission"] button', '승인')
check('승인 버튼을 눌렀다', clicked)
await sleep(90)
const settling = await evaluate<{ card: string; footer: string; shadow: string }>(`(() => {
  const card = document.querySelector('[data-seg="permission"] > div');
  const footer = card ? card.lastElementChild : null;
  return {
    card: card ? getComputedStyle(card).animationName : 'missing',
    footer: footer ? getComputedStyle(footer).animationName : 'missing',
    shadow: card ? getComputedStyle(card).boxShadow : 'missing',
  };
})()`)
check('결정된 카드가 마무리 움직임을 돈다(card-settle)', settling.card === 'card-settle', settling)
check('결과 띠가 내려앉는다(settle-in)', settling.footer === 'settle-in', settling)
// 도는 도중에는 실제로 **결과 색**(승인=초록) 고리가 화면에 있어야 한다.
//   카드 강조색(시안)이 아니어야 한다 — 시안이면 직전까지 깜빡이던 펄스와 구분이 안 돼서 안 보인다.
check('도는 동안 승인 초록 고리가 실제로 보인다', settling.shadow.includes('26, 127, 75'), settling.shadow)
check('결정 고리에 카드 강조색(시안)을 쓰지 않는다', !settling.shadow.includes('43, 184, 232'), settling.shadow)
await shoot(`motion-${label}-settling`)

// 애니메이션이 끝난 뒤 그림자가 카드 자신의 값으로 돌아오는지 — 재설계 4단계: 끝값을 붙잡지 않는다(fill-mode backwards).
// ⚠️ card-settle이 800ms이므로 위 sleep(90)과 합쳐 그보다 넉넉히 길어야 한다. 900ms 미만이면
//    스크린샷 폴더를 안 넘겼을 때(shoot이 아무 일도 안 한다) 애니메이션이 끝나기 직전에 재서 헛되이 실패한다.
await sleep(900)
const settled = await evaluate<{ shadow: string; anim: string }>(`(() => {
  const card = document.querySelector('[data-seg="permission"] > div');
  return { shadow: card ? getComputedStyle(card).boxShadow : 'missing', anim: card ? getComputedStyle(card).animationName : 'missing' };
})()`)
check('끝난 뒤 고리가 남지 않는다', !settled.shadow.includes('26, 127, 75'), settled.shadow)
check('끝난 뒤 퍼진 고리(30px)가 붙잡혀 남지 않는다', !settled.shadow.includes('30px'), settled.shadow)

// ── 3. 과거 기록으로 다시 불러온 카드는 움직이지 않는다(가장 중요한 구분) ──
await open('fixture-actions')
const replayed = await evaluate<{ cls: string; anim: string; resolved: boolean }>(`(() => {
  const card = document.querySelector('[data-seg="permission"] > div');
  return {
    cls: card ? card.className : 'missing',
    anim: card ? getComputedStyle(card).animationName : 'missing',
    resolved: !!card && (card.textContent || '').includes('승인됨'),
  };
})()`)
check('새로고침하면 카드가 이미 결정된 상태다', replayed.resolved, replayed)
check('과거 기록의 카드는 움직이지 않는다', !replayed.cls.includes('card-settle') && replayed.anim === 'none', replayed)

// ── 4. 접힌 도구 묶음을 펼치면 위에서부터 차례로 들어온다 ──
await open('fixture-codex')
const expanded = await evaluate<{ ok: boolean; chips: number; anims: string[]; delays: string[] }>(`(() => {
  const summary = document.querySelector('[data-seg="tools"] button');
  if (!summary) return { ok: false, chips: 0, anims: [], delays: [] };
  summary.click();
  return new Promise((resolve) => requestAnimationFrame(() => {
    const chips = [...document.querySelectorAll('[data-seg="tools"] .tool-chip')];
    resolve({
      ok: true,
      chips: chips.length,
      anims: chips.map((c) => getComputedStyle(c).animationName),
      delays: chips.map((c) => getComputedStyle(c).animationDelay),
    });
  }));
})()`)
check('도구 묶음을 펼쳤다', expanded.ok && expanded.chips > 0, expanded)
check('펼쳐진 칩이 차례로 들어온다(chip-in)', expanded.anims.every((a) => a === 'chip-in'), expanded.anims)
check('첫 칩은 기다리지 않는다', expanded.delays[0] === '0s', expanded.delays)
check('펼침 시차가 눈에 잡힐 만큼 벌어져 있다(70ms)', expanded.chips < 2 || expanded.delays[1] === '0.07s', expanded.delays)

// 접으면 아래 칸부터 역순으로 빠져나간 뒤에 요약 줄로 돌아간다.
await sleep(600)
const collapsing = await evaluate<{ anims: string[]; delays: string[]; count: number }>(`(() => {
  const back = [...document.querySelectorAll('[data-seg="tools"] button')][0];
  if (back) back.click();
  return new Promise((resolve) => requestAnimationFrame(() => {
    const chips = [...document.querySelectorAll('[data-seg="tools"] .tool-chip')];
    resolve({
      anims: chips.map((c) => getComputedStyle(c).animationName),
      delays: chips.map((c) => getComputedStyle(c).animationDelay),
      count: chips.length,
    });
  }));
})()`)
check('접으면 칩이 빠져나간다(chip-out)', collapsing.count > 0 && collapsing.anims.every((a) => a === 'chip-out'), collapsing)
// 역순 = 마지막 칩의 시차가 0이고 첫 칩이 가장 늦다(칩이 하나뿐이면 순서 자체가 없다).
check(
  '접힘은 아래에서부터 역순이다',
  collapsing.count < 2 || collapsing.delays[collapsing.delays.length - 1] === '0s',
  collapsing.delays,
)
await sleep(700)
const collapsed = await evaluate<number>(`document.querySelectorAll('[data-seg="tools"] .tool-chip').length`)
check('접힘이 끝나면 요약 줄로 돌아간다', collapsed === 0, collapsed)

// ── 5. 진행 중인 턴에서 중지 버튼이 미끄러져 들어온다 ──
await open('fixture-live')
const live = await evaluate<{ stop: string; send: string; sendBg: boolean }>(`(() => {
  const stop = document.querySelector('.stop-in');
  const sendBtn = document.querySelector('.send-btn');
  const t = sendBtn ? getComputedStyle(sendBtn).transitionProperty : '';
  return {
    stop: stop ? getComputedStyle(stop).animationName : 'missing',
    send: sendBtn ? getComputedStyle(sendBtn).transitionDuration : 'missing',
    sendBg: t.includes('background'),
  };
})()`)
check('중지 버튼이 등장 움직임을 갖는다(stop-in)', live.stop === 'stop-in', live)
check('전송 버튼 색이 번지듯 바뀐다', live.sendBg && live.send !== '0s', live)

// 전송 버튼은 켜지는 순간 한 번 도는 효과가 따로 있어야 한다(색 전환만으로는 거의 안 보였다).
const sendOn = await evaluate<{ anim: string; enabled: boolean }>(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { anim: 'no-textarea', enabled: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '보이나');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise((r) => requestAnimationFrame(() => {
    const btn = document.querySelector('.send-btn');
    r({ anim: btn ? getComputedStyle(btn).animationName : 'missing', enabled: !!btn && !btn.disabled });
  }));
})()`)
check('글자를 치면 전송 버튼이 켜진다', sendOn.enabled, sendOn)
check('켜지는 순간 한 번 도는 효과가 있다(send-on)', sendOn.anim === 'send-on', sendOn)

// ── 6. 세션 줄 선택 표시(왼쪽 막대). 두꺼운 카드 그라데이션은 쓰지 않는다. ──
await evaluate<boolean>(`(() => {
  const head = document.querySelector('.project-head[data-current="1"] [data-project-key]') || document.querySelector('[data-project-key]');
  if (head instanceof HTMLElement && !document.querySelector('.session-row')) head.click();
  return true;
})()`)
await sleep(200)
const sidebar = await evaluate<{ found: boolean; bg: boolean; lift: boolean; bar: boolean; cards: number }>(`(() => {
  const rows = [...document.querySelectorAll('.session-row')];
  if (!rows.length) return { found: false, bg: false, lift: false, bar: false, cards: 0 };
  const cs = getComputedStyle(rows[0]);
  return {
    found: true,
    bg: cs.transitionProperty.includes('background'),
    lift: rows.some((el) => el.classList.contains('lift')),
    bar: !!document.querySelector('.session-row-active .session-row-bar'),
    cards: rows.length,
  };
})()`)
check('세션 줄이 있다', sidebar.found && sidebar.cards > 0, sidebar)
check('세션 줄 배경이 바뀐다', sidebar.found && sidebar.bg, sidebar)
check('세션 줄을 띄우지 않는다', sidebar.found && !sidebar.lift, sidebar)
check('고른 줄에 왼쪽 막대가 있다', sidebar.bar, sidebar)

// ── 7. Agent Brain: 탭 전환과 닫힘 ──
const brainOpened = await evaluate<boolean>(`(() => {
  const orb = document.querySelector('.brain-orb') || [...document.querySelectorAll('button')].find((b) => b.querySelector('svg circle'));
  if (!orb) return false;
  orb.click();
  return true;
})()`)
if (brainOpened) await sleep(500)
const brain = await evaluate<{ open: boolean; tab: string; closing: string }>(`(() => {
  const overlay = document.querySelector('.brain-overlay');
  if (!overlay) return { open: false, tab: 'missing', closing: 'missing' };
  const tabs = [...overlay.querySelectorAll('button[aria-pressed]')];
  if (tabs[2]) tabs[2].click();
  return new Promise((resolve) => requestAnimationFrame(() => {
    const panel = document.querySelector('.tab-in-r, .tab-in-l');
    resolve({ open: true, tab: panel ? getComputedStyle(panel).animationName : 'missing', closing: '' });
  }));
})()`)
check('Agent Brain이 열렸다', brain.open, brain)
if (brain.open) {
  check('오른쪽 탭을 누르면 본문이 오른쪽에서 들어온다', brain.tab === 'tab-in-r', brain)
  await shoot(`motion-${label}-brain`)
  // 막(.brain-overlay)과 시트(.brain-toast)는 형제가 아니라 각자 다른 요소다 — 막은 흐려지기만 하고
  //   버튼은 시트 안에 있다. 그래서 시트에서 닫기 버튼을 찾는다.
  const closing = await evaluate<{ sheet: string; scrim: string }>(`(() => {
    const sheet = document.querySelector('.brain-toast');
    const scrim = document.querySelector('.brain-overlay');
    const close = sheet && [...sheet.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '닫기');
    if (!close || !sheet || !scrim) return { sheet: 'no-close-button', scrim: '' };
    close.click();
    return new Promise((r) => requestAnimationFrame(() => r({
      sheet: getComputedStyle(sheet).animationName,
      scrim: getComputedStyle(scrim).animationName,
    })));
  })()`)
  check('닫을 때 시트가 되돌아 내려간다(brain-sheet-out)', closing.sheet === 'brain-sheet-out', closing)
  // 막만 흐려지고 시트는 자기 투명도를 따로 갖는다 — 둘 다 흐려지면 투명도가 곱해져 이동이 안 보인다.
  check('막은 흐려지기만 한다(시트와 투명도가 겹치지 않는다)', closing.scrim === 'fade-out', closing)
  await sleep(500)
  const gone = await evaluate<boolean>(`!document.querySelector('.brain-toast')`)
  check('닫힘 애니메이션이 끝나면 사라진다', gone)
}

// ── 8. 오류 알림 — fixture 서버는 세션 시작 요청을 받지 않아서 화면에 실제로 떠 있다.
//      재설계 후 알림은 상단바 아래 가운데에서 내려온다. 바닥에 뜬 입력창과 겹치지 않는지 좌표로 확인한다. ──
const toast = await evaluate<{ found: boolean; anim: string; centered: boolean; offset: number; clearOfComposer: boolean }>(`(() => {
  const el = document.querySelector('.toast-in');
  if (!el) return { found: false, anim: 'missing', centered: false, offset: -1, clearOfComposer: false };
  const r = el.getBoundingClientRect();
  const offset = Math.abs((r.left + r.right) / 2 - window.innerWidth / 2);
  const composer = document.querySelector('.composer-box');
  const clearOfComposer = !composer || r.bottom <= composer.getBoundingClientRect().top;
  return { found: true, anim: getComputedStyle(el).animationName, centered: offset < 2, offset: Math.round(offset), clearOfComposer };
})()`)
check('오류 알림이 위에서 내려온다(toast-in)', toast.found && toast.anim === 'toast-in', toast)
check('내려오는 동안에도 가로 중앙을 지킨다', toast.centered, toast)
check('알림이 입력창보다 위에 있어 겹치지 않는다', toast.clearOfComposer, toast)

// ══ 움직임 줄이기 ══
console.log(`\n── ${label} · 움직임 줄이기(prefers-reduced-motion: reduce) ──`)
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await open('fixture-actions')

const reducedPending = await evaluate<{ perm: string }>(`(() => {
  const perm = document.querySelector('[data-seg="question"] > div');
  return { perm: perm ? getComputedStyle(perm).animationName : 'missing' };
})()`)
check('답 대기 카드가 숨쉬지 않는다', reducedPending.perm === 'none', reducedPending)

// 선택지를 고른 뒤 '답변 보내기' — 질문 카드는 다 고르기 전엔 보내기 버튼이 잠겨 있다.
const answered = await clickText('[data-seg="question"] button', '검증 후 진행')
await sleep(80)
const sent = await clickText('[data-seg="question"] button', '답변 보내기')
check('질문에 답했다', answered && sent, { answered, sent })
await sleep(200)
const reducedSettle = await evaluate<{ card: string; footer: string; resolved: boolean }>(`(() => {
  const card = document.querySelector('[data-seg="question"] > div');
  const footer = card ? card.lastElementChild : null;
  return {
    card: card ? getComputedStyle(card).animationName : 'missing',
    footer: footer ? getComputedStyle(footer).animationName : 'missing',
    resolved: !!card && (card.textContent || '').includes('답변함'),
  };
})()`)
check('결정해도 카드가 움직이지 않는다', reducedSettle.card === 'none', reducedSettle)
check('결과 띠도 움직이지 않는다', reducedSettle.footer === 'none', reducedSettle)

const reducedRest = await evaluate<{ send: string; session: string; chips: string[] }>(`(() => {
  const summary = document.querySelector('[data-seg="tools"] button');
  if (summary) summary.click();
  const sendBtn = document.querySelector('.send-btn');
  const card = document.querySelector('.session-row');
  return new Promise((resolve) => requestAnimationFrame(() => resolve({
    send: sendBtn ? getComputedStyle(sendBtn).transitionDuration : 'missing',
    session: card ? getComputedStyle(card).transitionDuration : 'missing',
    chips: [...document.querySelectorAll('.tool-chip')].map((c) => getComputedStyle(c).animationName),
  })));
})()`)
check('전송 버튼 색 전환이 꺼진다', reducedRest.send === '0s', reducedRest)
check('세션 선택 전환이 꺼진다', reducedRest.session === '0s', reducedRest)
check('펼친 도구 칩이 움직이지 않는다', reducedRest.chips.every((a) => a === 'none'), reducedRest.chips)

// 켜진 전송 버튼의 한 방 효과와 중지 버튼 등장도 꺼져야 한다.
const reducedOneShot = await evaluate<{ send: string; stop: string }>(`(() => {
  const ta = document.querySelector('textarea');
  if (ta) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '보이나');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return new Promise((r) => requestAnimationFrame(() => {
    const send = document.querySelector('.send-on');
    const stop = document.querySelector('.stop-in');
    r({
      send: send ? getComputedStyle(send).animationName : 'absent',
      stop: stop ? getComputedStyle(stop).animationName : 'absent',
    });
  }));
})()`)
check('전송 버튼 점등 효과가 꺼진다', reducedOneShot.send === 'none' || reducedOneShot.send === 'absent', reducedOneShot)
check('중지 버튼 등장 효과가 꺼진다', reducedOneShot.stop === 'none' || reducedOneShot.stop === 'absent', reducedOneShot)

// 예전부터 '움직임 줄이기'에서 안 꺼지고 있던 것들 — 배경 색면 네 덩어리와 말풍선 등장.
const reducedLegacy = await evaluate<{ mesh: string[]; msgIn: string; cardIn: string }>(`(() => {
  const mesh = ['.mesh-a', '.mesh-b', '.mesh-c', '.mesh-d']
    .map((sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).animationName : 'missing'; });
  const msg = document.querySelector('.msg-in');
  const card = document.querySelector('.card-in');
  return {
    mesh,
    msgIn: msg ? getComputedStyle(msg).animationName : 'none',
    cardIn: card ? getComputedStyle(card).animationName : 'none',
  };
})()`)
check('배경 색면 네 덩어리가 멈춘다', reducedLegacy.mesh.every((a) => a === 'none'), reducedLegacy.mesh)
check('말풍선·카드 등장이 멈춘다', reducedLegacy.msgIn === 'none' && reducedLegacy.cardIn === 'none', reducedLegacy)
await shoot(`motion-${label}-reduced`)

ws.close()
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
console.log(`\n${failures === 0 ? '✅' : '❌'} 움직임 확인 ${label}: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
