/**
 * 첫 진입·폴 보강 (경량화 2차 7단계 검토 반영) — 모델 호출 0.
 *   - 켜진 세션의 첫 진입이 잠든 세션과 같은 사건을 준다(버퍼가 덮을 때, 밀려났을 때 둘 다)
 *   - 폴에서 붙이다 읽기가 실패해도 서버가 살아 있고 다음 폴에서 다시 붙인다
 *   - 최신순 조회는 기본키 역순을 쓰고(임시 정렬 없음), 순번과 파일 순서가 어긋나도 순서가 같다
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useTempDatabase } from "./support/tempDb";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-first-open-"));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || extra === undefined ? "" : ` — ${String(JSON.stringify(extra)).slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tempDb = useTempDatabase("first-open");
  const store = await import("../sessions/persistence");
  const diary = await import("../db/sessionDiary");
  const events = await import("../db/sessionEvents");
  const { database } = await import("../db/sqlite");
  const { __resetEventLogsForTest } = await import("../sessions/eventLog");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { streamRouter } = await import("../routes/stream");
  const { config } = await import("../config");
  const { MOCK_PROVIDER, mockEntry } = await import("./support/mockProvider");
  const { __registerProviderForTest } = await import("../providers/registry");
  const unregister = __registerProviderForTest(mockEntry);
  const express = (await import("express")).default;

  const cwd = config.projectRootReal ?? config.projectRoot;
  const app = express();
  app.use("/api/sessions", streamRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  async function openStream(id: string, since: number, waitMs = 8000) {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/sessions/${id}/stream?since=${since}`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seqs: number[] = [];
    let backlog: { oldestSeq: number; hasOlder: boolean } | null = null;
    let caught = false;
    for (const start = Date.now(); !caught && Date.now() - start < waitMs; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const ev = /^event: (.*)$/m.exec(part)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(part)?.[1];
        if (!data) continue;
        if (ev === "caught_up") caught = true;
        else if (ev === "backlog_info") backlog = JSON.parse(data);
        else if (ev === "message") seqs.push((JSON.parse(data) as { seq: number }).seq);
      }
    }
    abort.abort();
    return { seqs, backlog, caught };
  }

  const note = (detail: string) => ({ kind: "notice", notice: "resumed", detail }) as never;
  try {
    await diary.openSessionDiary();

    // ── 켜진 세션 첫 진입 = 잠든 세션 첫 진입 ──
    for (const cap of [2000, 100]) {
      const saved = config.bufferCap;
      (config as { bufferCap: number }).bufferCap = cap;
      const live = sessionManager.create({ cwd, provider: MOCK_PROVIDER });
      for (let i = 0; i < 450; i++) sessionManager.appendDetached(live.id, note(`n${i}`));
      const liveView = await openStream(live.id, 0);
      (config as { bufferCap: number }).bufferCap = saved;
      sessionManager.delete(live.id);
      check(liveView.caught && liveView.seqs.length === 300 && liveView.backlog?.hasOlder === true, `켜진 세션(버퍼 ${cap}) 첫 진입: 꼬리 300개와 backlog_info`, [liveView.seqs.length, liveView.backlog]);
      check(liveView.seqs.at(-1) === liveView.seqs[0] + 299 && liveView.backlog?.oldestSeq === liveView.seqs[0], `켜진 세션(버퍼 ${cap}) 첫 진입: 마지막 300개 순번이 이어진다`);
    }
    {
      // 같은 사건을 잠든 쪽에서 열어 비교한다.
      const id = crypto.randomUUID();
      store.saveMeta({ id, cwd, provider: MOCK_PROVIDER, resumeKey: "mock-fo", createdAt: Date.now() } as never);
      sessionManager.restoreFromDisk();
      for (let i = 0; i < 450; i++) sessionManager.appendDetached(id, note(`n${i}`));
      const sleeping = await openStream(id, 0);
      check(sleeping.seqs.length === 300 && sleeping.backlog?.oldestSeq === 151, "잠든 세션 첫 진입: 같은 꼬리 규칙", sleeping.backlog);
    }

    // ── 폴에서 붙이다 읽기가 실패해도 서버가 산다 ──
    {
      const id = crypto.randomUUID();
      store.saveMeta({ id, cwd, provider: MOCK_PROVIDER, resumeKey: "mock-fo2", createdAt: Date.now() } as never);
      sessionManager.restoreFromDisk();
      sessionManager.appendDetached(id, note("x"));
      const realGet = sessionManager.get.bind(sessionManager);
      let attaches = 0;
      let alive = true;
      const onCrash = () => (alive = false);
      process.once("uncaughtException", onCrash);
      const abort = new AbortController();
      const view = fetch(`${base}/api/sessions/${id}/stream?since=0`, { signal: abort.signal }).catch(() => undefined); // 연결만 열어 둔다
      await sleep(300);
      const broken = {
        subscribe: () => () => undefined,
        replaySince: () => {
          attaches++;
          throw new Error("깨진 행");
        },
        replayNewestFirst: () => {
          attaches++;
          throw new Error("깨진 행");
        },
      };
      (sessionManager as { get: unknown }).get = (sid: string) => (sid === id ? broken : realGet(sid));
      await sleep(2600);
      (sessionManager as { get: unknown }).get = realGet;
      process.removeListener("uncaughtException", onCrash);
      abort.abort();
      await view;
      check(alive, "폴의 부착이 읽기 오류로 실패해도 서버가 꺼지지 않는다");
      check(attaches >= 2, "실패한 부착은 다음 폴에서 다시 시도한다", attaches);
    }

    // ── 최신순 조회: 임시 정렬 없음, 순서 어긋난 합성 행 ──
    {
      const id = "synthetic-order";
      const db = database();
      const lines: [number, number][] = [[10, 5], [20, 1], [30, 9], [40, 3], [50, 7]]; // [byteOffset, seq]
      for (const [off, seq] of lines) {
        const line = JSON.stringify({ seq, ts: seq, kind: "notice" });
        events.insertSessionRows(db, [{ sessionId: id, seq, ts: seq, kind: "notice", byteOffset: off, byteLength: Buffer.byteLength(line), line }]);
      }
      const got = [...events.eventRowsNewestFirst(id, 8)].map((r) => r.seq);
      check(got.join() === "7,3,1,5", "순번과 파일 순서가 어긋나도 파일 역순에서 seq<8만 고른다(7,3,1,5)", got);
      const all = [...events.eventRowsNewestFirst(id)].map((r) => r.seq);
      check(all.join() === "7,3,9,1,5", "before 없이는 파일 역순 전부", all);
      const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT seq FROM session_event WHERE session_id = ? AND +seq < ? ORDER BY byte_offset DESC").all(id, 8) as { detail: string }[]).map((r) => r.detail).join(" | ");
      check(!/TEMP B-TREE/i.test(plan) && /sqlite_autoindex_session_event_1/.test(plan), "최신순 조회 계획이 임시 정렬 없이 기본키를 쓴다", plan);
    }
  } catch (err) {
    check(false, "시험 중 예외", err instanceof Error ? err.stack : String(err));
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 300);
    });
    __resetEventLogsForTest();
    diary.__resetSessionDiaryForTest();
    unregister();
    tempDb.dispose();
    fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "✅" : "❌"} stream_first_open: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
