/**
 * 복원·재연결 바깥 계약 (경량화 2차 1단계 안전망) — 모델 호출 0.
 *
 * 사건을 메모리에 들지 않고 읽거나 저장 경로를 바꿔도 아래 계약은 그대로여야 한다. 내부 목록이 아니라
 * HTTP(GET /stream, GET /events)와 공개 함수만 본다. 임시 SQLite 파일에서 가짜 provider로 돈다.
 *   - 첫 진입: 꼬리 300개, 모델·명령·계획·대화 씨앗, 숨긴 순번 제외, backlog_info
 *   - 재연결: since=lastSeq 누락·중복 없음, 저장 계층을 다시 연 뒤에도 순번이 이어짐
 *   - 부팅: 미해결 카드 정리와 중단 표시가 한 번만, 거듭 재시작해도 늘지 않음
 *   - 페이지: /events의 hasOlder, oldestSeq
 * 이미 맡은 시험(여기서 다시 만들지 않는다):
 *   - 저장 실패 빈 번호, 닫힌 뒤 늦은 쓰기, 재진입 공개 순서: session_event_log.ts
 *   - 부팅 복원: phase6_restore.ts / 페이지 읽기 단위: events_paging.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-restore-contract-"));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || extra === undefined ? "" : ` — ${String(JSON.stringify(extra)).slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Wire = { seq?: number; kind?: string; id?: string; status?: string; events?: { type: string }[] };
type Page = { events: Wire[]; hasOlder: boolean; oldestSeq: number };

async function main() {
  const tempDb: TempDatabase = useTempDatabase("restore-contract");
  const store = await import("../sessions/persistence");
  const diary = await import("../db/sessionDiary");
  const { __resetEventLogsForTest } = await import("../sessions/eventLog");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { streamRouter } = await import("../routes/stream");
  const { sessionsRouter } = await import("../routes/sessions");
  const { config } = await import("../config");
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry, mockCodec, MOCK_PROVIDER } = await import("./support/mockProvider");
  const { buildAgentEvents } = await import("../../shared/agentEvent");
  const express = (await import("express")).default;

  // 가짜 codec에 없는 "명령 목록 관측"만 이 시험에서 덧붙인다(원본 t:"cmds").
  const unregister = __registerProviderForTest({
    ...mockEntry,
    codec: {
      ...mockCodec,
      normalize: (ev) =>
        (ev as { msg?: { t?: string } }).msg?.t === "cmds" && ev.kind === MOCK_PROVIDER
          ? buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "commands_available", names: ["/a"] }])
          : mockCodec.normalize(ev),
    },
  });

  const cwd = config.projectRootReal ?? config.projectRoot;
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", streamRouter);
  app.use("/api/sessions", sessionsRouter);
  const server = app.listen(0, "127.0.0.1"); // 다른 프로세스의 시험 서버가 127.0.0.1에서 같은 포트를 잡으면 요청이 그쪽으로 샌다
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  /** 저장 계층을 다시 여는 모의 재시작: 메모리 기록기와 일기 상태를 버리고 같은 DB 파일을 다시 연다. */
  async function restart() {
    __resetEventLogsForTest();
    diary.__resetSessionDiaryForTest();
    await diary.openSessionDiary();
    await diary.loadSessionDiaries(store.listDiarySources()); // 서버 부팅(index.ts)과 같은 순서
    sessionManager.restoreFromDisk();
  }
  const raw = (t: string, extra: object = {}) => ({ kind: MOCK_PROVIDER, msg: { t, ...extra } }) as never;
  const note = (detail: string) => ({ kind: "notice", notice: "resumed", detail }) as never;
  const put = (id: string, body: never) => sessionManager.appendDetached(id, body).seq;

  async function openStream(id: string, since: number) {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/sessions/${id}/stream?since=${since}`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const msgs: Wire[] = [];
    let backlog: { oldestSeq: number; hasOlder: boolean } | null = null;
    let caught = false;
    for (const start = Date.now(); !caught && Date.now() - start < 8000; ) {
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
        else if (ev === "message") msgs.push(JSON.parse(data));
      }
    }
    abort.abort();
    return { seqs: msgs.map((m) => m.seq as number), msgs, backlog, caught };
  }
  const page = async (id: string, q: string) => (await (await fetch(`${base}/api/sessions/${id}/events?${q}`)).json()) as Page;
  const types = (msgs: Wire[], seq: number) => (msgs.find((m) => m.seq === seq)?.events ?? []).map((e) => e.type);
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  try {
    await diary.openSessionDiary();

    // ── 긴 세션: 1~6은 모델·명령·사용자 말·답·계획·턴 끝, 7~406은 잡담. 150~160은 숨김 ──
    const id = crypto.randomUUID();
    store.saveMeta({ id, cwd, provider: MOCK_PROVIDER, resumeKey: "mock-thread-rc", createdAt: Date.now(), hiddenRanges: [{ after: 149, until: 160 }] } as never);
    sessionManager.restoreFromDisk();
    put(id, raw("model", { model: "mock-m1" }));
    put(id, raw("cmds"));
    put(id, { kind: "user_msg", text: "첫 질문" } as never);
    put(id, raw("say", { text: "첫 답" }));
    put(id, { kind: "todo_list", items: [{ id: "t1", text: "할 일", status: "pending" }] } as never);
    put(id, raw("done"));
    for (let i = 7; i <= 406; i++) put(id, note(`n${i}`));
    await restart();

    const first = await openStream(id, 0);
    // 가짜 codec은 user_msg를 user_text로 바꾸지 않아 3번은 씨앗에서 빠진다(실제 codec은 포함).
    const want = [1, 2, 4, 5, 6, ...range(96, 149), ...range(161, 406)];
    check(first.caught && first.seqs.join() === want.join(), "첫 진입: 씨앗(1~6 중 대화 사건)과 꼬리 300개만, 숨긴 순번(150~160) 제외", [first.seqs.length, first.seqs.slice(0, 8)]);
    check(first.backlog?.oldestSeq === 96 && first.backlog.hasOlder === true, "첫 진입: backlog_info가 꼬리 첫 순번 96과 hasOlder를 알린다", first.backlog);
    check(types(first.msgs, 1).includes("model_info") && types(first.msgs, 2).includes("commands_available"), "첫 진입: 꼬리 밖 마지막 모델과 명령 목록이 온다");
    check(first.msgs.some((m) => m.seq === 5 && types(first.msgs, 5).includes("plan_update")), "첫 진입: 꼬리 밖 마지막 계획이 온다");
    check([4, 6].every((s) => first.seqs.includes(s)) && types(first.msgs, 4).includes("text"), "첫 진입: 대화 씨앗(답, 턴 끝)이 온다");
    const short = await openStream(id, 400);
    check(short.backlog === null && short.seqs.join() === range(401, 406).join(), "since>0 재연결은 꼬리를 자르지 않고 그 뒤 전부만 받는다", short.seqs);

    // ── 재연결: 누락·중복 없음, 재시작 뒤 순번 이어짐 ──
    const last = first.seqs.at(-1)!;
    const added = [put(id, note("a")), put(id, note("b")), put(id, note("c"))];
    check(added.join() === `${last + 1},${last + 2},${last + 3}`, "새 사건 순번이 마지막 순번에 이어진다", added);
    const re = await openStream(id, last);
    check(re.seqs.join() === added.join(), "since=lastSeq는 놓친 사건을 빠짐없이 한 번씩 준다", re.seqs);
    const re2 = await openStream(id, added[1]);
    check(re2.seqs.join() === String(added[2]), "since가 중간이면 그 다음부터만 준다", re2.seqs);
    await restart();
    const none = await openStream(id, added[2]);
    check(none.caught && none.seqs.length === 0, "재시작 뒤 since=lastSeq는 빈 응답이다", none.seqs);
    const after = put(id, note("d"));
    check(after === added[2] + 1, "재시작 뒤 새 사건 순번이 이어진다", after);
    const re3 = await openStream(id, added[2]);
    check(re3.seqs.join() === String(after), "재시작 전에 받은 순번으로 재연결해도 중복 없이 새 사건만 온다", re3.seqs);

    // ── 페이지 ──
    const p1 = await page(id, "before=96&limit=50");
    check(p1.events[0]?.seq === 46 && p1.events.at(-1)?.seq === 95 && p1.oldestSeq === 46 && p1.hasOlder === true, "페이지: before=96 limit=50은 46~95, oldestSeq=46, hasOlder", [p1.oldestSeq, p1.hasOlder]);
    const p2 = await page(id, "before=96&limit=1000");
    check(p2.oldestSeq === 1 && p2.hasOlder === false && p2.events.length === 95, "페이지: 남은 전부면 oldestSeq=1, hasOlder=false", [p2.oldestSeq, p2.hasOlder, p2.events.length]);
    const p3 = await page(id, "before=7&limit=3");
    check(p3.events.map((e) => e.seq).join() === "4,5,6" && p3.oldestSeq === 4 && p3.hasOlder === true, "페이지: 경계 근처 limit=3", p3.events.map((e) => e.seq));
    const p4 = await page(id, "before=1&limit=5");
    check(p4.events.length === 0 && p4.oldestSeq === 1 && p4.hasOlder === false, "페이지: 맨 앞 너머는 빈 페이지(oldestSeq는 요청 before)", p4);
    const hid = await page(id, "before=170&limit=40");
    check(!hid.events.some((e) => (e.seq as number) >= 150 && (e.seq as number) <= 160), "페이지: 숨긴 순번은 빠진다");

    // ── 부팅: 미해결 카드와 중단 표시가 한 번만 ──
    const cid = crypto.randomUUID();
    store.saveMeta({ id: cid, cwd, provider: MOCK_PROVIDER, resumeKey: "mock-thread-rc2", createdAt: Date.now() } as never);
    sessionManager.restoreFromDisk();
    put(cid, { kind: "user_msg", text: "해줘" } as never);
    put(cid, { kind: "permission_request", req: { id: "p1", toolName: "Write", input: {}, toolUseID: "pt1", createdAt: 1 } } as never);
    put(cid, { kind: "question_request", req: { id: "q1", toolUseID: "qt1", questions: [{ question: "색?", options: [] }], createdAt: 1 } } as never);
    const before = sessionManager.list().find((s) => s.id === cid)?.status;
    await restart(); // 1차 부팅: 정리가 일어난다
    const kinds = async () => (await page(cid, "before=100000&limit=1000")).events.map((e) => `${e.kind}${e.id ? `:${e.id}` : ""}${e.status ? `=${e.status}` : ""}`);
    const k1 = await kinds();
    const count = (ks: string[], p: string) => ks.filter((k) => k.startsWith(p)).length;
    check(before !== undefined, "부팅 전 세션이 목록에 있다");
    check(count(k1, "permission_resolved:p1") === 1 && count(k1, "question_resolved:q1") === 1, "부팅: 미해결 권한·질문 카드가 각각 한 번 닫힌다", k1);
    check(count(k1, "status=interrupted") >= 1 && k1.at(-1)?.startsWith("status=") === true, "부팅: 중단 표시가 생기고 꼬리는 닫힌 턴이다", k1);
    check(sessionManager.list().find((s) => s.id === cid)?.status === "interrupted", "부팅: 세션 상태가 중단으로 보인다");
    check(store.loadMeta(cid)?.attentionHold?.kind === "interrupted_request", "부팅: 중단된 요청 표시가 남는다");
    await restart();
    await restart(); // 두 번 더 재시작해도 늘지 않는다
    const k3 = await kinds();
    check(k3.join() === k1.join(), "부팅: 두 번 더 재시작해도 사건이 늘지 않는다", { k1: k1.length, k3: k3.length });
    const view = await openStream(cid, 0);
    check(view.seqs.length === k1.length, "부팅: 재시작 뒤 첫 진입도 같은 사건 수를 보낸다", [view.seqs.length, k1.length]);

    // ── 세션 하나의 meta가 틀려도 나머지 복원이 산다 ──
    {
      const okId = crypto.randomUUID();
      store.saveMeta({ id: okId, cwd, provider: MOCK_PROVIDER, resumeKey: "mock-thread-ok", createdAt: Date.now() } as never);
      const badNames: string[] = [];
      for (const field of ["name", "generatedName"]) {
        const badId = crypto.randomUUID();
        store.saveMeta({ id: badId, cwd, provider: MOCK_PROVIDER, createdAt: Date.now() } as never);
        const f = path.join(config.dataDir, badId, "meta.json");
        fs.writeFileSync(f, JSON.stringify({ id: badId, cwd, provider: MOCK_PROVIDER, createdAt: Date.now(), [field]: 123 }));
        badNames.push(badId);
      }
      let listed: ReturnType<typeof sessionManager.list> | null = null;
      let threw = "";
      try {
        sessionManager.restoreFromDisk();
        listed = sessionManager.list();
      } catch (e) {
        threw = String(e);
      }
      check(listed !== null, "meta 칸 형태가 틀린 세션이 있어도 복원과 목록이 던지지 않는다", threw);
      check(!!listed?.find((x) => x.id === okId), "정상 세션은 그대로 목록에 있다");
      check(badNames.every((b) => listed?.find((x) => x.id === b)?.status === "corrupted"), "칸이 틀린 세션만 손상으로 표시된다");

      // 시각이 지난 자동 재개 예약 + 저장 임시 파일 자리를 폴더로 막아 saveMeta를 실패시킨다.
      const arId = crypto.randomUUID();
      store.saveMeta({ id: arId, cwd, provider: MOCK_PROVIDER, resumeKey: "mock-thread-ar", createdAt: Date.now(), autoResume: { action: { type: "send", text: "계속" }, at: 1, attempts: 0 } } as never);
      fs.mkdirSync(path.join(config.dataDir, arId, "meta.json.tmp"));
      let threw2 = "";
      try {
        sessionManager.restoreFromDisk();
      } catch (e) {
        threw2 = String(e);
      }
      check(threw2 === "", "자동 재개 예약 저장이 실패해도 복원이 던지지 않는다", threw2);
      check(!!sessionManager.list().find((x) => x.id === okId), "그 뒤에도 다른 세션이 목록에 있다");
    }
  } catch (err) {
    check(false, "시험 중 예외", err instanceof Error ? err.message : String(err));
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
    unregister();
    tempDb.dispose();
    fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "✅" : "❌"} session_restore_contract: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
