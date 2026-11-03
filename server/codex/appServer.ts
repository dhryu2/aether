import { failuresFor } from "../providers/failureTracking";
import { reportError } from "../observability/report";
import { classifyServiceError } from '../providers/codex/errorOrigin';
import { classifyError } from '../observability/event';
/**
 * codex app-server 프로세스 1개와 그 위의 JSON-RPC 2.0 통신 (Phase 8e · D1/D4).
 *
 * JSON-RPC 2.0은 "한 줄에 JSON 하나"로 요청·응답·알림을 주고받는 규약이다. codex app-server는 이걸
 * 표준입출력으로 말한다. 이 파일이 책임지는 것은 그 통신선 하나이며, **세션 지식은 하나도 없다** —
 * 스레드도, 턴도, 승인도 모른다. 그 위층은 `sessions/runtimes/codex.ts`(8e 단위 3)가 얹는다.
 *
 * 여기서 지키는 계약:
 *   ① 요청은 반드시 끝난다 — 응답·오류·시간 초과·프로세스 사망 중 하나로 항상 결말이 난다.
 *   ② 서버가 거꾸로 보낸 요청에는 **정확히 한 번** 답한다(승인 왕복이 여기 실린다 — 답이 없으면 모델이 멈춘다).
 *   ③ 깨진 줄 하나가 통신선을 죽이지 않는다(무시하고 다음 줄로).
 *   ④ 한 줄이 상한을 넘으면 버리되 조용히 넘어가지 않는다(로그로 알린다).
 *   ⑤ 프로세스가 죽으면 대기 중인 요청을 전부 실패로 정리한다(좀비 promise 금지).
 *   ⑥ 종료는 멱등이다 — 여러 번 불러도, 이미 죽은 뒤에 불러도 안전하다.
 *
 * 크래시 후 다시 띄우는 판단은 여기서 하지 않는다. 다시 띄우려면 초기화·스레드 이어가기·스킬 경로
 * 재등록을 함께 해야 하는데 그건 전부 세션 지식이라, `onExit`로 알리기만 하고 결정은 호출부에 맡긴다.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { config } from "../config";
import { findOnPath, resolveLaunch } from "../providers/installed";
import { modelEnv } from "../providers/modelEnv";
import type { InitializeResponse } from "./protocol/InitializeResponse";

/** stderr에서 기억해둘 최근 분량(바이트). 프로세스가 죽었을 때 원인을 오류 메시지에 싣는 용도. */
const STDERR_KEEP = 8 * 1024;

export type JsonRpcId = number | string;

/** `initialize`에서 우리를 소개하는 값 — 세션 프로세스와 인증 전용 프로세스가 같은 이름으로 붙는다. */
export const CLIENT_INFO = { name: "aether", title: "Aether", version: "0.1.0" };

/** app-server가 오류로 답한 경우. 코드·데이터를 보존해 호출부가 분기할 수 있게 한다. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
    classifyServiceError(this, true);
  }
}

export type CodexNotification = { method: string; params: unknown };
export type CodexServerRequest = { method: string; params: unknown; id: JsonRpcId };
export type CodexExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

export type AppServerOptions = {
  /** `-c key=value` 형태의 실행별 설정 오버라이드. 전역 `~/.codex/config.toml`은 건드리지 않는다(D8). */
  configOverrides?: readonly string[];
  /**
   * 자식 프로세스 환경변수.
   *
   * 미지정이면 **이 허브의 비밀을 뺀 환경**을 물려준다(R21). 기본값을 `process.env`로 두면 새 호출자가
   * 이 옵션을 잊는 순간 로그인 서명키·푸시 개인키가 모델 셸로 조용히 넘어간다 — 잊었을 때 안전한 쪽이
   * 기본이어야 한다.
   */
  env?: NodeJS.ProcessEnv;
  /** 서버가 보낸 알림(item/*·turn/*·thread/* 등). 순서 그대로 전달된다. */
  onNotification: (n: CodexNotification) => void;
  /**
   * 서버가 거꾸로 보낸 요청(승인·사용자 질문 등). 반환값이 그대로 응답의 result가 된다.
   * 여기서 throw하면 JSON-RPC 오류로 답한다 — 어느 쪽이든 답은 반드시 한 번 나간다.
   */
  onServerRequest: (r: CodexServerRequest) => Promise<unknown>;
  /** 프로세스가 끝났다(정상 종료·크래시·강제 종료 모두). 다시 띄울지는 호출부가 정한다. */
  onExit: (info: CodexExitInfo) => void;
};

type Pending = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

let cachedBin: string | null = null;

