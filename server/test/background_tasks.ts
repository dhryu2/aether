/**
 * 뒤 작업(턴이 끝난 뒤에도 백그라운드 작업) 흐름 — 가짜 provider, 모델 호출 0.
 *
 * 입력 → 뒤 작업 시작 → 턴 끝 → (백그라운드 작업 중, 완료 없음) → 뒤 작업 모두 끝남 → (보류) → 스스로 시작한 턴 → 턴 끝 → 완료 1회.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PresenceSession } from "../../shared/http";
import type { NotifyIntent } from "../notify/worthNotifying";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-bg-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-bg-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { attachNotify } = await import("../notify/coordinator");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("background_tasks"); // 임시 SQLite 일기
const { BACKGROUND_HOLD_MS } = await import("../sessions/LiveSession");
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
const attOf = (id: string) => sessionManager.list().find((s) => s.id === id)?.attention;
const rt = () => mock.lastMockRuntime!;
const doneCount = () => sent.filter((i) => i.kind === "done").length;

console.log("\n=== 뒤 작업이 남은 채 턴이 끝나고, 깨움 턴이 완료를 만든다 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    rt().emitRaw({ t: "bg", tasks: ["1"] });
    live.push("go");
    check(await waitUntil(() => attOf(live.id) === "background"), "턴이 끝나도 뒤 작업이 있으면 background", attOf(live.id));
    check(live.backgroundTasks.length === 1 && live.backgroundTasks[0].id === "1", "목록에 뒤 작업이 실린다");
    check(doneCount() === 0, "완료 알림이 아직 없다");
    check(live.attentionSticky === undefined, "완료 표시(sticky)가 아직 없다");

    rt().emitRaw({ t: "bg", tasks: [] });
    check(await waitUntil(() => live.backgroundHoldUntil !== undefined), "목록이 비면 보류가 걸린다");
    check(attOf(live.id) === "background", "보류 안에서는 여전히 background", attOf(live.id));
    check(doneCount() === 0, "보류 중에도 완료 알림이 없다");

    rt().emitRaw({ t: "start" });
    check(await waitUntil(() => attOf(live.id) === "running"), "스스로 시작한 턴은 running", attOf(live.id));
    rt().emitRaw({ t: "say", text: "정리 끝" });
    rt().emitRaw({ t: "done" });
    check(await waitUntil(() => attOf(live.id) === "done"), "깨움 턴이 끝나면 done", attOf(live.id));
    check(doneCount() === 1, "완료 알림은 정확히 1회", sent.map((i) => i.kind));
    check(live.attentionSticky?.kind === "done", "완료 표시가 한 번 생긴다");
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 보류가 끝나도 턴이 안 열리면 쉼 ===");
{
  sent.length = 0;
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    rt().emitRaw({ t: "bg", tasks: ["1", "2"] });
    live.push("go");
    check(await waitUntil(() => attOf(live.id) === "background"), "background 진입");
    rt().emitRaw({ t: "bg", tasks: [] });
    check(await waitUntil(() => live.backgroundHoldUntil !== undefined), "보류 시작");
    presence.length = 0;
    check(await waitUntil(() => attOf(live.id) === "idle", BACKGROUND_HOLD_MS + 2000), "보류가 끝나면 idle", attOf(live.id));
    check(await waitUntil(() => presence.some((u) => u.id === live.id && u.attention === "idle")), "보류 마감에 주의 상태를 다시 내보낸다", presence);
    check(doneCount() === 0, "완료 알림은 끝내 없다");
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 사건 흐름이 끝나면 목록이 빈다 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    rt().emitRaw({ t: "bg", tasks: ["1"] });
    check(await waitUntil(() => live.backgroundTasks.length === 1), "목록이 찬다");
    presence.length = 0;
    await rt().dispose();
    check(await waitUntil(() => live.backgroundTasks.length === 0 && live.backgroundHoldUntil === undefined), "흐름 종료 시 목록·보류가 빈다");
    await sleep(50);
    const lastLive = presence.filter((u) => u.id === live.id).at(-1);
    check(lastLive !== undefined && lastLive.attention !== "background" && !lastLive.backgroundTasks, "끝난 세션의 마지막 실시간 상태는 background가 아니고 목록도 없다", lastLive);
    const item = sessionManager.list().find((s) => s.id === live.id);
    check(item?.attention !== "background" && !item?.backgroundTasks, "끝난 세션 목록 항목에도 뒤 작업이 없다", item);
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 뒤 작업이 없어도 스스로 시작한 턴을 연다 ===");
{
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    rt().emitRaw({ t: "start" });
    check(await waitUntil(() => attOf(live.id) === "running" && live.isTurnOpen), "뒤 작업도 보류도 없을 때의 턴 시작도 턴을 연다", attOf(live.id));
    rt().emitRaw({ t: "done" });
    check(await waitUntil(() => !live.isTurnOpen), "턴 끝 사건으로 닫힌다");
    // 보류가 만료된 뒤의 턴 시작도 연다
    rt().emitRaw({ t: "bg", tasks: ["1"] });
    live.push("go");
    check(await waitUntil(() => attOf(live.id) === "background" || attOf(live.id) === "running"), "만료 시험: 뒤 작업 진입");
    rt().emitRaw({ t: "done" });
    check(await waitUntil(() => attOf(live.id) === "background"), "만료 시험: background 진입");
    rt().emitRaw({ t: "bg", tasks: [] });
    check(await waitUntil(() => attOf(live.id) !== "background", BACKGROUND_HOLD_MS + 2000), "만료 시험: 보류 만료");
    rt().emitRaw({ t: "start" });
    check(await waitUntil(() => attOf(live.id) === "running" && live.isTurnOpen), "보류 만료 뒤의 턴 시작도 턴을 연다", attOf(live.id));
  } finally {
    sessionManager.delete(live.id);
  }
}

console.log("\n=== 뒤 작업 중지 경로 ===");
{
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const stop = (id: string, taskId: string) => fetch(`${base}/api/sessions/${id}/background-tasks/${taskId}/stop`, { method: "POST" });

  const noStop = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  try {
    rt().emitRaw({ t: "bg", tasks: ["x1"] });
    check(await waitUntil(() => noStop.backgroundTasks.length === 1), "중지 없는 세션 준비");
    check((await stop(noStop.id, "x1")).status === 501, "메서드 없는 provider는 501");
    check(noStop.canStopBackground === false, "canStopBackground=false");
    check(sessionManager.list().find((s) => s.id === noStop.id)?.backgroundCanStop === false, "목록 backgroundCanStop=false");

    check((await stop("00000000-0000-4000-8000-000000000000", "x1")).status === 404, "없는 세션은 404");
    check((await stop(noStop.id, "a".repeat(80))).status === 400, "길이가 넘는 작업 id는 400");
    check((await stop(noStop.id, "a.b")).status === 400, "허용 밖 문자가 든 작업 id는 400");
  } finally {
    sessionManager.delete(noStop.id);
  }
  try {
    mock.mockState.stopBackgroundSupported = true;
    const s2 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
    rt().emitRaw({ t: "bg", tasks: ["y1", "y2"] });
    check(await waitUntil(() => s2.backgroundTasks.length === 2), "중지 지원 세션 준비");
    check(s2.canStopBackground === true, "canStopBackground=true");
    check((await stop(s2.id, "nope")).status === 404, "목록에 없는 작업 id는 404");
    check((await stop(s2.id, "y1")).status === 200, "목록에 있는 작업은 200");
    check(mock.mockState.stoppedBackgroundTasks.join() === "y1", "런타임에 해당 id만 전달");
    check(await waitUntil(() => s2.backgroundTasks.length === 1 && s2.backgroundTasks[0].id === "y2"), "중지 뒤 목록에서 빠진다");
    rt().emitRaw({ t: "bg", tasks: [] });
    check(await waitUntil(() => s2.backgroundHoldUntil !== undefined), "목록이 비면 보류가 걸린다(중지 경로)");
    const held = sessionManager.list().find((s) => s.id === s2.id);
    check(held?.backgroundTasks?.length === 1 && held.backgroundCanStop !== true, "보류 중에는 직전 목록은 보이되 중지 가능 표시는 꺼진다", held);
    sessionManager.delete(s2.id);
  } finally {
    mock.mockState.stopBackgroundSupported = false;
    server.close();
  }
}

unsubPresence();
sessionManager.setOnLive(undefined);
unregister();
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} background_tasks: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
