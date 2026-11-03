import { FailureTracker } from "../providers/failureTracking";
import { reportError } from "../observability/report";
/**
 * Claude 구독 OAuth 원격 재인증 중계 — PTY 로그인 매니저.
 *
 * 흐름: start() → claude auth login을 PTY로 띄워 authorize URL 캡처 → (사용자가 폰에서 로그인 후 코드 회신)
 *       → submitCode()로 PTY stdin에 코드 주입 → "Login successful" → 새 creds가 macOS Keychain에 기록.
 *
 * ⚠️ 스파이크로 확정된 함정 대응:
 *   - macOS `script`는 파이프 stdin 불가 → node-pty 필수.
 *   - node-pty는 claude **절대경로** 필요(launchd PATH에 ~/.local/bin 없음) → resolveClaudeBin.
 *   - node-pty prebuilt spawn-helper가 설치 시 exec 비트 유실 → ensureSpawnHelperExecutable로 chmod +x.
 *   - 새 creds는 파일이 아니라 **Keychain**에 써지고, launchd aether의 새 query()가 그걸 읽어 동작(검증됨).
 *
 * 보안: 이 통로는 구독 마스터 자격증명을 발급한다. 단, OAuth 완료엔 *사용자의 claude.com 로그인*이 필요하므로
 *       엔드포인트를 쳐도 creds를 훔칠 수 없다(실질 위험 = 프로세스 남발 DoS → 동시 1개 + 타임아웃으로 차단).
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as NodePty from "node-pty";
import type { IPty } from "node-pty";
import { config } from "../config";
import { findOnPath, resolveExecutablePath, resolveLaunch } from "../providers/installed";
import { extractAuthUrl, classifyLoginOutput } from "./loginParse";
import { st } from "../i18n";
import { modelEnv } from "../providers/modelEnv";
import type { LoginProgress, LoginStart } from "../providers/types";

const failures = new FailureTracker();

/** node-pty는 로그인을 시작할 때만 불러온다. 부팅 때 싣지 않으므로 모듈이 없어도 서버는 뜬다. */
let ptyLoading: Promise<{ default: typeof NodePty }> | undefined;
async function loadPty() {
  ptyLoading ??= import("node-pty");
  try {
    // CJS 모듈이라 로더에 따라 spawn이 default 아래에 있거나 최상위에 있다. 둘 다 받는다.
    const mod = await ptyLoading;
    return mod.default ?? mod;
  } catch (cause) {
    ptyLoading = undefined; // 다음 시도가 다시 불러오게 비운다.
    failures.report(cause, { component: "auth", operation: "auth.pty.load", severity: "warning" });
    throw new Error(st("routes.claudeAuth.ptyUnavailable"), { cause });
  }
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 전체 로그인 수명 상한(OAuth 코드 유효창과 결 맞춤)
const URL_WAIT_MS = 20_000; // spawn 후 URL 캡처 대기
const CODE_WAIT_MS = 30_000; // 코드 주입 후 결과 대기
const BUFFER_CAP = 32 * 1024; // PTY 버퍼 상한(디스크 영속 안 함 — 메모리만)

type Phase = "starting" | "awaiting_code" | "exchanging" | "success" | "error";
type AuthStatus = { loggedIn: boolean; email?: string; subscriptionType?: string };

interface LoginState {
  id: string;
  phase: Phase;
  url?: string;
  term: IPty;
  buffer: string;
  exited: boolean;
  timer: ReturnType<typeof setTimeout>;
}

let active: LoginState | null = null; // 단일 사용자 허브 → 동시 1개만
let cachedBin: string | null = null;
let helperFixed = false;
let statusCache: { at: number; data: AuthStatus } | null = null;
/**
 * 방금 끝난 로그인의 결말(8f) — `poll`이 답할 거리를 남긴다.
 *
 * 성공·실패 시 `dispose()`가 진행 상태를 지우므로, 그것만으로는 나중에 물어본 클라이언트에게 "그런 로그인
 * 없음"밖에 답할 수 없다. 코드 제출 방식에선 제출 응답으로 이미 결말을 알지만, 화면이 그 응답을 놓친
 * 경우(전환·새로고침)를 위해 마지막 하나는 기억해 둔다.
 */
let lastOutcome: { id: string; status: "success" | "error"; message: string } | null = null;

/** claude 절대경로 — env override → 저장해 둔 경로 → PATH → ~/.local/bin/claude → "claude". 못 찾으면 저장하지 않아 설치 직후에도 잡힌다. */
export function resolveClaudeBin(): string {
  return resolveExecutablePath(findClaudeBin());
}

function findClaudeBin(): string {
  if (config.claudeBin) return config.claudeBin;
  if (cachedBin) return cachedBin;
  const found = findOnPath("claude");
  if (found) return (cachedBin = found);
  const base = path.join(os.homedir(), ".local/bin/claude");
  // 윈도우는 확장자가 붙은 실행 파일(.exe/.cmd)을 먼저 본다(PATHEXT, findOnPath와 같은 규칙).
  const cand = [...(process.env.PATHEXT ?? "").split(";").filter(Boolean), ""].map((e) => base + e).find((f) => fs.existsSync(f));
  if (cand) return (cachedBin = cand);
  return "claude";
}

/**
 * 로그인/status 서브프로세스 env — PATH에 ~/.local/bin 보강 + 자동 브라우저 오픈 억제 시도.
 * 이 허브의 비밀 변수는 여기서도 뺀다(R21) — 이 프로세스는 모델을 돌리지 않지만 같은 CLI라 규율을 맞춘다.
 */
function loginEnv(): Record<string, string> {
  const home = os.homedir();
  const extra = home ? `${path.join(home, ".local/bin")}${path.delimiter}` : "";
  return modelEnv({ BROWSER: "true", PATH: extra + (process.env.PATH ?? "") }) as Record<string, string>;
}

/** `claude auth status` 1회 조회(캐시 없음). 판정 불가(프로세스 오류/타임아웃/파싱실패)면 null. */
function probeAuthStatus(): AuthStatus | null {
  try {
    const launch = resolveLaunch(findClaudeBin());
    const out = execFileSync(launch.command, [...launch.args, "auth", "status"], { encoding: "utf8", timeout: 12_000, env: loginEnv() });
    const j = JSON.parse(out) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    failures.clear("auth.status.probe");
    return { loggedIn: !!j.loggedIn, email: j.email, subscriptionType: j.subscriptionType };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number; killed?: boolean };
    // auth status의 미인증 종료와 응답 지연은 정상 미확인 상태다.
    if (e.status !== 1 && !e.killed && e.code !== "ETIMEDOUT") failures.report(error, { component: "auth", operation: "auth.status.probe", severity: "warning" });
    return null;
  }
}

