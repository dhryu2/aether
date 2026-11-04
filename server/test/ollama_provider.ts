/**
 * Ollama provider 검증 — 모델 호출 0.
 *
 * 가짜 Codex 실행기와 가짜 Ollama 서버를 띄워 확인한다.
 *   ① 모델 목록은 Ollama에서 오고, 도구 호출을 못 하는 모델은 빠진다.
 *   ② 세션은 Codex 실행기를 Ollama 공급처·대화 길이·전용 설정 폴더로 띄운다.
 *   ③ 모델을 안 고른 세션은 Ollama 목록의 기본 모델로 시작한다.
 *   ④ 배경 작업은 도구 정의 없이 Ollama를 직접 부르고, 잘린 답은 실패로 올린다.
 *   ⑤ 주입하지 않은 Codex 세션은 예전과 같다.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// ── 가짜 Ollama 서버 ──
const chatBodies: Record<string, unknown>[] = [];
const ollama = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [
        { name: "embed-only", capabilities: ["embedding"] },
        { name: "qwen-a", capabilities: ["completion", "tools", "thinking"] },
        { name: "plain", capabilities: ["completion", "tools"] },
        { name: "qwen-b", capabilities: ["completion", "tools"] },
      ] }));
      return;
    }
    // 모델 설정 조회. qwen-a·qwen-b는 대화 길이를 16384로 박아 두었고, plain은 설정이 없다(Ollama 자동).
    if (req.method === "POST" && req.url === "/api/show") {
      const { model } = JSON.parse(raw) as { model: string };
      const parameters = model === "plain" ? "temperature 1" : "temperature 1\nnum_ctx                        16384";
      res.end(JSON.stringify({ parameters }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      chatBodies.push(body);
      const cut = body.messages[0]?.content.includes("@@length@@");
      res.end(JSON.stringify({ message: { role: "assistant", content: "  요약  " }, done_reason: cut ? "length" : "stop" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
const URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-ollama-test-"));
process.env.AETHER_DATA_DIR = dataDir;
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";
process.env.AETHER_OLLAMA_URL = `${URL}/`; // 끝 빗금은 설정이 떼어 낸다
delete process.env.AETHER_OLLAMA_MODEL;
delete process.env.AETHER_OLLAMA_DISTILL_MODEL;
const callsFile = path.join(dataDir, "calls.jsonl");
process.env.FAKE_CALLS_FILE = callsFile;

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

const { providerEntry } = await import("../providers/registry");
const { codexCodec } = await import("../sessions/codec/codex");
const { CodexRuntime } = await import("../sessions/runtimes/codex");
const { toRuntimeModels } = await import("../providers/ollama/models");
const { ollamaConfigOverrides } = await import("../providers/ollama/backend");
const { parseNumCtx, ollamaModelWindow } = await import("../providers/ollama/models");
const { runOllamaDistill } = await import("../providers/ollama/distill");
type RuntimeStartOptions = import("../providers/types").RuntimeStartOptions;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (cond) pass++;
  else fail++;
}

function opts(sessionId: string): RuntimeStartOptions {
  return {
    sessionId,
    cwd: dataDir,
    permissionMode: "manual",
    onPermission: async () => ({ allow: false, message: "테스트" }),
    onQuestion: async () => ({ answered: false, reason: "테스트" }),
    onResumeKey: () => {},
  };
}
type Call = { method: string; params: Record<string, unknown> };
function readCalls(): Call[] {
  return fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
}

async function main() {
  console.log("── ① 모델 목록");
  {
    const models = toRuntimeModels(
      [{ name: "embed-only", capabilities: ["embedding"] }, { name: "embed-tools", capabilities: ["tools", "thinking", "embedding"] }, { name: "a", capabilities: ["tools"] }, { name: "b", capabilities: ["tools", "thinking"] }, { name: "old" }],
      "b",
    );
    check(JSON.stringify(models.map((m) => m.value)) === '["a","b","old"]', "도구 호출 못 하는 모델만 빠진다(능력 목록이 없으면 남긴다)", models.map((m) => m.value));
    check(models.find((m) => m.isDefault)?.value === "b", "설정한 모델이 목록에 있으면 기본이 된다");
    check(toRuntimeModels([{ name: "a", capabilities: ["tools"] }], "없음")[0].isDefault === true, "설정한 모델이 없으면 첫 모델이 기본이다");
    const b = models.find((m) => m.value === "b")!;
    check(JSON.stringify(b.supportedEffortLevels) === '["none","medium"]', "생각 모드가 있는 모델은 강도 none·medium을 받는다", b.supportedEffortLevels);
    check(!models.find((m) => m.value === "a")!.supportsEffort, "생각 모드가 없는 모델은 강도를 안 받는다");
  }

  console.log("── 등록표");
  const entry = providerEntry("ollama");
  check(entry.services.displayName === "Ollama" && !entry.services.auth, "표시 이름은 Ollama이고 로그인 절차가 없다");
  check(entry.codec.endsTurn === codexCodec.endsTurn && entry.codec.isLiveOnly === codexCodec.isLiveOnly, "이벤트 판정 규칙은 Codex와 같다");
  const norm = entry.codec.normalize({ seq: 1, ts: 1, kind: "user_msg", text: "안녕" } as never);
  check(norm.length > 0 && norm.every((a) => a.provider === "ollama"), "정리된 이벤트에는 provider가 ollama로 찍힌다", norm);
  check(codexCodec.normalize({ seq: 1, ts: 1, kind: "user_msg", text: "안녕" } as never).every((a) => a.provider === "codex"), "Codex 세션은 그대로 codex로 찍힌다");
  check(entry.isValidResumeKey("01a116af-d5b6-77b2-aa90-fb81516ba056") && !entry.isValidResumeKey("../x"), "이어가기 식별자 형식을 검사한다");

  console.log("── ② ③ 세션 실행기");
  {
    const overrides = ollamaConfigOverrides("http://h:1");
    check(overrides.includes('model_providers.aether_ollama.base_url="http://h:1/v1"'), "공급처 주소에 /v1을 붙인다", overrides);
    check(!overrides.some((o) => o.startsWith("model_context_window")), "대화 길이는 프로세스 설정에 넣지 않는다(모델마다 다르다)", overrides);
    check(parseNumCtx("temperature 1\nnum_ctx                        32768\ntop_k 20") === 32768, "모델 설정 글에서 대화 길이를 읽는다");
    check(parseNumCtx("temperature 1") === undefined && parseNumCtx(undefined) === undefined, "대화 길이 설정이 없으면 모른다고 답한다");
    check((await ollamaModelWindow("qwen-a")) === 16384, "모델에 박힌 대화 길이를 Ollama에서 읽는다");
    check((await ollamaModelWindow("plain")) === 32768, "모델에 길이가 없으면 운영자 설정값을 쓴다");

    const rt = entry.createRuntime(opts("ollama-1"));
    check(rt.provider === "ollama" && rt.capabilities.usage === false, "provider는 ollama이고 사용량 조회는 없다", { p: rt.provider, c: rt.capabilities });
    const hs = await rt.handshake();
    // 권한 모드: Ollama에는 자동 검토가 없어 자동이 목록에 없고, 새 세션은 수동으로 시작한다.
    const permModes = await rt.permissionModes();
    check(permModes.modes.join() === "manual,full" && permModes.current === "manual", "권한 모드 목록에 자동이 없다", permModes);
    let autoRefused = "";
    await rt.setPermissionMode("auto").catch((e: Error) => (autoRefused = e.message));
    check(autoRefused !== "" && (await rt.permissionModes()).current === "manual", "자동으로는 바꿀 수 없다");
    const fresh = entry.createRuntime({ ...opts("ollama-new"), permissionMode: undefined });
    check((await fresh.permissionModes()).current === "manual", "시작 모드를 안 정한 새 세션은 수동으로 시작한다");
    await fresh.dispose();
    for (const asked of ["auto", "edits"] as const) {
      const r = entry.createRuntime({ ...opts(`ollama-${asked}`), permissionMode: asked });
      check((await r.permissionModes()).current === "manual", `생성 때 ${asked}가 오면 수동으로 시작한다`);
      await r.dispose();
    }
    let editsRefused = "";
    await rt.setPermissionMode("edits").catch((e: Error) => (editsRefused = e.message));
    check(editsRefused !== "", "세션 중 편집 자동 수락 변경은 목록 검사로 거부한다");
    let wrong = "";
    await rt.setModel("gpt-6-astra").catch((e: Error) => (wrong = e.message));
    check(wrong.includes("Ollama") && !wrong.includes("Codex"), "없는 모델 안내 문구에 Ollama 이름이 나온다", wrong);
    check(JSON.stringify(hs.models.map((m) => m.value)) === '["qwen-a","plain","qwen-b"]', "모델 목록은 Ollama에서 온다", hs.models.map((m) => m.value));
    const calls = readCalls();
    const spawn = calls.find((c) => c.method === "__spawn")!.params as { codexHome: string; overrides: string[] };
    check(spawn.overrides.includes('model_provider="aether_ollama"'), "Codex 실행기를 Ollama 공급처로 띄운다", spawn.overrides);
    check(spawn.overrides.includes(`model_providers.aether_ollama.base_url="${URL}/v1"`), "설정한 주소로 연결한다", spawn.overrides);
    check(spawn.overrides.includes("tools.experimental_request_user_input.enabled=true"), "질문 카드 스위치는 그대로 켜진다");
    check(spawn.codexHome === path.join(dataDir, "ollama-codex-home"), "전용 설정 폴더를 쓴다", spawn.codexHome);
    check((fs.statSync(spawn.codexHome).mode & 0o777) === 0o700, "설정 폴더는 주인만 읽는다");
    const start = calls.find((c) => c.method === "thread/start");
    check(start?.params.model === "qwen-a", "모델을 안 고른 세션은 Ollama 기본 모델로 시작한다", start?.params);
    const cfg = (start?.params.config ?? {}) as Record<string, unknown>;
    check(cfg.model_context_window === 16384 && cfg.model_auto_compact_token_limit === 13107, "대화를 열 때 그 모델의 대화 길이와 압축 기준(80%)을 알린다", cfg);
    check("mcp_servers" in cfg, "지식 도구 창구 설정도 함께 넘어간다", Object.keys(cfg));
    let mismatch = "";
    await rt.setModel("plain").catch((e: Error) => (mismatch = e.message));
    check(mismatch.includes("plain") && mismatch.includes("16384") && mismatch.includes("32768"), "대화 길이가 다른 모델로는 바꾸지 못하고 이유를 알린다", mismatch);
    let sameOk = true;
    await rt.setModel("qwen-b").catch(() => (sameOk = false));
    check(sameOk, "대화 길이가 같은 모델로는 바꿀 수 있다");
    check(!calls.some((c) => c.method === "model/list"), "Codex 계정 모델 목록은 묻지 않는다");

    // 한 턴을 돌린다. 가짜 실행기는 턴마다 사용 한도 알림을 보낸다 — 한도가 없는 Ollama 세션은 버려야 한다.
    const methods: string[] = [];
    void (async () => {
      for await (const ev of rt.events()) methods.push(String((ev.msg as { method?: string })?.method));
    })().catch(() => {});
    rt.push({ text: "안녕" });
    const t0 = Date.now();
    while (!methods.includes("turn/completed") && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    check(methods.includes("turn/completed"), "턴이 끝난다", methods);
    check(!methods.includes("account/rateLimits/updated"), "사용 한도 알림은 세션 이벤트로 남지 않는다", methods);
    await rt.dispose();

    // 턴 도중 권한을 낮추면 그 턴에는 닿지 않는다고 Codex와 같은 방식으로 답한다.
    const slow = entry.createRuntime({ ...opts("ollama-slow"), permissionMode: "full" });
    const slowMethods: string[] = [];
    void (async () => {
      for await (const ev of slow.events()) slowMethods.push(String((ev.msg as { method?: string })?.method));
    })().catch(() => {});
    slow.push({ text: "@@slow@@ 오래 걸리는 일" });
    const t1 = Date.now();
    while (!slowMethods.includes("turn/started") && Date.now() - t1 < 10_000) await new Promise((r) => setTimeout(r, 20));
    const lowered = await slow.setPermissionMode("manual");
    check(lowered.deferred === true, "턴 도중 full에서 manual로 낮추면 deferred", lowered);
    await slow.dispose();
  }

  console.log("── ⑤ 주입 없는 Codex 세션");
  {
    fs.rmSync(callsFile, { force: true });
    const rt = new CodexRuntime(opts("codex-1"));
    check(rt.provider === "codex" && rt.capabilities.usage === true, "provider와 능력이 예전과 같다");
    const hs = await rt.handshake();
    const calls = readCalls();
    const spawn = calls.find((c) => c.method === "__spawn")!.params as { codexHome: string | null; overrides: string[] };
    check(!spawn.overrides.some((o) => o.startsWith("model_provider")), "공급처 설정을 얹지 않는다", spawn.overrides);
    const cstart = calls.find((c) => c.method === "thread/start");
    check(!("model_context_window" in ((cstart?.params.config ?? {}) as object)), "Codex 세션은 대화 길이를 따로 알리지 않는다", cstart?.params.config);
    check(spawn.codexHome !== path.join(dataDir, "ollama-codex-home"), "Ollama 전용 설정 폴더를 쓰지 않는다", spawn.codexHome);
    check(hs.models.length > 0 && !hs.models.some((m) => m.value === "qwen-a"), "모델 목록은 Codex 계정에서 온다", hs.models.map((m) => m.value));
    await rt.dispose();
  }

  console.log("── ④ 배경 작업");
  {
    const out = await runOllamaDistill("기억을 뽑아라", dataDir);
    check(out === "요약", "답을 다듬어 돌려준다", out);
    const body = chatBodies.at(-1)!;
    check(!("tools" in body) && body.think === false && body.stream === false, "도구 정의 없이, 생각 모드를 끄고 부른다", body);
    check(body.model === "qwen-a", "배경 작업 모델을 안 정하면 Ollama 기본 모델을 쓴다", body.model);
    let threw = "";
    await runOllamaDistill("@@length@@", dataDir).catch((e: Error) => (threw = e.message));
    check(threw.includes("length"), "잘린 답은 실패로 올린다", threw);
  }
}

main()
  .catch((e) => {
    fail++;
    console.error("  ❌ 예외:", e);
  })
  .finally(() => {
    ollama.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fake.dir, { recursive: true, force: true });
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  });
