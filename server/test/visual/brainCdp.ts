/**
 * checkBrain.ts가 쓰는 CDP 통신과 워크스페이스 창 조작 도우미.
 * 검사 순서는 checkBrain.ts에 두고, 여기에는 연결·키 입력·열고 닫기·누름 범위 측정만 둔다.
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

export async function connectBrain(port: number, phone: boolean) {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  })).json()) as {
    id: string;
    webSocketDebuggerUrl: string;
  };
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  });

  let messageId = 0;
  const waiters = new Map<number, (result: any) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)!(message.result);
      waiters.delete(message.id);
    }
  });
  // CDP 왕복 하나가 응답을 못 받으면(부하로 메시지가 늦거나 유실되면) 이 약속은 영원히 안 풀린다.
  // 기다림 상한을 둬서 "멈춘 것"과 "느린 것"을 구분한다 — 8초를 넘기면 그 자체가 결함으로 실패한다.
  function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++messageId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`CDP timeout: ${method} (id=${id}) got no response within 8s`));
      }, 8000);
      waiters.set(id, (result: any) => {
        clearTimeout(timer);
        resolve(result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value as T;
  }
  async function key(keyName: string, modifiers = 0) {
    const keyCode: Record<string, number> = {
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Enter: 13,
      Escape: 27,
      Tab: 9,
    };
    const code = keyCode[keyName] ?? 0;
    // nativeVirtualKeyCode는 넣지 않는다. 맥에서는 이 칸이 맥 고유 키 번호로 읽혀서,
    // Escape(27)가 크롬 단축키로 해석돼 chrome://settings/help 탭을 연다.
    // 그 탭이 앞으로 나오면 시험 탭이 숨김이 되어 움직임과 requestAnimationFrame이 멈춘다.
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyName,
      code: keyName,
      modifiers,
      windowsVirtualKeyCode: code,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyName,
      code: keyName,
      modifiers,
      windowsVirtualKeyCode: code,
    });
  }
  async function clickTab(id: string) {
    const clicked = await evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-brain-tab="${id}"]');
      if (!(el instanceof HTMLElement)) return false;
      el.focus();
      el.click();
      return true;
    })()`);
    assert(clicked, `Tab ${id} not found`);
    await sleep(120);
  }

  // 끝없이 도는 참딩은 빼고, 창이 올라오는 움직임이 끝날 때까지 기다린다. 최대 2초.
  async function waitForAnimations() {
    await evaluate<boolean>(`(async () => {
      const started = Date.now();
      const finiteRunning = () => document.getAnimations().filter((anim) => {
        if (anim.playState === "finished" || anim.playState === "idle") return false;
        const effect = anim.effect;
        const timing = effect && typeof effect.getTiming === "function" ? effect.getTiming() : null;
        return !(timing && timing.iterations === Infinity);
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (finiteRunning().length > 0 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return true;
    })()`);
  }

  async function openBrain() {
    const opened = await evaluate<boolean>(`(() => {
      const button = document.querySelector('button[aria-label="워크스페이스"]');
      if (!(button instanceof HTMLElement)) return false;
      button.focus();
      button.click();
      return true;
    })()`);
    assert(opened, "워크스페이스 opener not found");
    let dialogReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      dialogReady = await evaluate<boolean>(`!!document.querySelector('[role="dialog"][aria-modal="true"][aria-labelledby="brain-overlay-title"]')`);
      if (dialogReady) break;
      await sleep(100);
    }
    assert(dialogReady, "워크스페이스 dialog did not open");
    await waitForAnimations();
  }

  async function readFocus() {
    return evaluate<{ absent: boolean; onScreen: boolean; label: string | null }>(`(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) {
        return { absent: true, onScreen: true, label: null };
      }
      const rect = el.getBoundingClientRect();
      const onScreen = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      return { absent: false, onScreen, label: el.getAttribute("aria-label") };
    })()`);
  }

  async function assertFocusRestored() {
    let focus = { absent: false, onScreen: false, label: null as string | null };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      focus = await readFocus();
      const ok = phone ? focus.absent || focus.onScreen : focus.label === "워크스페이스";
      if (!ok) {
        await sleep(50);
        continue;
      }
      if (phone) {
        await sleep(120);
        focus = await readFocus();
      }
      break;
    }
    if (phone) assert(focus.absent || focus.onScreen, `Phone restore focus is off screen: ${JSON.stringify(focus)}`);
    else assert(focus.label === "워크스페이스", `Focus was not restored: ${focus.label}`);
  }

  async function assertEscapeClosed(normalMotion: boolean) {
    await key("Escape");
    if (normalMotion) {
      await sleep(80);
      assert(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), "Normal 360ms close removed the dialog immediately");
    }
    let closed = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      closed = await evaluate<boolean>(`!document.querySelector('[role="dialog"]')`);
      if (closed) break;
      await sleep(50);
    }
    assert(closed, "Escape did not close 워크스페이스");
    if (normalMotion) {
      await sleep(500);
      assert(await evaluate<boolean>(`!document.querySelector('[role="dialog"]')`), "Dialog was still present 0.5s after the normal close");
    }
    await assertFocusRestored();
  }

  // 탭 키는 창 안에서만 돈다. 마지막에서 앞으로, 처음에서 Shift+Tab으로 뒤로.
  async function assertTabTrapped() {
    for (const [pick, modifiers, label] of [["last", 0, "Tab"], ["first", 8, "Shift+Tab"]] as const) {
      const focused = await evaluate<boolean>(`(() => {
        const sheet = document.querySelector('[data-brain-sheet]');
        if (!(sheet instanceof HTMLElement)) return false;
        const items = [...sheet.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          if (el.hasAttribute('disabled') || el.tabIndex < 0) return false;
          if (getComputedStyle(el).visibility === 'hidden') return false;
          return el.getClientRects().length > 0;
        });
        const el = ${pick === "last" ? "items[items.length - 1]" : "items[0]"};
        if (!(el instanceof HTMLElement)) return false;
        el.focus();
        return document.activeElement === el;
      })()`);
      assert(focused, `Could not focus the ${pick} control in the dialog`);
      await key("Tab", modifiers);
      await sleep(40);
      assert(
        await evaluate<boolean>(`(() => {
          const sheet = document.querySelector('[data-brain-sheet]');
          return !!sheet && !!document.activeElement && sheet.contains(document.activeElement);
        })()`),
        `${label} left the dialog`,
      );
    }
  }

  async function close() {
    socket.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }

  return { send, evaluate, key, clickTab, waitForAnimations, openBrain, assertTabTrapped, assertEscapeClosed, close };
}

// 보이는 크기와, 폰에서만 넓어지는 ::after 누름 범위 중 큰 쪽. 폰에서만 쓴다.
export const HIT_SCRIPT = `(() => {
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    const aw = parseFloat(after.width);
    const ah = parseFloat(after.height);
    return {
      w: Math.max(rect.width, Number.isFinite(aw) ? aw : 0),
      h: Math.max(rect.height, Number.isFinite(ah) ? ah : 0),
    };
  };
  const small = [];
  const close = document.querySelector('[data-brain-sheet] button[aria-label="닫기"]');
  if (!(close instanceof HTMLElement)) small.push('close-missing');
  else {
    const b = box(close);
    if (b.w < 43.5 || b.h < 43.5) small.push('close ' + Math.round(b.w) + 'x' + Math.round(b.h));
  }
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    if (!(tab instanceof HTMLElement) || tab.getClientRects().length === 0) continue;
    const b = box(tab);
    if (b.w < 43.5 || b.h < 43.5) small.push('tab ' + (tab.getAttribute('data-brain-tab') || '') + ' ' + Math.round(b.w) + 'x' + Math.round(b.h));
  }
  for (const button of document.querySelectorAll('#brain-tabpanel button')) {
    if (!(button instanceof HTMLElement) || button.getClientRects().length === 0) continue;
    const b = box(button);
    if (b.w < 43.5 || b.h < 43.5) small.push('button ' + (button.getAttribute('aria-label') || button.textContent || '').trim().slice(0, 24) + ' ' + Math.round(b.w) + 'x' + Math.round(b.h));
  }
  return small;
})()`;
