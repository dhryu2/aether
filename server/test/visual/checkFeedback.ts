/**
 * Phase C feedback/status browser regression check.
 *
 * Run fixtureServer and CDP Chrome first, then:
 *   CDP_PORT=9333 node --import tsx test/visual/checkFeedback.ts \
 *     "http://127.0.0.1:8899/?s=fixture-codex" 390 844
 */
import fs from 'node:fs'

export {}

const [url, widthArg, heightArg, screenshotPath] = process.argv.slice(2)
if (!url) {
  console.error('사용: checkFeedback.ts <url> [너비] [높이]')
  process.exit(2)
}

const width = Number(widthArg || 1440)
const height = Number(heightArg || 900)
const port = Number(process.env.CDP_PORT || 9222)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const target = (await (
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
).json()) as {
  id: string
  webSocketDebuggerUrl: string
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true })
  ws.addEventListener('error', () => reject(new Error('CDP 연결 실패')), { once: true })
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
  const result = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T } }
  return result.result?.value as T
}

async function key(keyValue: string) {
  const keyCode = keyValue === 'Enter' ? 13 : keyValue === 'Escape' ? 27 : keyValue === 'Tab' ? 9 : 0
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyValue,
    code: keyValue,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text: keyValue === 'Enter' ? '\r' : undefined,
    unmodifiedText: keyValue === 'Enter' ? '\r' : undefined,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyValue,
    code: keyValue,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  })
  await sleep(50)
}

let failures = 0
function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) failures++
  console.log(`${condition ? '✅' : '❌'} ${name}${condition || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
}

await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: width < 700,
})
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
})
await send('Page.navigate', { url })
await sleep(3500)

const initial = await evaluate<{
  callouts: number
  warningCallouts: number
  pageBanners: number
  usageValue: number | null
  usageMax: number | null
  usageTone: string
  authActionHeight: number
  horizontalOverflow: boolean
}>(`(() => {
  const stream = document.querySelector('.aether-stream');
  const meter = document.querySelector('.aether-usage-meter');
  const authAction = document.querySelector('.aether-auth-banner button');
  return {
    callouts: document.querySelectorAll('.seed-callout__root').length,
    warningCallouts: document.querySelectorAll('.seed-callout__root--tone_warning').length,
    pageBanners: document.querySelectorAll('.seed-page-banner__root').length,
    usageValue: meter ? Number(meter.getAttribute('aria-valuenow')) : null,
    usageMax: meter ? Number(meter.getAttribute('aria-valuemax')) : null,
    usageTone: document.querySelector('.aether-usage-badge')?.className ?? '',
    authActionHeight: authAction instanceof HTMLElement ? Math.round(authAction.getBoundingClientRect().height) : 0,
    horizontalOverflow: stream instanceof HTMLElement ? stream.scrollWidth > stream.clientWidth + 1 : true,
  };
})()`)

check('대화 notice가 SEED Callout', initial.callouts >= 2, initial)
check('레이트리밋·fallback이 warning tone', initial.warningCallouts >= 2, initial)
check('인증 만료가 SEED PageBanner', initial.pageBanners === 1, initial)
check('context usage meter 의미값', initial.usageValue === 12 && initial.usageMax === 100, initial)
check('context usage informative Badge', initial.usageTone.includes('tone_informative'), initial.usageTone)
check('인증 CTA 최소 높이 36px', initial.authActionHeight >= 36, initial.authActionHeight)
check('피드백 카드 가로 overflow 없음', !initial.horizontalOverflow)

await key('Tab')
const authFocused = await evaluate<boolean>(`(() => {
  const button = document.querySelector('.aether-auth-banner button');
  if (!(button instanceof HTMLElement)) return false;
  button.focus();
  return document.activeElement === button && button.matches(':focus-visible');
})()`)
check('PageBanner CTA keyboard focus-visible', authFocused)
await key('Enter')
await sleep(250)
const authDialog = await evaluate<boolean>(
  `!!document.querySelector('[role="dialog"][aria-modal="true"]')`,
)
check('PageBanner CTA Enter로 재인증 dialog 열기', authDialog)
await key('Escape')
await sleep(150)

const errorTriggered = await evaluate<boolean>(`(async () => {
  let trigger = [...document.querySelectorAll('button')].find((button) =>
    button.getAttribute('aria-label')?.includes('세션 작업')
  );
  if (!(trigger instanceof HTMLElement)) {
    const drawer = document.querySelector('[aria-label="세션 목록 열기"]');
    if (!(drawer instanceof HTMLElement)) return false;
    drawer.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    trigger = [...document.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.includes('세션 작업')
    );
  }
  if (!(trigger instanceof HTMLElement)) return false;
  trigger.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reset = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('세션 초기화')
  );
  if (!(reset instanceof HTMLElement)) return false;
  reset.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((button) =>
    button.textContent?.trim() === '초기화'
  );
  if (!(confirm instanceof HTMLElement)) return false;
  confirm.click();
  return true;
})()`)
check('실패 동작으로 전역 오류 발생', errorTriggered)
await sleep(500)
const snackbar = await evaluate<{ critical: boolean; liveRegion: boolean }>(`(() => ({
  critical: !!document.querySelector('.aether-snackbar .seed-snackbar__prefixIcon--variant_critical'),
  liveRegion: !!document.querySelector('.seed-snackbar-region'),
}))()`)
check('critical SEED Snackbar 표시', snackbar.critical, snackbar)
check('Snackbar live region 존재', snackbar.liveRegion, snackbar)
if (screenshotPath) {
  const shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
  console.log(`📸 ${screenshotPath}`)
}

await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
})
const reduced = await evaluate<{ transition: number; animation: number }>(`(() => {
  const meter = document.querySelector('.aether-usage-meter-fill');
  const callout = document.querySelector('.aether-notice');
  const transition = meter ? parseFloat(getComputedStyle(meter).transitionDuration) : 1;
  const animation = callout ? parseFloat(getComputedStyle(callout).animationDuration) : 1;
  return { transition, animation };
})()`)
check('reduced-motion에서 transition 제거', reduced.transition <= 0.001, reduced)
check('reduced-motion에서 animation 제거', reduced.animation <= 0.001, reduced)

ws.close()
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
console.log(`\n${failures === 0 ? '✅' : '❌'} Feedback ${width}×${height}: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
