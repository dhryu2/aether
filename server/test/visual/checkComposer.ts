/**
 * Phase E Composer browser regression and visual fixture.
 *
 * Usage:
 *   CDP_PORT=9444 node --import tsx test/visual/checkComposer.ts \
 *     "http://127.0.0.1:8899/?s=fixture-claude" 390 844 [capture-dir] [--baseline]
 */
import fs from "node:fs";
import path from "node:path";

const [url, widthArg, heightArg, captureDir, mode] = process.argv.slice(2);
if (!url) {
  console.error("Usage: checkComposer.ts <url> [width] [height] [capture-dir] [--baseline]");
  process.exit(2);
}

const width = Number(widthArg || 390);
const height = Number(heightArg || 844);
const baselineOnly = mode === "--baseline";
const expectsPermission = url.includes("fixture-actions");
const port = Number(process.env.CDP_PORT || 9222);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const target = (await (
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
).json()) as { id: string; webSocketDebuggerUrl: string };
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP connection failed")), {
    once: true,
  });
});

let messageId = 0;
const waiters = new Map<number, (result: any) => void>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id != null && waiters.has(message.id)) {
    waiters.get(message.id)!(message.result);
    waiters.delete(message.id);
  }
});
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++messageId;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate<T>(expression: string): Promise<T> {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value as T;
}
async function key(keyName: string, code = keyName, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyName,
    code,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    modifiers,
  });
  await sleep(50);
}
async function capture(name: string) {
  if (!captureDir) return;
  fs.mkdirSync(captureDir, { recursive: true });
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(captureDir, name), Buffer.from(screenshot.data, "base64"));
}

const failures: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) failures.push(message);
};

await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: width < 700,
});
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.removeItem('aether.workspaceTabs'); localStorage.removeItem('aether.panes.v1'); } catch (e) {}",
});
await send("Page.navigate", { url });
await sleep(3500);
await capture(`composer-idle-${width}x${height}.png`);

const initial = await evaluate<{
  composer: boolean;
  textareaField: boolean;
  attachmentField: boolean;
  textareaDisabled: boolean;
  controls: Array<{ label: string; width: number; height: number }>;
  horizontalOverflow: boolean;
  textareaHeight: number;
  permissionStrip: boolean;
}>(`(() => {
  const composer = document.querySelector('.aether-composer');
  const textarea = composer?.querySelector('textarea');
  const rectOf = (element) => {
    const box = element.getBoundingClientRect();
    return {
      label: element.getAttribute('aria-label') || element.textContent.trim(),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  };
  return {
    composer: !!composer,
    textareaField: !!composer?.querySelector('.aether-composer-field .aether-field-textarea'),
    attachmentField: !!composer?.querySelector('.aether-composer-attachments'),
    textareaDisabled: !!textarea?.disabled,
    controls: composer
      ? [...composer.querySelectorAll('button')]
          .filter((element) => element.getClientRects().length)
          .map(rectOf)
      : [],
    horizontalOverflow: composer instanceof HTMLElement
      ? composer.scrollWidth > composer.clientWidth + 1
      : true,
    textareaHeight: Math.round(textarea?.getBoundingClientRect().height ?? 0),
    permissionStrip: !!composer?.querySelector('.aether-composer-permission'),
  };
})()`);

if (!baselineOnly) {
  check(initial.composer, "Composer가 렌더링되어야 합니다.");
  check(initial.textareaField, "Composer 입력은 textarea 필드 wrapper여야 합니다.");
  check(initial.attachmentField, "Composer 첨부는 첨부 필드 wrapper여야 합니다.");
  check(!initial.textareaDisabled, "idle Composer textarea는 활성 상태여야 합니다.");
  check(!initial.horizontalOverflow, "Composer는 가로 overflow를 만들면 안 됩니다.");
  if (expectsPermission) {
    check(initial.permissionStrip, "requires_action Composer에는 권한 strip이 있어야 합니다.");
  }
  if (width < 700) {
    for (const control of initial.controls) {
      check(
        control.width >= 44 && control.height >= 44,
        `모바일 control target이 44px 미만입니다: ${control.label} ${control.width}×${control.height}`,
      );
    }
  }
}

