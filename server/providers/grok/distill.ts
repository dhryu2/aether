import { classifyServiceError } from './errorOrigin';
import { classifyError } from '../../observability/event';
import { reportError } from "../../observability/report";
/**
 * Grok 배경 작업 — 도구를 못 쓰는 격리 실행기 (Phase 10d · D6).
 *
 * 대화 런타임은 ACP다. 배경 작업만 `grok -p`다. `--disallowed-tools`는 헤드리스 전용이고
 * `grok agent stdio`에는 무효다(10a S12 — ACP에 같은 플래그를 넣으면 셸이 남아 SECRET이 샜다).
 *
 * 격리:
 *   1. 임시 GROK_HOME에 auth.json만 0600 복제. 사용자 config/MCP/플러그인 미상속.
 *   2. GROK_MEMORY=0, 관측 끄기(D14).
 *   3. 도구는 todo_write만 허용. 셸·읽기·웹·하위 에이전트는 플래그로 제거.
 *
 * 실패·타임아웃·빈 글은 throw한다. 빈 성공으로 치면 그 대화 구간의 기억이 영구히 유실된다.
 *
 * 모델(배경 작업 모델 측정 계획 8절·D13): 옵션이 없으면 운영자가 못 박은 이름, 없으면 공통 고르기(`resolveAndApply`),
 * 그래도 못 정하면 `-m`을 넘기지 않는다(계정 기본 모델). 예전 고정값 `grok-4.5`는 2026-10-15 실측에서 CLI가 `unknown model id`로 거부했다.
 * 계정 기본이면 `-m`을 넘기지 않는다. 명시면 `-m`과 `--reasoning-effort`를 넘기고, 거부되면
 * `UnknownModelNameError`를 던진다. 거부 신호는 종료 코드 1과 출력의 `unknown model id`다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config";
import { st } from "../../i18n";
import { UnknownModelNameError, pinnedModel, resolveAndApply } from "../distillModel";
import type { DistillOptions, ProviderUsage, RuntimeModel } from "../types";
import { usageFromGrokBilling } from "./billingUsage";
import { grokAgentArgs } from "./args";
import { grokAuthHome, grokChildEnv, spawnGrokCli } from "./env";
import { readGrokModels } from "./models";
import { GROK_CLIENT_INFO, GrokRpcError, GrokStdio } from "./transport";

/** 10a S12 정본. 테스트가 글자 단위로 대조한다. */
export const DISTILL_DISALLOWED_TOOLS =
  "run_terminal_cmd,run_terminal_command,search_replace,web_search,web_fetch,read_file,list_dir,grep,Agent";

const DANGEROUS_TOOLS = new Set([
  "run_terminal_cmd",
  "run_terminal_command",
  "search_replace",
  "web_search",
  "web_fetch",
  "read_file",
  "list_dir",
  "grep",
  "Agent",
]);

/**
 * 글만 뽑는 실행에서 시도로 세지 않는 이름.
 * `todo_write`는 허용 도구. `search_tool`/`use_tool`은 10a S12에서 목록에 남을 수 있다고 확인한 메타 도구다.
 * 셸·읽기·웹·Agent는 여기 넣지 않는다.
 */
export const HARMLESS_TOOL_NAMES: ReadonlySet<string> = new Set(["todo_write", "search_tool", "use_tool"]);

export type DistillObservation = {
  text: string;
  toolAttempts: string[];
  /** 격리 홈에 있던 파일 이름. 정상이면 auth.json 하나. */
  homeEntries: string[];
  /** 관측 자체가 실패했으면 사유. 값이 있으면 위 목록은 "깨끗함"이 아니라 "모름"이다. */
  observeFailed: string | null;
  exitCode: number | null;
  externalFailure?: boolean;
  /** CLI가 지정한 모델을 모른다고 거부했다. */
  unknownModel: boolean;
};

/** CLI의 "모르는 모델" 거부 문구(2026-10-15 실측: `Couldn't set model '…': Invalid params: "unknown model id"`). */
const UNKNOWN_MODEL_RE = /unknown model id/i;

