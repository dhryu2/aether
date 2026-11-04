/**
 * 쉬는 세션 잠재우기 (경량화 2차 2단계) — 모델 호출 0.
 * 가짜 실행기를 네 provider 이름(claude·codex·grok·ollama)과 가짜 이름으로 똑같이 끼워, 공통 계층이 이름과 상관없이
 * 같게 움직이는지 본다. 임시 데이터 폴더와 임시 SQLite만 쓴다.
 *   - 잠드는 조건과 잠들지 않는 조건(턴, 카드, 뒤 작업, 식별자 없음, 예약 대기, 넘기기, 쉰 시간 부족)
 *   - 잠든 뒤: 실행기 정리, 목록 상태, 명령·모델 목록, SSE 순번, 깨울 때 거짓 안내 없음
 *   - 경합: 잠그는 사이 들어온 입력, 잠든 직후 들어온 메시지에서 프로세스가 둘 뜨지 않음
 *   - 설정: 저장값 우선, 끄기, 허용 밖 값 400, 하트비트·조회가 쉰 시간을 늘리지 않음
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useTempDatabase } from "./support/tempDb";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-idle-sleep-"));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || extra === undefined ? "" : ` — ${String(JSON.stringify(extra)).slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 4000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (cond()) return true;
    await sleep(15);
  }
  return cond();
}
const MIN = 60_000;

async function main() {
  const tempDb = useTempDatabase("idle-sleep");
  const diary = await import("../db/sessionDiary");
  const store = await import("../sessions/persistence");
  const { __resetEventLogsForTest } = await import("../sessions/eventLog");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { sessionsRouter } = await import("../routes/sessions");
  const { streamRouter } = await import("../routes/stream");
  const { idleSleepRouter } = await import("../routes/idleSleep");
  const { config } = await import("../config");
  const { __registerProviderForTest } = await import("../providers/registry");
  const mock = await import("./support/mockProvider");
  const { readIdleSleepMs, writeIdleSleepMinutes } = await import("../sessions/idleSleepSetting");
  const express = (await import("express")).default;

  // 실행기 수를 센다. dispose가 200ms 걸리는 느린 자식 프로세스를 흉내 내, 겹침을 드러낸다.
  let alive = 0;
  let maxAlive = 0;
  let disposeDelay = 0;
  const entryFor = (id: string) => ({
    ...mock.mockEntry,
    id: id as never,
    createRuntime: (opts: never) => {
      const r = new mock.MockRuntime(opts);
      alive += 1;
      maxAlive = Math.max(maxAlive, alive);
      const dispose = r.dispose.bind(r);
      r.dispose = async () => {
        if (disposeDelay) await sleep(disposeDelay);
        await dispose();
        alive -= 1;
      };
      return r;
    },
  });
  // 가짜 provider 이름 하나와 실제 네 이름 모두에 같은 가짜 실행기를 끼운다(시험 뒤 원복).
  const ids = [mock.MOCK_PROVIDER, "claude", "codex", "grok", "ollama"];
  const unregisters = ids.map((id) => __registerProviderForTest(entryFor(id)));

  const cwd = config.projectRootReal ?? config.projectRoot;
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", streamRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/idle-sleep", idleSleepRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** 한 턴을 끝까지 돌린다. */
  async function turn(live: ReturnType<typeof sessionManager.create>, text: string) {
    await live.push(text);
    await waitUntil(() => !live.isTurnOpen);
  }
  const later = () => Date.now() + 31 * MIN; // 기본 30분을 넘긴 가상 시각

  try {
    await diary.openSessionDiary();
    mock.mockState.manualReply = false;

    // ── 설정 ──
    console.log("\n=== 설정 ===");
    check(readIdleSleepMs() === 30 * MIN, "저장값이 없으면 기본 30분");
    check(writeIdleSleepMinutes(15) === 15 * MIN && readIdleSleepMs() === 15 * MIN, "15분을 저장하면 바로 읽힌다");
    fs.writeFileSync(path.join(config.dataDir, "idle-sleep.json"), JSON.stringify({ minutes: 7 }));
    check(readIdleSleepMs() === 30 * MIN, "허용 밖 저장값은 무시하고 기본값");
    fs.writeFileSync(path.join(config.dataDir, "idle-sleep.json"), "{깨짐");
    check(readIdleSleepMs() === 30 * MIN, "깨진 파일은 기본값");
    fs.rmSync(path.join(config.dataDir, "idle-sleep.json"), { force: true });
    const put = (body: unknown) => fetch(`${base}/api/idle-sleep`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    check((await put({ minutes: 60 })).status === 200 && ((await (await fetch(`${base}/api/idle-sleep`)).json()) as { minutes: number }).minutes === 60, "PUT 60 뒤 GET이 60");
    for (const bad of [{}, { minutes: 20 }, { minutes: "30" }, { minutes: -1 }, { minutes: null }]) check((await put(bad)).status === 400, `허용 밖 값은 400 ${JSON.stringify(bad)}`);
    check(readIdleSleepMs() === 60 * MIN, "거절된 요청은 저장값을 바꾸지 않는다");
    fs.rmSync(path.join(config.dataDir, "idle-sleep.json"), { force: true });
    check(fs.readdirSync(config.dataDir).every((f) => !f.endsWith(".tmp")), "임시 파일이 남지 않는다");

    // ── provider 이름마다 같은 동작 ──
    for (const provider of ids) {
      console.log(`\n=== ${provider} ===`);
      const live = sessionManager.create({ cwd, provider });
      const id = live.id;
      await turn(live, "첫 질문");
      const disposeBefore = mock.mockState.disposeCalls;

      // 하트비트·조회·열기는 쉰 시간을 늘리지 않는다.
      const since = live.idleSince;
      sessionManager.list();
      sessionManager.presenceSnapshot();
      sessionManager.addViewer(id);
      sessionManager.dropViewer(id);
      await live.listCommands();
      await live.listModels(2000);
      await sleep(5);
      check(live.idleSince === since, "목록·조회·열람은 쉰 시간 기준을 바꾸지 않는다", [since, live.idleSince]);

      check((await sessionManager.sweepIdle(Date.now())) === 0 && !!sessionManager.get(id), "쉰 시간이 모자라면 잠들지 않는다");

      // 잠들지 않는 조건들
      live.resumeKey = undefined;
      check((await sessionManager.sweepIdle(later())) === 0, "이어갈 식별자가 없으면 잠들지 않는다");
      live.resumeKey = mock.MOCK_RESUME_KEY;

      mock.mockState.manualReply = true;
      await live.push("대답 없는 턴");
      check((await sessionManager.sweepIdle(later())) === 0 && !!sessionManager.get(id), "턴이 열려 있으면 잠들지 않는다");
      (live as unknown as { turnOpen: boolean; openTurns: number }).turnOpen = false;
      (live as unknown as { openTurns: number }).openTurns = 0;
      mock.mockState.manualReply = false;

      mock.lastMockRuntime!.emitRaw({ t: "bg", tasks: ["b1"] });
      await sleep(30);
      check((await sessionManager.sweepIdle(later())) === 0, "뒤 작업이 있으면 잠들지 않는다");
      mock.lastMockRuntime!.emitRaw({ t: "bg", tasks: [] });
      await sleep(30);
      check((await sessionManager.sweepIdle(later())) === 0, "뒤 작업이 막 끝난 보류 시간에도 잠들지 않는다");
      (live as unknown as { bgHold: null }).bgHold = null; // 2초 보류가 지나간 것으로 본다

      live.setAutoResume({ action: { type: "send", text: "계속" }, attempts: 1 });
      check((await sessionManager.sweepIdle(later())) === 0, "자동 재개를 보내고 결과를 기다리면 잠들지 않는다");
      live.setAutoResume(undefined);

      live.setHandoff({ handoffJob: { focus: "", provider, cwd, copyOnly: true, state: "writing", requestedAt: Date.now() } as never });
      check((await sessionManager.sweepIdle(later())) === 0, "인계서를 쓰는 중이면 잠들지 않는다");
      live.setHandoff({ handoffJob: undefined });

      // 권한 카드 대기
      await live.push("ASK:/tmp/x");
      await waitUntil(() => live.pendingPermissions().length > 0);
      check((await sessionManager.sweepIdle(later())) === 0 && !!sessionManager.get(id), "승인 카드 대기 중이면 잠들지 않는다");
      live.resolvePermission(live.pendingPermissions()[0].id, "deny");
      await waitUntil(() => !live.isTurnOpen);
      // 위 턴이 활동으로 쳐져 쉰 시간이 새로 시작된다. 아래 시각은 그 뒤로 잡는다.

      // 설정이 끄기면 아무것도 하지 않는다 / 15분이면 15분 뒤부터
      writeIdleSleepMinutes(0);
      check((await sessionManager.sweepIdle(later())) === 0 && !!sessionManager.get(id), "끄기면 잠재우지 않는다");
      writeIdleSleepMinutes(15);
      check((await sessionManager.sweepIdle(Date.now() + 14 * MIN)) === 0, "15분 설정은 14분째에는 잠재우지 않는다");

      // 잠든다
      const seqBefore = store.lastSeqFromDisk(id);
      const n = await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      check(n === 1 && !sessionManager.get(id) && sessionManager.hasDiskSession(id), "15분 설정은 16분째에 잠든다");
      check(mock.mockState.disposeCalls === disposeBefore + 1, "잠들 때 실행기 dispose가 한 번 불린다");
      const row = sessionManager.list().find((s) => s.id === id);
      check(row?.status === "ended" && row.attention !== "running", "목록에서는 쉬는 세션이다", row?.status);
      check(store.lastSeqFromDisk(id) === seqBefore, "잠들면서 사건을 남기지 않는다(순번 그대로)", [seqBefore, store.lastSeqFromDisk(id)]);
      const meta = store.loadMeta(id);
      check(meta?.resumeKey === mock.MOCK_RESUME_KEY && (meta?.commandCatalog?.length ?? 0) > 0, "메타에 이어갈 식별자와 명령 목록이 저장된다");

      // 잠든 세션의 명령·모델
      const cmds = (await (await fetch(`${base}/api/sessions/${id}/commands`)).json()) as { commands: { name: string }[] };
      check(cmds.commands.some((c) => c.name === "mock-ping") && cmds.commands.some((c) => c.name === "model"), "잠든 세션도 provider 명령과 공통 명령을 준다");
      const models = await fetch(`${base}/api/sessions/${id}/models`);
      const modelBody = (await models.json()) as { models?: { value: string }[] };
      check(models.status === 200 && (modelBody.models?.length ?? 0) > 0, "잠든 세션도 기억한 모델 목록을 준다");
      const modes = await fetch(`${base}/api/sessions/${id}/permission-modes`);
      check(modes.status === 200, "잠든 세션도 권한 모드 목록을 준다");

      // 깨운다 — 거짓 안내가 없고 순번이 이어진다
      const wake = await post(`/api/sessions/${id}/wake`, {});
      check(wake.status === 200 && !!sessionManager.get(id) && !sessionManager.hasDiskSession(id), "깨우기가 같은 세션을 다시 띄운다");
      const woke = sessionManager.get(id)!;
      await turn(woke, "다시 질문");
      const events = store.readEventsSince(id, 0);
      const seqs = events.map((e) => e.seq);
      check(new Set(seqs).size === seqs.length && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "순번이 겹치지 않고 늘기만 한다");
      check(!events.some((e) => e.kind === "notice" && (e as { notice?: string }).notice === "resumed"), "깨울 때 '재시작 뒤 이어서' 안내를 남기지 않는다");
      check(!events.some((e) => e.kind === "notice" && (e as { notice?: string }).notice === "no_context"), "문맥 없음 안내도 남기지 않는다");
      check(!events.some((e) => e.kind === "status" && ["interrupted", "crashed"].includes((e as { status?: string }).status ?? "")), "끊김·충돌 표시가 없다");
      // 대화 없이 깨우고 다시 재워도 상태 알림이 매번 나간다(탭이 '활성'에 머물지 않는다)
      check(store.loadMeta(id)?.slept === undefined, "깨어난 세션의 메타에서 잠듦 표시가 지워진다");
      const seen: string[] = [];
      const un = sessionManager.subscribePresence((u) => { if (u.id === id) seen.push(u.status); });
      await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      check(store.loadMeta(id)?.slept === true, "잠들 때 메타에 잠듦 표시가 저장된다(재시작 뒤에도 안내를 남기지 않는다)");
      const pol = await fetch(`${base}/api/sessions/${id}/permission-policy`);
      check(pol.status === 200, "잠든 세션도 기억한 승인 정책으로 답한다");
      await post(`/api/sessions/${id}/wake`, {});
      await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      un();
      check(seen.join() === "ended,active,ended", "잠듦 → 깨움 → 잠듦마다 상태 알림이 나간다", seen);
      sessionManager.delete(id);
    }

    // ── 같은 세션에 SSE가 붙은 채로 잠들고 깨어난다 ──
    console.log("\n=== SSE 연속 ===");
    {
      writeIdleSleepMinutes(15);
      const live = sessionManager.create({ cwd, provider: "claude" });
      const id = live.id;
      await turn(live, "스트림 시작");
      const abort = new AbortController();
      const res = await fetch(`${base}/api/sessions/${id}/stream?since=0`, { signal: abort.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const got: number[] = [];
      let caught = false;
      void (async () => {
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (done) return;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            if (/^event: caught_up/m.test(part)) caught = true;
            const m = /^id: (\d+)$/m.exec(part);
            if (m) got.push(Number(m[1]));
          }
        }
      })();
      await waitUntil(() => caught);
      const lastBefore = got.at(-1)!;
      await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      check(!sessionManager.get(id), "SSE가 붙어 있어도 잠든다(열린 탭이 실행기를 붙잡지 않는다)");
      sessionManager.appendDetached(id, { kind: "notice", notice: "resumed", detail: "잠든 동안 쓴 사건" } as never);
      await waitUntil(() => got.length > 0 && got.at(-1)! > lastBefore, 3000);
      check(got.at(-1)! > lastBefore, "잠든 동안 기록된 사건이 같은 연결로 온다", got.slice(-3));
      const res2 = await post(`/api/sessions/${id}/message`, { text: "깨우는 말" });
      check(res2.status === 200, "메시지가 잠든 세션을 깨운다");
      await waitUntil(() => !sessionManager.get(id)?.isTurnOpen);
      // 저장되지 않는 사건이 번호를 예약해 디스크 상한이 앞서므로, 공개된 마지막 순번과 견준다.
      await waitUntil(() => got.length > 0 && sessionManager.eventLogFor(id).lastPublished() === got.at(-1), 3000);
      check(new Set(got).size === got.length && got.every((s, i) => i === 0 || s > got[i - 1]), "연결이 끊기지 않고 순번이 겹치지 않는다", got.slice(-8));
      check(got.at(-1) === sessionManager.eventLogFor(id).lastPublished(), "깨운 뒤 새 사건도 같은 연결로 온다", [got.at(-1), sessionManager.eventLogFor(id).lastPublished()]);
      abort.abort();
      sessionManager.delete(id);
    }

    // ── 경합 1: 목록을 받는 사이 입력이 들어온다 ──
    console.log("\n=== 경합 ===");
    {
      writeIdleSleepMinutes(15);
      const live = sessionManager.create({ cwd, provider: "codex" });
      await turn(live, "경합 시작");
      const sweeping = sessionManager.sweepIdle(Date.now() + 16 * MIN); // 목록을 받는 await 구간에 들어간다
      void live.push("그 사이 들어온 말");
      const n = await sweeping;
      check(n === 0 && sessionManager.get(live.id) === live, "잠그는 사이 입력이 들어오면 잠들지 않는다");
      await waitUntil(() => !live.isTurnOpen);
      sessionManager.delete(live.id);
    }
    // ── 경합 2: 잠든 직후 메시지 — 프로세스가 둘 뜨지 않는다 ──
    {
      writeIdleSleepMinutes(15);
      const live = sessionManager.create({ cwd, provider: "grok" });
      const id = live.id;
      await turn(live, "겹침 시험");
      disposeDelay = 250;
      maxAlive = alive;
      await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      check(!sessionManager.get(id) && alive === 1, "잠든 직후에는 자식 프로세스가 아직 내려가는 중이다", alive);
      const r = await post(`/api/sessions/${id}/message`, { text: "바로 다음 말" });
      check(r.status === 200, "잠든 직후 메시지도 성공한다");
      await waitUntil(() => !sessionManager.get(id)?.isTurnOpen);
      check(maxAlive === 1, "옛 프로세스가 내려간 뒤에 새로 띄워 동시에 둘이 뜨지 않는다", maxAlive);
      disposeDelay = 0;
      sessionManager.delete(id);
    }
    // ── 경합 3: 동시에 두 메시지 ──
    {
      const live = sessionManager.create({ cwd, provider: "ollama" });
      const id = live.id;
      await turn(live, "동시 시험");
      await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      await waitUntil(() => alive === 0, 2000);
      maxAlive = 0;
      const [a, b] = await Promise.all([post(`/api/sessions/${id}/message`, { text: "하나" }), post(`/api/sessions/${id}/message`, { text: "둘" })]);
      check(a.status === 200 && b.status === 200 && maxAlive === 1, "잠든 세션에 동시에 두 메시지가 와도 실행기는 하나다", [a.status, b.status, maxAlive]);
      await waitUntil(() => !sessionManager.get(id)?.isTurnOpen);
      sessionManager.delete(id);
    }

    // ── 예약 발화: 잠든 채 시각이 되면 깨워서 보낸다 ──
    {
      const live = sessionManager.create({ cwd, provider: "claude" });
      const id = live.id;
      await turn(live, "예약 시험");
      live.setAutoResume({ action: { type: "send", text: "예약된 말" }, attempts: 0, at: Date.now() + 600_000 });
      await sessionManager.sweepIdle(Date.now() + 16 * MIN);
      check(!sessionManager.get(id) && sessionManager.getAutoResume(id)?.action.type === "send", "시각이 남은 예약이 있어도 잠들고 예약은 남는다");
      await sessionManager.fireAutoResume(id);
      await waitUntil(() => !!sessionManager.get(id) && !sessionManager.get(id)!.isTurnOpen);
      const texts = store.readEventsSince(id, 0).filter((e) => e.kind === "user_msg").map((e) => (e as { text?: string }).text);
      check(!!sessionManager.get(id) && texts.includes("예약된 말"), "예약이 발화하면 잠든 세션을 깨워 말을 보낸다", texts);
      sessionManager.delete(id);
    }
  } catch (err) {
    check(false, "시험 중 예외", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 300);
    });
    try {
    } catch {
      /* 정리 */
    }
    __resetEventLogsForTest();
    diary.__resetSessionDiaryForTest();
    for (const u of unregisters) u();
    tempDb.dispose();
    fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "✅" : "❌"} idle_sleep: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
