/**
 * 격리 세션(isolated + mcpServers) — 모델 호출 0.
 *   요청 검증(400), Claude 외 provider 거부, meta 영속·복원, Claude 쿼리 옵션(격리 vs 보통).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-isolated-session-")));
const ROOT = path.join(tmp, "root");
fs.mkdirSync(ROOT, { recursive: true });
process.env.AETHER_DATA_DIR = path.join(tmp, "data");
process.env.AETHER_PROJECT_ROOT = ROOT;

const express = (await import("express")).default;
const { __registerProviderForTest } = await import("../providers/registry");
const { sessionsRouter } = await import("../routes/sessions");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("isolated_session");
const { loadMeta } = await import("../sessions/persistence");
const { claudeScope, parseIsolation, restoreIsolation } = await import("../sessions/isolation");
const mock = await import("./support/mockProvider");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const unregister = (["claude", "codex"] as const).map((id) =>
  __registerProviderForTest({
    ...mock.mockEntry,
    id,
    codec: { ...mock.mockCodec, provider: id },
    services: { ...mock.mockServices, provider: id, displayName: `Fake-${id}`, isolatedSession: id === "claude", availability: async () => ({ available: true }) },
  } as never),
);

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (body: Record<string, unknown>) =>
  fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ROOT, ...body }) });
const OK = "http://127.0.0.1:9000/mcp?ctx=a";

try {
  // 1. 400 케이스 — 세션이 생기지 않는다
  const bad: [string, Record<string, unknown>][] = [
    ["mcpServers만(isolated 없음)", { provider: "claude", mcpServers: { a: OK } }],
    ["isolated:false + mcpServers", { provider: "claude", isolated: false, mcpServers: { a: OK } }],
    ["isolated가 불리언 아님", { provider: "claude", isolated: "yes" }],
    ["이름 대문자", { provider: "claude", isolated: true, mcpServers: { Acme: OK } }],
    ["이름 숫자로 시작", { provider: "claude", isolated: true, mcpServers: { "1a": OK } }],
    ["이름 33자", { provider: "claude", isolated: true, mcpServers: { ["a".repeat(33)]: OK } }],
    ["원격 URL", { provider: "claude", isolated: true, mcpServers: { a: "http://example.com/mcp" } }],
    ["https 로컬", { provider: "claude", isolated: true, mcpServers: { a: "https://127.0.0.1:9000/mcp" } }],
    ["호스트 위장(127.0.0.1.evil.com)", { provider: "claude", isolated: true, mcpServers: { a: "http://127.0.0.1.evil.com/mcp" } }],
    ["userinfo 위장", { provider: "claude", isolated: true, mcpServers: { a: ["http://localhost", "evil.example/mcp"].join("\u0040") } }],
    ["URL이 문자열 아님", { provider: "claude", isolated: true, mcpServers: { a: 1 } }],
    ["배열", { provider: "claude", isolated: true, mcpServers: [OK] }],
    ["9개", { provider: "claude", isolated: true, mcpServers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, OK])) }],
    ["codex + isolated", { provider: "codex", isolated: true }],
  ];
  for (const [label, body] of bad) {
    const before = sessionManager.list().length;
    const res = await post(body);
    check(res.status === 400 && sessionManager.list().length === before, `400: ${label}`, res.status);
  }
  {
    const res = await post({ provider: "codex", isolated: true });
    const b = (await res.json()) as { error?: string };
    check(!!b.error?.includes("Claude"), "codex 거부 문구가 Claude 전용임을 알린다", b);
  }

  // 2. 정상 — 201, meta에 영속, 복원 가능
  {
    const res = await post({ provider: "claude", isolated: true, mcpServers: { acme: OK, local_2: "http://localhost:1/x" } });
    const b = (await res.json()) as { id?: string };
    check(res.status === 201 && !!b.id, "정상 격리 세션 201", res.status);
    const meta = b.id ? loadMeta(b.id) : null;
    check(meta?.isolation?.mcpServers?.acme === OK, "meta.json에 isolation이 저장된다", meta?.isolation);
    check(JSON.stringify(restoreIsolation(meta?.isolation)) === JSON.stringify(meta?.isolation), "meta에서 같은 값으로 복원된다");
    check(sessionManager.get(b.id!)?.isolation?.mcpServers?.acme === OK, "live 세션이 isolation을 든다");
    if (b.id) sessionManager.delete(b.id);
  }
  {
    const res = await post({ provider: "claude", isolated: true });
    const b = (await res.json()) as { id?: string };
    check(res.status === 201 && !!b.id && sessionManager.get(b.id)?.isolation !== undefined, "mcpServers 없는 isolated:true도 격리");
    if (b.id) sessionManager.delete(b.id);
  }
  {
    const res = await post({ provider: "claude" });
    const b = (await res.json()) as { id?: string };
    check(res.status === 201 && !!b.id && loadMeta(b.id)?.isolation === undefined, "보통 세션은 isolation이 없다");
    if (b.id) sessionManager.delete(b.id);
  }

  // 2b. 화면에서 숨김 — 목록·presence·GET /api/sessions에서 빠지고, 보통 세션은 그대로, 세션 API는 동작
  {
    const iso = (await (await post({ provider: "claude", isolated: true, mcpServers: { acme: OK } })).json()) as { id: string };
    const plain = (await (await post({ provider: "claude" })).json()) as { id: string };
    const seen: string[] = [];
    const off = sessionManager.subscribePresence((u) => seen.push(u.id));
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    check(!ids(sessionManager.list()).includes(iso.id) && ids(sessionManager.list()).includes(plain.id), "list(): 격리 세션만 빠진다");
    check(!ids(sessionManager.presenceSnapshot()).includes(iso.id) && ids(sessionManager.presenceSnapshot()).includes(plain.id), "presenceSnapshot: 격리 세션만 빠진다");
    const api = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: { id: string }[]; rooms: { sourceSessionId: string }[] };
    check(!ids(api.sessions).includes(iso.id) && !api.rooms.some((r) => r.sourceSessionId === iso.id) && ids(api.sessions).includes(plain.id), "GET /api/sessions: 격리 세션만 빠진다(200)");
    const tsk = await fetch(`${base}/api/sessions/${iso.id}/usage`);
    check(tsk.status !== 404, "격리 세션 API(/usage)는 그대로 동작", tsk.status);
    check(sessionManager.isExternal(iso.id) && !sessionManager.isExternal(plain.id), "isExternal 판정(live)");
    check(!seen.includes(iso.id), "presence 갱신이 격리 세션에서 나가지 않는다", seen);
    off();
    sessionManager.delete(iso.id);
    sessionManager.delete(plain.id);
  }

  // 3. 변조된 meta는 되살릴 때 다시 검증된다
  check(restoreIsolation({ mcpServers: { a: "http://evil.com/" } }) === undefined, "변조된 meta의 원격 URL은 복원되지 않는다");
  check(restoreIsolation(undefined) === undefined && restoreIsolation("x") === undefined, "isolation 없는 meta는 보통 세션");
  check("error" in parseIsolation({ isolated: true, mcpServers: "x" }), "parseIsolation: 문자열 mcpServers 거부");

  // 4. Claude 쿼리 옵션 — 격리 vs 보통
  const fakeAether = { name: "aether" };
  const normal = claudeScope(undefined, { aetherMcp: fakeAether, promptAppend: "APPEND", wantsTurnHook: true });
  check(JSON.stringify(normal.settingSources) === '["user","project","local"]', "보통: settingSources에 user 포함");
  check(JSON.stringify(Object.keys(normal.mcpServers ?? {})) === '["aether"]', "보통: aether MCP 주입");
  check(normal.promptAppend === "APPEND" && normal.turnHook === true, "보통: systemPrompt append와 턴 훅 유지");
  const iso = claudeScope({ mcpServers: { acme: OK } }, { aetherMcp: fakeAether, promptAppend: "APPEND", wantsTurnHook: true });
  check(JSON.stringify(iso.settingSources) === '["project","local"]', "격리: settingSources는 project,local");
  check(JSON.stringify(iso.mcpServers) === JSON.stringify({ acme: { type: "http", url: OK } }), "격리: HTTP MCP만, aether 없음", iso.mcpServers);
  check(iso.extraArgs?.["strict-mcp-config"] === null && normal.extraArgs === undefined, "격리: strict-mcp-config만 켠다(보통은 없음)");
  check(iso.promptAppend === "" && iso.turnHook === false, "격리: append 없음, 턴 훅 없음");
  check(claudeScope({ mcpServers: {} }, { promptAppend: "x", wantsTurnHook: true }).mcpServers === undefined, "격리 + MCP 없음: mcpServers 생략");
} finally {
  server.close();
  for (const off of unregister.reverse()) off();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