export function makeIsolatedGrokHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grok-distill-home-"));
  fs.chmodSync(dir, 0o700);
  try {
    const source = path.join(grokAuthHome(), "auth.json");
    if (!fs.existsSync(source)) throw classifyError(new Error(st('notice.grok.distillNoAuth')), 'external_environment');
    const target = path.join(dir, "auth.json");
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    return dir;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** 이번 실행의 모델과 effort. 모델이 undefined면 `-m`을 넘기지 않는다(계정 기본 모델). */
function distillChoice(opts: DistillOptions): { model?: string; effort?: string } {
  if (opts?.use === "explicit") return { model: opts.model, effort: opts.effort };
  if (opts?.use === "account_default") return {};
  return { model: pinnedModel("grok") };
}

export function distillArgv(prompt: string, model: string | undefined, cwd: string, effort?: string): string[] {
  return [
    "-p",
    prompt,
    ...(model ? ["-m", model] : []),
    ...(effort ? ["--reasoning-effort", effort] : []),
    "--cwd",
    cwd,
    "--output-format",
    "streaming-json",
    "--tools",
    "todo_write",
    "--disallowed-tools",
    DISTILL_DISALLOWED_TOOLS,
    "--no-subagents",
    "--disable-web-search",
    "--always-approve",
    "--max-turns",
    "4",
  ];
}

function listHome(dir: string): { entries: string[]; failed: string | null } {
  try {
    return { entries: fs.readdirSync(dir), failed: null };
  } catch (e) {
    return { entries: [], failed: String((e as Error)?.message ?? e) };
  }
}

function toolNameOf(j: Record<string, unknown>): string {
  return String(j.toolName ?? j.title ?? j.name ?? "");
}

function isToolCallLine(line: string, j: Record<string, unknown> | null): boolean {
  if (/"type"\s*:\s*"tool_call"/.test(line)) return true;
  const t = j?.type ?? j?.sessionUpdate;
  return t === "tool_call";
}

/** streaming-json 줄에서 본문과 도구 시도를 가른다. 파싱 실패는 도구 0건이 아니라 관측 실패다. */
export function parseDistillStream(blob: string): { text: string; toolAttempts: string[]; parseFailed: boolean } {
  const toolAttempts: string[] = [];
  const texts: string[] = [];
  let parseFailed = false;
  for (const line of blob.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      try {
        const j = JSON.parse(t) as Record<string, unknown>;
        if (isToolCallLine(t, j)) {
          const name = toolNameOf(j);
          if (name && !HARMLESS_TOOL_NAMES.has(name)) toolAttempts.push(name);
          else if (!name && DANGEROUS_TOOLS.has(String(j.toolName ?? ""))) toolAttempts.push(String(j.toolName));
          continue;
        }
        const kind = String(j.type ?? "");
        // 10a S12 실측: 본문은 `{type:"text", data:"…"}` 조각이다. thought는 답이 아니다.
        if (kind === "text" && typeof j.data === "string") {
          texts.push(j.data);
          continue;
        }
        if (kind === "thought" || kind === "available_commands" || kind === "usage" || kind === "end") continue;
        if (typeof j.result === "string") texts.push(j.result);
        else if (typeof j.text === "string") texts.push(j.text);
        else if (typeof j.message === "string") texts.push(j.message);
        const content = j.content;
        if (content && typeof content === "object" && !Array.isArray(content) && typeof (content as { text?: string }).text === "string") {
          texts.push((content as { text: string }).text);
        }
      } catch {
        parseFailed = true;
      }
      continue;
    }
    // streaming-json이 아닌 줄(Node FORCE_COLOR 경고 등)은 본문이 아니다.
  }
  return { text: texts.join(""), toolAttempts, parseFailed };
}

/**
 * 옵션이 없을 때 쓸 모델을 공통 고르기로 정한다.
 * 못 고르면(목록 조회 실패·답 없음) undefined — 호출자는 운영자 고정값, 없으면 `-m` 없이 계정 기본 모델로 진행한다.
 * 운영자 고정값도 `resolveAndApply`가 먼저 시도한다(다른 provider와 같은 동작).
 * 비용: 목록 조회가 배경 작업마다 `grok agent stdio` 프로세스를 한 번 더 띄운다(실측 약 1초).
 */
