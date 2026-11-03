import { reportError } from "../../observability/report";
/**
 * Grok 로그인 제어 프로세스 (Phase 10d · D13).
 *
 * Codex 제어 프로세스와 같은 수명 규칙을 따른다. 다른 점은 통로다. Grok 기기코드는 ACP가 아니라
 * `grok login --device-auth` CLI다. 대화 세션(`grok agent stdio`)을 만들지 않는다.
 *
 *   - 뜨는 때: 로그인 시작. 상태 조회는 인증 파일만 읽으므로 프로세스를 안 띄운다.
 *   - 내려가는 때: 마지막 요청 이후 `grokControlIdleMs` 동안 붙잡은 것이 없을 때.
 *     로그인이 진행 중이면 안 내려간다.
 *   - 역방향 JSON-RPC: 이 CLI는 ACP가 아니라 승인 요청이 오면 안 된다. 표준출력에 JSON-RPC
 *     요청 모양이 보이면 오류로 마감한다(빈 성공 금지).
 */
import { config } from "../../config";
import type { ChildProcess } from "node:child_process";
import { spawnGrokCli } from "./env";

export type GrokLoginExit = { code: number | null; signal: NodeJS.Signals | null };

type ExitListener = (info: GrokLoginExit) => void;
type OutputListener = (chunk: string) => void;

const exitListeners = new Set<ExitListener>();
const outputListeners = new Set<OutputListener>();

let child: ChildProcess | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let holds = 0;
let inFlight = 0;
let epoch = 0;
let stdoutBuf = "";

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function idle(): boolean {
  return holds === 0 && inFlight === 0;
}

function armIdle() {
  clearIdle();
  if (!idle() || !child) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!idle() || !child) return;
    const p = child;
    child = null;
    killProc(p);
  }, config.grokControlIdleMs);
  idleTimer.unref?.();
}

function killProc(p: ChildProcess) {
  try {
    if (p.pid) process.kill(-p.pid, "SIGTERM");
  } catch {
    /* 이미 죽었거나 그룹이 없음 */
  }
  try {
    p.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function emitOutput(s: string) {
  for (const l of [...outputListeners]) {
    try {
      l(s);
    } catch (e) {
      void reportError(e, { component: "providers", operation: "provider.grok.login_output" }); console.error("[aether] Grok 로그인 출력 처리 실패:", e);
    }
  }
}

function looksLikeJsonRpcRequest(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{")) return false;
  try {
    const j = JSON.parse(t) as { method?: unknown; jsonrpc?: unknown };
    return j.jsonrpc === "2.0" && typeof j.method === "string";
  } catch {
    // 일반 출력과 JSON RPC 요청을 구분하는 정상 탐지다.
    return false;
  }
}

/** 로그인 CLI를 띄운다. 이미 떠 있으면 그것을 쓴다. */
export function ensureLoginProcess(): ChildProcess {
  if (child && !child.killed) return child;
  const myEpoch = epoch;
  stdoutBuf = "";
  const p = spawnGrokCli(["login", "--device-auth"], undefined, { detached: true });
  child = p;
  const grab = (d: Buffer) => {
    if (child !== p) return;
    const s = String(d);
    stdoutBuf += s;
    if (stdoutBuf.length > 32 * 1024) stdoutBuf = stdoutBuf.slice(-16 * 1024);
    for (const line of s.split(/\r?\n/)) {
      if (looksLikeJsonRpcRequest(line)) {
        const err = new Error(`인증 전용 Grok 프로세스는 역방향 요청을 받지 않는다(${line.slice(0, 80)})`);
        void reportError(err, { component: "provider", operation: "provider.auth.protocol", provider: "grok" });
        console.error("[aether]", err.message);
        settleExit(p, { code: 1, signal: null });
        killProc(p);
        return;
      }
    }
    emitOutput(s);
  };
  p.stdout?.on("data", grab);
  p.stderr?.on("data", grab);
  p.on("error", (e) => {
    void reportError(e, { component: "provider", operation: "provider.auth.process", provider: "grok" });
    console.error("[aether] Grok 로그인 프로세스 오류:", String((e as Error)?.message ?? e));
    settleExit(p, { code: 1, signal: null });
  });
  p.on("exit", (code, signal) => settleExit(p, { code, signal }));
  if (epoch !== myEpoch) {
    killProc(p);
    throw new Error("인증 전용 Grok 프로세스가 종료 중이라 요청을 취소했다");
  }
  return p;
}

function settleExit(p: ChildProcess, info: GrokLoginExit) {
  if (child !== p) return;
  child = null;
  for (const l of [...exitListeners]) {
    try {
      l(info);
    } catch (e) {
      void reportError(e, { component: "providers", operation: "provider.grok.auth_exit" }); console.error("[aether] Grok 인증 프로세스 종료 처리 실패:", e);
    }
  }
}

/** 지금까지 모은 표준출력·표준에러. 코드는 호출자가 파싱하고 로그에 남기지 않는다. */
export function loginOutput(): string {
  return stdoutBuf;
}

export function onLoginOutput(cb: OutputListener): () => void {
  outputListeners.add(cb);
  return () => outputListeners.delete(cb);
}

export function onControlExit(cb: ExitListener): () => void {
  exitListeners.add(cb);
  return () => exitListeners.delete(cb);
}

export function beginRequest(): void {
  inFlight++;
  clearIdle();
}

export function endRequest(): void {
  inFlight = Math.max(0, inFlight - 1);
  armIdle();
}

export function holdControl(): () => void {
  holds++;
  clearIdle();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    armIdle();
  };
}

export function controlAlive(): boolean {
  return !!child && !child.killed;
}

/** 지금 쓰는 로그인 프로세스를 내린다. 일부러 내린 종료는 크래시로 방송하지 않는다. */
export function stopLoginProcess(): void {
  const p = child;
  child = null;
  clearIdle();
  if (p) killProc(p);
}

export function disposeControl(): void {
  epoch++;
  holds = 0;
  inFlight = 0;
  clearIdle();
  const p = child;
  child = null;
  if (p) killProc(p);
}