await send("Page.bringToFront");
const textareaCenter = await evaluate<{ x: number; y: number }>(`(() => {
  const box = document.querySelector('.aether-composer textarea')?.getBoundingClientRect();
  return { x: (box?.left ?? 0) + (box?.width ?? 0) / 2, y: (box?.top ?? 0) + (box?.height ?? 0) / 2 };
})()`);
await send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  button: "left",
  clickCount: 1,
  x: textareaCenter.x,
  y: textareaCenter.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  button: "left",
  clickCount: 1,
  x: textareaCenter.x,
  y: textareaCenter.y,
});
await sleep(100);
const focusedViewport = await evaluate<{ focused: boolean; appHeight: string }>(`(() => ({
  focused: document.activeElement === document.querySelector('.aether-composer textarea'),
  appHeight: document.documentElement.style.getPropertyValue('--app-h'),
}))()`);
if (!baselineOnly) {
  check(focusedViewport.focused, "Composer textarea가 직접 focus를 받아야 합니다.");
  check(!!focusedViewport.appHeight, "textarea focus 중 visualViewport 높이가 --app-h에 연결되어야 합니다.");
}

await send("Input.insertText", { text: "한글" });
const imePreserved = await evaluate<boolean>(`(() => {
  const textarea = document.querySelector('.aether-composer textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return false;
  textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    isComposing: true,
  }));
  return textarea.value === '한글';
})()`);
if (!baselineOnly) {
  check(imePreserved, "IME 조합 중 Enter는 전송하거나 입력을 비우면 안 됩니다.");
}

