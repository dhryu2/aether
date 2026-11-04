import { failuresFor } from "../failureTracking";
import { reportError } from "../../observability/report";
import { classifyServiceError } from './errorOrigin';
import { classifyError } from '../../observability/event';
/**
 * grok agent stdio 프로세스 1개와 그 위의 JSON-RPC 2.0 통신 (Phase 10c · D1).
 *
 * Codex `codex/appServer.ts`와 같은 통신선이다. 세션 지식은 없다. 손구현이며 공식 ACP SDK를 넣지 않는다.
 * 캡처한 실메시지 스키마가 정본이다(내부 실측).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { config } from "../../config";
import { findOnPath, resolveLaunch } from "../installed";
import { modelEnv } from "../modelEnv";

const STDERR_KEEP = 8 * 1024;

export type JsonRpcId = number | string;

export const GROK_CLIENT_INFO = { name: "aether", title: "Aether", version: "0.1.0" };

export class GrokRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "GrokRpcError";
    classifyServiceError(this, true);
  }
}

export type GrokNotification = { method: string; params: unknown };
export type GrokServerRequest = { method: string; params: unknown; id: JsonRpcId };
export type GrokExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

export type GrokStdioOptions = {
  /** `grok` 뒤에 붙는 인자. runtime이 `grokAgentArgs()`로 조립한다. */
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  onNotification: (n: GrokNotification) => void;
  onServerRequest: (r: GrokServerRequest) => Promise<unknown>;
  onExit: (info: GrokExitInfo) => void;
};

type Pending = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

let cachedBin: string | null = null;

export function resolveGrokBin(): string {
  if (config.grokBin) return config.grokBin;
  if (cachedBin) return cachedBin;
  const found = findOnPath("grok");
  if (found) return (cachedBin = found);
  // Grok 설치 프로그램의 기본 위치(~/.grok/bin). 서비스의 PATH에 개인 경로를 넣지 않으려고 어댑터가 직접 찾는다.
  const base = path.join(os.homedir(), ".grok", "bin", "grok");
  const own = [...(process.env.PATHEXT ?? "").split(";").filter(Boolean), ""].map((e) => base + e).find((f) => fs.existsSync(f));
  if (own) return (cachedBin = own);
  return "grok"; // 못 찾으면 저장하지 않는다. 설치 직후에 재시작 없이 잡히게 하려는 것이다.
}

export function resetGrokBinCache(): void {
  cachedBin = null;
}

export class GrokStdio {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly opts: GrokStdioOptions;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private nextId = 1;
  private stdoutBuf = "";
  private skipping = false;
  private stderrBuf = "";
  private finished = false;
  private exitInfo: GrokExitInfo | null = null;
  private closePromise: Promise<GrokExitInfo> | null = null;
  private readonly onFinish: Array<(info: GrokExitInfo) => void> = [];
  private droppedLines = 0;
  private malformedLines = 0;

