/**
 * 세션 사건 기록기.
 * 데이터베이스는 임시 SQLite 파일만 쓴다. 저장 멈춤은 일기의 시험 전용 저장 문으로 만든다.
 * 끝나면 그 파일을 지운다. 실제 모델은 부르지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabaseAt } from "../db/sqlite";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

if (!process.env.AETHER_DATA_DIR) {
  process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-evtlog-data-"));
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const FAIL_MARK = "EVTLOG_FAIL";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  const shown = cond || extra === undefined ? "" : ` — ${detail(extra)}`;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${shown}`);
  cond ? pass++ : fail++;
}

function detail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("://") || msg.includes("@") || /postgres/i.test(msg)) return "연결 실패";
  return msg.slice(0, 240);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

type Frame = { event: string; id?: string; data: string };

function takeFrames(buf: string): { rest: string; frames: Frame[] } {
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: Frame[] = [];
  for (const part of parts) {
    let event = "message";
    let id: string | undefined;
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("id: ")) id = line.slice(4).trim();
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) frames.push({ event, id, data });
  }
  return { rest, frames };
}

function frameSeq(frame: Frame): number | null {
  if (frame.id && Number.isFinite(Number(frame.id))) return Number(frame.id);
  try {
    const body = JSON.parse(frame.data) as { seq?: unknown };
    if (typeof body.seq === "number") return body.seq;
  } catch {
    /* 제어 프레임 */
  }
  return null;
}