await evaluate(`(() => {
  const textarea = document.querySelector('.aether-composer textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await send("Input.insertText", { text: "자동 높이 입력 ".repeat(80) });
await sleep(100);
const resizedHeight = await evaluate<number>(
  `Math.round(document.querySelector('.aether-composer textarea')?.getBoundingClientRect().height ?? 0)`,
);
if (!baselineOnly) {
  check(
    resizedHeight > initial.textareaHeight && resizedHeight <= 132,
    `textarea는 내용에 따라 132px 상한 안에서 자동 확장되어야 합니다: ${initial.textareaHeight}→${resizedHeight}`,
  );
}
await evaluate(`(() => {
  const textarea = document.querySelector('.aether-composer textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(100);
await send("Input.insertText", { text: "/" });
await sleep(250);
const slash = await evaluate<{
  expanded: string | null;
  listbox: boolean;
  options: number;
  activeDescendant: string | null;
  focused: boolean;
}>(`(() => {
  const textarea = document.querySelector('.aether-composer textarea');
  return {
    expanded: textarea?.getAttribute('aria-expanded') ?? null,
    listbox: !!document.querySelector('.aether-slash-list[role="listbox"]'),
    options: document.querySelectorAll('.aether-slash-option[role="option"]').length,
    activeDescendant: textarea?.getAttribute('aria-activedescendant') ?? null,
    focused: document.activeElement === textarea,
  };
})()`);
if (!baselineOnly) {
  check(slash.expanded === "true", "슬래시 메뉴가 열리면 textarea aria-expanded가 true여야 합니다.");
  check(slash.listbox && slash.options >= 2, "슬래시 명령은 listbox로 보여야 합니다.");
  check(!!slash.activeDescendant, "선택된 슬래시 option은 aria-activedescendant로 연결되어야 합니다.");
  check(slash.focused, "슬래시 메뉴가 열려도 textarea 포커스를 유지해야 합니다.");
}
await capture(`composer-slash-${width}x${height}.png`);

await key("ArrowDown");
await key("Enter");
const slashAccepted = await evaluate<{ value: string; expanded: string | null }>(`(() => {
  const textarea = document.querySelector('.aether-composer textarea');
  return { value: textarea?.value ?? '', expanded: textarea?.getAttribute('aria-expanded') ?? null };
})()`);
if (!baselineOnly) {
  check(/^\/(model|effort) $/.test(slashAccepted.value), "화살표+Enter로 슬래시 명령을 채워야 합니다.");
  check(slashAccepted.expanded === "false", "명령을 채우면 슬래시 메뉴가 닫혀야 합니다.");
}

await evaluate(`(() => {
  const textarea = document.querySelector('.aether-composer textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await evaluate(`(() => {
  const input = document.querySelector('.aether-composer input[type="file"]');
  if (!(input instanceof HTMLInputElement)) return false;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['phase e fixture'], 'phase-e-notes.txt', { type: 'text/plain' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(500);
const attachment = await evaluate<{
  nameVisible: boolean;
  removeButton: boolean;
  targetWidth: number;
  targetHeight: number;
}>(`(() => {
  const composer = document.querySelector('.aether-composer');
  const remove = composer?.querySelector('[aria-label="첨부 제거"], [aria-label="파일 제거"]');
  const box = remove?.getBoundingClientRect();
  return {
    nameVisible: composer?.textContent.includes('phase-e-notes.txt') ?? false,
    removeButton: !!remove,
    targetWidth: Math.round(box?.width ?? 0),
    targetHeight: Math.round(box?.height ?? 0),
  };
})()`);
if (!baselineOnly) {
  check(attachment.nameVisible, "선택한 텍스트 파일명이 첨부 영역에 보여야 합니다.");
  check(attachment.removeButton, "첨부 항목에 제거 action이 있어야 합니다.");
  if (width < 700) {
    check(
      attachment.targetWidth >= 44 && attachment.targetHeight >= 44,
      "모바일 첨부 제거 action은 44px 이상이어야 합니다.",
    );
  }
}
await capture(`composer-attachment-${width}x${height}.png`);

await evaluate(`(() => {
  const remove = document.querySelector('.aether-composer [aria-label="첨부 제거"], .aether-composer [aria-label="파일 제거"]');
  if (remove instanceof HTMLElement) remove.focus();
})()`);
await key(" ", "Space");
await sleep(200);
const attachmentRemoved = await evaluate<boolean>(
  `!document.querySelector('.aether-composer')?.textContent.includes('phase-e-notes.txt')`,
);
if (!baselineOnly) {
  check(attachmentRemoved, "Space 키로 첨부 항목을 제거할 수 있어야 합니다.");
}

// 글 칸은 알약 윗줄 폭을 다 쓴다. 버튼은 아랫줄에 있다 — 폰에서 글 칸이 버튼에 밀려 좁아지지 않는지 본다.
const layout = await evaluate<{ box: number; ta: number; buttonsBelow: boolean } | null>(`(() => {
  const box = document.querySelector('.aether-composer .composer-box');
  const ta = box?.querySelector('textarea');
  const plus = box?.querySelector('[data-composer-plus]');
  if (!(box instanceof HTMLElement) || !(ta instanceof HTMLElement) || !(plus instanceof HTMLElement)) return null;
  return {
    box: box.getBoundingClientRect().width,
    ta: ta.getBoundingClientRect().width,
    buttonsBelow: plus.getBoundingClientRect().top >= ta.getBoundingClientRect().bottom - 1,
  };
})()`);
if (!baselineOnly) {
  check(!!layout && layout.ta >= layout.box - 40, `글 칸이 알약 폭을 다 써야 합니다: ${JSON.stringify(layout)}`);
  check(!!layout?.buttonsBelow, "＋ 버튼은 글 칸 아래 줄에 있어야 합니다.");
}

const plusButton = await evaluate<boolean>(`(() => {
  const button = document.querySelector('.aether-composer [data-composer-plus]');
  if (!(button instanceof HTMLElement)) return false;
  button.focus();
  return true;
})()`);
if (plusButton) await key(" ", "Space");
await sleep(250);
const plusMenu = await evaluate<{ menu: boolean; items: number; expanded: string | null }>(`(() => {
  const button = document.querySelector('.aether-composer [data-composer-plus]');
  const menu = document.querySelector('.aether-composer [role="menu"]');
  return {
    menu: !!menu,
    items: menu ? menu.querySelectorAll('[role="menuitem"]').length : 0,
    expanded: button?.getAttribute('aria-expanded') ?? null,
  };
})()`);
if (!baselineOnly) {
  check(plusMenu.menu && plusMenu.items === 1, "Space 키로 ＋ 메뉴(파일 첨부)를 열 수 있어야 합니다.");
  check(plusMenu.expanded === "true", "＋ 버튼은 열린 상태를 ARIA로 노출해야 합니다.");
}
await capture(`composer-plus-menu-${width}x${height}.png`);
await key("Escape", "Escape");
await sleep(150);
const blurredViewport = await evaluate<string>(
  `document.documentElement.style.getPropertyValue('--app-h')`,
);
if (!baselineOnly) {
  check(!blurredViewport, "textarea focus가 끝나면 visualViewport --app-h를 제거해야 합니다.");
}

await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
const reducedMotion = await evaluate<number>(`(() => {
  const popup = document.querySelector('.aether-slash-list, [role="menu"]');
  if (!popup) return 0;
  const duration = getComputedStyle(popup).animationDuration;
  return duration.endsWith('ms') ? parseFloat(duration) : parseFloat(duration) * 1000;
})()`);
if (!baselineOnly) {
  check(reducedMotion <= 0.01, "reduced-motion에서 Composer popup animation이 비활성화되어야 합니다.");
}

// 뒤 작업 띠 — fixture-background 세션에서만 본다.
if (!baselineOnly && url.includes("fixture-background")) {
  const strip = await evaluate<{ has: boolean; expanded: string | null; announcer: string | null; announcerRole: string | null }>(`(() => {
    const strip = document.querySelector('[data-testid="bg-strip"]');
    const btn = strip?.querySelector('button[aria-expanded]');
    const a = document.querySelector('[data-testid="bg-announcer"]');
    return { has: !!strip, expanded: btn ? btn.getAttribute('aria-expanded') : null, announcer: a ? a.getAttribute('aria-live') : null, announcerRole: a ? a.getAttribute('role') : null };
  })()`);
  check(strip.has, "뒤 작업 띠가 보여야 합니다.");
  check(strip.expanded === "false", "띠는 접힌 채 시작해야 합니다.");
  check(strip.announcer === "polite" && strip.announcerRole === "status", "알림 영역(role=status, aria-live=polite)이 있어야 합니다.");
  const focusBefore = await evaluate<string>(`document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.getAttribute('data-testid') || '') : ''`);
  check(!focusBefore.includes("bg-announcer"), "알림 영역이 포커스를 가져가면 안 됩니다.");
  await capture("background-collapsed.png");
  await evaluate(`document.querySelector('[data-testid="bg-strip"] button[aria-expanded]').click()`);
  await sleep(200);
  const open = await evaluate<{ expanded: string | null; items: number; minH: number; overflow: boolean; inViewport: boolean }>(`(() => {
    const strip = document.querySelector('[data-testid="bg-strip"]');
    const btn = strip.querySelector('button[aria-expanded]');
    const buttons = [...strip.querySelectorAll('button')];
    const r = strip.getBoundingClientRect();
    return {
      expanded: btn.getAttribute('aria-expanded'),
      items: strip.querySelectorAll('li').length,
      minH: Math.min(...buttons.map((b) => b.getBoundingClientRect().height)),
      overflow: strip.scrollWidth > strip.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1,
      inViewport: r.left >= 0 && r.right <= window.innerWidth,
    };
  })()`);
  check(open.expanded === "true", "눌러서 펼치면 aria-expanded가 true여야 합니다.");
  check(open.items === 2, "펼치면 작업 두 개가 보여야 합니다.");
  check(open.minH >= 44, "띠의 버튼은 높이 44px 이상이어야 합니다.");
  check(!open.overflow && open.inViewport, "띠가 화면 폭 안에서 줄이 깨지면 안 됩니다.");
  await capture("background-expanded.png");
  const motion = await evaluate<string>(`getComputedStyle(document.querySelector('[data-testid="bg-strip"]')).animationName`);
  check(motion === "none", "움직임 줄이기에서는 띠의 전환이 즉시여야 합니다.");
}

socket.close();
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);

if (baselineOnly) {
  console.log(`Composer baseline captured (${width}×${height})`);
  process.exit(0);
}
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`Composer check passed (${width}×${height}, ${initial.controls.length} controls)`);