  constructor(opts: GrokStdioOptions) {
    this.opts = opts;
    const launch = resolveLaunch(resolveGrokBin());
    this.proc = spawn(launch.command, [...launch.args, ...opts.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? modelEnv(),
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (e) => this.finish(null, null, `프로세스 오류: ${String(e)}`));
    this.proc.on("exit", (code, signal) => this.finish(code, signal));
    this.proc.on("close", (code, signal) => this.finish(code, signal));
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get alive(): boolean {
    return !this.finished;
  }

  get exit(): GrokExitInfo | null {
    return this.exitInfo;
  }

  get diagnostics(): { droppedLines: number; malformedLines: number } {
    return { droppedLines: this.droppedLines, malformedLines: this.malformedLines };
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = config.grokRequestTimeoutMs): Promise<T> {
    if (this.finished) {
      return Promise.reject(new Error(`grok agent가 이미 종료돼 요청을 보낼 수 없다(${method})${this.exitDetail()}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(classifyError(new Error(`grok 응답 시간 초과(${method}, ${timeoutMs}ms)`), 'external_environment'));
        }, timeoutMs);
        p.timer.unref?.();
      }
      this.pending.set(id, p);
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new Error(`grok agent로 요청을 보내지 못했다(${method})${this.exitDetail()}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): Promise<GrokExitInfo> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<GrokExitInfo>((resolve) => {
      if (this.finished && this.exitInfo) return resolve(this.exitInfo);
      const kill = setTimeout(() => {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* 이미 죽었으면 무해 */
        }
      }, config.grokShutdownGraceMs);
      kill.unref?.();
      this.onFinish.push((info) => {
        clearTimeout(kill);
        resolve(info);
      });
      try {
        this.proc.stdin.end();
      } catch {
        /* 이미 닫혔으면 무해 */
      }
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* 이미 죽었으면 무해 */
      }
    });
    return this.closePromise;
  }

  private exitDetail(): string {
    const s = this.exitInfo?.stderr?.trim();
    return s ? `: ${s.slice(-500)}` : "";
  }

  private send(obj: unknown): boolean {
    if (this.finished) return false;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
      failuresFor(this).clear("provider.transport.send");
      return true;
    } catch (error) {
      failuresFor(this).report(error, { component: "providers", operation: "provider.transport.send", severity: "error" });
      return false;
    }
  }

  private onStderr(chunk: Buffer) {
    this.stderrBuf = (this.stderrBuf + chunk.toString("utf8")).slice(-STDERR_KEEP);
  }

  private onStdout(chunk: Buffer) {
    let s = this.decoder.write(chunk);
    if (this.skipping) {
      const nl = s.indexOf("\n");
      if (nl < 0) return;
      this.skipping = false;
      s = s.slice(nl + 1);
    }
    this.stdoutBuf += s;
    for (;;) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.handleLine(line);
    }
    if (this.stdoutBuf.length > config.grokMaxLineBytes) {
      this.skipping = true;
      this.stdoutBuf = "";
      this.droppedLines++;
      // 같은 통신선에서 반복되는 손실은 콘솔의 누계로 남기고 수집은 최초 한 번만 한다.
      if (this.droppedLines === 1) void reportError(new Error("출력 한 줄이 상한을 넘어 프로토콜 데이터 유실"), {
        component: "provider", operation: "provider.output.drop", severity: "warning", provider: "grok",
      });
      console.error(`[aether] grok 출력 한 줄이 상한(${config.grokMaxLineBytes}바이트)을 넘어 버렸다 — 이벤트 ${this.droppedLines}건 유실.`);
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
      failuresFor(this).clear("provider.message.parse");
    } catch (error) {
      failuresFor(this).report(error, { component: "providers", operation: "provider.message.parse", severity: "warning" });
      this.malformedLines++;
      return;
    }
    if (!msg || typeof msg !== "object") {
      this.malformedLines++;
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = "result" in msg || "error" in msg;
    if (hasId && isResponse) return this.settle(msg.id as JsonRpcId, msg);
    if (hasId && typeof msg.method === "string") return void this.dispatchServerRequest(msg.method, msg.params, msg.id as JsonRpcId);
    if (typeof msg.method === "string") {
      // 알림 처리기의 예외가 표준출력 콜백을 넘어 허브 전체를 끝내지 않게 그 알림 하나만 버린다.
      try {
        this.opts.onNotification({ method: msg.method, params: msg.params });
      } catch (e) {
        failuresFor(this).report(e, { component: "providers", operation: "provider.notification.dispatch", severity: "error" });
      }
      return;
    }
    this.malformedLines++;
  }

  private settle(id: JsonRpcId, msg: Record<string, unknown>) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (err) p.reject(new GrokRpcError(err.code ?? -32603, err.message ?? `grok 오류(${p.method})`, err.data));
    else p.resolve(msg.result);
  }

  private async dispatchServerRequest(method: string, params: unknown, id: JsonRpcId) {
    try {
      const result = await this.opts.onServerRequest({ method, params, id });
      failuresFor(this).clear("provider.request.dispatch");
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      const code = /method not found|처리하지 않는 요청/i.test(message) ? -32601 : -32603;
      if (code !== -32601) failuresFor(this).report(e, { component: "providers", operation: "provider.request.dispatch", severity: "error" });
      this.send({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, extraStderr?: string) {
    if (this.finished) return;
    this.finished = true;
    if (extraStderr) this.stderrBuf = (this.stderrBuf + extraStderr).slice(-STDERR_KEEP);
    const info: GrokExitInfo = { code, signal, stderr: this.stderrBuf };
    this.exitInfo = info;
    const detail = info.stderr.trim() ? `: ${info.stderr.trim().slice(-500)}` : "";
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`grok agent 종료로 요청이 실패했다(${p.method}, code=${code ?? "-"} signal=${signal ?? "-"})${detail}`));
    }
    this.pending.clear();
    for (const fn of this.onFinish.splice(0)) fn(info);
    this.opts.onExit(info);
  }
}
