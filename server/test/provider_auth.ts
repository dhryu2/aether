/**
 * 인증 계약 게이트 (Phase 8f 단위 1) — 모델 호출 0.
 *
 * 지키려는 문장 하나: **"로그인 방식이 반대인 provider도 같은 라우트로 끝까지 갈 수 있다."**
 *
 * 8f 이전 계약은 한쪽만 가정했다. 서버가 주소를 주고 사용자가 코드를 되돌려 보내는 Claude 방식이다.
 * Codex 기기 코드 로그인은 반대다 — 서버가 주소와 코드를 함께 주고, 되돌려 보낼 코드가 없으며, 완료는
 * 나중에 알림으로 온다. 그래서 세 가지를 여기서 반증한다.
 *
 *   ① 시작 응답이 방식을 밝히고, 기기 코드 방식이면 코드가 함께 온다.
 *   ② 코드를 안 받는 provider에 코드를 제출하면 **거부된다**. 받아 놓고 무시하면 화면은 제출에 성공했다고
 *      믿고 완료를 기다리는데, 그 로그인은 영원히 안 끝난다.
 *   ③ 완료 확인 통로가 실제로 pending → success로 넘어간다. 이게 없으면 기기 코드 방식은 끝난 줄을 모른다.
 *
 * 여기에 더해 인증 구현이 아예 없는 provider(501)와 등록되지 않은 이름(404)이 조용히 통과하지 않는지 본다.
 * 마지막으로 Claude 구현이 새 통로에 답하는지 확인한다 — PTY를 띄우지 않는 조회만 쓴다(실 로그인은 8i).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 세션 저장소가 진짜 데이터 폴더를 건드리지 않게 — config import보다 먼저.
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-auth-"));
process.env.AETHER_ENABLE_PROVIDER_RELOGIN = "1";

const express = (await import("express")).default;
const { __registerProviderForTest } = await import("../providers/registry");
const { providerAuthRouter } = await import("../routes/providerAuth");
const { claudeLogin } = await import("../auth/claudeLogin");
const mock = await import("./support/mockProvider");
import type { LoginProgress, LoginStart, ProviderAuth, ProviderServices } from "../providers/types";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const app = express();
app.use(express.json());
app.use("/api/provider-auth", providerAuthRouter);
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const mockAuth = (leaf: string) => `/api/provider-auth/${mock.MOCK_PROVIDER}/${leaf}`;

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, json };
}

/** 등록표의 가짜 세 번째 자리에 임시로 끼워 넣고 검사 뒤 원복한다. */
async function withAuth<T>(auth: ProviderAuth | undefined, fn: () => Promise<T>): Promise<T> {
  const services: ProviderServices = { ...mock.mockServices, auth };
  const off = __registerProviderForTest({ ...mock.mockEntry, services });
  try {
    return await fn();
  } finally {
    off();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 기기 코드 방식 — 서버가 주소와 코드를 함께 주고, 완료는 나중에 온다
// ────────────────────────────────────────────────────────────────────────────

/** 완료가 비동기로 오는 로그인. `finish()`를 부르기 전까지는 진행 중이다. */
function deviceAuth() {
  let outcome: LoginProgress = { status: "pending" };
  let cancelled = 0;
  const impl: ProviderAuth = {
    status: async () => ({ loggedIn: false }),
    start: async (): Promise<LoginStart> => ({ mode: "deviceCode", loginId: "dev-1", url: "https://example.invalid/device", userCode: "ABCD-EFGH" }),
    // submitCode 없음 — 되돌려 보낼 코드가 없는 방식이다.
    poll: async (loginId) => (loginId === "dev-1" ? outcome : { status: "error", message: "모르는 로그인" }),
    cancel: () => {
      cancelled++;
    },
    disposeAll: () => {},
  };
  return { impl, finish: (o: LoginProgress) => (outcome = o), cancelled: () => cancelled };
}

const dev = deviceAuth();
await withAuth(dev.impl, async () => {
  const started = await call("POST", mockAuth("start"));
  check(started.status === 200 && started.json?.mode === "deviceCode", "① 시작 응답이 기기 코드 방식임을 밝힌다", started.json);
  check(started.json?.userCode === "ABCD-EFGH" && !!started.json?.url, "① 주소와 코드가 함께 온다(사용자가 그 화면에서 끝낸다)", started.json);

  const submitted = await call("POST", mockAuth("code"), { loginId: "dev-1", code: "1234" });
  check(submitted.status === 501, "② 코드를 안 받는 방식에 코드를 제출하면 거부된다(성공한 척 금지)", submitted);

  const before = await call("POST", mockAuth("poll"), { loginId: "dev-1" });
  check(before.status === 200 && before.json?.status === "pending", "③ 완료 전에는 진행 중으로 답한다", before.json);

  dev.finish({ status: "success", message: "끝" });
  const after = await call("POST", mockAuth("poll"), { loginId: "dev-1" });
  check(after.json?.status === "success", "③ 완료 알림이 오면 확인 통로가 성공으로 바뀐다", after.json);

  const unknown = await call("POST", mockAuth("poll"), { loginId: "없는-로그인" });
  check(unknown.json?.status === "error", "모르는 로그인 식별자는 오류로 끝난다(영원히 도는 화면 방지)", unknown.json);

  const noId = await call("POST", mockAuth("poll"), {});
  check(noId.status === 400, "완료 확인에 loginId가 없으면 400", noId);

  await call("POST", mockAuth("cancel"), { loginId: "dev-1" });
  check(dev.cancelled() === 1, "취소가 provider 구현까지 도달한다");
});

// ────────────────────────────────────────────────────────────────────────────
// 2. 코드 제출 방식 — 기존 흐름이 그대로 성립한다(무회귀)
// ────────────────────────────────────────────────────────────────────────────

await withAuth(mock.mockServices.auth, async () => {
  const started = await call("POST", mockAuth("start"));
  check(started.json?.mode === "submitCode" && !("userCode" in (started.json ?? {})), "코드 제출 방식은 방식만 밝히고 코드를 주지 않는다", started.json);

  const ok = await call("POST", mockAuth("code"), { loginId: "mock-login", code: "1234" });
  check(ok.status === 200 && ok.json?.status === "success", "코드 제출 흐름은 그대로 성립한다", ok.json);

  const bad = await call("POST", mockAuth("code"), { loginId: "mock-login", code: "   " });
  check(bad.status === 400, "빈 코드는 400", bad);

  const polled = await call("POST", mockAuth("poll"), { loginId: "mock-login" });
  check(polled.json?.status === "pending", "코드 제출 방식도 완료 확인 통로에 답한다", polled.json);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 인증 구현이 없는 provider / 등록되지 않은 이름
// ────────────────────────────────────────────────────────────────────────────

await withAuth(undefined, async () => {
  for (const [method, url] of [
    ["POST", mockAuth("start")],
    ["POST", mockAuth("poll")],
    ["POST", mockAuth("cancel")],
  ] as const) {
    const r = await call(method, url, method === "POST" ? {} : undefined);
    check(r.status === 501, `인증 구현이 없는 provider의 ${url.split("/").pop()}는 501`, r);
  }
});

const unregistered = await call("POST", "/api/provider-auth/gemini/poll", {});
check(unregistered.status === 404, "등록되지 않은 provider 이름은 404(조용한 fallback 금지)", unregistered);

// ────────────────────────────────────────────────────────────────────────────
// 4. Claude 구현이 새 통로에 답하는가 — PTY를 띄우지 않는 조회만 쓴다
// ────────────────────────────────────────────────────────────────────────────

const claudeUnknown = await claudeLogin.poll("진행-중이-아닌-로그인");
check(claudeUnknown.status === "error", "Claude: 진행 중이 아닌 로그인은 오류로 답한다", claudeUnknown);
check(typeof claudeLogin.submitCode === "function", "Claude: 코드 제출 방식이므로 submitCode를 갖는다");

await new Promise<void>((r) => server.close(() => r()));
console.log(`\n${fail === 0 ? "✅" : "❌"} provider_auth: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
