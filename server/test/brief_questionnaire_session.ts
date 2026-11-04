/**
 * 브리프 질문지: 세션 쪽 동작 시험 (Q1b).
 * 세션 표시, 질문 도구 막기, 턴 끝 질문지 사건, 열린 질문지 계산, 카드 답 경로, 화면 봉투를 본다.
 * 가짜 runtime이 낸 사건을 시험이 직접 흘려 넣는다. 실제 모델은 부르지 않는다.
 * 데이터베이스는 실행마다 임시 SQLite 파일로 만들고, 끝나면 그 파일을 지운다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const LIVE_DATA = path.join(SERVER_DIR, "data");

if (!process.env.AETHER_DATA_DIR || path.resolve(process.env.AETHER_DATA_DIR) === path.resolve(LIVE_DATA)) {
  process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-q1b-"));
}
process.env.AETHER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-q1b-skills-"));
delete process.env.AETHER_READ_CANON;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  const shown = cond || extra === undefined ? "" : ` — ${detail(extra)}`;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${shown}`);
  cond ? pass++ : fail++;
}

function detail(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  if (msg.includes("://") || msg.includes("@") || /postgres/i.test(msg)) return "연결 실패";
  return msg.slice(0, 400);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = { seq: number; kind: string; [key: string]: any };

async function waitFor(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`기다리다 시간 초과: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function main(): Promise<void> {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-q1b-proj-")));
  process.env.AETHER_PROJECT_ROOT = projectDir;
  const { config } = await import("../config");
  if (path.resolve(config.dataDir) === path.resolve(LIVE_DATA)) throw new Error("데이터 폴더가 운영 data다");
  const store = await import("../sessions/persistence");
  const diary = await import("../db/sessionDiary");
  const { __resetEventLogsForTest, eventLogFor: openEventLog } = await import("../sessions/eventLog");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { LiveSession } = await import("../sessions/LiveSession");
  const { sessionsRouter } = await import("../routes/sessions");
  const { streamRouter } = await import("../routes/stream");
  const { toWireEvent } = await import("../sessions/wireEvent");
  const { __registerProviderForTest, providerEntry } = await import("../providers/registry");
  const { mockEntry, mockCodec, MOCK_PROVIDER } = await import("./support/mockProvider");
  type MockRaw = import("./support/mockProvider").MockRaw;
  type MockRuntime = import("./support/mockProvider").MockRuntime;
  const { questionToolRedirect, questionnaireFollowupHint } = await import("../agent-brief/rules");
  const { buildQuestionnaireAnswerText } = await import("../agent-brief/questionnaire");
  const { buildAgentEvents } = await import("../../shared/agentEvent");
  const { setLocale } = await import("../i18n");
  const express = (await import("express")).default;
  setLocale("ko");

  // ── 가짜 provider: 한 사건에 글이 여럿인 경우를 만들려고 normalize만 덧씌운다 ──
  const SPLIT = "<<SPLIT>>";
  const splitCodec = {
    ...mockCodec,
    normalize(ev: Parameters<typeof mockCodec.normalize>[0]) {
      const raw = (ev as { msg?: MockRaw }).msg;
      if (ev.kind === MOCK_PROVIDER && raw?.t === "say" && typeof raw.text === "string" && raw.text.includes(SPLIT)) {
        return buildAgentEvents(ev, MOCK_PROVIDER, raw.text.split(SPLIT).map((text) => ({ type: "text" as const, text })));
      }
      return mockCodec.normalize(ev);
    },
  };

  type Rec = {
    rt: MockRuntime;
    opts: Parameters<typeof mockEntry.createRuntime>[0];
    pushes: string[];
    ctxCalls: number;
    failNextPush: boolean;
    commandGate: Promise<void> | null;
  };
  const recs = new Map<string, Rec>();
  const unregister = __registerProviderForTest({
    ...mockEntry,
    codec: splitCodec,
    createRuntime(opts) {
      const rt = mockEntry.createRuntime(opts) as MockRuntime;
      const rec: Rec = { rt, opts, pushes: [], ctxCalls: 0, failNextPush: false, commandGate: null };
      // 시험이 사건을 직접 흘리므로 push는 입력만 적고 아무 사건도 만들지 않는다.
      rt.push = (input) => {
        if (rec.failNextPush) {
          rec.failNextPush = false;
          throw new Error("runtime 전달 실패(시험)");
        }
        rec.pushes.push(input.text);
      };
      const exec = rt.executeCommand.bind(rt);
      rt.executeCommand = async (command) => {
        if (rec.commandGate) await rec.commandGate;
        return exec(command);
      };
      const usage = rt.contextUsage.bind(rt);
      rt.contextUsage = async () => {
        rec.ctxCalls += 1;
        return usage();
      };
      recs.set(opts.sessionId, rec);
      return rt;
    },
  });

  const made = new Set<string>();
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", streamRouter);
  app.use("/api/sessions", sessionsRouter);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  async function post(sessionId: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  // ── 시험 도구 ──
  type Rig = { s: InstanceType<typeof LiveSession>; rec: Rec };
  const priv = (r: Rig) => r.s as unknown as { openTurns: number; buffer: Ev[]; ingest: (body: Ev) => unknown; rewinding: boolean; blockingCommandOperations: Set<string>; commitUserTurn: (...args: unknown[]) => unknown };
  function mk(): Rig {
    const s = sessionManager.create({ cwd: projectDir, provider: MOCK_PROVIDER, permissionMode: "full" });
    made.add(s.id);
    return { s, rec: recs.get(s.id)! };
  }
  const emitRaw = (r: Rig, msg: MockRaw) => (r.rec.rt as unknown as { emit(m: MockRaw): void }).emit(msg);
  const say = (r: Rig, text: string) => emitRaw(r, { t: "say", text });
  const done = (r: Rig) => emitRaw(r, { t: "done" });
  const evs = (r: Rig): Ev[] => store.readEventsSince(r.s.id, 0) as unknown as Ev[];
  const qevs = (r: Rig) => evs(r).filter((e) => e.kind === "questionnaire");
  const users = (r: Rig) => evs(r).filter((e) => e.kind === "user_msg");
  const rawsOf = (r: Rig, t: string) => evs(r).filter((e) => e.kind === MOCK_PROVIDER && (e.msg as MockRaw).t === t);
  const sayEv = (r: Rig, text: string) => evs(r).find((e) => e.kind === MOCK_PROVIDER && (e.msg as MockRaw).t === "say" && (e.msg as MockRaw).text === text);
  let syncNo = 0;
  /** 앞서 흘린 사건을 세션이 다 처리할 때까지 기다린다. 글 사건이 아닌 표지 하나를 뒤에 흘려 그것이 기록되면 끝난 것이다. */
  async function sync(r: Rig): Promise<void> {
    const mark = `sync-${(syncNo += 1)}`;
    r.rec.rt.emitModel(mark);
    await waitFor(() => evs(r).some((e) => e.kind === MOCK_PROVIDER && (e.msg as MockRaw).model === mark), `표지 ${mark}`);
  }
  const brief = (r: Rig, text: string, id?: string) => r.s.push(text, undefined, undefined, id, { brief: true });

  const QJ = {
    questions: [
      { id: "q1", text: "재시도할 오류", kind: "single", options: [{ label: "A" }, { label: "B" }], recommended: "A" },
      { id: "q2", text: "재시도할 단계", kind: "multi", options: [{ label: "x" }, { label: "y" }] },
      { id: "q3", text: "횟수", kind: "text", recommended: "2회" },
    ],
  };
  const ANS = { q1: { chosen: ["A"] }, q2: { chosen: ["x", "y"], note: "메모" }, q3: { custom: "3회" } };
  const box = (label: string, json: unknown = QJ) => `${label} 정리를 마쳤다.\n\`\`\`aether-questions\n${typeof json === "string" ? json : JSON.stringify(json)}\n\`\`\``;

  /** 브리프 세션을 만들고 질문지를 하나 받아 둔다. */
  async function withQuestionnaire(label: string, json: unknown = QJ): Promise<{ r: Rig; q: Ev }> {
    const r = mk();
    await brief(r, `${label} 요청`, `${label}-req`);
    say(r, box(label, json));
    done(r);
    await sync(r);
    return { r, q: qevs(r)[0] };
  }

  async function scenarios(mode: string): Promise<void> {
    const tag = (name: string) => `[${mode}] ${name}`;

    // ── 세션 표시와 질문 도구 ──
    {
      const general = mk();
      const ask = (r: Rig) =>
        r.rec.opts.onQuestion({
          toolUseID: "tool-q",
          questions: [{ question: "무엇을?", options: [{ label: "가" }, { label: "나" }] }],
          signal: new AbortController().signal,
        });
      const pendingGeneral = ask(general);
      const settled = await Promise.race([pendingGeneral.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("held"), 50))]);
      check(settled === "held" && evs(general).some((e) => e.kind === "question_request"), tag("일반 세션은 질문 도구가 그대로 카드를 만든다"), settled);
      general.s.drainPending("정리");
      check(store.loadMeta(general.s.id)?.briefOpen === undefined, tag("일반 세션 메타에는 브리프 표시가 없다"));

      const r = mk();
      await brief(r, "브리프 표시 요청", "mark-1");
      const out = await ask(r);
      check(!out.answered && out.reason === questionToolRedirect(), tag("브리프 세션의 질문 도구는 카드 없이 안내 사유로 끝난다"), out);
      check(!evs(r).some((e) => e.kind === "question_request"), tag("브리프 세션에는 질문 카드 사건이 없다"));
      check(store.loadMeta(r.s.id)?.briefOpen === true, tag("브리프 표시가 메타에 남는다"), store.loadMeta(r.s.id)?.briefOpen);

      const again = new LiveSession({ id: r.s.id, cwd: projectDir, provider: MOCK_PROVIDER, permissionMode: "full", eventLog: openEventLog(r.s.id) });
      const out2 = await recs.get(r.s.id)!.opts.onQuestion({
        toolUseID: "tool-q2",
        questions: [{ question: "다시?", options: [{ label: "가" }, { label: "나" }] }],
        signal: new AbortController().signal,
      });
      check(!out2.answered && out2.reason === questionToolRedirect(), tag("메타에서 복원한 세션도 브리프 세션이다"), out2);
      again.dispose();

      // 예전 칸(briefSession)은 영구 표시였다. 남아 있어도 브리프 대화로 보지 않는다.
      const old = mk();
      const oldMeta = (old.s as unknown as { metaSnapshot(): Record<string, unknown> }).metaSnapshot();
      store.saveMeta({ ...oldMeta, briefSession: true } as never);
      const revived = new LiveSession({ id: old.s.id, cwd: projectDir, provider: MOCK_PROVIDER, permissionMode: "full", eventLog: openEventLog(old.s.id) });
      const pendingOld = recs.get(old.s.id)!.opts.onQuestion({
        toolUseID: "tool-q3",
        questions: [{ question: "예전?", options: [{ label: "가" }, { label: "나" }] }],
        signal: new AbortController().signal,
      });
      const settledOld = await Promise.race([pendingOld.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("held"), 50))]);
      check(settledOld === "held", tag("예전 영구 표시가 남은 세션은 질문 도구가 카드를 만든다"), settledOld);
      revived.drainPending("정리");
      revived.dispose();
    }

    // ── 뒤에서 도는 작업과 사람 입력 없이 이어진 턴 ──
    {
      const bgEmit = (r: Rig, tasks: string[]) => emitRaw(r, { t: "bg", tasks });
      const { r } = await withQuestionnaire("작업");
      await r.s.push("조사해", undefined, undefined, "bg-ans");
      bgEmit(r, ["t1"]);
      say(r, "에이전트를 띄웠다. 결과를 기다린다.");
      done(r);
      await sync(r);
      check(store.loadMeta(r.s.id)?.briefOpen === true, tag("작업을 기다리며 멈춘 턴은 브리프 대화를 끝내지 않는다"));
      bgEmit(r, []);
      emitRaw(r, { t: "start" });
      say(r, box("최종"));
      done(r);
      await sync(r);
      check(qevs(r).length === 2 && (await r.s.openQuestionnaire())?.id === qevs(r)[1].id, tag("사람 입력 없이 이어진 턴의 상자도 질문지가 된다"), qevs(r).length);
      await r.s.push("답", undefined, undefined, "bg-final");
      say(r, "마쳤다.");
      done(r);
      await sync(r);
      check(store.loadMeta(r.s.id)?.briefOpen === undefined, tag("작업이 없는 턴이 상자 없이 끝나면 브리프 대화가 끝난다"));

      const held = mk();
      await brief(held, "요청", "held-req");
      bgEmit(held, ["t1"]);
      say(held, box("먼저"));
      done(held);
      await sync(held);
      bgEmit(held, []);
      emitRaw(held, { t: "start" });
      say(held, "남은 결과가 왔다.");
      done(held);
      emitRaw(held, { t: "start" });
      done(held);
      await sync(held);
      check(store.loadMeta(held.s.id)?.briefOpen === true && (await held.s.openQuestionnaire())?.id === qevs(held)[0].id, tag("질문지를 낸 뒤 이어진 턴이 상자 없이 끝나도 카드에 답할 수 있다"));

      const { r: cut } = await withQuestionnaire("끼어들기");
      emitRaw(cut, { t: "start" });
      say(cut, "이어진 턴의 글");
      await sync(cut);
      await cut.s.push("끼어든 말", undefined, undefined, "cut-in");
      done(cut);
      await sync(cut);
      check(store.loadMeta(cut.s.id)?.briefOpen === true, tag("사람 입력 전에 쓴 글로 끝난 턴은 브리프 대화를 끝내지 않는다"));
      say(cut, box("끼어든 답"));
      done(cut);
      await sync(cut);
      check(qevs(cut).length === 2, tag("끼어든 말의 답에 쓴 상자도 질문지가 된다"), qevs(cut).length);
    }

    // ── 브리프 대화의 끝 ──
    {
      const askHeld = async (r: Rig, id: string) => {
        const pending = r.rec.opts.onQuestion({
          toolUseID: id,
          questions: [{ question: "무엇을?", options: [{ label: "가" }, { label: "나" }] }],
          signal: new AbortController().signal,
        });
        const settled = await Promise.race([pending.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("held"), 50))]);
        r.s.drainPending("정리");
        return settled === "held";
      };
      const { r } = await withQuestionnaire("끝");
      check(store.loadMeta(r.s.id)?.briefOpen === true, tag("질문지로 끝난 턴 뒤에는 브리프 대화가 이어진다"));
      await r.s.push("채팅으로 한 답", undefined, undefined, "end-ans");
      say(r, box("다시"));
      done(r);
      await sync(r);
      check(store.loadMeta(r.s.id)?.briefOpen === true && qevs(r).length === 2, tag("답 뒤에 또 물으면 브리프 대화가 이어진다"), qevs(r).length);
      await r.s.push("두 번째 답", undefined, undefined, "end-ans-2");
      say(r, "답대로 작업을 마쳤다.");
      done(r);
      await sync(r);
      check(store.loadMeta(r.s.id)?.briefOpen === undefined, tag("질문지 없이 끝난 턴에서 브리프 대화가 끝난다"), store.loadMeta(r.s.id)?.briefOpen);
      check(await askHeld(r, "tool-after"), tag("브리프 대화가 끝나면 질문 도구가 다시 카드를 만든다"));
      await r.s.push("일반 요청", undefined, undefined, "end-plain");
      say(r, box("일반"));
      done(r);
      await sync(r);
      check(qevs(r).length === 2, tag("브리프 대화가 끝난 뒤의 상자는 질문지가 되지 않는다"), qevs(r).length);

      const bad = mk();
      await brief(bad, "틀린 상자 요청", "bad-1");
      say(bad, box("틀림", "{깨짐"));
      done(bad);
      await sync(bad);
      check(store.loadMeta(bad.s.id)?.briefOpen === true, tag("형식이 틀린 상자도 물은 것으로 보고 브리프 대화를 잇는다"));

      const zero = mk();
      await brief(zero, "질문 없는 요청", "zero-1");
      say(zero, "정리를 마쳤다. 이대로 진행할까요?");
      done(zero);
      await sync(zero);
      check(store.loadMeta(zero.s.id)?.briefOpen === undefined, tag("질문이 0개인 정리 턴에서 브리프 대화가 끝난다"));
    }

    // ── 턴 끝의 질문지 사건 ──
    {
      const { r, q } = await withQuestionnaire("기본");
      const sayE = sayEv(r, box("기본"))!;
      const doneE = rawsOf(r, "done")[0];
      check(qevs(r).length === 1 && !!q.id && q.sourceSeq === sayE.seq && q.sourcePart === 0 && q.questions?.length === 3, tag("브리프 세션의 턴 끝에서 질문지 사건이 하나 생긴다"), q);
      check(sayE.seq < q.seq && q.seq < doneE.seq, tag("질문지 순번은 원문 글보다 크고 턴 끝 사건보다 작다"), [sayE.seq, q.seq, doneE.seq]);
      check((await r.s.openQuestionnaire())?.id === q.id, tag("질문지 뒤에 입력이 없으면 열려 있다"));
    }
    {
      const r = mk();
      await r.s.push("일반 요청", undefined, undefined, "plain-1");
      say(r, box("일반"));
      done(r);
      await sync(r);
      check(qevs(r).length === 0, tag("일반 세션은 상자가 있어도 질문지가 없다"));
    }
    {
      const r = mk();
      await brief(r, "여러 글 요청", "multi-1");
      say(r, `앞말${SPLIT}${box("여럿")}`);
      done(r);
      await sync(r);
      const sayE = rawsOf(r, "say")[0];
      check(qevs(r).length === 1 && qevs(r)[0].sourceSeq === sayE.seq && qevs(r)[0].sourcePart === 1, tag("한 사건에 글이 여럿이면 마지막 (seq, part)를 쓴다"), qevs(r)[0]);
      await brief(r, "여러 글 요청 2", "multi-2");
      say(r, `${box("여럿둘")}${SPLIT}뒷말`);
      done(r);
      await sync(r);
      check(qevs(r).length === 1, tag("마지막 글에 상자가 없으면 앞 글의 상자는 쓰지 않는다"), qevs(r).length);
    }
    {
      const r = mk();
      await brief(r, "도중 요청", "mid-1");
      say(r, box("도중"));
      say(r, "다음 작업을 했다");
      done(r);
      await sync(r);
      check(qevs(r).length === 0, tag("작업 도중 글의 상자는 무시한다"));
    }
    {
      const r = mk();
      await brief(r, "잘못된 요청", "bad-1");
      say(r, box("잘못", "{ 이건 JSON이 아니다"));
      done(r);
      await sync(r);
      const q = qevs(r)[0];
      check(qevs(r).length === 1 && q.invalid === true && typeof q.error === "string" && !q.questions, tag("검사에 실패한 상자는 실패 질문지 사건이 된다"), q);
      check((await r.s.openQuestionnaire()) === null, tag("실패 질문지는 열린 질문지가 아니다"));
    }
    {
      // 도중에 입력이 들어온 턴(A 도중 B)은 질문지가 없고, 대기열에서 이어서 도는 B는 있다
      const r = mk();
      await brief(r, "A 요청", "ab-a");
      await r.s.push("B 입력", undefined, undefined, "ab-b");
      say(r, box("A턴"));
      done(r);
      await sync(r);
      check(qevs(r).length === 0, tag("턴 도중 사람 입력이 들어온 턴은 모델 글이 더 와도 질문지가 없다"));
      say(r, box("B턴"));
      done(r);
      await sync(r);
      check(qevs(r).length === 1 && qevs(r)[0].sourceSeq === sayEv(r, box("B턴"))!.seq, tag("대기열에서 이어서 돈 턴은 질문지가 있다"), qevs(r).length);
    }
    {
      // A, B, C 순서: A 끝 없음, B 끝 없음(B 도중 C), C 끝 있음
      const r = mk();
      await brief(r, "A 요청", "abc-a");
      await r.s.push("B 입력", undefined, undefined, "abc-b");
      say(r, box("에이"));
      done(r);
      await sync(r);
      await r.s.push("C 입력", undefined, undefined, "abc-c");
      say(r, box("비"));
      done(r);
      await sync(r);
      check(qevs(r).length === 0, tag("대기열에서 시작한 턴 도중 또 입력이 오면 질문지가 없다"), qevs(r).length);
      say(r, box("씨"));
      done(r);
      await sync(r);
      check(qevs(r).length === 1 && qevs(r)[0].sourceSeq === sayEv(r, box("씨"))!.seq, tag("마지막 대기 턴 끝에서만 질문지가 생긴다"), qevs(r).length);
    }
    {
      const r = mk();
      await brief(r, "쌓임 A", "pile-a");
      await r.s.push("쌓임 B", undefined, undefined, "pile-b");
      await r.s.push("쌓임 C", undefined, undefined, "pile-c");
      for (const label of ["첫째", "둘째"]) {
        say(r, box(label));
        done(r);
        await sync(r);
      }
      check(qevs(r).length === 0, tag("입력 둘이 쌓이면 두 턴 끝까지 질문지가 없다"), qevs(r).length);
      say(r, box("셋째"));
      done(r);
      await sync(r);
      check(qevs(r).length === 1, tag("쌓인 입력이 다 끝나면 질문지가 생긴다"), qevs(r).length);
    }
    {
      // 같은 식별자로 A를 다시 보내면 runtime에는 두 번 간다
      const r = mk();
      await brief(r, "재전송 요청", "again-1");
      await brief(r, "재전송 요청", "again-1");
      check(users(r).filter((u) => u.clientMessageId === "again-1").length === 1 && r.rec.pushes.length === 2, tag("같은 식별자 재전송은 사건 하나에 runtime 입력 둘이다"), r.rec.pushes.length);
      say(r, box("재전송 첫째"));
      done(r);
      await sync(r);
      check(qevs(r).length === 0, tag("A 실행 중 같은 식별자로 A를 재전송하면 A 끝에서 질문지가 없다"));
      say(r, box("재전송 둘째"));
      done(r);
      await sync(r);
      check(qevs(r).length === 1, tag("재전송으로 돈 뒤 턴 끝에서는 질문지가 있다"), qevs(r).length);
    }
    {
      // 턴 끝 사건이 공개되는 순간 들어온 입력은 다음 판정에 센다
      const r = mk();
      await brief(r, "끝 후처리 요청", "tail-a");
      let fired = false;
      r.s.subscribe((ev) => {
        if (!fired && ev.kind === MOCK_PROVIDER && (ev as unknown as Ev).msg.t === "done") {
          fired = true;
          void r.s.push("끝 후처리 중 입력", undefined, undefined, "tail-b");
        }
      });
      say(r, box("끝앞"));
      done(r);
      await waitFor(() => r.rec.pushes.includes("끝 후처리 중 입력"), "후처리 중 입력이 runtime에 전달됨");
      await sync(r);
      check(qevs(r).length === 1, tag("턴 끝 판정은 그 뒤에 들어온 입력과 섞이지 않는다"), qevs(r).length);
      say(r, box("끝뒤"));
      done(r);
      await sync(r);
      check(qevs(r).length === 2 && qevs(r)[1].sourceSeq === sayEv(r, box("끝뒤"))!.seq, tag("턴 끝 후처리 도중 들어온 입력이 다음 판정에 반영된다"), qevs(r).length);
    }
    {
      // 모델 글이 없는 다음 턴은 지난 질문지를 다시 만들지 않는다
      const { r } = await withQuestionnaire("지난");
      await r.s.push("글 없는 턴", undefined, undefined, "silent-1");
      done(r);
      await sync(r);
      check(qevs(r).length === 1, tag("다음 턴에 모델 글이 없어도 지난 질문지를 다시 만들지 않는다"), qevs(r).length);
    }
    {
      // 질문지 저장이 실패해도 턴은 정상으로 끝난다(저장 실패는 ingest가 null을 돌려주는 계약)
      const r = mk();
      await brief(r, "저장 실패 요청", "save-1");
      const p = priv(r);
      const original = p.ingest.bind(r.s);
      p.ingest = (body: Ev) => (body.kind === "questionnaire" ? null : original(body));
      const logs: string[] = [];
      const savedError = console.error;
      console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
      say(r, box("저장실패"));
      done(r);
      await sync(r);
      console.error = savedError;
      p.ingest = original;
      check(qevs(r).length === 0 && rawsOf(r, "done").length === 1 && logs.some((l) => l.includes("질문지 사건 저장 실패")), tag("질문지 저장이 실패해도 턴은 정상으로 끝나고 로그가 남는다"), logs);
      await r.s.push("저장 실패 뒤", undefined, undefined, "save-2");
      say(r, box("저장뒤"));
      done(r);
      await sync(r);
      check(qevs(r).length === 1, tag("저장 실패 뒤 다음 턴은 질문지를 만든다"), qevs(r).length);
    }
    {
      // runtime이 끝나면 계수기가 0이다
      const r = mk();
      await brief(r, "계수 A", "cnt-a");
      await r.s.push("계수 B", undefined, undefined, "cnt-b");
      check(priv(r).openTurns === 2, tag("runtime에 넘긴 입력마다 열린 턴 수가 오른다"), priv(r).openTurns);
      await r.rec.rt.dispose();
      await waitFor(() => priv(r).openTurns === 0, "계수기 0");
      check(priv(r).openTurns === 0, tag("runtime이 끝나면 열린 턴 수가 0이다"));
    }
    {
      // 턴 끝 후처리 호출 횟수는 브리프 여부와 상관없이 같다
      const b = mk();
      const g = mk();
      await brief(b, "횟수 요청", "ctx-b");
      await g.s.push("횟수 요청", undefined, undefined, "ctx-g");
      for (const r of [b, g]) {
        say(r, box("횟수"));
        done(r);
        await sync(r);
      }
      const ctxCount = (r: Rig) => evs(r).filter((e) => e.kind === "ctx").length;
      check(b.rec.ctxCalls === 1 && g.rec.ctxCalls === 1 && ctxCount(b) === ctxCount(g), tag("턴 끝의 컨텍스트 갱신은 브리프 여부와 상관없이 한 번이다"), [b.rec.ctxCalls, g.rec.ctxCalls, ctxCount(b), ctxCount(g)]);
    }

    // ── 열린 질문지 계산 ──
    {
      const closers: Array<[string, (r: Rig) => Promise<unknown>]> = [
        ["일반 글", (r) => Promise.resolve(r.s.push("그냥 말한다", undefined, undefined, "close-text"))],
        ["첨부만 있는 글", (r) => Promise.resolve(r.s.push("", [{ media_type: "image/png", data: "AAAA" }], undefined, "close-img"))],
        ["턴 시작 명령", (r) => r.s.executeCommand({ name: "mock-turn", arguments: "" })],
        ["새 브리프", (r) => Promise.resolve(brief(r, "새 브리프 요청", "close-brief"))],
      ];
      for (const [name, close] of closers) {
        const { r, q } = await withQuestionnaire(`닫힘-${name}`);
        const before = (await r.s.openQuestionnaire())?.id;
        await close(r);
        check(before === q.id && (await r.s.openQuestionnaire()) === null, tag(`${name}이 질문지를 닫는다`), before);
      }
    }
    {
      const { r, q } = await withQuestionnaire("숨김");
      await r.s.push("닫는 글", undefined, undefined, "hide-close");
      const closer = users(r).find((u) => u.clientMessageId === "hide-close")!;
      check((await r.s.openQuestionnaire()) === null, tag("닫는 글 뒤에는 열린 질문지가 없다"));
      r.s.hiddenRanges = [{ after: closer.seq - 1, until: closer.seq }];
      check((await r.s.openQuestionnaire())?.id === q.id, tag("닫는 글을 되돌리기로 숨기면 질문지가 다시 열린다"));
      r.s.hiddenRanges = [{ after: q.seq - 1, until: q.seq }];
      check((await r.s.openQuestionnaire()) === null, tag("질문지를 숨기면 열린 질문지가 없다"));
      r.s.hiddenRanges = [];
    }
    {
      const { r, q } = await withQuestionnaire("꼬리");
      for (let i = 0; i < 450; i++) say(r, `꼬리 ${i}`);
      await sync(r);
      priv(r).buffer = [];
      check((await r.s.openQuestionnaire())?.id === q.id, tag("한 쪽보다 긴 꼬리 뒤에서도 기록을 더 읽어 질문지를 찾는다"));
    }

    // ── 카드 답 경로 ──
    {
      const { r, q } = await withQuestionnaire("답");
      const submit = (answers: unknown, clientMessageId: string, resendOnDuplicate = true, questionnaireId = q.id) =>
        r.s.submitQuestionnaireAnswer({ questionnaireId, answers, clientMessageId, resendOnDuplicate });
      const pushesBefore = r.rec.pushes.length;
      const first = await submit(ANS, "ans-1");
      const expected = buildQuestionnaireAnswerText(q.questions, ANS as never);
      const row = users(r).find((u) => u.clientMessageId === "ans-1");
      check(first.ok === true && !("duplicate" in first), tag("정상 카드 답이 받아들여진다"), first);
      check(row?.text === expected && row?.questionnaireAnswer?.id === q.id && row?.questionnaireAnswer?.answers?.q3?.custom === "3회", tag("user_msg에 글과 questionnaireAnswer가 남는다"), row);
      check(r.rec.pushes.length === pushesBefore + 1 && r.rec.pushes.at(-1) === `${expected}\n${questionnaireFollowupHint()}` && !row?.text.includes(questionnaireFollowupHint()), tag("모델 입력 끝에만 안내 줄이 붙고 사건에는 없다"), r.rec.pushes.at(-1));
      check((await r.s.openQuestionnaire()) === null, tag("카드 답으로 질문지가 닫힌다"));

      const retry = await submit(ANS, "ans-1");
      check(retry.ok === true && users(r).filter((u) => u.clientMessageId === "ans-1").length === 1 && r.rec.pushes.length === pushesBefore + 2, tag("같은 식별자 재시도는 성공하고 사건은 하나, runtime에는 다시 보낸다"), retry);
      const retryReordered = await submit({ q3: { custom: " 3회 " }, q2: { chosen: ["y", "x"], note: "메모" }, q1: { chosen: ["A"] } }, "ans-1", false);
      check(retryReordered.ok === true && "duplicate" in retryReordered && r.rec.pushes.length === pushesBefore + 2, tag("승격 길(resendOnDuplicate 거짓)은 runtime에 다시 보내지 않고 이미 있음을 알린다"), retryReordered);
      const different = await submit({ ...ANS, q3: { custom: "5회" } }, "ans-1");
      check(!different.ok && different.status === 409, tag("같은 식별자에 다른 답이면 409다"), different);
      const lateNew = await submit(ANS, "ans-2");
      check(!lateNew.ok && lateNew.status === 409, tag("이미 닫힌 질문지에 새 식별자로 답하면 409다"), lateNew);
    }
    {
      const { r, q } = await withQuestionnaire("다른글");
      await r.s.push("다른 글로 먼저 닫는다", undefined, undefined, "other-1");
      const late = await r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "other-2", resendOnDuplicate: true });
      check(!late.ok && late.status === 409, tag("다른 글로 닫힌 뒤 카드 답은 409다"), late);
    }
    {
      const { r, q } = await withQuestionnaire("동시");
      const send = (id: string) => r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: id, resendOnDuplicate: true });
      const [a, b] = await Promise.all([send("par-a"), send("par-b")]);
      const oks = [a, b].filter((x) => x.ok).length;
      const conflicts = [a, b].filter((x) => !x.ok && x.status === 409).length;
      check(oks === 1 && conflicts === 1 && users(r).filter((u) => u.questionnaireAnswer).length === 1, tag("동시 카드 답 둘 중 하나만 받아들여지고 나머지는 409다"), [a, b]);
    }
    {
      const { r, q } = await withQuestionnaire("섞임");
      const send = (id: string) => r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: id, resendOnDuplicate: true });
      const results = await Promise.all([send("mix-a"), Promise.resolve(r.s.push("사이에 낀 글", undefined, undefined, "mix-text")), send("mix-b")]);
      check(results[0].ok === true && !(results[2] as { ok: boolean }).ok && (results[2] as { status?: number }).status === 409 && users(r).some((u) => u.clientMessageId === "mix-text"), tag("일반 글과 카드 답이 섞여도 질문지는 한 번만 닫힌다"), results);
      const { r: r2, q: q2 } = await withQuestionnaire("섞임뒤");
      const results2 = await Promise.all([
        Promise.resolve(r2.s.push("먼저 온 글", undefined, undefined, "mix2-text")),
        r2.s.submitQuestionnaireAnswer({ questionnaireId: q2.id, answers: ANS, clientMessageId: "mix2-a", resendOnDuplicate: true }),
      ]);
      check(!(results2[1] as { ok: boolean }).ok && (results2[1] as { status?: number }).status === 409, tag("카드 답보다 먼저 온 일반 글이 질문지를 닫으면 카드 답은 409다"), results2[1]);
    }
    {
      const { r, q } = await withQuestionnaire("재시도둘");
      const send = () => r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "twin-1", resendOnDuplicate: true });
      const [a, b] = await Promise.all([send(), send()]);
      check(a.ok && b.ok && users(r).filter((u) => u.clientMessageId === "twin-1").length === 1, tag("같은 식별자 재시도 둘이 동시에 와도 둘 다 성공하고 사건은 하나다"), [a, b]);
      const { r: r2, q: q2 } = await withQuestionnaire("재시도승격");
      const sendNoResend = () => r2.s.submitQuestionnaireAnswer({ questionnaireId: q2.id, answers: ANS, clientMessageId: "twin-2", resendOnDuplicate: false });
      const before = r2.rec.pushes.length;
      const [c, d] = await Promise.all([sendNoResend(), sendNoResend()]);
      check(c.ok && d.ok && users(r2).filter((u) => u.clientMessageId === "twin-2").length === 1 && r2.rec.pushes.length === before + 1, tag("승격 길 재시도 둘이 동시에 와도 runtime 전달은 한 번이다"), [c, d, r2.rec.pushes.length - before]);
    }
    {
      const { r, q } = await withQuestionnaire("검사");
      const submit = (answers: unknown, id: string, questionnaireId = q.id) => r.s.submitQuestionnaireAnswer({ questionnaireId, answers, clientMessageId: id, resendOnDuplicate: true });
      const wrongId = await submit(ANS, "chk-1", "없는-질문지-id");
      check(!wrongId.ok && wrongId.status === 409, tag("없는 질문지 id는 409다"), wrongId);
      const missing = await submit({ q1: ANS.q1 }, "chk-2");
      check(!missing.ok && missing.status === 400, tag("빠진 질문이 있으면 400이다"), missing);
      const shapeless = await submit("글", "chk-3");
      check(!shapeless.ok && shapeless.status === 400, tag("답이 객체가 아니면 400이다"), shapeless);
      check((await r.s.openQuestionnaire())?.id === q.id && users(r).every((u) => !u.clientMessageId?.startsWith("chk-")), tag("기록 전 실패 뒤에도 질문지는 열려 있고 사건도 없다"));
      const ok = await submit(ANS, "chk-2");
      check(ok.ok === true, tag("고친 답을 같은 식별자로 다시 보낼 수 있다"), ok);
    }
    {
      const { r: bad } = await withQuestionnaire("실패질문지", "{ 이건 JSON이 아니다");
      const badQ = qevs(bad)[0];
      const res = await bad.s.submitQuestionnaireAnswer({ questionnaireId: badQ.id, answers: ANS, clientMessageId: "inv-1", resendOnDuplicate: true });
      check(!res.ok && res.status === 409, tag("실패 질문지에 답하면 409다"), res);
    }
    {
      // 기록 전 실패(저장 실패)는 질문지를 열어 둔다
      const { r, q } = await withQuestionnaire("저장전");
      const p = priv(r);
      const original = p.commitUserTurn.bind(r.s);
      p.commitUserTurn = () => {
        throw new Error("저장 실패(시험)");
      };
      const failed = await r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "pre-1", resendOnDuplicate: true }).then(
        () => "성공",
        (e: Error) => e.message,
      );
      p.commitUserTurn = original;
      check(failed === "저장 실패(시험)" && (await r.s.openQuestionnaire())?.id === q.id, tag("저장이 실패하면 예외가 나가고 질문지는 열린 채다"), failed);
      const retried = await r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "pre-1", resendOnDuplicate: true });
      check(retried.ok === true, tag("저장 실패 뒤 같은 식별자로 다시 보내면 성공한다"), retried);
    }
    {
      // 기록 뒤 runtime 실패는 질문지가 닫힌 채다
      const { r, q } = await withQuestionnaire("전달후");
      const turnsBefore = priv(r).openTurns;
      r.rec.failNextPush = true;
      const failed = await r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "post-1", resendOnDuplicate: true }).then(
        () => "성공",
        (e: Error) => e.message,
      );
      check(failed.includes("runtime 전달 실패") && users(r).some((u) => u.clientMessageId === "post-1") && (await r.s.openQuestionnaire()) === null && priv(r).openTurns === turnsBefore, tag("기록 뒤 runtime 전달이 실패하면 질문지는 닫히고 열린 턴 수는 되돌아간다"), [failed, priv(r).openTurns, turnsBefore]);
    }
    {
      // 턴 시작 명령을 처리하는 중에 온 카드 답은 명령 뒤에 처리되어 409다
      const { r, q } = await withQuestionnaire("명령중");
      let release: () => void = () => {};
      r.rec.commandGate = new Promise<void>((resolve) => (release = resolve));
      const command = r.s.executeCommand({ name: "mock-turn", arguments: "" });
      const answer = r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "cmd-1", resendOnDuplicate: true });
      const early = await Promise.race([answer.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 60))]);
      release();
      r.rec.commandGate = null;
      const [commandResult, answerResult] = await Promise.all([command, answer]);
      check(early === "waiting" && commandResult.accepted && !answerResult.ok && answerResult.status === 409, tag("턴 시작 명령을 처리하는 중에 온 카드 답은 명령 뒤에 처리되어 409다"), [early, answerResult]);
    }
    {
      // 계획 수정 글(resolvePlan의 push)이 실패해도 로그만 남고 다음 입력이 막히지 않는다
      const r = mk();
      await brief(r, "계획 요청", "plan-0");
      const plan = r.rec.opts.onPlan!({ planId: "plan-1", text: "계획", signal: new AbortController().signal });
      void plan;
      await waitFor(() => r.s.pendingPlanList().length === 1, "계획 카드");
      let release: () => void = () => {};
      r.rec.commandGate = new Promise<void>((resolve) => (release = resolve));
      const command = r.s.executeCommand({ name: "mock-turn", arguments: "" });
      const logs: string[] = [];
      const savedError = console.error;
      console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
      r.s.resolvePlan(r.s.pendingPlanList()[0].id, { decision: "revise", message: "고쳐 써라" });
      priv(r).blockingCommandOperations.add("block-1");
      release();
      r.rec.commandGate = null;
      await command;
      await waitFor(() => logs.some((l) => l.includes("계획 수정 글 전달 실패")), "실패 로그");
      console.error = savedError;
      priv(r).blockingCommandOperations.delete("block-1");
      await r.s.push("뒤따르는 글", undefined, undefined, "plan-next");
      check(logs.some((l) => l.includes("계획 수정 글 전달 실패")) && users(r).some((u) => u.clientMessageId === "plan-next") && r.rec.pushes.includes("뒤따르는 글"), tag("resolvePlan 안의 push 실패는 로그로 처리되고 다음 입력이 막히지 않는다"), logs);
    }

    // ── 경로 ──
    {
      const { r, q } = await withQuestionnaire("경로");
      const noId = await post(r.s.id, { questionnaire: { id: q.id, answers: ANS } });
      const withBrief = await post(r.s.id, { text: "x", brief: true, clientMessageId: "rt-b", questionnaire: { id: q.id, answers: ANS } });
      const withAlias = await post(r.s.id, { text: "/brief x", clientMessageId: "rt-a", questionnaire: { id: q.id, answers: ANS } });
      const shapeless = await post(r.s.id, { clientMessageId: "rt-s", questionnaire: "문자열" });
      check(noId.status === 400 && withBrief.status === 400 && withAlias.status === 400 && shapeless.status === 400, tag("경로: clientMessageId가 없거나 브리프와 같이 오거나 모양이 틀리면 400이다"), [noId.status, withBrief.status, withAlias.status, shapeless.status]);
      const wrong = await post(r.s.id, { clientMessageId: "rt-w", questionnaire: { id: "다른-id", answers: ANS } });
      const bad = await post(r.s.id, { clientMessageId: "rt-m", questionnaire: { id: q.id, answers: { q1: ANS.q1 } } });
      check(wrong.status === 409 && bad.status === 400 && (await r.s.openQuestionnaire())?.id === q.id, tag("경로: 없는 질문지는 409, 답이 틀리면 400이고 질문지는 열린 채다"), [wrong.status, bad.status]);
      const okRes = await post(r.s.id, { clientMessageId: "rt-1", questionnaire: { id: q.id, answers: ANS } });
      check(okRes.status === 200 && okRes.json.ok === true && users(r).find((u) => u.clientMessageId === "rt-1")?.questionnaireAnswer?.id === q.id, tag("경로: 빈 text로도 카드 답이 받아들여진다"), okRes);
      const retry = await post(r.s.id, { clientMessageId: "rt-1", questionnaire: { id: q.id, answers: ANS } });
      const differ = await post(r.s.id, { clientMessageId: "rt-1", questionnaire: { id: q.id, answers: { ...ANS, q3: { custom: "9회" } } } });
      check(retry.status === 200 && differ.status === 409, tag("경로: 같은 식별자 재시도는 200, 다른 답은 409다"), [retry.status, differ.status]);
    }

    // ── 화면 봉투 ──
    {
      const { r, q } = await withQuestionnaire("봉투");
      await r.s.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: ANS, clientMessageId: "wire-1", resendOnDuplicate: true });
      const codec = providerEntry(MOCK_PROVIDER).codec;
      const wireQ = toWireEvent(qevs(r)[0] as never, codec) as unknown as Ev;
      const wireU = toWireEvent(users(r).find((u) => u.clientMessageId === "wire-1") as never, codec) as unknown as Ev;
      check(wireQ.kind === "questionnaire" && wireQ.id === q.id && wireQ.sourceSeq === q.sourceSeq && wireQ.questions?.length === 3, tag("화면 봉투가 questionnaire 필드를 그대로 보존한다"), wireQ);
      check(wireU.kind === "user_msg" && wireU.questionnaireAnswer?.id === q.id && wireU.questionnaireAnswer?.answers?.q1?.chosen?.[0] === "A", tag("화면 봉투가 user_msg.questionnaireAnswer를 보존한다"), wireU);
    }
  }

  // 턴 끝 사건이 글 사건을 만들지 않는다는 전제를 세 codec으로 고정한다
  function codecTurnEnds(): void {
    const text = "```aether-questions\n{}\n```";
    const cases: Array<[string, Ev]> = [
      ["claude", { seq: 1, ts: 1, kind: "sdk", msg: { type: "result", subtype: "success", is_error: false, result: text } }],
      ["codex", { seq: 1, ts: 1, kind: "codex", msg: { method: "turn/completed", params: { turn: { status: "completed", text } } } }],
      ["grok", { seq: 1, ts: 1, kind: "grok", msg: { method: "session/prompt_result", params: { stopReason: "end_turn", text } } }],
    ];
    for (const [id, ev] of cases) {
      const codec = providerEntry(id).codec;
      const out = codec.normalize(ev as never);
      check(codec.endsTurn(ev as never) && out.every((e) => e.type !== "text"), `[codec] ${id}의 턴 끝 사건은 글 사건을 만들지 않는다`, out.map((e) => e.type));
    }
  }

  let tempDb: TempDatabase | undefined;

  try {
    codecTurnEnds();
    tempDb = useTempDatabase("brief-q1b");
    await diary.openSessionDiary();
    await scenarios("데이터베이스");
  } catch (err) {
    check(false, "시험이 예외 없이 끝난다", err);
    console.error(err);
  } finally {
    // 데이터베이스에 아직 들어가는 중인 사건이 있으면 세션을 지우기 전에 끝낸다. 안 그러면 정리 중 실패 로그가 쏟아진다.
    try {
    } catch {
      /* 정리 */
    }
    for (const id of [...made]) {
      try {
        sessionManager.delete(id);
      } catch {
        /* 이미 없음 */
      }
    }
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
    fs.rmSync(projectDir, { recursive: true, force: true });
    console.log(`\n${fail === 0 ? "✅" : "❌"} brief_questionnaire_session: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
