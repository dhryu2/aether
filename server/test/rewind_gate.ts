/**
 * 되돌리는 동안 입력을 세션 단위로 막는다 — 모델 호출 0.
 * 실행기가 끝난 뒤 되돌리기가 아직 끝나지 않은 틈에서, 같은 세션 번호로 새 객체가 만들어지거나 명령이 옛 객체로 가면 안 된다.
 * 임시 데이터 폴더와 임시 SQLite만 쓴다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useTempDatabase } from "./support/tempDb";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-gate-"));

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

async function main() {
  const tempDb = useTempDatabase("rewind-gate");
  const diary = await import("../db/sessionDiary");
  const letter = await import("../db/sessionLetter");
  const store = await import("../sessions/persistence");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { sessionsRouter } = await import("../routes/sessions");
  const { RewindError } = await import("../sessions/rewind");
  const { config } = await import("../config");
  const { __registerProviderForTest } = await import("../providers/registry");
  const mock = await import("./support/mockProvider");
  const express = (await import("express")).default;

  // 종료가 끝난 뒤 약속 하나를 기다리게 해, 실행기 스트림은 끝났지만 되돌리기는 끝나지 않은 틈을 만든다.
  let hold: Promise<void> | null = null;
  let failDispose = false;
  const unregister = __registerProviderForTest({
    ...mock.mockEntry,
    createRuntime: (opts: never) => {
      const r = new mock.MockRuntime(opts);
      const dispose = r.dispose.bind(r);
      r.dispose = async () => {
        if (failDispose) throw new Error("dispose 실패");
        await dispose();
        if (hold) await hold;
      };
      return r;
    },
  });

  const cwd = config.projectRootReal ?? config.projectRoot;
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const userMsgs = (id: string) => store.readRecentEvents(id).filter((e) => e.kind === "user_msg");

  try {
    await diary.openSessionDiary();
    await letter.openSessionLetter();
    mock.mockState.manualReply = false;

    console.log("\n=== 틈 안에서 ===");
    const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
    const id = live.id;
    await live.push("남겨");
    await waitUntil(() => !live.isTurnOpen);
    await live.push("DUMMYREWOUND");
    await waitUntil(() => !live.isTurnOpen);
    const hitCount = async () => (await letter.searchSessionLetters({ query: "DUMMYREWOUND", sessionId: id })).length;
    check(await (async () => { for (let i = 0; i < 100 && (await hitCount()) === 0; i++) await sleep(15); return (await hitCount()) > 0; })(), "되돌리기 전에 실시간 색인에 글이 있다");
    const firstSeq = (userMsgs(id)[0] as { seq: number }).seq;
    let release: () => void = () => {};
    hold = new Promise<void>((r) => (release = r));
    const rewinding = sessionManager.rewind(id, firstSeq);
    check(await waitUntil(() => live.isEnded), "실행기가 끝난 틈에 들어왔다");
    check(sessionManager.rewindInFlight(id), "되돌리는 중 표시가 서 있다");

    let busy = false;
    try {
      sessionManager.getOrResume(id);
    } catch (error) {
      busy = error instanceof RewindError && error.code === "busy";
    }
    check(busy, "getOrResume이 busy를 던진다");
    check(sessionManager.get(id) === live, "새 객체가 만들어지지 않고 옛 객체 그대로다");

    const msgsBefore = userMsgs(id).length;
    const cmdBefore = mock.mockState.commandCalls.length;
    const pushBefore = mock.mockState.pushCalls;
    check((await post(`/api/sessions/${id}/message`, { text: "끼어들기" })).status === 409, "message가 409다");
    check((await post(`/api/sessions/${id}/wake`, {})).status === 409, "wake가 409다");
    check((await post(`/api/sessions/${id}/commands`, { command: "help" })).status === 409, "commands가 409다");
    check(userMsgs(id).length === msgsBefore && mock.mockState.commandCalls.length === cmdBefore && mock.mockState.pushCalls === pushBefore, "거절된 입력은 저장되거나 실행기로 가지 않는다");

    let second = "";
    try {
      await sessionManager.rewind(id, firstSeq);
    } catch (error) {
      second = error instanceof RewindError ? error.code : String(error);
    }
    check(second === "busy" && sessionManager.rewindInFlight(id), "두 번째 되돌리기는 busy이고 첫 표시를 지우지 않는다", second);

    console.log("\n=== 틈을 푼 뒤 ===");
    release();
    await rewinding;
    check(!sessionManager.rewindInFlight(id), "끝나면 표시가 지워진다");
    check((await hitCount()) === 0, "되돌린 뒤 실시간으로 쓴 글이 검색에서 0건이다");
    const next = sessionManager.getOrResume(id);
    check(next !== live && next.hiddenRanges.length > 0, "새 객체가 숨김 범위를 받는다", next.hiddenRanges);
    await next.push("새 말");
    await waitUntil(() => !next.isTurnOpen);
    const saved = store.loadMeta(id);
    check((saved?.hiddenRanges?.length ?? 0) > 0 && saved?.rewound === true, "새 객체의 첫 턴 뒤에도 메타에 숨김 범위가 남는다", saved?.hiddenRanges);

    console.log("\n=== 실패 경로 ===");
    hold = null;
    const live2 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
    await live2.push("남겨");
    await waitUntil(() => !live2.isTurnOpen);
    await live2.push("지울 말");
    await waitUntil(() => !live2.isTurnOpen);
    failDispose = true;
    const seq2 = (userMsgs(live2.id)[0] as { seq: number }).seq;
    let failed = false;
    try {
      await sessionManager.rewind(live2.id, seq2);
    } catch {
      failed = true;
    }
    failDispose = false;
    check(failed && !sessionManager.rewindInFlight(live2.id), "dispose가 실패하면 되돌리기도 실패하고 표시가 지워진다");
    let reopened = true;
    try {
      sessionManager.getOrResume(live2.id);
    } catch {
      reopened = false;
    }
    check(reopened, "표시가 지워져 getOrResume이 다시 통한다");

    console.log("\n=== 끝난 세션의 되돌리기 표시 ===");
    const live3 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
    await live3.push("남겨");
    await waitUntil(() => !live3.isTurnOpen);
    await live3.push("지울 말");
    await waitUntil(() => !live3.isTurnOpen);
    const seq3 = (userMsgs(live3.id)[0] as { seq: number }).seq;
    await sessionManager.rewind(live3.id, seq3);
    const old3 = sessionManager.get(live3.id)!;
    check(old3.isEnded && !old3.isRewinding, "성공한 뒤 옛 객체의 되돌리는 중 표시가 풀린다");
    let code = "";
    try {
      await sessionManager.rewind(live3.id, 999999);
    } catch (error) {
      code = error instanceof RewindError ? error.code : String(error);
    }
    check(code === "notfound" && !old3.isRewinding, "끝난 세션에서 실패한 되돌리기도 표시를 남기지 않는다", code);
    let again = "";
    try {
      await sessionManager.rewind(live3.id, seq3);
    } catch (error) {
      again = error instanceof RewindError ? error.code : String(error);
    }
    check(again !== "busy", "그 뒤 다시 되돌려도 busy가 아니다", again);

    sessionManager.delete(id);
    sessionManager.delete(live2.id);
    sessionManager.delete(live3.id);
  } finally {
    unregister();
    server.close();
    tempDb.dispose();
  }
  console.log(`\n${fail === 0 ? "✅" : "❌"} rewind_gate: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