/**
 * codex 실행 파일 경로. 설정 override → 저장해 둔 경로 → PATH를 직접 훑은 절대경로 순.
 * launchd로 띄우면 PATH가 최소라 이름만으로는 못 찾을 수 있어 절대경로를 먼저 찾는다.
 * 못 찾으면 이름만 돌려주고 저장하지 않는다. 설치 직후에 재시작 없이 잡히게 하려는 것이다.
 */
export function resolveCodexBin(): string {
  if (config.codexBin) return config.codexBin;
  if (cachedBin) return cachedBin;
  const found = findOnPath("codex");
  if (found) return (cachedBin = found);
  return "codex";
}

export class CodexAppServer {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly opts: AppServerOptions;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private nextId = 1;
  private stdoutBuf = "";
  /** 상한을 넘긴 줄을 버리는 중 — 다음 줄바꿈까지 계속 버린다. */
  private skipping = false;
  private stderrBuf = "";
  private finished = false;
  private exitInfo: CodexExitInfo | null = null;
  private closePromise: Promise<CodexExitInfo> | null = null;
  private readonly onFinish: Array<(info: CodexExitInfo) => void> = [];
  /** 진단용 집계 — 조용한 유실을 남기지 않기 위해 센다. */
  private droppedLines = 0;
  private malformedLines = 0;

