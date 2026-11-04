/**
 * 준비(악수·스레드 시작)에 실패한 런타임이 허브를 멈추지 않는 계약 — 모델 호출 0.
 *
 * 준비가 거부된 채 입력이 오면 예전에는 pump가 같은 거부를 마이크로태스크만으로 무한히 되풀이해
 * 이벤트 루프가 굶었다. 이제 흐름이 오류로 정확히 한 번 끝나고, 그 사이 타이머가 계속 돌아야 한다.
 * 멈춤 재현이 일괄 실행 전체를 붙잡지 않도록 시나리오마다 자식 프로세스 + timeout으로 돌린다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const scenarios = ["codex-start", "codex-resume", "grok-new", "ollama-refused"] as const;
type Scenario = (typeof scenarios)[number];

async function child(scenario: Scenario) {
  process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-bootfail-"));
  process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";
  process.env.AETHER_GROK_SHUTDOWN_GRACE_MS = "500";
  const GROK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bootfail-home-"));
  fs.writeFileSync(path.join(GROK_HOME, "auth.json"), JSON.stringify({ email: "fake-grok@example.invalid" }), { mode: 0o600 });
  process.env.GROK_HOME = GROK_HOME;

  const { makeFakeCodexBin } = await import("./support/fakeAppServer");
  const { makeFakeGrokBin } = await import("./support/fakeGrokStdio");
  process.env.AETHER_CODEX_BIN = makeFakeCodexBin().bin;
  process.env.AETHER_GROK_BIN = makeFakeGrokBin().bin;

  const opts = {
    sessionId: "sess-bootfail",
    cwd: process.env.AETHER_DATA_DIR!,
    permissionMode: "manual" as const,
    onPermission: async () => ({ allow: false as const, message: "테스트" }),
    onQuestion: async () => ({ answered: false as const, reason: "테스트" }),
    onResumeKey: () => {},
  };
  let rt: { push(i: { text: string }): void; events(): AsyncIterable<unknown>; dispose(): Promise<void> };
  if (scenario === "grok-new") {
    process.env.FAKE_GROK_SESSION_NEW = "fail";
    const { GrokRuntime } = await import("../sessions/runtimes/grok");
    rt = new GrokRuntime(opts) as unknown as typeof rt;
  } else if (scenario === "ollama-refused") {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    process.env.AETHER_OLLAMA_URL = `http://127.0.0.1:${port}`;
    const { CodexRuntime } = await import("../sessions/runtimes/codex");
    const { ollamaBackend } = await import("../providers/ollama/backend");
    rt = new CodexRuntime(opts, ollamaBackend()) as unknown as typeof rt;
  } else {
    process.env.FAKE_THREAD_START = "fail";
    const { CodexRuntime } = await import("../sessions/runtimes/codex");
    rt = new CodexRuntime(scenario === "codex-resume" ? { ...opts, resumeKey: "thr-example" } : opts) as unknown as typeof rt;
  }

  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let ended = 0;
  let error = "";
  const done = (async () => {
    try {
      for await (const _ of rt.events()) void _;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    ended++;
  })();
  rt.push({ text: "안녕" });
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 200)); // 재시도 폭주가 있으면 이 사이 타이머가 안 돈다
  clearInterval(timer);
  console.log("RESULT " + JSON.stringify({ ticks, ended, error }));
  await rt.dispose();
  process.exit(0);
}

async function parent() {
  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, name: string, detail?: unknown) => {
    console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
    cond ? pass++ : fail++;
  };
  for (const s of scenarios) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bootfail-test-"));
    const r = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "child", s], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, AETHER_DATA_DIR: dataDir },
    });
    const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) {
      check(false, `${s}: 자식이 멈추지 않고 끝난다`, { signal: r.signal, status: r.status });
      continue;
    }
    const res = JSON.parse(line.slice(7)) as { ticks: number; ended: number; error: string };
    check(res.ticks > 5, `${s}: 이벤트 루프가 계속 돈다`, res);
    check(res.ended === 1 && res.error.length > 0, `${s}: 흐름이 준비 실패 오류로 정확히 한 번 끝난다`, res);
  }
  console.log(`\n${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[2] === "child") await child(process.argv[3] as Scenario);
else await parent();
