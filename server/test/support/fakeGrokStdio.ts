/**
 * 가짜 grok agent stdio (Phase 10c 시험대) — 모델 호출 0.
 *
 * 진짜 `grok agent --no-leader stdio`처럼 줄 단위 JSON-RPC를 말하되 대본대로만 답한다.
 * `AETHER_GROK_BIN`에 이 스크립트를 가리키면 서버는 진짜 grok를 띄운 줄 안다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_GROK_SESSION_ID = "01a01111-2222-7333-8444-555566667777";
export const FAKE_GROK_CLEARED_SESSION_ID = "01a0cccc-2222-7333-8444-555566667777";

export function makeFakeGrokBin(): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-fake-grok-"));
  const bin = path.join(dir, "grok");
  const tsx = path.resolve(HERE, "..", "..", "node_modules", ".bin", "tsx");
  const script = path.join(HERE, "fakeGrokStdio.ts");
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(tsx)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { bin, dir };
}

const isMain = process.argv[1] ? fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) : false;

type Json = Record<string, unknown>;

function send(obj: Json) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function recordSpawn(argv: string[], extra: Json = {}) {
  const CALLS_FILE = process.env.FAKE_GROK_CALLS_FILE;
  if (!CALLS_FILE) return;
  const grokHome = process.env.GROK_HOME ?? "";
  let homeEntries: { name: string; mode: string }[] = [];
  if (grokHome) {
    try {
      homeEntries = fs.readdirSync(grokHome).map((name) => {
        const st = fs.statSync(path.join(grokHome, name));
        return { name, mode: (st.mode & 0o777).toString(8) };
      });
    } catch {
      homeEntries = [];
    }
  }
  try {
    fs.appendFileSync(
      CALLS_FILE,
      JSON.stringify({
        method: "__spawn",
        params: {
          argv,
          grokHome,
          homeEntries,
          grokMemory: process.env.GROK_MEMORY ?? "",
          ...extra,
        },
      }) + "\n",
    );
  } catch {
    /* 관측용 */
  }
}

/** 기기코드 로그인 흉내 — 주소와 코드를 찍고 신호 파일이 올 때까지 기다린다. */
function runFakeLogin() {
  recordSpawn(process.argv.slice(2));
  process.stdout.write("Visit https://accounts.x.ai/device\n");
  process.stdout.write("Confirm this code: FAKE-CODE\n");
  if (process.env.FAKE_GROK_EMIT_RPC === "1") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: {} }) + "\n");
  }
  const signal = process.env.FAKE_GROK_LOGIN_SIGNAL;
  const tick = () => {
    if (signal && fs.existsSync(signal)) {
      const cmd = fs.readFileSync(signal, "utf8").trim();
      if (cmd === "complete") {
        const home = process.env.GROK_HOME;
        if (home) {
          try {
            fs.mkdirSync(home, { recursive: true });
            fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ email: "fake-grok@example.invalid" }), { mode: 0o600 });
          } catch {
            /* ignore */
          }
        }
        process.exit(0);
      }
      if (cmd === "fail") process.exit(1);
      if (cmd === "crash") process.exit(9);
    }
  };
  const timer = setInterval(tick, 30);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(1);
  });
  tick();
}

function promptOf(argv: string[]): string {
  const i = argv.indexOf("-p");
  return i >= 0 ? String(argv[i + 1] ?? "") : "";
}