/** node-pty prebuilt spawn-helper가 npm 추출 시 exec 비트를 잃는 경우 → 첫 사용 전 1회 교정(스파이크 검증). */
function ensureSpawnHelperExecutable(): void {
  if (helperFixed) return;
  helperFixed = true;
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
    const candidates: string[] = [path.join(pkgDir, "build", "Release", "spawn-helper")];
    const prebuilds = path.join(pkgDir, "prebuilds");
    if (fs.existsSync(prebuilds)) {
      for (const d of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, d, "spawn-helper"));
    }
    for (const h of candidates) {
      try {
        if (fs.existsSync(h) && !(fs.statSync(h).mode & 0o111)) fs.chmodSync(h, 0o755);
      } catch (error) {
        failures.file(error, { component: "auth", operation: "auth.spawn_helper.chmod" }, h);
        /* per-file 무시 */
      }
    }
  } catch (e) {
    void reportError(e, { component: "provider", operation: "provider.auth.helper" });
    console.error("[aether] spawn-helper chmod 가드 실패:", e);
  }
}

function dispose(s: LoginState): void {
  clearTimeout(s.timer);
  try {
    s.term.kill();
  } catch {
    /* 이미 죽음 */
  }
  if (active === s) active = null;
  // 결말을 아직 안 적었으면 여기서 적는다(시간 초과·취소·중도 실패). 안 적으면 `poll`이 이 로그인을
  //   "모르는 것"으로 답해, 화면이 왜 끝났는지 모른 채 계속 기다린다.
  if (lastOutcome?.id !== s.id) lastOutcome = { id: s.id, status: "error", message: st("routes.claudeAuth.noActiveSession") };
}

