import { reportError } from "../../observability/report";
/**
 * Grok 인증 — 기기 코드 로그인 중계 (Phase 10d · D13).
 *
 * Claude와 방향이 반대다. Claude는 서버가 주소를 주고 사용자가 코드를 되돌려 보낸다.
 * Grok는 Codex와 같다. `grok login --device-auth`가 주소와 코드를 함께 찍고, 사용자는
 * 그 화면에서 끝낸다. ACP `x.ai/auth/get_url`은 이 CLI에서 Method not found다.
 *
 * 완료는 CLI 프로세스 종료로 온다(성공=종료 코드 0). 화면은 `poll`로 물어본다.
 * ⚠️ userCode는 로그인 자격이다. 로그로 남기지 않는다.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { st } from "../../i18n";
import type { AuthStatus, LoginProgress, LoginStart, ProviderAuth } from "../types";
import { grokAuthHome } from "./env";
import {
  beginRequest,
  disposeControl,
  endRequest,
  ensureLoginProcess,
  holdControl,
  loginOutput,
  onControlExit,
  onLoginOutput,
  stopLoginProcess,
} from "./control";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const URL_WAIT_MS = 20_000;
const STATUS_CACHE_MS = 60_000;

type Pending = {
  id: string;
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
};

let pending: Pending | null = null;
let lastOutcome: { id: string; status: "success" | "error"; message: string } | null = null;
let statusCache: { at: number; data: AuthStatus } | null = null;
let wired = false;
let startChain: Promise<unknown> = Promise.resolve();

function settle(id: string, status: "success" | "error", message: string): boolean {
  if (pending?.id !== id) return false;
  clearTimeout(pending.timer);
  pending.release();
  pending = null;
  lastOutcome = { id, status, message };
  if (status === "success") statusCache = null;
  return true;
}

function wireOnce() {
  if (wired) return;
  wired = true;
  onControlExit((info) => {
    if (!pending) return;
    if (info.code === 0) {
      settle(pending.id, "success", st("routes.providerAuth.completed"));
      return;
    }
    settle(pending.id, "error", st("routes.providerAuth.interrupted"));
  });
}

function authFile(): string {
  return path.join(grokAuthHome(), "auth.json");
}

/**
 * CLI가 찍은 주소와 기기 코드를 꺼낸다.
 * 코드 값은 반환만 하고 로그에 쓰지 않는다.
 */
export function parseDeviceAuthOutput(blob: string): { url: string; userCode: string } | null {
  const urlMatch = blob.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return null;
  const url = urlMatch[0].replace(/[),.;]+$/, "");
  const codeMatch =
    blob.match(/Confirm this code[:\s]+([A-Za-z0-9-]+)/i) ||
    blob.match(/user[_ ]?code[:\s]+([A-Za-z0-9-]+)/i) ||
    blob.match(/\bcode[:\s]+([A-Za-z0-9-]{4,})/i);
  if (!codeMatch?.[1]) return null;
  return { url, userCode: codeMatch[1] };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForDeviceAuth(): Promise<{ url: string; userCode: string }> {
  const t0 = Date.now();
  let parsed = parseDeviceAuthOutput(loginOutput());
  const off = onLoginOutput(() => {
    parsed = parseDeviceAuthOutput(loginOutput()) ?? parsed;
  });
  try {
    while (!parsed && Date.now() - t0 < URL_WAIT_MS) {
      await sleep(50);
      parsed = parseDeviceAuthOutput(loginOutput()) ?? parsed;
    }
  } finally {
    off();
  }
  if (!parsed) throw new Error(st("notice.grok.loginOutputMissing"));
  return parsed;
}

async function doStart(): Promise<LoginStart> {
  wireOnce();
  beginRequest();
  try {
    if (pending) {
      const old = pending.id;
      settle(old, "error", st("routes.providerAuth.replaced"));
      stopLoginProcess();
    }
    const release = holdControl();
    try {
      ensureLoginProcess();
      const creds = await waitForDeviceAuth();
      const loginId = randomUUID();
      const timer = setTimeout(() => settle(loginId, "error", st("routes.providerAuth.expired")), LOGIN_TIMEOUT_MS);
      timer.unref?.();
      pending = { id: loginId, release, timer };
      lastOutcome = null;
      return { mode: "deviceCode", loginId, url: creds.url, userCode: creds.userCode };
    } catch (e) {
      release();
      stopLoginProcess();
      throw new Error(st("notice.grok.loginStartFailed", { error: String((e as Error)?.message ?? e) }));
    }
  } finally {
    endRequest();
  }
}

function readAuthStatus(): AuthStatus {
  const file = authFile();
  try {
    if (!fs.existsSync(file)) return { loggedIn: false };
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const email =
      (typeof j.email === "string" && j.email) ||
      (typeof (j.user as { email?: string } | undefined)?.email === "string" && (j.user as { email: string }).email) ||
      undefined;
    return { loggedIn: true, email };
  } catch (e) {
    void reportError(e, { component: "providers", operation: "provider.grok.auth_status" }); console.error("[aether] grok 인증 상태 조회 실패:", String((e as Error)?.message ?? e));
    return { loggedIn: false };
  }
}

export const grokAuth: ProviderAuth = {
  async status(): Promise<AuthStatus> {
    if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.data;
    const data = readAuthStatus();
    statusCache = { at: Date.now(), data };
    return data;
  },

  start(): Promise<LoginStart> {
    const run = startChain.then(doStart, doStart);
    startChain = run.then(
      () => {},
      () => {},
    );
    return run;
  },

  async poll(loginId: string): Promise<LoginProgress> {
    if (pending?.id === loginId) return { status: "pending" };
    if (lastOutcome?.id === loginId) return { status: lastOutcome.status, message: lastOutcome.message };
    return { status: "error", message: st("routes.providerAuth.unknownLogin") };
  },

  cancel(loginId?: string): void {
    const p = pending;
    if (!p || (loginId && p.id !== loginId)) return;
    stopLoginProcess();
    settle(p.id, "error", st("routes.providerAuth.cancelled"));
  },

  disposeAll(): void {
    if (pending) settle(pending.id, "error", st("routes.providerAuth.interrupted"));
    disposeControl();
  },
};

export function __resetGrokAuthForTest(): void {
  if (pending) {
    clearTimeout(pending.timer);
    pending.release();
    pending = null;
  }
  lastOutcome = null;
  statusCache = null;
  stopLoginProcess();
}

