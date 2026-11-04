/**
 * 권한 모드(manual·edits·auto·full) — 가짜 provider와 가짜 SDK, 모델 호출 0.
 * 옛 저장값 변환, 라이브·잠든 세션 API, 목록에 없는 값 거부, 새 세션 기본값, 모델 변경 뒤 수동으로 내림,
 * 그리고 어댑터 매핑(Claude 모드 문자열·Grok 인자·Codex 정책과 폴더 안 판정). Ollama 목록은 ollama_provider에서 본다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-data-")));
process.env.AETHER_DATA_DIR = DATA;

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("permission_modes"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const { ClaudeRuntime } = await import("../sessions/runtimes/claude");
const { grokAgentArgs } = await import("../providers/grok/args");
const { codexModePolicy, changesInsideFolder } = await import("../providers/codex/permissionPolicy");
const express = (await import("express")).default;
const { sessionsRouter } = await import("../routes/sessions");
const { config } = await import("../config");
type PermissionMode = import("../../shared/http").PermissionMode;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const eq = (name: string, a: unknown, b: unknown) => check(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const unregister = __registerProviderForTest(mock.mockEntry);
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-cwd-")));
const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${url}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, json };
}
const ALL: PermissionMode[] = ["manual", "edits", "auto", "full"];
const NO_AUTO: PermissionMode[] = ["manual", "edits", "full"];

console.log("\n=== 옛 저장값 변환(읽기 전용) ===");
{
  const base0 = { cwd, provider: mock.MOCK_PROVIDER, createdAt: 1 };
  store.saveMeta({ id: "legacy-true", ...base0, skipPermissions: true });
  store.saveMeta({ id: "legacy-false", ...base0, skipPermissions: false });
  store.saveMeta({ id: "legacy-none", ...base0 });
  store.saveMeta({ id: "new-wins", ...base0, skipPermissions: true, permissionMode: "auto" });
  eq("skipPermissions:true는 full", store.loadMeta("legacy-true")?.permissionMode, "full");
  eq("skipPermissions:false는 manual", store.loadMeta("legacy-false")?.permissionMode, "manual");
  eq("값이 없으면 manual(자동으로 올리지 않는다)", store.loadMeta("legacy-none")?.permissionMode, "manual");
  eq("새 칸이 있으면 새 칸이 이긴다", store.loadMeta("new-wins")?.permissionMode, "auto");
  check(!("skipPermissions" in (store.loadMeta("legacy-true") ?? {})), "읽은 결과에는 옛 칸이 남지 않는다");
}

console.log("\n=== 새 세션 기본값 ===");
{
  mock.mockState.permissionModes = [...ALL];
  const a = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  check(a.permissionMode === "manual", "시작 직후에는 좁은 쪽(수동)이다 — 어댑터 값이 오기 전에 넓어지지 않는다");
  check(await waitUntil(() => a.permissionMode === "auto"), "자동이 있으면 어댑터가 정한 자동으로 맞춘다", a.permissionMode);
  eq("목록과 현재 모드가 메타에 저장된다", [store.loadMeta(a.id)?.permissionMode, store.loadMeta(a.id)?.permissionModes], ["auto", ALL]);
  const b = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "edits" });
  await sleep(50);
  check(b.permissionMode === "edits", "명시한 시작 모드를 어댑터 기본값으로 덮지 않는다", b.permissionMode);
  mock.mockState.permissionModes = [...NO_AUTO];
  const c = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  check(await waitUntil(() => JSON.stringify(c.permissionModes) === JSON.stringify(NO_AUTO)), "refresh가 돌아 어댑터 목록을 받는다", c.permissionModes);
  check(c.permissionMode === "manual" && (await mock.lastMockRuntime!.permissionModes()).current === "manual", "자동이 없으면 수동으로 시작한다(어댑터도 수동)", c.permissionMode);
  check(!(store.readRecentEvents(c.id) as unknown as { notice?: string }[]).some((e) => e.notice === "permission_lowered"), "새 세션의 첫 기본값 확정은 알리지 않는다");
  const d = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "full" });
  check(d.permissionMode === "full", "full은 명시한 경우에 그대로 쓴다");
  for (const s of [a, b, c, d]) sessionManager.delete(s.id);
}

console.log("\n=== 살아 있는 세션 API ===");
{
  mock.mockState.permissionModes = [...ALL];
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await waitUntil(() => live.permissionMode === "auto");
  const list = await call("GET", `/api/sessions/${live.id}/permission-modes`);
  eq("목록과 현재 모드를 준다", [list.status, list.json], [200, { modes: ALL, current: "auto" }]);
  check((await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "yolo" })).status === 400, "정해진 값이 아니면 400");
  check((await call("POST", `/api/sessions/${live.id}/permissions`, { skipPermissions: true })).status === 400, "옛 skipPermissions 본문은 400");
  const full = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "full" });
  check(full.status === 200 && full.json.permissionMode === "full" && live.permissionMode === "full", "목록에 있는 값으로 바꾼다", full.json);
  eq("바꾼 값이 저장된다", store.loadMeta(live.id)?.permissionMode, "full");
  mock.mockState.permissionModes = [...NO_AUTO];
  const refused = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "auto" });
  check(refused.status === 400 && live.permissionMode !== "auto", "provider가 알려 준 목록에 없는 값은 거부한다", refused.json);
  check((await call("GET", `/api/sessions/no-such/permission-modes`)).status === 404, "없는 세션은 404");
  check((await call("POST", `/api/sessions`, { provider: mock.MOCK_PROVIDER, cwd, permissionMode: "yolo" })).status === 400, "생성 본문의 잘못된 값은 400");
  sessionManager.delete(live.id);
}

console.log("\n=== 모델을 바꾼 뒤 목록에서 빠지면 수동으로 내린다 ===");
{
  mock.mockState.permissionModes = [...ALL];
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await waitUntil(() => live.permissionMode === "auto");
  await live.setPermissionMode("auto"); // 사용자가 직접 고른 자동이다(기본값이 아니다)
  mock.mockState.permissionModes = [...NO_AUTO]; // 새 모델은 자동을 못 쓴다
  await live.setModel(mock.MOCK_ALT_MODEL);
  eq("현재 모드가 수동으로 내려간다", live.permissionMode, "manual");
  eq("어댑터에도 수동이 적용된다", (await mock.lastMockRuntime!.permissionModes()).current, "manual");
  eq("내린 값과 새 목록이 저장된다", [store.loadMeta(live.id)?.permissionMode, store.loadMeta(live.id)?.permissionModes], ["manual", NO_AUTO]);
  const notices = store.readRecentEvents(live.id).filter((e) => e.kind === "notice") as unknown as { notice: string; detail?: string }[];
  check(notices.some((n) => n.notice === "permission_lowered" && !!n.detail), "사용자가 알 수 있게 알림을 남긴다", notices);
  // 모드가 목록 안에 있으면 건드리지 않는다.
  await live.setPermissionMode("edits");
  await live.setModel("mock-small");
  eq("목록 안의 모드는 그대로 둔다", live.permissionMode, "edits");
  sessionManager.delete(live.id);
}

console.log("\n=== 잠든 세션: 깨우지 않고 저장된 목록으로 답한다 ===");
{
  store.saveMeta({ id: "sleeping-a", cwd, provider: mock.MOCK_PROVIDER, createdAt: 1, permissionMode: "manual", permissionModes: ["manual", "edits"] });
  store.saveMeta({ id: "sleeping-b", cwd, provider: mock.MOCK_PROVIDER, createdAt: 2, skipPermissions: true });
  store.appendEvent("sleeping-a", { seq: 1, ts: 1, kind: "user_msg", text: "안녕" } as never);
  store.appendEvent("sleeping-b", { seq: 1, ts: 1, kind: "user_msg", text: "안녕" } as never);
  sessionManager.restoreFromDisk();
  check(!sessionManager.get("sleeping-a"), "잠든 세션은 라이브가 아니다");
  eq("저장된 목록을 그대로 답한다", (await call("GET", "/api/sessions/sleeping-a/permission-modes")).json, { modes: ["manual", "edits"], current: "manual" });
  eq("목록이 없으면 manual·full만, 옛 true는 full", (await call("GET", "/api/sessions/sleeping-b/permission-modes")).json, { modes: ["manual", "full"], current: "full" });
  check((await call("POST", "/api/sessions/sleeping-a/permissions", { permissionMode: "auto" })).status === 400, "저장된 목록에 없는 값은 400");
  const ok = await call("POST", "/api/sessions/sleeping-a/permissions", { permissionMode: "edits" });
  check(ok.status === 200 && ok.json.deferred === true, "저장된 목록에 있는 값은 다음 깨울 때 적용(deferred)", ok.json);
  eq("메타에 저장된다", store.loadMeta("sleeping-a")?.permissionMode, "edits");
  check(!sessionManager.get("sleeping-a"), "바꿔도 깨우지 않는다");
  check((await call("POST", "/api/sessions/sleeping-b/permissions", { permissionMode: "auto" })).status === 400, "목록이 없는 잠든 세션은 auto를 못 받는다");
}


console.log("\n=== 경쟁과 실패 ===");
{
  const notices = (id: string) => (store.readRecentEvents(id) as unknown as { notice?: string }[]).filter((e) => e.notice === "permission_lowered").length;
  mock.mockState.permissionModes = [...ALL];
  // 되돌리기 경쟁: 먼저 시작한 변경이 늦게 실패해도 나중 선택을 덮지 않는다.
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "manual" });
  await sleep(30);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  mock.mockState.permissionSetHook = async (m) => {
    if (m === "full") {
      await gate;
      throw new Error("늦게 실패");
    }
  };
  const slow = live.setPermissionMode("full").catch(() => "failed");
  await sleep(20);
  eq("변경 중에는 새 값이 보인다", live.permissionMode, "full");
  // 변경 중의 목록 조회는 목록만 갱신하고 현재 모드를 옛 어댑터 값으로 덮지 않는다.
  const during = await live.listPermissionModes(2000);
  eq("변경 중 조회가 현재 모드를 덮지 않는다", [during.current, live.permissionMode], ["full", "full"]);
  await live.setPermissionMode("edits");
  release();
  eq("늦은 실패는", await slow, "failed");
  eq("나중 선택(edits)을 되돌리지 않는다", [live.permissionMode, store.loadMeta(live.id)?.permissionMode], ["edits", "edits"]);
  // 단독 실패: 어댑터가 실제로 적용 중인 값과 표시가 맞는다.
  mock.mockState.permissionSetHook = async (m) => {
    if (m === "auto") throw new Error("실패");
  };
  await live.setPermissionMode("auto").catch(() => {});
  eq("실패하면 어댑터 값과 같다", [live.permissionMode, (await mock.lastMockRuntime!.permissionModes()).current], ["edits", "edits"]);
  mock.mockState.permissionSetHook = undefined;
  sessionManager.delete(live.id);

  // 조회 실패: 어댑터를 수동으로 내리고 표시도 맞춘다. 실제가 표시보다 넓은 상태가 남지 않는다.
  mock.mockState.permissionModesFail = true;
  mock.mockState.permissionSets.length = 0;
  const failing = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "full" });
  check(await waitUntil(() => failing.permissionMode === "manual"), "조회가 실패하면 수동으로 내린다", failing.permissionMode);
  mock.mockState.permissionModesFail = false;
  eq("어댑터도 수동으로 내려갔다", [mock.mockState.permissionSets.at(-1), (await mock.lastMockRuntime!.permissionModes()).current], ["manual", "manual"]);
  check(notices(failing.id) === 1, "저장된 모드보다 낮아졌으니 알린다");
  // POST manual은 목록 확인 없이 적용된다(조회가 실패해도 넓은 모드에서 내려올 수 있다).
  await failing.setPermissionMode("full");
  mock.mockState.permissionModesFail = true;
  const down = await call("POST", `/api/sessions/${failing.id}/permissions`, { permissionMode: "manual" });
  check(down.status === 200 && failing.permissionMode === "manual", "조회가 실패해도 manual은 바로 적용된다", down.json);
  const up = await call("POST", `/api/sessions/${failing.id}/permissions`, { permissionMode: "edits" });
  check(up.status >= 400, "다른 모드는 조회 실패 때 막힌다", up.json);
  mock.mockState.permissionModesFail = false;
  sessionManager.delete(failing.id);

  // 복원: 저장된 모드가 어댑터 목록에 없으면 항상 refresh해서 낮추고 알린다.
  mock.mockState.permissionModes = [...NO_AUTO];
  const restored = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "auto" });
  check(await waitUntil(() => restored.permissionMode === "manual"), "복원된 세션도 refresh해서 낮춘다", restored.permissionMode);
  check(notices(restored.id) === 1, "낮아졌으면 항상 알린다");
  const kept = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "edits" });
  await waitUntil(() => !!kept.permissionModes);
  check(kept.permissionMode === "edits" && notices(kept.id) === 0, "목록 안의 저장 모드는 알림 없이 유지한다");
  for (const s of [restored, kept]) sessionManager.delete(s.id);

  // 끝난 세션: 준비 신호를 기다리지 않고 잠든 세션과 같은 기본 목록, 변경은 나중 적용.
  mock.mockState.permissionModes = [...ALL];
  const dead = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "manual" });
  await sleep(30);
  (dead as unknown as { ended: boolean }).ended = true;
  mock.mockState.handshakeDelayMs = 5000;
  const t0 = Date.now();
  const deadList = await call("GET", `/api/sessions/${dead.id}/permission-modes`);
  check(Date.now() - t0 < 1500 && deadList.status === 200 && deadList.json.modes.includes("full"), "끝난 세션은 기다리지 않고 저장 목록으로 답한다", deadList.json);
  const deferred = await call("POST", `/api/sessions/${dead.id}/permissions`, { permissionMode: "full" });
  check(deferred.status === 200 && deferred.json.deferred === true && Date.now() - t0 < 3000, "끝난 세션의 변경은 deferred", deferred.json);
  mock.mockState.handshakeDelayMs = 0;
  sessionManager.delete(dead.id);
}

console.log("\n=== 모델 지정 생성 ===");
{
  // 첫 턴 전의 새 세션에서 모델을 지정해 만들어도 경고 없이 새 모델 기준으로 정해진다.
  mock.mockState.permissionModes = [...ALL];
  const made = await sessionManager.createChecked({ cwd, provider: mock.MOCK_PROVIDER }, mock.MOCK_ALT_MODEL);
  await sleep(50);
  const lowered = (store.readRecentEvents(made.id) as unknown as { notice?: string }[]).filter((e) => e.notice === "permission_lowered");
  check(lowered.length === 0 && ["manual", "auto"].includes(made.permissionMode), "모델 지정 생성은 경고를 내지 않는다", { mode: made.permissionMode, lowered });
  sessionManager.delete(made.id);
}

console.log("\n=== 끊어진 링크와 링크 조각 ===");
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-dangling-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-dout-")));
  fs.symlinkSync(path.join(outside, "없는파일"), path.join(root, "dangling")); // 끊어진 링크
  fs.symlinkSync(path.join(outside, "없는폴더"), path.join(root, "dlink")); // 끊어진 폴더 링크
  check(!changesInsideFolder(root, ["dangling"]), "끊어진 링크가 밖을 가리키면 안 된다");
  check(!changesInsideFolder(root, ["dlink/x.txt"]), "끊어진 폴더 링크 아래도 안 된다");
  check(!changesInsideFolder(root, ["src/inside.txt", "../moved.txt"]), "이름 바꾸기의 도착 경로가 밖이면 안 된다");
}


console.log("\n=== 요청 순서 경쟁(409)과 응답 없는 어댑터(504) ===");
{
  mock.mockState.permissionModes = [...ALL];
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "manual" });
  await sleep(30);
  // A. 먼저 보낸 full이 목록 조회에 묶인 사이 나중에 보낸 manual이 적용되면, 조회가 끝나도 full이 덮어쓰면 안 된다.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  mock.mockState.permissionModesHook = async () => {
    if (held) return;
    held = true;
    await gate;
  };
  const first = call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "full" });
  await sleep(30);
  const second = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "manual" });
  check(second.status === 200, "나중 manual은 조회를 기다리지 않고 적용된다", second.json);
  release();
  const firstRes = await first;
  check(firstRes.status === 409 && !!firstRes.json.error, "조회 뒤 달라졌으면 적용하지 않고 409", firstRes.json);
  eq("최종 모드는 나중 선택(manual)이다", [live.permissionMode, (await mock.lastMockRuntime!.permissionModes()).current], ["manual", "manual"]);
  mock.mockState.permissionModesHook = undefined;

  // B. 어댑터가 응답하지 않아도 요청은 끝나고(504), 늦게 끝난 full은 어댑터에 남지 않는다.
  const savedTimeout = config.sessionReadyTimeoutMs;
  (config as { sessionReadyTimeoutMs: number }).sessionReadyTimeoutMs = 200;
  let lateRelease!: () => void;
  const lateGate = new Promise<void>((r) => (lateRelease = r));
  mock.mockState.permissionSetHook = async (m) => {
    if (m === "full") await lateGate;
  };
  const t0 = Date.now();
  const timed = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "full" });
  check(timed.status === 504 && Date.now() - t0 < 3000, "응답 없는 어댑터는 504로 끝난다", timed.json);
  eq("표시는 어댑터 실제 값(manual)으로 돌아간다", live.permissionMode, "manual");
  const after = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "edits" });
  check(after.status === 200 && live.permissionMode === "edits", "변경 중 표시가 남지 않아 다음 변경이 된다", after.json);
  await live.setPermissionMode("manual");
  lateRelease(); // 늦은 full이 이제 어댑터에 적용된다
  check(await waitUntil(() => mock.mockState.permissionSets.includes("full")), "늦은 full이 어댑터에 실제로 적용된다", mock.mockState.permissionSets.slice(-3));
  let adapterNow = "";
  check(await waitUntil(() => { void mock.lastMockRuntime!.permissionModes().then((r) => (adapterNow = r.current)); return adapterNow === "manual" && mock.mockState.permissionSets.at(-1) === "manual" && mock.mockState.permissionSets.lastIndexOf("full") < mock.mockState.permissionSets.length - 1; }), "늦은 full은 세션 값으로 다시 내려간다", mock.mockState.permissionSets.slice(-4));
  eq("어댑터 값이 세션과 같다", [live.permissionMode, (await mock.lastMockRuntime!.permissionModes()).current], ["manual", "manual"]);
  (config as { sessionReadyTimeoutMs: number }).sessionReadyTimeoutMs = savedTimeout;
  mock.mockState.permissionSetHook = undefined;
  sessionManager.delete(live.id);
}

console.log("\n=== 저장소 제어 폴더는 카드로 묻는다 ===");
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-ctl-")));
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  check(!changesInsideFolder(root, [".git/hooks/pre-commit"]), ".git/hooks 쓰기");
  check(!changesInsideFolder(root, [".GIT/config"]), "대소문자 달라도 .git");
  check(!changesInsideFolder(root, ["sub/.codex/config.toml"]), "하위 폴더의 .codex");
  check(!changesInsideFolder(root, [path.join(root, ".git", "hooks", "x")]), "절대 경로의 .git");
  check(!changesInsideFolder(root, ["a.txt", "x/.Git/y"]), "하나라도 제어 폴더면 전체가 아니다");
  check(changesInsideFolder(root, [".gitignore", "src/.github/ci.yml"]), ".gitignore·.github는 제어 폴더가 아니다");
}

console.log("\n=== Claude 어댑터 매핑 ===");
{
  const calls: string[] = [];
  const mk = (model: string | undefined, mode: PermissionMode, failSet = false) => {
    const qh = {
      supportedModels: async () => [
        { value: "default", displayName: "기본", description: "", supportsAutoMode: true },
        { value: "sonnet", displayName: "소넷", description: "", resolvedModel: "claude-sonnet-x", supportsAutoMode: true },
        { value: "haiku", displayName: "하이쿠", description: "", resolvedModel: "claude-haiku-x" },
      ],
      setPermissionMode: async (m: string) => {
        if (failSet) throw new Error("거부");
        calls.push(m);
      },
    };
    const rt = Object.create(ClaudeRuntime.prototype) as InstanceType<typeof ClaudeRuntime>;
    Object.assign(rt, { opts: { sessionId: "claude-map", cwd, onResumeKey: () => {} }, qh, model, permissionMode: mode, autoStart: Promise.resolve() });
    return rt;
  };
  const sonnet = mk("sonnet", "manual");
  eq("지원 모델은 네 모드", (await sonnet.permissionModes()).modes, ALL);
  eq("지원하지 않는 모델은 자동이 없다", (await mk("haiku", "manual").permissionModes()).modes, NO_AUTO);
  eq("모델을 안 골랐으면 기본 줄 기준", (await mk(undefined, "manual").permissionModes()).modes, ALL);
  eq("목록에 없는 모델은 자동이 없다", (await mk("모르는", "manual").permissionModes()).modes, NO_AUTO);
  for (const [mode, sdk] of [["manual", "default"], ["edits", "acceptEdits"], ["auto", "auto"], ["full", "bypassPermissions"]] as const) {
    calls.length = 0;
    await sonnet.setPermissionMode(mode);
    check(calls.join() === sdk && (await sonnet.permissionModes()).current === mode, `${mode} → SDK ${sdk}`, calls);
  }
  let err = "";
  await mk("haiku", "manual").setPermissionMode("auto").catch((e: Error) => (err = e.message));
  check(err !== "", "자동을 못 쓰는 모델에 auto를 주면 거부한다");
  // 시작 때 자동 올리기
  calls.length = 0;
  const up = mk("sonnet", "manual");
  await (up as unknown as { tryAutoMode(): Promise<void> }).tryAutoMode();
  check(calls.join() === "auto" && (await up.permissionModes()).current === "auto", "지원 모델이면 시작 뒤 자동으로 올린다", calls);
  calls.length = 0;
  const stay = mk("haiku", "manual");
  await (stay as unknown as { tryAutoMode(): Promise<void> }).tryAutoMode();
  check(calls.length === 0 && (await stay.permissionModes()).current === "manual", "지원하지 않으면 수동을 유지한다", calls);
  const broken = mk("sonnet", "manual", true);
  await (broken as unknown as { tryAutoMode(): Promise<void> }).tryAutoMode();
  check((await broken.permissionModes()).current === "manual", "전환이 실패해도 수동을 유지한다");
  // 모델을 바꾸면 목록이 새 모델 기준이 된다
  const sw = mk("sonnet", "auto");
  (sw as unknown as { qh: unknown }).qh = { ...((sw as unknown as { qh: object }).qh), setModel: async () => {} };
  await sw.setModel("haiku");
  const after = await sw.permissionModes();
  check(!after.modes.includes("auto") && after.current === "auto", "모델을 바꾸면 목록이 새 모델 기준이다(현재 모드가 목록 밖이면 공통 계층이 내린다)", after);
}

console.log("\n=== Grok 인자 ===");
{
  const flag = (mode: PermissionMode) => grokAgentArgs({ permissionMode: mode, model: "m" });
  eq("manual", flag("manual").slice(0, 4), ["--permission-mode", "default", "--sandbox", "workspace"]);
  eq("edits", flag("edits").slice(0, 4), ["--permission-mode", "acceptEdits", "--sandbox", "workspace"]);
  eq("auto", flag("auto").slice(0, 4), ["--permission-mode", "auto", "--sandbox", "workspace"]);
  eq("full은 전역 인자 없이 --always-approve", flag("full"), ["agent", "--no-leader", "--always-approve", "-m", "m", "stdio"]);
}

console.log("\n=== 잠든(해제된) 세션의 변경은 성공으로 답하지 않는다 ===");
{
  mock.mockState.permissionModes = [...ALL];
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "manual" });
  await sleep(30);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  mock.mockState.permissionModesHook = async () => {
    await gate;
  };
  const pending = call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "edits" });
  await sleep(30);
  live.dispose(); // 잠재우기가 끝난 뒤의 인스턴스와 같은 상태(disposed·ended)
  release();
  const res = await pending;
  mock.mockState.permissionModesHook = undefined;
  check(res.status === 400 && !res.json.deferred && !!res.json.error, "해제된 뒤 도착한 권한 변경은 400이고 deferred가 없다", res.json);
  eq("권한 모드는 이전 값 그대로", live.permissionMode, "manual");
  const modelBefore = live.model;
  const effortBefore = live.effort;
  const m = await live.setModel("other-model").then(() => "ok", () => "rejected");
  const e = await live.setEffort("high").then(() => "ok", () => "rejected");
  eq("해제된 인스턴스의 setModel·setEffort는 거부", [m, e], ["rejected", "rejected"]);
  eq("모델·강도 값도 안 바뀐다", [live.model, live.effort], [modelBefore, effortBefore]);
}

console.log("\n=== 진행 중 턴에 닿지 않는 변경 신호(deferred)는 공통 계층이 그대로 옮긴다 ===");
{
  mock.mockState.permissionModes = [...ALL];
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, permissionMode: "full" });
  await sleep(30);
  mock.mockState.permissionDeferred = true;
  const res = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "manual" });
  mock.mockState.permissionDeferred = false;
  eq("어댑터가 deferred로 답하면 응답에 deferred:true", [res.status, res.json.permissionMode, res.json.deferred], [200, "manual", true]);
  eq("저장값은 낮춘 모드", live.permissionMode, "manual");
  const plain = await call("POST", `/api/sessions/${live.id}/permissions`, { permissionMode: "edits" });
  check(plain.status === 200 && plain.json.deferred === undefined, "어댑터가 즉시 적용이라 답하면 deferred가 없다", plain.json);
}

console.log("\n=== Codex 정책 ===");
{
  eq("manual", codexModePolicy("manual"), { approvalPolicy: "untrusted", approvalsReviewer: "user", fullAccess: false });
  eq("edits", codexModePolicy("edits"), { approvalPolicy: "untrusted", approvalsReviewer: "user", fullAccess: false });
  eq("auto", codexModePolicy("auto"), { approvalPolicy: "on-request", approvalsReviewer: "auto_review", fullAccess: false });
  eq("full", codexModePolicy("full"), { approvalPolicy: "never", approvalsReviewer: "user", fullAccess: true });

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-folder-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-out-")));
  fs.writeFileSync(path.join(root, "a.txt"), "x");
  fs.symlinkSync(outside, path.join(root, "link"));
  check(changesInsideFolder(root, ["a.txt"]), "폴더 안 기존 파일");
  check(changesInsideFolder(root, ["new/deep/b.txt"]), "아직 없는 하위 폴더의 새 파일");
  check(changesInsideFolder(root, [path.join(root, "a.txt")]), "폴더 안 절대 경로");
  check(!changesInsideFolder(root, ["../x.txt"]), "..로 폴더 밖으로 나가면 안 된다");
  check(!changesInsideFolder(root, ["sub/../../x.txt"]), "중간의 ..로 나가도 안 된다");
  check(!changesInsideFolder(root, [path.join(outside, "x.txt")]), "폴더 밖 절대 경로");
  check(!changesInsideFolder(root, ["link/x.txt"]), "심볼릭 링크로 폴더 밖에 쓰는 경로");
  check(!changesInsideFolder(root, ["a.txt", "../x.txt"]), "하나라도 밖이면 전체가 아니다");
  check(!changesInsideFolder(root, []), "경로가 없으면 안 된 것으로 본다");
  check(!changesInsideFolder(root, ["a.txt", ""]), "빈 경로가 섞이면 안 된 것으로 본다");
  check(!changesInsideFolder(path.join(root, "없는폴더"), ["a.txt"]), "작업 폴더 자체를 못 풀면 안 된 것으로 본다");
}

server.close();
unregister();
console.log(`\n${fail === 0 ? "✅" : "❌"} 권한 모드: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
