/**
 * Phase D Stream/card browser regression check.
 *
 * Usage:
 *   CDP_PORT=9333 node --import tsx test/visual/checkStream.ts \
 *     "http://127.0.0.1:8899/?s=fixture-actions" 390 844 [capture.png]
 */
import fs from "node:fs";

const [url, widthArg, heightArg, capturePath] = process.argv.slice(2);
if (!url) {
  console.error("Usage: checkStream.ts <url> [width] [height] [capture.png]");
  process.exit(2);
}

const width = Number(widthArg || 390);
const height = Number(heightArg || 844);
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

const anatomy = await evaluate<{
  permission: number;
  question: number;
  articles: number;
  radioCount: number;
  otherField: boolean;
  actionSizes: { text: string; width: number; height: number }[];
}>(`(() => {
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { text: element.textContent.trim(), width: box.width, height: box.height };
  };
  return {
    permission: document.querySelectorAll('.aether-permission-card[data-state="pending"]').length,
    question: document.querySelectorAll('.aether-question-card[data-state="pending"]').length,
    articles: document.querySelectorAll('.aether-article').length,
    radioCount: document.querySelectorAll('.aether-question-card input[type="radio"]').length,
    otherField: !!document.querySelector('.aether-question-other input'),
    actionSizes: [...document.querySelectorAll('.aether-permission-card button, .aether-question-card button')]
      .filter((element) => element.getClientRects().length)
      .map(rect),
  };
})()`);

check(anatomy.permission === 1, "pending PermissionCard가 1개여야 합니다.");
check(anatomy.question === 1, "pending QuestionCard가 1개여야 합니다.");
check(anatomy.articles >= 1, "Stream 본문에 SEED Article wrapper가 있어야 합니다.");
check(anatomy.radioCount === 2, "QuestionCard의 SEED radio option이 2개여야 합니다.");
check(anatomy.otherField, "QuestionCard의 SEED TextField가 있어야 합니다.");
if (width < 700) {
  for (const action of anatomy.actionSizes) {
    check(
      action.height >= 44 && action.width >= 44,
      `모바일 action target이 44px 미만입니다: ${action.text} ${action.width}×${action.height}`,
    );
  }
}

await evaluate(`(() => {
  const radio = document.querySelector('.aether-question-card input[type="radio"]');
  radio?.focus();
})()`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
await sleep(200);
const keyboardChoice = await evaluate<{ checked: boolean; submitEnabled: boolean }>(`(() => {
  const radio = document.querySelector('.aether-question-card input[type="radio"]');
  const submit = [...document.querySelectorAll('.aether-question-card button')]
    .find((button) => button.textContent.includes('답변'));
  return { checked: !!radio?.checked, submitEnabled: !!submit && !submit.disabled };
})()`);
check(keyboardChoice.checked, "Space 키로 첫 radio option을 선택할 수 있어야 합니다.");
check(keyboardChoice.submitEnabled, "선택 완료 후 답변 버튼이 활성화되어야 합니다.");

await evaluate(`document.querySelector('.aether-question-other input')?.focus()`);
const otherFocused = await evaluate<boolean>(
  `document.activeElement === document.querySelector('.aether-question-other input')`,
);
check(otherFocused, "기타 입력 SEED TextField로 focus가 이동해야 합니다.");

await evaluate(`(() => {
  const stream = document.querySelector('.stream-scroll');
  if (!stream) return;
  stream.scrollTop = 0;
  stream.dispatchEvent(new Event('scroll', { bubbles: true }));
})()`);
await sleep(300);
const scrollAction = await evaluate<{
  exists: boolean;
  scrollable: boolean;
  width: number;
  height: number;
}>(`(() => {
  const stream = document.querySelector('.stream-scroll');
  const button = document.querySelector('.aether-scroll-bottom');
  const scrollable = !!stream && stream.scrollHeight > stream.clientHeight + 2;
  if (!button) return { exists: false, scrollable, width: 0, height: 0 };
  const box = button.getBoundingClientRect();
  button.focus();
  return { exists: true, scrollable, width: box.width, height: box.height };
})()`);
if (scrollAction.scrollable) {
  check(scrollAction.exists, "상단 이탈 시 Contextual Floating Button이 보여야 합니다.");
  check(
    scrollAction.width >= 44 && scrollAction.height >= 44,
    "아래로 이동 Contextual Floating Button은 44px 이상이어야 합니다.",
  );
}
if (scrollAction.exists) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
  });
  await sleep(300);
  const bottomState = await evaluate<{
    atBottom: boolean;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    activeClass: string;
  }>(`(() => {
    const stream = document.querySelector('.stream-scroll');
    return {
      atBottom: !!stream && Math.abs(stream.scrollHeight - stream.scrollTop - stream.clientHeight) <= 2,
      scrollTop: stream?.scrollTop ?? -1,
      scrollHeight: stream?.scrollHeight ?? -1,
      clientHeight: stream?.clientHeight ?? -1,
      activeClass: document.activeElement?.className ?? '',
    };
  })()`);
  check(
    bottomState.atBottom,
    `Space 키로 아래로 이동 버튼을 실행하면 Stream 바닥으로 이동해야 합니다: ${JSON.stringify(bottomState)}`,
  );
}

await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
const reducedDuration = await evaluate<number>(`(() => {
  const card = document.querySelector('.aether-question-card');
  if (!card) return 1;
  const duration = getComputedStyle(card).animationDuration;
  return duration.endsWith('ms') ? parseFloat(duration) : parseFloat(duration) * 1000;
})()`);
check(reducedDuration <= 0.01, "reduced-motion에서 card animation이 사실상 비활성화되어야 합니다.");

if (capturePath) {
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(capturePath, Buffer.from(screenshot.data, "base64"));
}

socket.close();
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`Stream/card check passed (${width}×${height}, ${anatomy.actionSizes.length} actions)`);