async function autoPickOpts(cwd: string): Promise<DistillOptions> {
  try {
    const models = await listGrokBackgroundModels();
    const names = new Set(models.map((m) => m.value));
    const picked = await resolveAndApply(
      "grok",
      models,
      async (m) => { if (!names.has(m)) throw classifyError(new UnknownModelNameError(m), "external_environment"); },
      (p) => runGrokDistill(p, cwd, { use: "account_default" }),
      (model, p) => runGrokDistill(p, cwd, { use: "explicit", model }),
    );
    return picked ? { use: "explicit", model: picked } : undefined;
  } catch (e) {
    void reportError(e, { component: "providers", operation: "provider.grok.distill_pick", severity: "warning" });
    console.error("[aether] Grok 배경 작업 모델 고르기 실패 — 계정 기본 모델로 진행한다:", e);
    return undefined;
  }
}

export async function runGrokDistill(prompt: string, cwd: string, opts?: DistillOptions): Promise<string> {
  if (opts === undefined) opts = await autoPickOpts(cwd);
  const o = await runGrokDistillObserved(prompt, cwd, opts);
  if (o.toolAttempts.length || o.homeEntries.some((n) => n !== "auth.json") || o.observeFailed) {
    void reportError(new Error("배경 작업 도구 격리 실패 또는 확인 불가"), { component: "provider", operation: "provider.distill.isolation", provider: "grok" });
    console.error(
      "[aether] ⚠️ Grok 배경 작업의 도구 격리가 깨졌거나 확인되지 않았다 — 즉시 확인 필요:",
      JSON.stringify({
        toolAttempts: o.toolAttempts,
        homeEntries: o.homeEntries,
        observeFailed: o.observeFailed,
      }),
    );
  }
  // 명시한 칸이 거부되면 다른 모델로 넘어가지 않고 그대로 알린다(측정하려는 칸이 조용히 바뀌면 안 된다).
  if (o.unknownModel && opts?.use === "explicit") throw classifyError(new UnknownModelNameError(opts.model), "external_environment");
  if (o.exitCode !== 0) {
    const error = new Error(st('notice.grok.distillFailed', { code: String(o.exitCode) }));
    if (o.externalFailure && !o.observeFailed && !o.toolAttempts.length) classifyError(error, 'external_environment');
    throw error;
  }
  if (!o.text.trim()) throw new Error(st("notice.grok.distillEmpty"));
  return o.text;
}