async function scenario(title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${title} ===`);
  try {
    await fn();
  } catch (err) {
    check(false, title, err);
  }
}

async function main() {
  let tempDb: TempDatabase | undefined;

  const { config } = await import("../config");
  const store = await import("../sessions/persistence");
  const diary = await import("../db/sessionDiary");
  const { eventLogFor, __dropEventLogForTest, __resetEventLogsForTest } = await import("../sessions/eventLog");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { LiveSession } = await import("../sessions/LiveSession");
  const { streamRouter } = await import("../routes/stream");
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry, MOCK_PROVIDER } = await import("./support/mockProvider");
  const express = (await import("express")).default;

  let runtimeCreates = 0;
  const unregister = __registerProviderForTest({
    ...mockEntry,
    createRuntime(opts) {
      runtimeCreates += 1;
      return mockEntry.createRuntime(opts);
    },
  });

  const cwd = config.projectRootReal ?? config.projectRoot;
  const dataDir = process.env.AETHER_DATA_DIR!;
  const app = express();
  app.use("/api/sessions", streamRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const timer = setTimeout(() => {
    console.error("타임아웃");
    process.exit(1);
  }, 90_000);

  function db() {
    return openDatabaseAt(tempDb!.file);
  }

  async function offsetsOf(id: string): Promise<{ offset: number; length: number }[]> {
    const found = db()
      .prepare("SELECT byte_offset, byte_length FROM session_event WHERE session_id = ? ORDER BY byte_offset ASC")
      .all(id) as { byte_offset: number; byte_length: number }[];
    return found.map((row) => ({ offset: Number(row.byte_offset), length: Number(row.byte_length) })).sort((a, b) => a.offset - b.offset);
  }

  function offsetsFit(rows: { offset: number; length: number }[]): boolean {
    for (let i = 1; i < rows.length; i++) {
      const prevEnd = rows[i - 1].offset + rows[i - 1].length;
      if (rows[i].offset < prevEnd) return false;
      if (rows[i].offset !== prevEnd + 1) return false;
    }
    return rows.every((row) => row.offset >= 0 && row.length > 0);
  }

  function seqs(events: { seq: number }[]): number[] {
    return events.map((ev) => ev.seq);
  }

  function note(detail: string): { kind: "notice"; notice: "resumed"; detail: string } {
    return { kind: "notice", notice: "resumed", detail };
  }
  async function waitFor(cond: () => Promise<boolean>, ms = 2000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await cond()) return true;
      await sleep(20);
    }
    return cond();
  }

  async function linesOf(id: string): Promise<string[]> {
    const found = db().prepare("SELECT line_text FROM session_event WHERE session_id = ? ORDER BY byte_offset ASC").all(id) as { line_text: string }[];
    return found.map((row) => row.line_text);
  }

  async function openDiary(): Promise<void> {
    await diary.openSessionDiary();
  }

  function metaOf(id: string, resumeKey: string) {
    store.saveMeta({
      id,
      cwd,
      provider: MOCK_PROVIDER,
      resumeKey,
      createdAt: Date.now(),
    });
  }

  async function collect(id: string, since: number, signal: AbortSignal, into: Frame[]): Promise<void> {
    const res = await fetch(`${base}/api/sessions/${id}/stream?since=${since}`, { signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const taken = takeFrames(buf);
        buf = taken.rest;
        into.push(...taken.frames);
      }
    } catch {
      /* 중단 */
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  try {
    tempDb = useTempDatabase("evtlog");
    await openDiary();
    db().exec(`
      CREATE TRIGGER evtlog_fail_ins BEFORE INSERT ON session_event
      WHEN NEW.line_text LIKE '%${FAIL_MARK}%'
      BEGIN
        SELECT RAISE(ABORT, 'evtlog test fail');
      END`);

    await scenario("구독자 안에서 다시 써도 공개 순서가 순번 순서다", async () => {
      const id = crypto.randomUUID();
      metaOf(id, `mock-reenter-${id.slice(0, 8)}`);
      sessionManager.restoreFromDisk();
      const log = sessionManager.eventLogFor(id);
      const order: number[] = [];
      const trace: string[] = [];
      let nested = 0;
      log.bindLive((published) => {
        order.push(published.event.seq);
        trace.push(`s${published.event.seq}`);
        // 첫 사건을 공개하는 도중 두 건을 더 쓴다. 두 건은 첫 사건 다음에 와야 한다.
        if (nested === 0) {
          nested += 1;
          log.write(note("재진입 A"), (ev) => ev);
          log.write(note("재진입 B"), (ev) => ev);
        }
        trace.push(`e${published.event.seq}`);
      });
      const first = log.write(note("바깥"), (ev) => ev);
      if (!first) throw new Error("바깥 사건이 없다");
      const stored = seqs(store.readEventsSince(id, 0));
      check(order.join(",") === `${first.seq},${first.seq + 1},${first.seq + 2}` && stored.join(",") === order.join(",") && log.lastPublished() === first.seq + 2 && trace.join(",") === [first.seq, first.seq + 1, first.seq + 2].flatMap((n) => [`s${n}`, `e${n}`]).join(","), "구독자 안에서 다시 써도 공개 순서가 순번 순서다", `${order.join(",")} | ${stored.join(",")}`);
      check(offsetsFit(await offsetsOf(id)), "재진입 쓰기의 오프셋도 이어진다");
      // 일기를 다시 읽지 않은 채 기록기만 새로 열어도 기존 행 끝 다음부터 이어 기본키가 겹치지 않는다.
      __dropEventLogForTest(id);
      diary.__resetSessionDiaryForTest();
      await openDiary();
      const fresh = eventLogFor(id).write(note("새 기록기"), (ev) => ev);
      const freshRow = (await linesOf(id)).some((line) => line.includes("새 기록기"));
      check(fresh != null && freshRow && offsetsFit(await offsetsOf(id)), "새 기록기의 오프셋이 기존 행 끝 다음부터 이어진다", fresh?.seq);
      sessionManager.delete(id);
    });

    await scenario("appendEvent가 실패해도 그 순번의 상한이 오른다", async () => {
      const id = crypto.randomUUID();
      metaOf(id, `mock-append-${id.slice(0, 8)}`);
      sessionManager.restoreFromDisk();
      store.appendEvent(id, { seq: 1, ts: 1, kind: "notice", notice: "resumed", detail: "기준" } as never);
      store.appendEvent(id, { seq: 2, ts: 2, kind: "notice", notice: "resumed", detail: FAIL_MARK } as never);
      check(store.lastSeqFromDisk(id) >= 2, "appendEvent 실패 뒤에도 마지막 순번이 실패한 순번 이상이다", store.lastSeqFromDisk(id));
      sessionManager.delete(id);
    });

    await scenario("저장 실패 빈 번호 뒤에도 페이지·재접속·재시작 순번이 맞다", async () => {
      const id = crypto.randomUUID();
      metaOf(id, `mock-gap-${id.slice(0, 8)}`);
      sessionManager.restoreFromDisk();
      const seed = sessionManager.appendDetached(id, note("기준"));
      const pending = sessionManager.appendDetachedDurable(id, { kind: "user_msg", text: FAIL_MARK });
      const gapSeq = sessionManager.eventLogFor(id).lastAssigned();
      const later = sessionManager.appendDetached(id, note("뒤 사건"));
      check(gapSeq === seed.seq + 1 && later.seq === gapSeq + 1, "실패시킬 사건과 뒤 사건의 순번이 다르다");
      let rejected = false;
      try {
        await pending;
      } catch {
        rejected = true;
      }
      const page = store.readEventsPage(id, 1_000_000, 50);
      const again = store.readEventsSince(id, 0);
      const pageSeq = seqs(page.events);
      check(
        rejected && !pageSeq.includes(gapSeq) && pageSeq.join(",") === seqs(again).join(",") && pageSeq.join(",") === `${seed.seq},${later.seq}` && page.hasOlder === false,
        "저장 실패 빈 번호 뒤에도 페이지·재접속·재시작 순번이 맞다",
        pageSeq.join(","),
      );
      check(store.lastSeqFromDisk(id) >= gapSeq && offsetsFit(await offsetsOf(id)), "빈 번호가 있어도 마지막 순번과 오프셋이 깨지지 않는다", store.lastSeqFromDisk(id));

      __dropEventLogForTest(id);
      diary.__resetSessionDiaryForTest();
      await openDiary();
      await diary.loadSessionDiary(id, path.join(dataDir, id, "events.jsonl"));
      const restarted = eventLogFor(id);
      const next = restarted.write(note("재시작 다음"), (ev) => ev);
      if (!next) throw new Error("재시작 다음 사건이 없다");
      check(restarted.lastAssigned() === next.seq && next.seq === later.seq + 1, "재시작 뒤 마지막 순번 다음부터 잇는다", next.seq);

      const tailId = crypto.randomUUID();
      metaOf(tailId, `mock-tail-${tailId.slice(0, 8)}`);
      const tailSeed = sessionManager.appendDetached(tailId, note("꼬리 기준"));
      const tailPending = sessionManager.appendDetachedDurable(tailId, { kind: "user_msg", text: FAIL_MARK });
      const tailGap = sessionManager.eventLogFor(tailId).lastAssigned();
      let tailRejected = false;
      try {
        await tailPending;
      } catch {
        tailRejected = true;
      }
      const tailSeen = store.readEventsSince(tailId, 0).map((ev) => ev.seq);
      const heldSeq = store.lastSeqFromDisk(tailId);
      const followed = sessionManager.appendDetached(tailId, note("꼬리 다음"));
      check(
        tailRejected && tailGap === tailSeed.seq + 1 && !tailSeen.includes(tailGap) && heldSeq === tailGap && followed.seq === tailGap + 1,
        "같은 프로세스에서는 꼬리 빈 번호를 다시 쓰지 않는다",
        `gap=${tailGap} last=${heldSeq} next=${followed.seq}`,
      );
    });

    await scenario("잠든 세션 기록은 실행기를 안 띄우고 깨워도 순번이 안 겹친다", async () => {
      runtimeCreates = 0;
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      metaOf(id1, `mock-wake-${id1.slice(0, 8)}`);
      metaOf(id2, `mock-wake-${id2.slice(0, 8)}`);
      sessionManager.restoreFromDisk();
      const seed1 = sessionManager.appendDetached(id1, note("잠든 1"));
      const seed2 = sessionManager.appendDetached(id2, note("잠든 2"));
      check(runtimeCreates === 0, "잠든 기록만으로는 실행기가 뜨지 않는다", runtimeCreates);
      try {
        const hold1 = sessionManager.appendDetachedDurable(id1, { kind: "user_msg", text: "깨우기 전 1" });
        const hold2 = sessionManager.appendDetachedDurable(id2, { kind: "user_msg", text: "깨우기 전 2" });
        const gap1 = sessionManager.eventLogFor(id1).lastAssigned();
        const gap2 = sessionManager.eventLogFor(id2).lastAssigned();
        check(runtimeCreates === 0, "저장을 기다리는 동안에도 실행기가 뜨지 않는다", runtimeCreates);
        const woke = sessionManager.getOrResume(id1);
        const again = sessionManager.getOrResume(id1);
        const woke2 = sessionManager.getOrResume(id2);
        const notice1 = (woke as unknown as { ingest: (body: { kind: "notice"; notice: string }) => { seq: number } }).ingest({
          kind: "notice",
          notice: "깨운 뒤",
        });
        const notice2 = (woke2 as unknown as { ingest: (body: { kind: "notice"; notice: string }) => { seq: number } }).ingest({
          kind: "notice",
          notice: "깨운 뒤 2",
        });
        check(
          again === woke && runtimeCreates === 2 && notice1.seq > gap1 && notice2.seq > gap2,
          "잠든 세션 기록은 실행기를 안 띄우고 깨워도 순번이 안 겹친다",
          `creates=${runtimeCreates} ${gap1}/${notice1.seq} ${gap2}/${notice2.seq}`,
        );
        await hold1;
        await hold2;
        const order1 = store.readEventsSince(id1, seed1.seq).map((ev) => ev.seq);
        const order2 = store.readEventsSince(id2, seed2.seq).map((ev) => ev.seq);
        const rising = (rows: number[]) => rows.every((seq, i) => i === 0 || seq > rows[i - 1]) && new Set(rows).size === rows.length;
        check(rising(order1) && rising(order2) && order1.includes(gap1) && order1.includes(notice1.seq) && order2.includes(gap2) && order2.includes(notice2.seq), "깨운 뒤에도 순번 순서가 유지된다", `${order1.join(",")} | ${order2.join(",")}`);
      } finally {
        sessionManager.delete(id1);
        sessionManager.delete(id2);
      }
    });

    await scenario("잠든 세션 SSE가 새 사건을 한 번만 받는다", async () => {
      await sleepingOnce("DB");
      await sleepingBurst("DB");
    });

    await scenario("공개된 뒤 저장에 실패한 순번을 재시작 뒤에도 다시 쓰지 않는다", async () => {
      const id = crypto.randomUUID();
      metaOf(id, `mock-high-${id.slice(0, 8)}`);
      sessionManager.restoreFromDisk();
      const seed = sessionManager.appendDetached(id, note("상한 기준"));
      const seen: number[] = [];
      sessionManager.eventLogFor(id).bindLive((published) => {
        seen.push(published.event.seq);
      });
      const failed = sessionManager.appendDetached(id, note(FAIL_MARK));
      const listed = store.readEventsSince(id, 0).map((ev) => ev.seq);
      const highFile = path.join(dataDir, id, "seq-high");
      const high = fs.existsSync(highFile) ? Number(fs.readFileSync(highFile, "utf8")) : 0;
      check(seen.includes(failed.seq) && !listed.includes(failed.seq) && high >= failed.seq && store.lastSeqFromDisk(id) >= failed.seq, "실패한 꼬리 순번은 공개됐지만 저장 목록에는 없고 상한은 남는다", `seen=${seen.join(",")} listed=${listed.join(",")} high=${high}`);
      __dropEventLogForTest(id);
      diary.__resetSessionDiaryForTest();
      await openDiary();
      await diary.loadSessionDiary(id, path.join(dataDir, id, "events.jsonl"));
      const restarted = eventLogFor(id);
      const next = restarted.write(note("상한 다음"), (ev) => ev);
      if (!next) throw new Error("상한 다음 사건이 없다");
      check(next.seq === failed.seq + 1, "재시작 뒤 공개됐던 순번을 다시 쓰지 않는다", next.seq);
      const frames: Frame[] = [];
      const abort = new AbortController();
      const reading = collect(id, failed.seq, abort.signal, frames);
      const got = await waitUntil(() => frames.some((frame) => frameSeq(frame) === next.seq), 1500);
      const hits = frames.filter((frame) => frameSeq(frame) === next.seq).length;
      check(got && hits === 1 && !frames.some((frame) => frameSeq(frame) === failed.seq), "그 순번으로 재접속하면 새 사건을 한 번 받는다", frames.map(frameSeq).join(","));
      abort.abort();
      await reading;
    });

    await scenario("세션을 지운 뒤 늦은 저장이 기록기와 폴더를 다시 만들지 않는다", async () => {
      const live = sessionManager.create({ cwd, provider: MOCK_PROVIDER, permissionMode: "full" });
      const id = live.id;
      (live as unknown as { ingest: (body: { kind: "notice"; notice: "resumed"; detail: string }) => { seq: number } | null }).ingest(note("지울 기준"));
      const log = sessionManager.eventLogFor(id);
      const staleGen = (log as unknown as { generation: import("../sessions/persistence").RecordGeneration }).generation;
      sessionManager.delete(id);
      const folder = path.join(dataDir, id);
      const lateWrite = log.write(note("지운 뒤 도착"), (ev) => ev);
      let rejected = false;
      await log.writeDurable({ kind: "user_msg", text: "지운 뒤 도착" }, (ev) => ev).catch(() => {
        rejected = true;
      });
      let staleRejected = false;
      try {
        store.insertEventRow(id, { seq: 99, ts: 1, kind: "user_msg", text: "지운 뒤 도착" } as never, staleGen);
      } catch {
        staleRejected = true;
      }
      let reopened = false;
      try {
        eventLogFor(id);
        reopened = true;
      } catch {
        reopened = false;
      }
      const lateLines = await linesOf(id);
      const lateHit = lateLines.some((line) => line.includes("지운 뒤 도착"));
      check(lateWrite === null && rejected && staleRejected && !fs.existsSync(folder) && !reopened && !lateHit, "세션을 지운 뒤 늦은 쓰기가 기록기와 폴더와 사건 표를 다시 만들지 않는다", `folder=${fs.existsSync(folder)} log=${reopened} row=${lateHit}`);

      sessionManager.delete(id);
    });

    await scenario("상한 파일을 못 써도 저장 요청은 거절로 끝나고 순번을 다시 쓰지 않는다", async () => {
      const id = crypto.randomUUID();
      metaOf(id, `mock-seqdir-${id.slice(0, 8)}`);
      sessionManager.restoreFromDisk();
      sessionManager.appendDetached(id, note("상한 실패 기준"));
      const highPath = path.join(dataDir, id, "seq-high");
      const tmpPath = path.join(dataDir, id, "seq-high.tmp");
      fs.rmSync(highPath, { force: true });
      fs.mkdirSync(highPath);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const pending = sessionManager.appendDetachedDurable(id, { kind: "user_msg", text: FAIL_MARK });
        const gapSeq = sessionManager.eventLogFor(id).lastAssigned();
        const outcome = await Promise.race([
          pending.then(
            () => "resolved" as const,
            () => "rejected" as const,
          ),
          sleep(2000).then(() => "timeout" as const),
        ]);
        const followed = sessionManager.appendDetached(id, note("상한 실패 다음"));
        check(
          outcome === "rejected" && followed.seq > gapSeq,
          "상한 파일을 못 써도 저장 먼저 쓰기는 거절로 끝나고 그 순번을 다시 쓰지 않는다",
          `${outcome} gap=${gapSeq} next=${followed.seq}`,
        );
        const normal = sessionManager.appendDetached(id, note(FAIL_MARK));
        await sleep(50);
        check(unhandled.length === 0, "상한 파일을 못 써도 일반 쓰기 실패가 처리되지 않은 거절이 되지 않는다", unhandled.length);
        __dropEventLogForTest(id);
        const again = eventLogFor(id).write(note("상한 실패 재개"), (ev) => ev);
        check(
          store.lastSeqFromDisk(id) >= normal.seq && again != null && again.seq > normal.seq && again.seq > gapSeq,
          "같은 프로세스의 새 기록기도 실패한 순번을 다시 쓰지 않는다",
          `last=${store.lastSeqFromDisk(id)} again=${again?.seq} normal=${normal.seq}`,
        );
      } finally {
        process.off("unhandledRejection", onUnhandled);
        fs.rmSync(highPath, { recursive: true, force: true });
        fs.rmSync(tmpPath, { force: true });
        sessionManager.delete(id);
      }
    });

    await scenario("저장이 늦거나 실패해도 권한·질문 처리가 끝난다", async () => {
      const live = sessionManager.create({ cwd, provider: MOCK_PROVIDER, permissionMode: "manual" });
      const id = live.id;
      const permSignal = new AbortController();
      const questionSignal = new AbortController();
      let permSettled = false;
      let questionSettled = false;
      const permHeld: { current: { allow: boolean } | null } = { current: null };
      const questionHeld: { current: { answered: boolean; answers?: { chosen: string[] }[] } | null } = { current: null };
      const permP = (
        live as unknown as {
          requestPermission: (ask: { toolName: string; input: Record<string, unknown>; toolUseID: string; signal: AbortSignal }) => Promise<{ allow: boolean }>;
        }
      )
        .requestPermission({ toolName: "mock_write", input: { target: "note.txt" }, toolUseID: "perm-evt", signal: permSignal.signal })
        .then((outcome: { allow: boolean }) => {
          permSettled = true;
          permHeld.current = outcome;
          return outcome;
        });
      const questionP = (
        live as unknown as {
          requestQuestion: (ask: { toolUseID: string; questions: { question: string; options: { label: string }[] }[]; signal: AbortSignal }) => Promise<{ answered: boolean; answers?: { chosen: string[] }[] }>;
        }
      )
        .requestQuestion({
          toolUseID: "q-evt",
          questions: [{ question: "계속할까요", options: [{ label: "예" }] }],
          signal: questionSignal.signal,
        })
        .then((outcome: { answered: boolean; answers?: { chosen: string[] }[] }) => {
          questionSettled = true;
          questionHeld.current = outcome;
          return outcome;
        });
      const permId = live.pendingPermissions()[0]?.id;
      const questionId = live.pendingQuestionList()[0]?.id;
      try {
        const durable = (live as unknown as { commitUserTurnDurable: (text: string) => Promise<void> }).commitUserTurnDurable(FAIL_MARK);
        const permOk = live.resolvePermission(permId, "allow");
        const questionOk = live.resolveQuestion(questionId, [{ chosen: ["예"] }]);
        const marker = await Promise.race([
          Promise.all([permP, questionP]).then(() => "settled"),
          sleep(300).then(() => "timeout"),
        ]);
        check(
          marker === "settled" && permOk && questionOk && permSettled && questionSettled,
          "저장이 늦거나 실패해도 권한·질문 처리가 끝난다",
          marker,
        );
        let rejected = false;
        try {
          await durable;
        } catch {
          rejected = true;
        }
        const texts = store.readEventsSince(id, 0).map((ev) => (ev.kind === "user_msg" ? (ev as { text?: string }).text : ev.kind));
        check(rejected && !texts.includes(FAIL_MARK) && texts.includes("permission_resolved") && texts.includes("question_resolved"), "실패한 사람 말은 빠지고 카드 결정은 남는다", texts.join(","));
        const allowed = permHeld.current?.allow === true;
        const answered = questionHeld.current?.answered === true && questionHeld.current.answers?.[0]?.chosen?.[0] === "예";
        check(allowed && answered, "권한은 허용이고 질문 답은 예다", `perm=${permHeld.current?.allow} q=${questionHeld.current?.answered}`);
      } finally {
        sessionManager.delete(id);
      }

      const abortLive = sessionManager.create({ cwd, provider: MOCK_PROVIDER, permissionMode: "manual" });
      const abortSignal = new AbortController();
      const abortHeld: { current: { allow: boolean } | null } = { current: null };
      const abortP = (
        abortLive as unknown as {
          requestPermission: (ask: { toolName: string; input: Record<string, unknown>; toolUseID: string; signal: AbortSignal }) => Promise<{ allow: boolean }>;
        }
      )
        .requestPermission({ toolName: "mock_write", input: { target: "abort.txt" }, toolUseID: "perm-abort", signal: abortSignal.signal })
        .then((outcome: { allow: boolean }) => {
          abortHeld.current = outcome;
          return outcome;
        });
      const questionAbort = new AbortController();
      const questionAbortHeld: { current: { answered: boolean } | null } = { current: null };
      const questionAbortP = (
        abortLive as unknown as {
          requestQuestion: (ask: { toolUseID: string; questions: { question: string; options: { label: string }[] }[]; signal: AbortSignal }) => Promise<{ answered: boolean }>;
        }
      )
        .requestQuestion({
          toolUseID: "q-abort",
          questions: [{ question: "멈출까요", options: [{ label: "아니오" }] }],
          signal: questionAbort.signal,
        })
        .then((outcome: { answered: boolean }) => {
          questionAbortHeld.current = outcome;
          return outcome;
        });
      abortSignal.abort();
      questionAbort.abort();
      const abortMarker = await Promise.race([
        Promise.all([abortP, questionAbortP]).then(() => "settled"),
        sleep(300).then(() => "timeout"),
      ]);
      check(
        abortMarker === "settled" && abortHeld.current?.allow === false && questionAbortHeld.current?.answered === false && abortLive.pendingPermissions().length === 0 && abortLive.pendingQuestionList().length === 0,
        "취소하면 권한·질문 대기가 풀리고 거절로 끝난다",
        abortMarker,
      );
      sessionManager.delete(abortLive.id);

      const drainLive = sessionManager.create({ cwd, provider: MOCK_PROVIDER, permissionMode: "manual" });
      const drainSignal = new AbortController();
      const drainPermHeld: { current: { allow: boolean } | null } = { current: null };
      const drainQuestionHeld: { current: { answered: boolean } | null } = { current: null };
      const drainPermP = (
        drainLive as unknown as {
          requestPermission: (ask: { toolName: string; input: Record<string, unknown>; toolUseID: string; signal: AbortSignal }) => Promise<{ allow: boolean }>;
        }
      )
        .requestPermission({ toolName: "mock_write", input: { target: "drain.txt" }, toolUseID: "perm-drain", signal: drainSignal.signal })
        .then((outcome: { allow: boolean }) => {
          drainPermHeld.current = outcome;
          return outcome;
        });
      const drainQuestionP = (
        drainLive as unknown as {
          requestQuestion: (ask: { toolUseID: string; questions: { question: string; options: { label: string }[] }[]; signal: AbortSignal }) => Promise<{ answered: boolean }>;
        }
      )
        .requestQuestion({
          toolUseID: "q-drain",
          questions: [{ question: "지울까요", options: [{ label: "예" }] }],
          signal: drainSignal.signal,
        })
        .then((outcome: { answered: boolean }) => {
          drainQuestionHeld.current = outcome;
          return outcome;
        });
      check(drainLive.pendingPermissions().length === 1 && drainLive.pendingQuestionList().length === 1, "삭제 전에 권한·질문 대기가 있다");
      sessionManager.delete(drainLive.id);
      const drainMarker = await Promise.race([
        Promise.all([drainPermP, drainQuestionP]).then(() => "settled"),
        sleep(300).then(() => "timeout"),
      ]);
      check(drainMarker === "settled" && drainPermHeld.current?.allow === false && drainQuestionHeld.current?.answered === false, "세션을 지우면 권한·질문 대기가 풀린다", drainMarker);
    });
  } finally {
    clearTimeout(timer);
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
    unregister();
    tempDb?.dispose();
    console.log("─".repeat(50));
    console.log(`session_event_log: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  }

  async function sleepingOnce(label: string): Promise<void> {
    const id = crypto.randomUUID();
    metaOf(id, `mock-sse-${id.slice(0, 8)}`);
    sessionManager.restoreFromDisk();
    const frames: Frame[] = [];
    const abort = new AbortController();
    const reading = collect(id, 0, abort.signal, frames);
    const caught = await waitUntil(() => frames.some((frame) => frame.event === "caught_up"));
    const added = sessionManager.appendDetached(id, note(`${label} 새 사건`));
    const got = await waitUntil(() => frames.some((frame) => frameSeq(frame) === added.seq), 1300);
    const woke = sessionManager.getOrResume(id);
    const extra = (woke as unknown as { ingest: (body: { kind: "notice"; notice: "resumed"; detail: string }) => { seq: number } | null }).ingest(note(`${label} 깨어난 뒤`));
    const extraGot = extra ? await waitUntil(() => frames.some((frame) => frameSeq(frame) === extra.seq), 1300) : false;
    const hits = frames.filter((frame) => frameSeq(frame) === added.seq).length;
    const extraHits = extra ? frames.filter((frame) => frameSeq(frame) === extra.seq).length : 0;
    check(caught && got && extraGot && hits === 1 && extraHits === 1 && woke.id === id, `${label} 잠든 세션 SSE가 새 사건을 한 번만 받고 깨어난 뒤 사건도 한 번만 받는다`, `hits=${hits} extra=${extraHits}`);
    abort.abort();
    await reading;
    sessionManager.delete(id);
  }

  async function sleepingBurst(label: string): Promise<void> {
    const id = crypto.randomUUID();
    metaOf(id, `mock-burst-${id.slice(0, 8)}`);
    sessionManager.restoreFromDisk();
    const frames: Frame[] = [];
    const abort = new AbortController();
    const reading = collect(id, 0, abort.signal, frames);
    const caught = await waitUntil(() => frames.some((frame) => frame.event === "caught_up"));
    const seqsWanted: number[] = [];
    for (let i = 0; i < 310; i++) seqsWanted.push(sessionManager.appendDetached(id, note(`${label} 묶음 ${i}`)).seq);
    const woke = sessionManager.getOrResume(id);
    const allIn = await waitUntil(() => seqsWanted.every((seq) => frames.some((frame) => frameSeq(frame) === seq)), 2500);
    const counts = seqsWanted.map((seq) => frames.filter((frame) => frameSeq(frame) === seq).length);
    const once = counts.every((n) => n === 1);
    const extra = (woke as unknown as { ingest: (body: { kind: "notice"; notice: "resumed"; detail: string }) => { seq: number } | null }).ingest(note(`${label} 묶음 뒤`));
    const extraGot = extra ? await waitUntil(() => frames.filter((frame) => frameSeq(frame) === extra.seq).length === 1, 1300) : false;
    const extraHits = extra ? frames.filter((frame) => frameSeq(frame) === extra.seq).length : 0;
    check(caught && allIn && once && extraGot && extraHits === 1, `${label} 잠든 동안 300개가 넘는 사건도 깨어난 연결에서 빠지지 않는다`, `in=${allIn} once=${once} extra=${extraHits}`);
    abort.abort();
    await reading;
    sessionManager.delete(id);
  }
}

main().catch((err) => {
  console.error("테스트 오류:", detail(err));
  process.exit(1);
});
