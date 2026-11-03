/**
 * 실행 프로그램 찾기 — 모델 호출 0.
 *   PATH를 직접 훑는 findOnPath, 못 찾았을 때 저장하지 않아 설치 직후 재시작 없이 잡히는 경로 찾기,
 *   Ollama가 Codex 프로그램을 필요로 한다는 사실이 사용 불가 응답과 REST 409 문구에 실리는지.
 * 이 맥의 실제 PATH·HOME·데이터 폴더를 건드리지 않도록 모두 임시 폴더로 바꾸고, 끝나면 되돌린다.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-provider-install-")));
const BIN = path.join(tmp, "bin");
const HOME = path.join(tmp, "home");
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });

const saved = { PATH: process.env.PATH, HOME: process.env.HOME, PATHEXT: process.env.PATHEXT };
for (const k of ["AETHER_CLAUDE_BIN", "AETHER_CODEX_BIN", "AETHER_GROK_BIN"]) delete process.env[k];
delete process.env.PATHEXT;
process.env.PATH = BIN;
process.env.HOME = HOME;
process.env.AETHER_DATA_DIR = path.join(tmp, "data");
process.env.AETHER_PROJECT_ROOT = tmp;
process.env.AETHER_ENABLE_PROVIDER_RELOGIN = "1";

// 모델을 주는 가짜 Ollama 서버 — 응답 가능한 서버가 있어도 Codex가 없으면 쓸 수 없음을 보이기 위한 것이다.
const fakeOllama = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ models: [{ name: "fake:1b", model: "fake:1b" }] }));
});
await new Promise<void>((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
process.env.AETHER_OLLAMA_URL = `http://127.0.0.1:${(fakeOllama.address() as { port: number }).port}`;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

function makeExecutable(name: string) {
  const file = path.join(BIN, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

let server: http.Server | undefined;
try {
  const { findOnPath } = await import("../providers/installed");
  const { resolveClaudeBin } = await import("../auth/claudeLogin");
  const { resolveCodexBin } = await import("../codex/appServer");
  const { resolveGrokBin, resetGrokBinCache } = await import("../providers/grok/transport");
  const { ollamaAvailability } = await import("../providers/ollama/models");
  const express = (await import("express")).default;
  const { sessionsRouter } = await import("../routes/sessions");
  const { providerAuthRouter } = await import("../routes/providerAuth");

  // 1. findOnPath
  check(findOnPath("aether-nothing-here") === null, "PATH에 없는 이름은 null이다");
  const sample = makeExecutable("aether-sample");
  check(findOnPath("aether-sample") === sample, "PATH의 실행 파일은 절대경로로 찾는다", findOnPath("aether-sample"));
  fs.writeFileSync(path.join(BIN, "aether-plain"), "x");
  fs.chmodSync(path.join(BIN, "aether-plain"), 0o644);
  check(findOnPath("aether-plain") === null, "실행 권한이 없는 파일은 찾지 않는다");

  // 2. 못 찾으면 이름만 돌려주고 저장하지 않아, 설치한 뒤 다시 부르면 절대경로를 준다
  check(resolveClaudeBin() === "claude", "claude가 없으면 이름만 돌려준다", resolveClaudeBin());
  check(resolveCodexBin() === "codex", "codex가 없으면 이름만 돌려준다", resolveCodexBin());
  check(resolveGrokBin() === "grok", "grok이 없으면 이름만 돌려준다", resolveGrokBin());

  // 2-1. Grok은 PATH에 없어도 설치 프로그램의 기본 위치(~/.grok/bin)를 어댑터가 직접 찾는다
  fs.mkdirSync(path.join(HOME, ".grok", "bin"), { recursive: true });
  const homeGrok = path.join(HOME, ".grok", "bin", "grok");
  fs.writeFileSync(homeGrok, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(homeGrok, 0o755);
  check(resolveGrokBin() === homeGrok, "PATH에 없어도 ~/.grok/bin의 grok을 찾는다", resolveGrokBin());
  fs.rmSync(path.join(HOME, ".grok"), { recursive: true, force: true });
  resetGrokBinCache();

  // 3. Codex가 없으면 모델을 주는 Ollama 서버가 있어도 Codex가 필요하다고 답한다
  const missing = await ollamaAvailability();
  check(!missing.available && missing.reason === "not_installed" && missing.requires === "Codex", "Codex가 없으면 ollama는 requires: Codex를 준다", missing);

  // 4. REST 409 문구에 Codex가 들어 있다
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/provider-auth", providerAuthRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const res = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: tmp, provider: "ollama" }) });
  const body = (await res.json()) as { error?: string };
  check(res.status === 409 && !!body.error?.includes("Codex"), "ollama 세션 요청은 409이고 문구에 Codex가 들어 있다", { status: res.status, body });

  // 5. 로그인 시작도 409이고, 세션 생성 문구가 아니라 로그인 문구가 나온다
  for (const provider of ["grok"]) {
    const login = await fetch(`${base}/api/provider-auth/${provider}/start`, { method: "POST" });
    const loginBody = (await login.json()) as { error?: string };
    check(login.status === 409 && !!loginBody.error?.includes("로그인") && !loginBody.error?.includes("세션"), `${provider} 로그인 시작은 409이고 문구에 로그인이 들어 있다`, { status: login.status, loginBody });
  }

  // 설치한 뒤에는 재시작 없이 절대경로로 잡힌다
  const claude = makeExecutable("claude");
  const codex = makeExecutable("codex");
  const grok = makeExecutable("grok");
  check(resolveClaudeBin() === claude, "claude를 설치하면 다시 불러 절대경로를 준다", resolveClaudeBin());
  check(resolveCodexBin() === codex, "codex를 설치하면 다시 불러 절대경로를 준다", resolveCodexBin());
  check(resolveGrokBin() === grok, "grok을 설치하면 다시 불러 절대경로를 준다", resolveGrokBin());
  const found = await ollamaAvailability();
  check(found.available === true, "Codex가 생기면 ollama를 쓸 수 있다", found);
} finally {
  server?.close();
  fakeOllama.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "✅" : "❌"} provider_install: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
