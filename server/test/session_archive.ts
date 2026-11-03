/**
 * 세션 보관(archive) — 가짜 provider, 모델 호출 0.
 * 보관·해제·멱등·메타 영속·일하는 중 409·읽기 전용(message/wake/commands 409)·알림 억제·presence 전달.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PresenceSession } from "../../shared/http";
import type { NotifyIntent } from "../notify/worthNotifying";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-archive-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-archive-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { attachNotify } = await import("../notify/coordinator");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("session_archive"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const { config } = await import("../config");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const express = (await import("express")).default;
const { sessionsRouter } = await import("../routes/sessions");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const unregister = __registerProviderForTest(mock.mockEntry);
const sent: NotifyIntent[] = [];
sessionManager.setOnLive((session) => attachNotify(session, (intent) => sent.push(intent)));
const presence: PresenceSession[] = [];
const unsubPresence = sessionManager.subscribePresence((u) => presence.push(u));
const cwd = config.projectRootReal ?? config.projectRoot;
const item = (id: string) => sessionManager.list().find((s) => s.id === id);
const rt = () => mock.lastMockRuntime!;

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (id: string, sub: string, body: unknown) =>
  fetch(`${base}/api/sessions/${id}/${sub}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const archive = async (id: string, archived: unknown) => {
  const r = await post(id, "archive", { archived });
  return { status: r.status, body: (await r.json()) as { ok?: boolean; archivedAt?: number; error?: string } };
};

console.log("\n=== 살아 있는 세션 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    check(item(live.id)?.archivedAt === undefined, "처음엔 archivedAt 없음");
    const a = await archive(live.id, true);
    check(a.status === 200 && a.body.ok === true && typeof a.body.archivedAt === "number", "보관 200 + archivedAt", a);
    check(item(live.id)?.archivedAt === a.body.archivedAt, "목록에 archivedAt이 실린다");
    check(store.loadMeta(live.id)?.archivedAt === a.body.archivedAt, "meta.json에 영속");
    check(presence.some((p) => p.id === live.id && p.archivedAt === a.body.archivedAt), "presence로 전달");
    await sleep(5);
    const again = await archive(live.id, true);
    check(again.status === 200 && again.body.archivedAt === a.body.archivedAt, "다시 보관해도 시각 불변(멱등)", again);

    check((await post(live.id, "message", { text: "hi" })).status === 409, "보관된 세션 message 409");
    check((await post(live.id, "wake", {})).status === 409, "보관된 세션 wake 409");
    check((await post(live.id, "commands", { command: "compact" })).status === 409, "보관된 세션 commands 409");
    check((await post(live.id, "rewind", { seq: 1 })).status === 409, "보관된 세션 rewind 409");
    check((await post(live.id, "name", { name: "새 이름" })).status === 200, "이름 변경은 허용");

    // 알림·주의: 보관 중 끝난 턴은 알림도 sticky 표시도 없다
    const before = sent.length;
    rt().emitRaw({ t: "say", text: "x" });
    rt().emitRaw({ t: "done" });
    await sleep(200);
    check(sent.length === before, "보관된 세션은 알림을 내지 않는다", sent.slice(before));
    check(item(live.id)?.attention === "idle", "보관된 세션 attention=idle", item(live.id)?.attention);

    const off = await archive(live.id, false);
    check(off.status === 200 && off.body.ok === true && off.body.archivedAt === undefined, "해제 200", off);
    check(item(live.id)?.archivedAt === undefined && store.loadMeta(live.id)?.archivedAt === undefined, "해제 뒤 목록·meta에서 칸이 사라진다");
    check((await archive(live.id, false)).status === 200, "해제도 멱등");
    check(presence.some((p) => p.id === live.id && p.archivedAt === undefined), "해제도 presence로 전달");
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 요구 행동 대기 중이면 보관 409 (running·background는 같은 판정 분기) ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    live.push("ASK:x"); // 승인 카드를 띄우고 결정을 기다리는 가짜 입력
    check(await waitUntil(() => item(live.id)?.attention === "waiting"), "준비: waiting", item(live.id)?.attention);
    const w = await archive(live.id, true);
    check(w.status === 409 && !!w.body.error, "승인 대기 중이면 409", w);
    check(item(live.id)?.archivedAt === undefined, "보관 안 됨");
    for (const p of live.pendingPermissions()) live.resolvePermission(p.id, "deny");
    check(await waitUntil(() => item(live.id)?.attention !== "waiting"), "대기 해소");
    await sleep(100);
    check((await archive(live.id, true)).status === 200, "대기가 풀리면 보관 가능");
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 입력이 처리 중이면 표시가 꺼져 있어도 보관 409 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    const pushed = live.push("a"); // 기록·전달이 끝나기 전 — 아직 일하는 중 표시가 켜지기 전 틈
    check(live.hasPendingInput, "준비: 처리 중인 입력이 있다");
    check(sessionManager.setArchived(live.id, true) === "busy" && item(live.id)?.archivedAt === undefined, "입력 처리 중 보관은 busy(=409 경로)");
    await pushed;
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 잠든(디스크) 세션 ===");
{
  fs.mkdirSync(path.join(DATA, "d1"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "d1", "meta.json"), JSON.stringify({ id: "d1", cwd: ROOT, provider: mock.MOCK_PROVIDER, resumeKey: "k", createdAt: 1000 }));
  sessionManager.restoreFromDisk();
  const a = await archive("d1", true);
  check(a.status === 200 && typeof a.body.archivedAt === "number", "디스크 세션 보관 200", a);
  check(item("d1")?.archivedAt === a.body.archivedAt && store.loadMeta("d1")?.archivedAt === a.body.archivedAt, "목록·meta 반영");
  check(!sessionManager.get("d1"), "보관해도 깨우지 않는다");
  check((await post("d1", "message", { text: "hi" })).status === 409, "디스크 세션 message 409");
  check((await post("d1", "wake", {})).status === 409 && !sessionManager.get("d1"), "디스크 세션 wake 409 + 깨어나지 않음");
  // 재시작 시뮬레이션: 메모리 목록을 다시 읽어 와도 유지
  sessionManager.restoreFromDisk();
  check(item("d1")?.archivedAt === a.body.archivedAt, "디스크 복원 뒤에도 유지");
  check((await archive("d1", false)).status === 200 && item("d1")?.archivedAt === undefined, "해제");
  check((await post("d1", "wake", {})).status === 200, "해제 뒤 wake 가능");
  sessionManager.delete("d1");
}

console.log("\n=== 보관된 세션을 매니저가 다시 만들어도 보관 상태가 유지된다 ===");
{
  fs.mkdirSync(path.join(DATA, "d2"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "d2", "meta.json"), JSON.stringify({ id: "d2", cwd: ROOT, provider: mock.MOCK_PROVIDER, resumeKey: "k", createdAt: 1000 }));
  sessionManager.restoreFromDisk();
  const a = await archive("d2", true);
  const woke = sessionManager.getOrResume("d2"); // 라우트는 막지만 매니저 직접 호출은 가능
  check(woke.archivedAt === a.body.archivedAt && store.loadMeta("d2")?.archivedAt === a.body.archivedAt, "디스크에서 깨워도 archivedAt 유지", woke.archivedAt);
  sessionManager.delete("d2");
}

console.log("\n=== 오류 ===");
{
  check((await archive("00000000-0000-4000-8000-000000000000", true)).status === 404, "없는 세션 404");
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    check((await archive(live.id, "yes")).status === 400, "archived가 boolean이 아니면 400");
    check((await post(live.id, "archive", {})).status === 400, "body 없으면 400");
  } finally {
    sessionManager.delete(live.id);
  }
}

server.close();
unsubPresence();
sessionManager.setOnLive(undefined);
unregister();
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} session_archive: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