export async function runGrokDistillObserved(prompt: string, _cwd: string, opts?: DistillOptions): Promise<DistillObservation> {
  let grokHome: string | null = null;
  let emptyCwd: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let proc: ReturnType<typeof spawnGrokCli> | null = null;

  try {
    grokHome = makeIsolatedGrokHome();
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grok-distill-cwd-"));
    const { model, effort } = distillChoice(opts);
    const args = distillArgv(prompt, model, emptyCwd, effort);
    proc = spawnGrokCli(args, { GROK_HOME: grokHome });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += String(d);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += String(d);
    });

    const exit = new Promise<number | null>((resolve, reject) => {
      proc!.on("error", reject);
      proc!.on("exit", (code) => resolve(code));
    });

    timer = setTimeout(() => {
      timedOut = true;
      console.error(`[aether] Grok 배경 작업이 ${config.distillTimeoutMs}ms를 넘겨 중단한다`);
      try {
        proc?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, config.distillTimeoutMs);
    timer.unref?.();

    let code: number | null;
    try {
      code = await exit;
    } catch {
      throw timedOut ? classifyError(new Error(st('notice.grok.distillTimeout', { ms: String(config.distillTimeoutMs) })), 'external_environment') : new Error(st('notice.grok.distillProcessGone'));
    }

    const listed = grokHome ? listHome(grokHome) : { entries: [] as string[], failed: "no-home" };
    const parsed = parseDistillStream(stdout + "\n" + stderr);
    const observeFailed = listed.failed ?? (parsed.parseFailed ? "stream-parse" : null);

    if (timedOut) throw classifyError(new Error(st('notice.grok.distillTimeout', { ms: String(config.distillTimeoutMs) })), 'external_environment');
    if (code === null) throw new Error(st("notice.grok.distillProcessGone"));
    const text = parsed.text.trim();

    return {
      text,
      toolAttempts: parsed.toolAttempts,
      homeEntries: listed.entries,
      observeFailed,
      exitCode: code,
      externalFailure: 'errorOrigin' in classifyServiceError(new Error(stderr), true),
      unknownModel: code !== 0 && UNKNOWN_MODEL_RE.test(stdout + "\n" + stderr),
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      proc?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    if (grokHome) removeTempDir(grokHome);
    if (emptyCwd) removeTempDir(emptyCwd);
  }
}

/**
 * 턴을 쓰지 않는 모델 목록 조회 — 배경 작업 측정용.
 * 격리 홈(인증 파일만 복사)으로 `grok agent stdio`를 띄우고 ACP `initialize`만 보낸다. 세션도 턴도 열지 않는다.
 * 2026-10-15 실측: 약 1초 만에 모델과 effort 목록이 왔다.
 */
export async function listGrokBackgroundModels(): Promise<RuntimeModel[]> {
  let grokHome: string | null = null;
  let stdio: GrokStdio | null = null;
  try {
    grokHome = makeIsolatedGrokHome();
    stdio = new GrokStdio({
      args: grokAgentArgs({ permissionMode: "manual" }),
      env: grokChildEnv({ GROK_HOME: grokHome }),
      onNotification: () => {},
      onServerRequest: async (r) => {
        throw new Error(`배경 작업 목록 조회는 역방향 요청을 받지 않는다(${r.method})`);
      },
      onExit: () => {},
    });
    const init = await stdio.request<Record<string, unknown>>(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: GROK_CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      config.distillTimeoutMs,
    );
    return readGrokModels(init);
  } finally {
    await stdio?.close().catch(() => { /* 목록 조회 뒤 이미 닫힌 통신선을 다시 닫아도 무해하다. */ });
    if (grokHome) removeTempDir(grokHome);
  }
}

/**
 * 세션 없이 계정 한도를 읽는다. 프롬프트를 보내지 않으므로 모델을 부르지 않는다.
 * 인증 파일을 복제하면 토큰 갱신이 원본과 어긋날 수 있어 대화 세션과 같은 설정 폴더로 띄운다.
 */
export async function readGrokAccountUsage(timeoutMs: number): Promise<ProviderUsage> {
  let stdio: GrokStdio | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    stdio = new GrokStdio({
      args: grokAgentArgs({ permissionMode: "manual" }),
      env: grokChildEnv(),
      onNotification: () => {},
      onServerRequest: async (r) => {
        throw new Error(`사용량 조회는 역방향 요청을 받지 않는다(${r.method})`);
      },
      onExit: () => {},
    });
    // 상한은 두 요청 합쳐 하나다. 닫으면 기다리던 요청이 실패로 끝난다.
    const owned = stdio;
    timer = setTimeout(() => void owned.close(), timeoutMs);
    timer.unref?.();
    await stdio.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: GROK_CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      timeoutMs,
    );
    return usageFromGrokBilling(await stdio.request("_x.ai/billing", {}, timeoutMs));
  } catch (error) {
    // 청구 조회를 지원하지 않는 버전은 정상 기능 탐지다. 대화 세션의 사용량 조회와 같게 다룬다.
    if (error instanceof GrokRpcError && error.code === -32601) return { windowsAvailable: false, windows: [] };
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await stdio?.close().catch(() => { /* 조회 뒤 이미 닫힌 통신선을 다시 닫아도 무해하다. */ });
  }
}

export function removeTempDirForTest(dir: string): void {
  removeTempDir(dir);
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    return;
  } catch (e) {
    void reportError(e, { component: "providers", operation: "provider.grok.temp_remove" }); console.error("[aether] 배경 작업 임시 폴더 정리 실패(잠시 뒤 재시도):", e);
  }
  const later = setTimeout(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      void reportError(e, { component: "providers", operation: "provider.grok.temp_retry" }); console.error("[aether] 배경 작업 임시 폴더가 남았다(다음 부팅에 정리된다):", dir, e);
    }
  }, 2000);
  later.unref?.();
}

export function purgeOrphanGrokDistillHomes(): void {
  const tmp = os.tmpdir();
  for (const prefix of ["aether-grok-distill-home-", "aether-grok-distill-cwd-"]) {
    try {
      for (const name of fs.readdirSync(tmp)) {
        if (!name.startsWith(prefix)) continue;
        try {
          fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
        } catch {
          /* 다른 프로세스가 쓰는 중이면 건너뛴다 */
        }
      }
    } catch (e) {
      void reportError(e, { component: "providers", operation: "provider.grok.temp_cleanup" }); console.error("[aether] Grok 배경 작업 임시 폴더 청소 실패:", e);
    }
  }
}