/** probe가 non-null이 되거나(성공) 프로세스 종료/타임아웃이면(null) resolve. 폴링 200ms. */
function waitFor<T>(s: LoginState, probe: () => T | null, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = probe();
      if (v != null) return resolve(v);
      if (s.exited) return resolve(null);
      if (Date.now() - start >= ms) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

export const claudeLogin = {
  /** 로그인 시작 — PTY spawn + authorize URL 캡처. 진행 중 세션이 있으면 교체. */
  async start(): Promise<LoginStart> {
    if (active) dispose(active);
    const pty = await loadPty();
    ensureSpawnHelperExecutable();
    const term = pty.spawn(resolveClaudeBin(), ["auth", "login"], {
      name: "xterm-256color",
      cols: 220, // 넓게 → URL 줄바꿈 방지
      rows: 40,
      env: loginEnv(),
    });
    const s: LoginState = {
      id: randomUUID(),
      phase: "starting",
      term,
      buffer: "",
      exited: false,
      timer: setTimeout(() => dispose(s), LOGIN_TIMEOUT_MS),
    };
    active = s;
    term.onData((d) => {
      s.buffer += d;
      if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(-BUFFER_CAP);
      if (!s.url) {
        const u = extractAuthUrl(s.buffer);
        if (u) s.url = u;
      }
    });
    term.onExit(() => {
      s.exited = true;
    });

    const url = await waitFor(s, () => s.url ?? null, URL_WAIT_MS);
    if (!url) {
      dispose(s);
      throw new Error(st("routes.claudeAuth.urlFetchFailed"));
    }
    s.phase = "awaiting_code";
    lastOutcome = null; // 새 로그인이 시작됐으므로 이전 결말은 더 이상 답이 아니다
    return { mode: "submitCode", loginId: s.id, url };
  },

  /** 코드 주입 → 결과. invalid_code는 awaiting_code 유지(재시도 허용). */
  async submitCode(loginId: string, code: string): Promise<{ status: "success" | "invalid_code" | "error"; message: string }> {
    const s = active;
    if (!s || s.id !== loginId) throw new Error(st("routes.claudeAuth.noActiveSession"));
    if (s.phase !== "awaiting_code") throw new Error(st("routes.claudeAuth.notAwaitingCode"));
    s.phase = "exchanging";
    s.buffer = ""; // 이전 시도 출력 비움(재시도 시 stale 마커 오판 방지). URL은 이미 s.url에 보관.
    s.term.write(code.trim() + "\r");
    const outcome = await waitFor(s, () => classifyLoginOutput(s.buffer), CODE_WAIT_MS);
    if (outcome === "success") {
      s.phase = "success";
      statusCache = null; // 재인증됨 → status 캐시 무효화
      dispose(s);
      // 가드: 정말 loggedIn인지 재확인 — launchd-spawn의 Keychain *쓰기*가 조용히 실패하는 경우를 검출.
      //   판정 불가(null)면 marker("Login successful")를 신뢰(false-negative 차단). 명시적 loggedIn:false만 다운그레이드.
      const probe = probeAuthStatus();
      if (probe && probe.loggedIn === false) {
        const message = st("routes.claudeAuth.verifyFailed");
        lastOutcome = { id: s.id, status: "error", message };
        return { status: "error", message };
      }
      const message = st("routes.claudeAuth.success");
      lastOutcome = { id: s.id, status: "success", message };
      return { status: "success", message };
    }
    if (outcome === "invalid_code") {
      s.phase = "awaiting_code"; // 재시도 허용(프로세스 생존·재프롬프트 — 스파이크 확인)
      return { status: "invalid_code", message: st("routes.claudeAuth.invalidCode") };
    }
    s.phase = "error";
    dispose(s);
    const message = st("routes.claudeAuth.exchangeFailed");
    lastOutcome = { id: s.id, status: "error", message };
    return { status: "error", message };
  },

  /**
   * 이 로그인이 끝났는가(8f 계약). 코드 제출 방식은 제출 응답으로 이미 결말을 알지만, 화면이 그 응답을
   * 놓쳤거나 PTY가 시간 초과로 죽은 경우를 이 통로로 알아챈다.
   */
  async poll(loginId: string): Promise<LoginProgress> {
    if (active && active.id === loginId) return { status: "pending" };
    if (lastOutcome?.id === loginId) return { status: lastOutcome.status, message: lastOutcome.message };
    return { status: "error", message: st("routes.claudeAuth.noActiveSession") };
  },

  cancel(loginId?: string): void {
    if (active && (!loginId || active.id === loginId)) dispose(active);
  },

  /** 서버 종료 시 활성 로그인 정리(좀비 PTY 방지). */
  disposeAll(): void {
    if (active) dispose(active);
  },

  /** `claude auth status`(60s 캐시) → 인증 유효성. UI 표시·재인증 후 가드용. */
  async status(): Promise<AuthStatus> {
    if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.data;
    const data = probeAuthStatus() ?? { loggedIn: false }; // 판정 불가 → 미로그인 취급(UI는 재인증 유도)
    statusCache = { at: Date.now(), data };
    return data;
  },
};
