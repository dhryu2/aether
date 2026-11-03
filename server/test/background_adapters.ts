/**
 * 배경 작업 어댑터의 옵션 세 형태와 목록 조회 — 모델 호출 0.
 *
 * 배경 작업 모델 어댑터 시험.
 *   - 옵션 없음·계정 기본·명시가 각 provider에 맞게 전달된다.
 *   - 명시 실행이 거부되면 다른 모델로 넘어가지 않고 `UnknownModelNameError`가 난다.
 *   - 목록 조회가 턴 없이 돌고, Claude 어댑터만 중립 필드를 채운다.
 * Claude는 가짜 query, Codex는 가짜 app-server, Grok은 가짜 grok, Ollama는 가짜 HTTP 서버로 본다.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bg-adapters-"));
process.env.AETHER_DATA_DIR = DATA_DIR;
process.env.AETHER_DISTILL_TIMEOUT_MS = "5000";
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";
for (const k of ["AETHER_REFLECT_MODEL", "AETHER_CODEX_DISTILL_MODEL", "AETHER_GROK_DISTILL_MODEL", "AETHER_OLLAMA_DISTILL_MODEL", "AETHER_OLLAMA_MODEL"]) delete process.env[k];

// 가짜 인증 폴더(Codex·Grok 배경 작업은 인증 파일 하나만 복사해 간다).
const CODEX_SRC = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bgad-codex-"));
fs.writeFileSync(path.join(CODEX_SRC, "auth.json"), "{}");
process.env.CODEX_HOME = CODEX_SRC;
const GROK_SRC = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bgad-grok-"));
fs.writeFileSync(path.join(GROK_SRC, "auth.json"), "{}");
process.env.GROK_HOME = GROK_SRC;

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fakeCodex = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fakeCodex.bin;
const { makeFakeGrokBin } = await import("./support/fakeGrokStdio");
const fakeGrok = makeFakeGrokBin();
process.env.AETHER_GROK_BIN = fakeGrok.bin;

// 가짜 Ollama
const chatBodies: Record<string, unknown>[] = [];
const ollama = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "local-a", capabilities: ["completion", "tools", "thinking"] }, { name: "local-b", capabilities: ["completion", "tools"] }] }));
      return;
    }
    if (req.url === "/api/chat") {
      chatBodies.push(JSON.parse(raw));
      res.end(JSON.stringify({ message: { content: "ok" }, done_reason: "stop" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
process.env.AETHER_OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

await import("../providers/registry");
const { UnknownModelNameError, PICK_RULE } = await import("../providers/distillModel");
const claude = await import("../providers/claude/distill");
const codex = await import("../providers/codex/distill");
const grok = await import("../providers/grok/distill");
const { resetGrokBinCache } = await import("../providers/grok/transport");
resetGrokBinCache();
const ollamaDistill = await import("../providers/ollama/distill");

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
}
async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

// ───────────────────────────── Claude ─────────────────────────────
console.log("── Claude ──");
{
  type Log = { setModel: string[]; flags: unknown[]; prompts: string[] };
  let log: Log;
  const KNOWN = new Set(["default", "haiku", "claude-haiku-5-5"]);
  claude.setClaudeDistillSpawnForTest((_cwd, input) => {
    const stream = input.stream();
    return {
      async *[Symbol.asyncIterator]() {
        for await (const m of stream) {
          const text = String((m as { message: { content: string } }).message.content);
          log.prompts.push(text);
          yield { type: "result", result: `받음: ${text}` };
        }
      },
      supportedModels: async () => [
        { value: "default", displayName: "Default", description: "", resolvedModel: "claude-big-5" },
        { value: "haiku", displayName: "Haiku", description: "", resolvedModel: "claude-haiku-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium"] },
        { value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "", resolvedModel: "claude-haiku-5-5" },
      ],
      setModel: async (m?: string) => {
        log.setModel.push(String(m));
        if (!KNOWN.has(String(m))) throw new Error(`Model "${m}" is not a recognized model id. Run /model to see available models.`);
      },
      applyFlagSettings: async (s) => {
        log.flags.push(s);
      },
      interrupt: async () => {},
      close: () => {},
    };
  });

  // 옵션 없음: 저장해 둔 이름을 쓰는 지금 동작.
  fs.writeFileSync(path.join(DATA_DIR, "distill-model.json"), JSON.stringify({ model: "haiku", rule: PICK_RULE }));
  log = { setModel: [], flags: [], prompts: [] };
  check((await claude.runDistill("p0", DATA_DIR)) === "받음: p0" && log.setModel.join() === "haiku" && log.flags.length === 0, "옵션 없음 → 지금의 자동 선택(저장값)", log);

  log = { setModel: [], flags: [], prompts: [] };
  check((await claude.runDistill("p1", DATA_DIR, { use: "account_default" })) === "받음: p1" && log.setModel.length === 0 && log.flags.length === 0, "계정 기본 → setModel·effort 없음", log);

  log = { setModel: [], flags: [], prompts: [] };
  await claude.runDistill("p2", DATA_DIR, { use: "explicit", model: "haiku", effort: "low" });
  check(log.setModel.join() === "haiku" && JSON.stringify(log.flags) === JSON.stringify([{ effortLevel: "low" }]), "명시 → setModel 다음 effort", log);

  log = { setModel: [], flags: [], prompts: [] };
  await claude.runDistill("p3", DATA_DIR, { use: "explicit", model: "haiku" });
  check(log.flags.length === 0, "명시에 effort가 없으면 모델 기본값", log);

  log = { setModel: [], flags: [], prompts: [] };
  const e = await rejects(claude.runDistill("p4", DATA_DIR, { use: "explicit", model: "nope-9" }));
  check(e instanceof UnknownModelNameError, "명시 이름이 거부되면 UnknownModelNameError", String(e));
  check(log.setModel.join() === "nope-9" && log.prompts.length === 0, "거부되면 다른 모델로 넘어가지 않고 프롬프트도 안 보낸다", log);

  const rows = await claude.listClaudeBackgroundModels();
  const by = (v: string) => rows.find((r) => r.value === v);
  check(by("default")?.followsAccountDefault === true && !by("default")?.movingAlias, "목록: default 줄은 기본값 선택지");
  check(by("haiku")?.movingAlias === true && !by("haiku")?.followsAccountDefault, "목록: haiku 줄은 별칭");
  check(!by("claude-haiku-5-5")?.movingAlias && !by("claude-haiku-5-5")?.followsAccountDefault, "목록: 정식 id 줄은 둘 다 아님");
  check(JSON.stringify(by("haiku")?.supportedEffortLevels) === JSON.stringify(["low", "medium"]), "목록: effort 목록을 옮긴다");
  claude.setClaudeDistillSpawnForTest(null);
}

// ───────────────────────────── Codex ─────────────────────────────
console.log("── Codex ──");
{
  type Call = { method: string; params: Record<string, any> };
  const observe = () => {
    const file = path.join(DATA_DIR, `codex-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.FAKE_CALLS_FILE = file;
    return () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : []);
  };
  let read = observe();
  await codex.runCodexDistill("x", DATA_DIR, { use: "explicit", model: "gpt-5.4-mini", effort: "medium" });
  let turn = read().find((c) => c.method === "turn/start");
  check(turn?.params.model === "gpt-5.4-mini" && turn?.params.effort === "medium", "명시 → 그 모델·그 effort", turn?.params);

  read = observe();
  await codex.runCodexDistill("x", DATA_DIR, { use: "explicit", model: "gpt-5.4-mini" });
  turn = read().find((c) => c.method === "turn/start");
  check(turn?.params.model === "gpt-5.4-mini" && !("effort" in (turn?.params ?? {})), "명시에 effort가 없으면 모델 기본값(가장 낮은 값으로 바꾸지 않는다)", turn?.params);

  read = observe();
  await codex.runCodexDistill("x", DATA_DIR, { use: "account_default" });
  turn = read().find((c) => c.method === "turn/start");
  const starts = read().filter((c) => c.method === "turn/start").length;
  check(!!turn && !("model" in turn.params) && !("effort" in turn.params) && starts === 1, "계정 기본 → 모델 지정 없이 턴 하나", turn?.params);

  read = observe();
  const e = await rejects(codex.runCodexDistill("x", DATA_DIR, { use: "explicit", model: "nope-9" }));
  check(e instanceof UnknownModelNameError, "명시 이름이 목록에 없으면 UnknownModelNameError", String(e));
  check(!read().some((c) => c.method === "thread/start"), "거부되면 턴을 열지 않는다(다른 모델로 넘어가지 않는다)");

  read = observe();
  const rows = await codex.listCodexBackgroundModels();
  check(rows.map((r) => r.value).join() === "gpt-5.4-mini,gpt-5.6-terra,gpt-5.4-nano", "목록 조회", rows.map((r) => r.value));
  check(!read().some((c) => c.method === "thread/start" || c.method === "turn/start"), "목록 조회는 턴을 쓰지 않는다");
  check(rows.every((r) => !r.followsAccountDefault && !r.movingAlias), "Codex는 중립 필드를 채우지 않는다");
  check(rows.find((r) => r.value === "gpt-5.6-terra")?.isDefault === true, "실제 모델 줄의 isDefault는 그대로(기본값 선택지가 아니다)");
}

// ───────────────────────────── Grok ─────────────────────────────
console.log("── Grok ──");
{
  type Call = { method: string; params: Record<string, any> };
  const observe = () => {
    const file = path.join(DATA_DIR, `grok-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.FAKE_GROK_CALLS_FILE = file;
    return () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : []);
  };
  const argvOf = (calls: Call[]) => (calls.find((c) => c.method === "__spawn")?.params.argv as string[]) ?? [];

  let read = observe();
  await grok.runGrokDistill("x", DATA_DIR);
  check(!argvOf(read()).includes("-m"), "옵션 없음·지정 없음 → -m을 넘기지 않는다(D13)", argvOf(read()));

  read = observe();
  await grok.runGrokDistill("x", DATA_DIR, { use: "account_default" });
  check(!argvOf(read()).includes("-m") && !argvOf(read()).includes("--reasoning-effort"), "계정 기본 → -m 없음");

  read = observe();
  await grok.runGrokDistill("x", DATA_DIR, { use: "explicit", model: "grok-4.6", effort: "low" });
  let argv = argvOf(read());
  check(argv[argv.indexOf("-m") + 1] === "grok-4.6" && argv[argv.indexOf("--reasoning-effort") + 1] === "low", "명시 → -m과 --reasoning-effort", argv);

  process.env.FAKE_GROK_UNKNOWN_MODELS = "nope-9";
  read = observe();
  const e = await rejects(grok.runGrokDistill("x", DATA_DIR, { use: "explicit", model: "nope-9" }));
  delete process.env.FAKE_GROK_UNKNOWN_MODELS;
  check(e instanceof UnknownModelNameError, "명시 이름이 거부되면 UnknownModelNameError", String(e));
  check(read().filter((c) => c.method === "__spawn").length === 1, "거부되면 다시 띄우지 않는다(다른 모델로 넘어가지 않는다)");

  read = observe();
  const rows = await grok.listGrokBackgroundModels();
  const calls = read();
  check(rows.map((r) => r.value).join() === "grok-4.6,grok-4.5", "목록 조회(initialize만)", rows.map((r) => r.value));
  check(calls.some((c) => c.method === "initialize") && !calls.some((c) => c.method === "session/new" || c.method === "session/prompt"), "목록 조회는 세션도 턴도 열지 않는다", calls.map((c) => c.method));
  check(JSON.stringify(rows[0].supportedEffortLevels) === JSON.stringify(["low", "medium", "high", "xhigh"]), "목록: effort 목록을 옮긴다");
  check(rows.every((r) => !r.followsAccountDefault && !r.movingAlias), "Grok은 중립 필드를 채우지 않는다");
  argv = (calls.find((c) => c.method === "__spawn")?.params.argv as string[]) ?? [];
  check(!argv.includes("--always-approve"), "목록 조회 프로세스는 승인 우회 없이 뜬다", argv);
}

// ───────────────────────────── Ollama ─────────────────────────────
console.log("── 세션 없는 계정 한도 ──");
{
  // Claude: 값을 읽어도, 응답이 없어도 임시 프로세스를 닫는다.
  const fakeUsageQuery = (usage: () => Promise<unknown>) => {
    const state = { closed: 0 };
    let finish = () => {};
    const done = new Promise<void>((resolve) => { finish = resolve; });
    claude.setClaudeDistillSpawnForTest(() => ({
      async *[Symbol.asyncIterator]() { await done; },
      supportedModels: async () => [],
      setModel: async () => {},
      applyFlagSettings: async () => {},
      interrupt: async () => {},
      close: () => { state.closed++; finish(); },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage as never,
    }));
    return state;
  };
  let query = fakeUsageQuery(async () => ({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" }, internal: { utilization: 99 } },
  }));
  const read = await claude.readClaudeAccountUsage(1000);
  check(read.windows.length === 1 && read.windows[0]?.utilization === 12, "Claude: 표시할 한도 창만 옮긴다", read);
  check(query.closed > 0, "Claude: 값을 읽으면 프로세스를 닫는다");
  query = fakeUsageQuery(() => new Promise((_, reject) => setTimeout(() => reject(new Error("닫힘")), 50)));
  check((await rejects(claude.readClaudeAccountUsage(10))) instanceof Error, "Claude: 응답이 없으면 실패로 끝난다");
  check(query.closed > 0, "Claude: 응답이 없으면 제한 시간에 프로세스를 닫는다");
  claude.setClaudeDistillSpawnForTest(null);

  // Grok: 가짜 프로세스가 끝나야 함수가 돌아온다(close를 기다린다).
  const { readGrokAccountUsage } = await import("../providers/grok/distill");
  const billed = await readGrokAccountUsage(10_000);
  check(billed.windowsAvailable && billed.windows[0]?.utilization === 42, "Grok: 세션 없이 한도를 읽는다", billed);
  process.env.FAKE_GROK_BILLING = "unsupported";
  const unsupported = await readGrokAccountUsage(10_000);
  check(!unsupported.windowsAvailable && unsupported.windows.length === 0, "Grok: 조회를 지원하지 않는 버전은 한도 없음이다", unsupported);
  process.env.FAKE_GROK_BILLING = "hang";
  const started = Date.now();
  const hung = await rejects(readGrokAccountUsage(3000));
  check(hung instanceof Error && Date.now() - started < 8000, "Grok: 응답이 없으면 전체 상한 안에 닫고 실패한다", Date.now() - started);
  delete process.env.FAKE_GROK_BILLING;
}

console.log("── Ollama ──");
{
  // 옵션 없음은 저장값(현행 규칙 판)을 쓴다. 판이 없는 저장값은 버리고 새로 고르므로 판을 함께 적는다.
  fs.writeFileSync(path.join(DATA_DIR, "distill-model-ollama.json"), JSON.stringify({ model: "local-a", rule: PICK_RULE }));
  chatBodies.length = 0;
  await ollamaDistill.runOllamaDistill("x", DATA_DIR, { use: "explicit", model: "local-b", effort: "medium" });
  await ollamaDistill.runOllamaDistill("x", DATA_DIR, { use: "explicit", model: "local-b", effort: "none" });
  await ollamaDistill.runOllamaDistill("x", DATA_DIR, { use: "account_default" });
  await ollamaDistill.runOllamaDistill("x", DATA_DIR);
  const sum = chatBodies.map((b) => `${b.model}:${b.think}`);
  check(JSON.stringify(sum) === JSON.stringify(["local-b:true", "local-b:false", "local-a:false", "local-a:false"]), "명시(effort 켬·끔)·계정 기본·옵션 없음", sum);
  const n = chatBodies.length;
  const e = await rejects(ollamaDistill.runOllamaDistill("x", DATA_DIR, { use: "explicit", model: "nope-9" }));
  check(e instanceof UnknownModelNameError && chatBodies.length === n, "명시 이름이 목록에 없으면 UnknownModelNameError, 요청 없음", String(e));
  const rows = await ollamaDistill.listOllamaBackgroundModels();
  check(rows.map((r) => r.value).join() === "local-a,local-b" && rows.every((r) => !r.followsAccountDefault && !r.movingAlias), "목록 조회", rows);
}

ollama.close();
for (const d of [DATA_DIR, CODEX_SRC, GROK_SRC, fakeCodex.dir, fakeGrok.dir]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} background_adapters: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