  constructor(opts: AppServerOptions) {
    this.opts = opts;
    const args = ["app-server"];
    for (const c of opts.configOverrides ?? []) args.push("-c", c);
    const launch = resolveLaunch(resolveCodexBin());
    this.proc = spawn(launch.command, [...launch.args, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? modelEnv(),
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    // 표준입력이 먼저 닫히는 경우(상대가 죽는 중) write가 EPIPE로 터지는데, 그건 종료 처리에서 이미 다루므로 삼킨다.
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (e) => this.finish(null, null, `프로세스 오류: ${String(e)}`));
    this.proc.on("exit", (code, signal) => this.finish(code, signal));
    this.proc.on("close", (code, signal) => this.finish(code, signal));
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** 아직 살아 있는가. 죽은 뒤의 요청은 즉시 거부된다. */
  get alive(): boolean {
    return !this.finished;
  }

  /** 프로세스가 끝난 사유(아직 살아 있으면 null). */
  get exit(): CodexExitInfo | null {
    return this.exitInfo;
  }

  /** 통신 상태 진단 — 버린 줄·해석 못 한 줄 수. 0이 아니면 어딘가에서 이벤트를 잃었다는 뜻이다. */
  get diagnostics(): { droppedLines: number; malformedLines: number } {
    return { droppedLines: this.droppedLines, malformedLines: this.malformedLines };
  }

  /**
   * 요청 1건. 응답·오류·시간 초과·프로세스 사망 중 하나로 반드시 끝난다.
   * `timeoutMs`에 0을 주면 상한 없이 기다린다(프로세스가 죽으면 그때 정리된다).
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = config.codexRequestTimeoutMs): Promise<T> {
    if (this.finished) {
      return Promise.reject(new Error(`codex app-server가 이미 종료돼 요청을 보낼 수 없다(${method})${this.exitDetail()}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(classifyError(new Error(`codex 응답 시간 초과(${method}, ${timeoutMs}ms)`), 'external_environment'));
        }, timeoutMs);
        p.timer.unref?.(); // 이 대기가 서버 종료를 붙잡지 않게
      }
      this.pending.set(id, p);
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new Error(`codex app-server로 요청을 보내지 못했다(${method})${this.exitDetail()}`));
      }
    });
  }

  /** 알림 1건(응답 없음). */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * 프로토콜 악수 — `initialize` 요청 뒤 `initialized` 알림까지가 한 세트다(8a 실측).
   * `experimentalApi`를 켜는 이유는 사용자 질문 요청(`item/tool/requestUserInput`)이 그 뒤에만 오기 때문이다(D1).
   */
  async initialize(clientInfo: { name: string; title?: string; version: string }): Promise<InitializeResponse> {
    const res = await this.request<InitializeResponse>("initialize", {
      clientInfo,
      capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
    });
    // 이 프로세스가 실제로 쓰는 설정 폴더. 승인 정책 요약이 규칙 파일을 찾을 때 쓴다 — 우리가 환경변수로
    //   짐작하지 않고 상대가 알려준 값을 쓴다(같은 계정이라도 CODEX_HOME이 다를 수 있다).
    this.codexHome = res.codexHome;
    this.notify("initialized");
    return res;
  }

  /** `initialize`가 알려준 $CODEX_HOME. 악수 전에는 비어 있다. */
  codexHome: string | null = null;

  /**
   * 정상 종료 시도 후 필요하면 강제 종료. 멱등이며, 이미 죽었으면 곧바로 끝난다.
   * 반환값은 종료 사유다 — 호출부가 로그에 남길 수 있게 돌려준다.
   */
  close(): Promise<CodexExitInfo> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<CodexExitInfo>((resolve) => {
      if (this.finished && this.exitInfo) return resolve(this.exitInfo);
      const kill = setTimeout(() => {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* 이미 죽었으면 무해 */
        }
      }, config.codexShutdownGraceMs);
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

  // ── 내부 ──

  private exitDetail(): string {
    const s = this.exitInfo?.stderr?.trim();
    return s ? `: ${s.slice(-500)}` : "";
  }

  private send(obj: unknown): boolean {
    if (this.finished) return false;
    try {
      // write가 false를 돌려주는 것은 버퍼가 찼다는 신호일 뿐 실패가 아니다 — 내용은 그대로 큐에 쌓인다.
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
      failuresFor(this).clear("provider.transport.send");
      return true;
    } catch (error) {
      failuresFor(this).report(error, { component: "providers", operation: "provider.transport.send", severity: "error" });
      return false;
    }
  }

  private onStderr(chunk: Buffer) {
    // 읽지 않고 두면 파이프가 차서 상대가 멈춘다. 최근 분량만 남기고 흘려보낸다.
    this.stderrBuf = (this.stderrBuf + chunk.toString("utf8")).slice(-STDERR_KEEP);
  }

  private onStdout(chunk: Buffer) {
    // 청크 경계에서 한글 같은 여러 바이트 글자가 잘릴 수 있어 디코더로 이어 붙인다.
    let s = this.decoder.write(chunk);
    if (this.skipping) {
      // 상한을 넘겨 버리는 중인 줄이 끝날 때까지는 쌓지 않고 흘려보낸다(버퍼가 다시 부푸는 것 방지).
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
    if (this.stdoutBuf.length > config.codexMaxLineBytes) {
      this.skipping = true;
      this.stdoutBuf = "";
      this.droppedLines++;
      // 같은 통신선에서 반복되는 손실은 콘솔의 누계로 남기고 수집은 최초 한 번만 한다.
      if (this.droppedLines === 1) void reportError(new Error("출력 한 줄이 상한을 넘어 프로토콜 데이터 유실"), {
        component: "provider", operation: "provider.output.drop", severity: "warning", provider: "codex",
      });
      console.error(`[aether] codex 출력 한 줄이 상한(${config.codexMaxLineBytes}바이트)을 넘어 버렸다 — 이벤트 ${this.droppedLines}건 유실.`);
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
      return; // 깨진 줄 하나가 통신선을 죽이지 않는다
    }
    if (!msg || typeof msg !== "object") {
      this.malformedLines++;
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = "result" in msg || "error" in msg;
    if (hasId && isResponse) return this.settle(msg.id as JsonRpcId, msg);
    if (hasId && typeof msg.method === "string") return void this.dispatchServerRequest(msg.method, msg.params, msg.id as JsonRpcId);
    if (typeof msg.method === "string") return this.opts.onNotification({ method: msg.method, params: msg.params });
    this.malformedLines++;
  }

  private settle(id: JsonRpcId, msg: Record<string, unknown>) {
    const p = this.pending.get(id);
    if (!p) return; // 이미 시간 초과로 끝났거나 우리가 보낸 적 없는 id — 무시
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (err) p.reject(new CodexRpcError(err.code ?? -32603, err.message ?? `codex 오류(${p.method})`, err.data));
    else p.resolve(msg.result);
  }

  private async dispatchServerRequest(method: string, params: unknown, id: JsonRpcId) {
    try {
      const result = await this.opts.onServerRequest({ method, params, id });
      failuresFor(this).clear("provider.request.dispatch");
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      failuresFor(this).report(e, { component: "providers", operation: "provider.request.dispatch", severity: "error" });
      // 답을 안 보내면 모델이 그 자리에서 멈춘다 — 실패도 반드시 응답으로 돌려준다.
      this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error)?.message ?? e) } });
    }
  }

  /** 종료를 한 번만 확정한다(error·exit·close 중 먼저 온 것). */
  private finish(code: number | null, signal: NodeJS.Signals | null, extraStderr?: string) {
    if (this.finished) return;
    this.finished = true;
    if (extraStderr) this.stderrBuf = (this.stderrBuf + extraStderr).slice(-STDERR_KEEP);
    const info: CodexExitInfo = { code, signal, stderr: this.stderrBuf };
    this.exitInfo = info;
    const detail = info.stderr.trim() ? `: ${info.stderr.trim().slice(-500)}` : "";
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`codex app-server 종료로 요청이 실패했다(${p.method}, code=${code ?? "-"} signal=${signal ?? "-"})${detail}`));
    }
    this.pending.clear();
    for (const fn of this.onFinish.splice(0)) fn(info);
    this.opts.onExit(info);
  }
}
