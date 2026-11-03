/**
 * 세션을 만들 때 provider를 비웠을 때의 정책과, provider 칸이 없는 옛 meta.json의 해석 — 모델 호출 0.
 *   0개 가용 → 409, 정확히 1개 → 그것으로 생성(meta에 기록), 2개 이상 → 400(가능한 id 목록 포함).
 *   등록되지 않은 이름은 400. 기본 provider는 없다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-provider-policy-")));
const ROOT = path.join(tmp, "root");
fs.mkdirSync(ROOT, { recursive: true });
process.env.AETHER_DATA_DIR = path.join(tmp, "data");
process.env.AETHER_PROJECT_ROOT = ROOT;

const express = (await import("express")).default;
const { __registerProviderForTest, providerEntry, storedProviderId } = await import("../providers/registry");
const { sessionsRouter } = await import("../routes/sessions");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("session_provider_policy"); // 임시 SQLite 일기
const { loadMeta } = await import("../sessions/persistence");
const mock = await import("./support/mockProvider");
import type { ProviderAvailability } from "../providers/types";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

// 네 provider id를 모두 가짜 항목으로 덮는다. 가용성은 시험이 정한다.
const IDS = ["claude", "codex", "grok", "ollama"] as const;
const avail: Record<string, boolean> = { claude: false, codex: false, grok: false, ollama: false };
const unregister = IDS.map((id) =>
  __registerProviderForTest({
    ...mock.mockEntry,
    id,
    codec: { ...mock.mockCodec, provider: id },
    services: {
      ...mock.mockServices,
      provider: id,
      displayName: `Fake-${id}`,
      availability: async (): Promise<ProviderAvailability> => (avail[id] ? { available: true } : { available: false, reason: "not_installed" }),
    },
  } as never),
);
const setAvail = (...on: string[]) => { for (const id of IDS) avail[id] = on.includes(id); };

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (body: Record<string, unknown>) =>
  fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ROOT, ...body }) });

try {
  // 1. 0개 가용 + provider 비움 → 409, 세션 수 그대로
  setAvail();
  {
    const before = sessionManager.list().length;
    const res = await post({});
    const body = (await res.json()) as { error?: string };
    check(res.status === 409 && !!body.error?.includes("쓸 수 있는 AI 서비스가 없"), "0개일 때 provider를 비우면 409 noProviderAvailable", { status: res.status, body });
    check(sessionManager.list().length === before, "거절하면 세션이 생기지 않는다");
  }

  // 2. 정확히 1개(codex) + provider 비움 → 201, 응답과 meta.json에 codex
  setAvail("codex");
  {
    const res = await post({});
    const body = (await res.json()) as { id?: string; provider?: string };
    check(res.status === 201 && body.provider === "codex", "1개일 때 비우면 201이고 응답 provider가 그 하나", { status: res.status, body });
    check(!!body.id && loadMeta(body.id)?.provider === "codex", "meta.json에 provider가 기록된다");
    if (body.id) sessionManager.delete(body.id);
  }

  // 3. 2개 이상(codex, grok) + provider 비움 → 400 providerRequired, 목록 포함
  setAvail("codex", "grok");
  {
    const before = sessionManager.list().length;
    const res = await post({});
    const body = (await res.json()) as { error?: string; providers?: string[] };
    check(res.status === 400 && !!body.error?.includes("provider를 지정"), "2개 이상일 때 비우면 400 providerRequired", { status: res.status, body });
    check(JSON.stringify(body.providers) === JSON.stringify(["codex", "grok"]) && !!body.error?.includes("codex, grok"), "쓸 수 있는 id 목록이 등록 순서대로 실린다", body);
    check(sessionManager.list().length === before, "거절하면 세션이 생기지 않는다");
    const blank = await post({ provider: "   " });
    check(blank.status === 400, "공백 provider도 비운 것으로 본다", blank.status);
  }

  // 4. provider를 적음: 못 쓰면 409, 쓰면 201
  setAvail("codex");
  {
    const no = await post({ provider: "grok" });
    check(no.status === 409, "적은 provider를 못 쓰면 409", no.status);
    const yes = await post({ provider: "codex" });
    const body = (await yes.json()) as { id?: string; provider?: string };
    check(yes.status === 201 && body.provider === "codex", "적은 provider를 쓸 수 있으면 201", yes.status);
    if (body.id) sessionManager.delete(body.id);
  }

  // 5. 등록되지 않은 이름 → 400
  {
    const res = await post({ provider: "no-such-provider" });
    check(res.status === 400, "등록되지 않은 이름은 400", res.status);
  }

  // 6. 매니저에 provider 없이 부르면 던진다(기본 provider가 없다)
  check((() => { try { sessionManager.create({ cwd: ROOT } as never); return false; } catch { return true; } })(), "sessionManager.create는 provider 없이 던진다");

  // 7. provider 칸이 없는 옛 meta.json → 복원하면 claude로 해석
  {
    const id = "11111111-2222-4333-8444-555555555555";
    const dir = path.join(tmp, "data", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: ROOT, model: "haiku", resumeKey: "legacy-key", createdAt: 1000 }));
    (await import("../sessions/persistence")).appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" } as never);
    sessionManager.restoreFromDisk();
    const listed = sessionManager.list().find((s) => s.id === id);
    check(listed?.provider === "claude", "옛 meta(provider 없음)는 목록에서 claude", listed?.provider);
    check(sessionManager.codecOf(id) === providerEntry("claude").codec, "옛 meta의 codec은 claude 항목의 것");
  }

  // 8. storedProviderId
  check(storedProviderId(undefined) === "claude" && storedProviderId("") === "claude" && storedProviderId("  ") === "claude", "storedProviderId: 비면 claude");
  check(storedProviderId("codex") === "codex", "storedProviderId: 값이 있으면 그대로");

  // 9. git이 아닌 폴더 + isolateWorkspace → 400이고 notGit 문구(일반 createFailed로 덮지 않는다)
  {
    const { st } = await import("../i18n");
    setAvail("codex");
    const res = await post({ provider: "codex", isolateWorkspace: true });
    const body = (await res.json()) as { error?: string };
    check(res.status === 400 && body.error === st("notice.workspace.notGit"), "git 아닌 폴더의 복사본 요청은 400이고 notGit 문구다", body);
  }
} finally {
  server.close();
  for (const off of unregister.reverse()) off();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