/** 배경 작업 `grok -p` 흉내. */
function runFakeDistill(argv: string[]) {
  recordSpawn(argv);
  const prompt = promptOf(argv);
  // 진짜 CLI의 "모르는 모델" 거부(2026-10-15 실측 문구와 종료 코드).
  const mi = argv.indexOf("-m");
  const unknown = (process.env.FAKE_GROK_UNKNOWN_MODELS ?? "").split(",").filter(Boolean);
  if (mi >= 0 && unknown.includes(String(argv[mi + 1]))) {
    const msg = `Couldn't set model '${argv[mi + 1]}': Invalid params: "unknown model id". Run 'grok models' to see available models.`;
    process.stdout.write(JSON.stringify({ type: "error", message: msg }) + "\n");
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
    return;
  }
  if (prompt.includes("@@hang@@")) {
    setInterval(() => {}, 60_000);
    return;
  }
  if (prompt.includes("@@empty@@")) {
    process.exit(0);
    return;
  }
  if (prompt.includes("@@fail@@")) {
    process.exit(1);
    return;
  }
  if (prompt.includes("@@tool@@")) {
    process.stdout.write(JSON.stringify({ type: "tool_call", toolName: "run_terminal_command" }) + "\n");
  }
  if (prompt.includes("@@badjson@@")) {
    process.stdout.write("{not json\n");
  }
  process.stdout.write(JSON.stringify({ type: "result", result: `받음: ${prompt}` }) + "\n");
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("login") && (argv.includes("--device-auth") || argv.includes("--device-code"))) {
    runFakeLogin();
    return;
  }
  if (argv.includes("-p")) {
    runFakeDistill(argv);
    return;
  }
  if (!argv.includes("agent") || !argv.includes("stdio") || !argv.includes("--no-leader")) {
    process.stderr.write(`fake grok: agent --no-leader stdio 인자가 없다(${argv.join(" ")})\n`);
    process.exit(2);
  }

  const CALLS_FILE = process.env.FAKE_GROK_CALLS_FILE;
  const calls: { method: string; params: Json; _rpcError?: boolean }[] = [];
  function record(entry: { method: string; params: Json; _rpcError?: boolean }) {
    calls.push(entry);
    if (!CALLS_FILE) return;
    try {
      fs.appendFileSync(CALLS_FILE, JSON.stringify(entry) + "\n");
    } catch {
      /* 관측용 */
    }
  }
  record({
    method: "__spawn",
    params: {
      argv,
      aetherEnvNames: Object.keys(process.env).filter((n) => n.startsWith("AETHER_") || n.startsWith("GROK_")).sort(),
      envHasMcpToken: Boolean(process.env.AETHER_MCP_TOKEN),
      askTimeoutEnabled: process.env.GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED ?? null,
      envValuesContainBearer: Object.values(process.env).some((v) => typeof v === "string" && /Bearer\s+\S/.test(v)),
    },
  });

  let initialized = false;
  let sessionId = "";
  let cwd = process.cwd();
  let nextId = 1;
  const awaitingAnswer = new Map<number, (result: unknown) => void>();
  let promptActive = false;
  let cancelRequested = false;
  const decoder = new StringDecoder("utf8");
  let buf = "";

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function ok(id: unknown, result: unknown) {
    send({ jsonrpc: "2.0", id, result });
  }
  function fail(id: unknown, message: string, code = -32601, data?: unknown) {
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  async function askClient(label: string, method: string, params: Json) {
    const rid = nextId++;
    const answer = await new Promise<unknown>((resolve) => {
      awaitingAnswer.set(rid, resolve);
      send({ jsonrpc: "2.0", id: rid, method, params });
    });
    const rec = asObj(answer);
    const rpcError = rec?.__rpcError === true;
    const payload = rpcError ? (asObj(rec?.error) ?? { value: rec?.error }) : rec ?? { value: answer };
    record({ method: label, params: payload as Json, ...(rpcError ? { _rpcError: true } : {}) });
    return answer;
  }

  function writeSessionPlan(text: string) {
    const home = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
    const dir = path.join(home, "sessions", encodeURIComponent(cwd), sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.md"), text);
  }

  function asObj(v: unknown): Json | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  }

  function textOfPrompt(params: Json): string {
    const prompt = params.prompt;
    if (!Array.isArray(prompt)) return "";
    return prompt
      .map((b) => {
        const rec = asObj(b);
        return typeof rec?.text === "string" ? rec.text : "";
      })
      .join("");
  }

  function resourceTexts(params: Json): string[] {
    const prompt = params.prompt;
    if (!Array.isArray(prompt)) return [];
    return prompt
      .map((b) => {
        const rec = asObj(b);
        const resource = rec ? asObj(rec.resource) : null;
        return typeof resource?.text === "string" ? resource.text : "";
      })
      .filter(Boolean);
  }

  async function runPrompt(id: unknown, params: Json) {
    promptActive = true;
    cancelRequested = false;
    const text = textOfPrompt(params);
    const recalled = resourceTexts(params).find((t) => t.includes("<aether-context>"));
    if (recalled) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: recalled } } },
      });
    }
    if (!text.includes("@@nolead@@")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "받음: " } } },
      });
    }

    if (text.includes("@@ask@@") || text.includes("@@ask-session@@") || text.includes("@@ask-secret@@")) {
      const sessionOnly = text.includes("@@ask-session@@");
      const secret = text.includes("@@ask-secret@@"); // 폴더 밖 비밀 경로 쓰기
      await askClient("permissionAnswer", "session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "tc-ask",
          title: "Write",
          kind: "edit",
          rawInput: secret ? { file_path: "/tmp/example-outside/.env", content: "DUMMY-SECRET" } : { file_path: "/tmp/demo.txt", content: "hello" },
        },
        options: sessionOnly
          ? [
              { optionId: "allow-edits-session", kind: "allow-edits-session", name: "Allow edits this session" },
              { optionId: "reject-once", kind: "reject_once", name: "Reject" },
            ]
          : [
              { optionId: "allow-once", kind: "allow_once", name: "Allow" },
              { optionId: "reject-once", kind: "reject_once", name: "Reject" },
              { optionId: "allow-edits-session", kind: "allow-edits-session", name: "Allow edits this session" },
            ],
      });
    }
    if (text.includes("@@plan-perm@@")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "plan", plan: "1. 인증 방식을 고른다\n2. 세션을 붙인다" } },
      });
      await askClient("permissionAnswer", "session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "tc-plan-exit",
          title: "exit_plan_mode",
          kind: "other",
          rawInput: { plan: "1. 인증 방식을 고른다\n2. 세션을 붙인다" },
        },
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow" },
          { optionId: "reject-once", kind: "reject_once", name: "Reject" },
        ],
      });
    } else if (text.includes("@@plan@@") || text.includes("@@plan-timeout@@")) {
      writeSessionPlan("1. 인증 방식을 고른다\n2. 세션을 붙인다");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-plan-exit",
            title: "exit_plan_mode",
            kind: "other",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            title: "Plan mode entered",
            rawOutput: {
              type: "EnterPlanMode",
              Entered: {
                plan_file_path: path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "sessions", encodeURIComponent(cwd), sessionId, "plan.md"),
              },
            },
          },
        },
      });
      if (text.includes("@@plan-timeout@@")) {
        const rid = nextId++;
        const answered = new Promise<unknown>((resolve) => {
          awaitingAnswer.set(rid, resolve);
          send({ jsonrpc: "2.0", id: rid, method: "_x.ai/exit_plan_mode", params: { sessionId, toolCallId: "tc-plan-exit" } });
        });
        await wait(40);
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-plan-exit",
              title: "exit_plan_mode",
              status: "failed",
              rawOutput: { message: "Plan approval could not be completed because the client disconnected." },
            },
          },
        });
        const answer = await answered;
        const rec = asObj(answer);
        const rpcError = rec?.__rpcError === true;
        const payload = rpcError ? (asObj(rec?.error) ?? { value: rec?.error }) : rec ?? { value: answer };
        record({ method: "planAnswer", params: payload as Json, ...(rpcError ? { _rpcError: true } : {}) });
      } else {
        await askClient("planAnswer", "_x.ai/exit_plan_mode", { sessionId, toolCallId: "tc-plan-exit" });
      }
    }
    if (text.includes("@@question@@") || text.includes("@@question-timeout@@") || text.includes("@@nolead@@")) {
      const questions = [
        {
          question: "어디에 배포할까요?",
          header: "배포 대상",
          options: [{ label: "운영" }, { label: "테스트" }],
        },
      ];
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-ask",
            title: "ask_user_question",
            rawInput: { questions },
          },
        },
      });
      if (text.includes("@@question-timeout@@")) {
        const rid = nextId++;
        const answered = new Promise<unknown>((resolve) => {
          awaitingAnswer.set(rid, resolve);
          send({ jsonrpc: "2.0", id: rid, method: "_x.ai/ask_user_question", params: { sessionId, questions } });
        });
        await wait(40);
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-ask",
              status: "completed",
              rawOutput: {
                type: "AskUserQuestion",
                UserAnswered: {
                  message: "User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.",
                },
              },
            },
          },
        });
        const answer = await answered;
        const rec = asObj(answer);
        const rpcError = rec?.__rpcError === true;
        const payload = rpcError ? (asObj(rec?.error) ?? { value: rec?.error }) : rec ?? { value: answer };
        record({ method: "questionAnswer", params: payload as Json, ...(rpcError ? { _rpcError: true } : {}) });
      } else {
        await askClient("questionAnswer", "_x.ai/ask_user_question", { sessionId, questions });
      }
    }
    if (text.includes("@@unknown@@")) {
      await askClient("unknownAnswer", "account/refresh", { sessionId });
    }
    if (text.includes("@@slow@@")) {
      await wait(Number(process.env.FAKE_GROK_TURN_DELAY_MS ?? 400));
    }
    if (cancelRequested) {
      promptActive = false;
      ok(id, { stopReason: "cancelled" });
      return;
    }
    // 한도 오류 흉내(실제 오류 표본이 아니라 1.0.50 문구 기준). 표지마다 문구나 상태 숫자를 달리한다.
    const limitFail = text.includes("@@ratelimit@@")
      ? { message: "You've hit the rate limit for your plan.", code: -32000 }
      : text.includes("@@weekly@@")
        ? { message: "You hit your weekly limit.", code: -32000 }
        : text.includes("@@free@@")
          ? { message: "You hit your free usage limit.", code: -32000 }
          : text.includes("@@http429@@")
            ? { message: "Too many requests", code: -32000, data: { status: 429 } }
            : text.includes("@@http402@@")
              ? { message: "Payment required", code: -32000, data: { status: 402 } }
              : undefined;
    if (limitFail) {
      promptActive = false;
      fail(id, limitFail.message, limitFail.code, limitFail.data);
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        _meta: { totalTokens: 1200 },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "session_info_update", title: "fake" },
        _meta: { totalTokens: 1200 },
      },
    });
    promptActive = false;
    ok(id, { stopReason: "end_turn" });
  }

  async function dispatch(msg: Json) {
    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = (asObj(msg.params) ?? {}) as Json;
    if (id !== undefined && ("result" in msg || "error" in msg)) {
      const waiter = awaitingAnswer.get(id as number);
      if (waiter) {
        awaitingAnswer.delete(id as number);
        waiter("error" in msg ? { __rpcError: true, error: msg.error } : msg.result);
      }
      return;
    }
    record({ method, params });
    switch (method) {
      case "initialize":
        initialized = true;
        ok(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, embeddedContext: true },
            mcpCapabilities: { http: true },
            sessionCapabilities: { resume: true, close: true },
          },
          _meta: {
            modelState: {
              currentModelId: "grok-4.6",
              availableModels: [
                {
                  modelId: "grok-4.6",
                  displayName: "Grok 4.6",
                  _meta: {
                    reasoningEffort: "high",
                    reasoningEfforts: [
                      { value: "low", label: "낮음" },
                      { value: "medium", label: "보통" },
                      { value: "high", label: "높음" },
                      { value: "xhigh", label: "최고" },
                    ],
                  },
                },
                {
                  modelId: "grok-4.5",
                  displayName: "Grok 4.5",
                  _meta: { reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
                },
              ],
            },
            availableCommands: [
              { name: "compact", description: "Compact conversation history" },
              { name: "dashboard" },
              { name: "memory" },
              { name: "rewind" },
              { name: "fork" },
              { name: "remember" },
            ],
          },
        });
        return;
      case "session/new":
        if (!initialized) return fail(id, "not initialized");
        if (process.env.FAKE_GROK_SESSION_NEW === "fail") return fail(id, "session new refused", -32000);
        if (typeof params.cwd === "string" && params.cwd) cwd = params.cwd;
        sessionId = sessionId ? FAKE_GROK_CLEARED_SESSION_ID : FAKE_GROK_SESSION_ID;
        ok(id, { sessionId });
        return;
      case "session/resume":
        if (!initialized) return fail(id, "not initialized");
        sessionId = typeof params.sessionId === "string" ? params.sessionId : FAKE_GROK_SESSION_ID;
        ok(id, { sessionId });
        return;
      case "session/load":
        return fail(id, "session/load is not the resume path");
      case "session/prompt":
        if (!sessionId) return fail(id, "no session");
        await runPrompt(id, params);
        return;
      case "test/calls":
        ok(id, { calls, argv });
        return;
      case "test/argv":
        ok(id, { argv });
        return;
      case "test/emit_commands": {
        const repeat = typeof params.repeat === "number" ? Math.max(1, Math.floor(params.repeat)) : 1;
        const availableCommands = Array.isArray(params.availableCommands) ? params.availableCommands : [];
        for (let i = 0; i < repeat; i++) {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands } },
          });
        }
        ok(id, { emitted: repeat });
        return;
      }
      case "_x.ai/billing":
        if (process.env.FAKE_GROK_BILLING === "hang") return;
        if (process.env.FAKE_GROK_BILLING === "unsupported") {
          fail(id, "Method not found", -32601);
          return;
        }
        ok(id, {
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-08-20T00:00:00.000Z",
              end: process.env.FAKE_GROK_BILLING_END ?? "2026-08-27T00:00:00.000Z",
            },
            creditUsagePercent: 42,
            billingPeriodStart: "2026-08-20T00:00:00.000Z",
            billingPeriodEnd: process.env.FAKE_GROK_BILLING_END ?? "2026-08-27T00:00:00.000Z",
          },
          subscription_tier: "SuperGrok",
        });
        return;
      default:
        if (id !== undefined) fail(id, `Method not found: ${method}`);
    }
  }

  process.stdin.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (msg.method === "session/cancel") {
        cancelRequested = true;
        continue;
      }
      void dispatch(msg);
    }
  });
}

if (isMain) main();
