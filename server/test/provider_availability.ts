/**
 * provider를 지금 쓸 수 있는지 확인하고, 못 쓰면 세션을 만들지 않는지 — 모델 호출 0.
 * 실행 프로그램이 없는 provider, 로그인 안 된 provider, 꺼진 Ollama를 가짜로 꾸민다.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aether-availability-"));
process.env.AETHER_DATA_DIR ??= path.join(tmp, "data");
// 실 CLI를 부르지 않게 경로를 바꿔 둔다. claude·grok은 없는 파일, codex는 바로 끝나는 가짜 프로그램이다.
const fakeBin = path.join(tmp, "fake-codex");
fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
process.env.AETHER_CLAUDE_BIN = path.join(tmp, "no-claude");
process.env.AETHER_GROK_BIN = path.join(tmp, "no-grok");
process.env.AETHER_CODEX_BIN = fakeBin;

// 가짜 Ollama. models 값을 바꿔 가며 답한다.
let ollamaModels: unknown[] = [{ name: "tiny:latest", model: "tiny:latest" }];
const ollama = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: ollamaModels }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
ollama.listen(0);
await new Promise<void>((resolve) => ollama.once("listening", resolve));
process.env.AETHER_OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;

const express = (await import("express")).default;
const { isCommandInstalled, cliAvailability } = await import("../providers/installed");
const { ollamaAvailability } = await import("../providers/ollama/models");
const { __registerProviderForTest, providerAvailability } = await import("../providers/registry");
const { rememberModelList } = await import("../providers/modelCatalogMemory");
const { sessionsRouter } = await import("../routes/sessions");
const { providersRouter } = await import("../routes/providers");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("provider_availability"); // 임시 SQLite 일기
const { config } = await import("../config");
const mock = await import("./support/mockProvider");
import type { ProviderAuth, ProviderAvailability } from "../providers/types";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

function fakeAuth(status: () => Promise<{ loggedIn: boolean }>): ProviderAuth & { calls: number } {
  const auth = {
    calls: 0,
    async status() {
      auth.calls++;
      return status();
    },
    start: async () => ({ mode: "deviceCode" as const, loginId: "x", url: "", userCode: "" }),
    poll: async () => ({ status: "error" as const }),
    cancel() {},
    disposeAll() {},
  };
  return auth;
}

// ① 설치 확인
check(isCommandInstalled(process.execPath), "절대경로의 실행 파일은 설치된 것으로 본다");
check(!isCommandInstalled(path.join(tmp, "missing")), "없는 절대경로는 설치 안 됨");
check(!isCommandInstalled(path.join(tmp)), "폴더는 실행 프로그램이 아니다");
{
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "aether-fake-tool"), "#!/bin/sh\n", { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prev ?? ""}`;
  check(isCommandInstalled("aether-fake-tool"), "이름만 주면 PATH에서 찾는다");
  process.env.PATH = prev;
  check(!isCommandInstalled("aether-fake-tool"), "PATH에 없으면 설치 안 됨");
}

// ② 프로그램과 로그인 확인
{
  const auth = fakeAuth(async () => ({ loggedIn: true }));
  const r = await cliAvailability(path.join(tmp, "missing"), auth);
  check(!r.available && r.reason === "not_installed", "프로그램이 없으면 not_installed", r);
  check(auth.calls === 0, "프로그램이 없으면 로그인은 묻지 않는다");
}
check((await cliAvailability(process.execPath, fakeAuth(async () => ({ loggedIn: true })))).available, "프로그램 있고 로그인돼 있으면 쓸 수 있다");
{
  const r = await cliAvailability(process.execPath, fakeAuth(async () => ({ loggedIn: false })));
  check(!r.available && r.reason === "logged_out", "로그인 안 됐으면 logged_out", r);
}
{
  const r = await cliAvailability(process.execPath, fakeAuth(async () => { throw new Error("status down"); }));
  check(!r.available && r.reason === "check_failed", "상태 조회가 던지면 check_failed", r);
}

// ③ Ollama 확인
check((await ollamaAvailability()).available, "Ollama가 응답하고 모델이 있으면 쓸 수 있다");
ollamaModels = [];
{
  const r = await ollamaAvailability();
  check(!r.available && r.reason === "no_models", "모델이 없으면 no_models", r);
}
ollamaModels = [{ name: "tiny:latest", model: "tiny:latest" }];
await new Promise<void>((resolve) => ollama.close(() => resolve()));
{
  const r = await ollamaAvailability();
  check(!r.available && r.reason === "unreachable", "Ollama가 꺼져 있으면 unreachable", r);
}

// ④ 등록표 확인: 어댑터가 던지면 check_failed
let mockAvailability: () => Promise<ProviderAvailability> = async () => ({ available: true });
const entry = { ...mock.mockEntry, services: { ...mock.mockServices, availability: () => mockAvailability() } };
const unregister = __registerProviderForTest(entry);
mockAvailability = async () => { throw new Error("boom"); };
{
  const r = await providerAvailability(entry);
  check(!r.available && r.reason === "check_failed", "확인이 던지면 check_failed", r);
}

// ⑤ 라우트: 목록과 세션 만들기 거절
const app = express();
app.use(express.json());
app.use("/api/providers", providersRouter);
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const cwd = config.projectRootReal ?? config.projectRoot;
const create = (provider: string) =>
  fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, provider }) });

try {
  mockAvailability = async () => ({ available: false, reason: "logged_out" });
  const listed = (await (await fetch(`${base}/api/providers/availability`)).json()) as { availability: Record<string, ProviderAvailability> };
  const a = listed.availability;
  check(a[mock.MOCK_PROVIDER]?.available === false, "목록에 가짜 provider의 결과가 들어 있다", a[mock.MOCK_PROVIDER]);
  check(a.claude?.available === false && !a.claude.available && a.claude.reason === "not_installed", "claude 프로그램이 없으면 not_installed", a.claude);
  check(a.grok?.available === false && !a.grok.available && a.grok.reason === "not_installed", "grok 프로그램이 없으면 not_installed", a.grok);
  check(a.codex?.available === false, "codex 로그인 확인이 실패하면 고를 수 없다", a.codex);
  check(a.ollama?.available === false && !a.ollama.available && a.ollama.reason === "unreachable", "꺼진 Ollama는 unreachable", a.ollama);

  // SDK만 못 불러온 사유는 "프로그램 없음"과 다른 문구로 거절한다.
  mockAvailability = async () => ({ available: false, reason: "sdk_unavailable" });
  const sdkRefused = await create(mock.MOCK_PROVIDER);
  const sdkBody = (await sdkRefused.json()) as { error?: string };
  check(sdkRefused.status === 409 && !!sdkBody.error && sdkBody.error.includes("구성 요소") && !sdkBody.error.includes("이 컴퓨터에 없어"), "sdk_unavailable은 구성 요소 문구로 거절한다", sdkBody);
  mockAvailability = async () => ({ available: false, reason: "logged_out" });

  const before = sessionManager.list().length;
  const refused = await create(mock.MOCK_PROVIDER);
  const body = (await refused.json()) as { error?: string };
  check(refused.status === 409, "쓸 수 없는 provider면 409", refused.status);
  check(!!body.error && body.error.includes(mock.mockServices.displayName), "거절 문구에 서비스 이름이 들어 있다", body);
  check(sessionManager.list().length === before, "거절하면 세션이 생기지 않는다");

  const missing = await create("claude");
  check(missing.status === 409, "프로그램이 없는 claude로도 세션을 만들지 않는다", missing.status);

  mockAvailability = async () => ({ available: true });
  const ok = await create(mock.MOCK_PROVIDER);
  const made = (await ok.json()) as { id?: string };
  check(ok.status === 201 && !!made.id, "쓸 수 있으면 그대로 만든다", ok.status);
  if (made.id) sessionManager.delete(made.id);

  // 저장해 둔 모델 목록: 처음엔 비어 있고, 저장 뒤에는 기본값 선택지 없이 실제 모델만 나온다.
  const remembered = async () => ((await (await fetch(`${base}/api/providers/remembered-models`)).json()) as { models: Record<string, { value: string }[]> }).models;
  check((await remembered())[mock.MOCK_PROVIDER]?.length === 0, "저장된 목록이 없으면 빈 목록", await remembered());
  rememberModelList(mock.MOCK_PROVIDER, [
    { value: "default", displayName: "기본", followsAccountDefault: true },
    { value: "mock-a", displayName: "Mock A", isDefault: true },
  ]);
  const saved = (await remembered())[mock.MOCK_PROVIDER];
  check(saved?.length === 1 && saved[0].value === "mock-a", "저장된 실제 모델만 돌려준다", saved);

  const unknown = await create("no-such-provider");
  check(unknown.status === 400, "등록되지 않은 이름은 예전처럼 400", unknown.status);
} finally {
  server.close();
  unregister();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
