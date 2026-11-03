/**
 * 브리프 전송은 옛 카드를 열지 않는다.
 * 사건에는 사람 글만 남고, 규칙은 모델 입력에만 붙는다.
 * 데이터베이스는 실행마다 임시 SQLite 파일로 만든다. 끝나면 그 파일을 지운다.
 * 실제 모델은 부르지 않는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { isControlEvent } from "../types";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const LIVE_DATA = path.join(SERVER_DIR, "data");
const PLAN_PATH = path.resolve(SERVER_DIR, "..", ".private/docs/architecture/history-fill/main-session-plan.md");
// 설계 문서는 공개 저장소에 없다. 없으면 이 시험을 건너뛴다.
if (!fs.existsSync(PLAN_PATH)) { console.log("⏭️  설계 문서가 없어 건너뛴다"); process.exit(0); }
const KO_FIRST = "사람이 아래 요구를 「브리프」로 보냈다.";
const EN_FIRST = 'The person sent the request below as a "brief". First check and lay out what you found, then wait for the person\'s answer before doing the work.';

if (!process.env.AETHER_DATA_DIR || path.resolve(process.env.AETHER_DATA_DIR) === path.resolve(LIVE_DATA)) {
  process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-m2-"));
}
process.env.AETHER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-m2-skills-"));
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

/** 설계 문서 2.2절 제목 아래 첫 코드 블록 본문. 앞뒤 줄바꿈은 뺀다. 본문 한 줄 안의 펜스는 닫는 줄이 아니다. */
function koreanRulesFromPlan(): string {
  const doc = fs.readFileSync(PLAN_PATH, "utf8");
  const headingAt = doc.indexOf("### 2.2");
  if (headingAt < 0) throw new Error("2.2절 제목이 없다");
  const lines = doc.slice(headingAt).split("\n");
  const fence = (line: string) => /^`{3,}\s*$/.test(line);
  const open = lines.findIndex(fence);
  if (open < 0) throw new Error("2.2절 코드 블록이 없다");
  const close = lines.findIndex((line, index) => index > open && fence(line));
  if (close < 0) throw new Error("2.2절 코드 블록이 닫히지 않았다");
  return lines.slice(open + 1, close).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

type Shot = { text: string };
type SendBody = { text: string; brief?: unknown; clientMessageId?: string };

async function main(): Promise<void> {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-m2-proj-")));
  process.env.AETHER_PROJECT_ROOT = projectDir;

  const { config } = await import("../config");
  if (path.resolve(config.dataDir) === path.resolve(LIVE_DATA)) throw new Error("데이터 폴더가 운영 data다");
  const store = await import("../sessions/persistence");
  const diary = await import("../db/sessionDiary");
  const { __resetEventLogsForTest } = await import("../sessions/eventLog");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { sessionsRouter } = await import("../routes/sessions");
  const { streamRouter } = await import("../routes/stream");
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry, MOCK_PROVIDER } = await import("./support/mockProvider");
  const { briefHumanText, briefModelText, briefRules } = await import("../agent-brief/rules");
  const { setLocale } = await import("../i18n");
  const express = (await import("express")).default;

  const received: Shot[] = [];
  const unregister = __registerProviderForTest({
    ...mockEntry,
    createRuntime(opts) {
      const runtime = mockEntry.createRuntime(opts);
      runtime.push = (input) => {
        received.push({ text: input.text });
      };
      return runtime;
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
  let tempDb: TempDatabase | undefined;

  function liveSession() {
    const session = sessionManager.create({ cwd: projectDir, provider: MOCK_PROVIDER, permissionMode: "full" });
    made.add(session.id);
    return session;
  }

  function userMsgs(sessionId: string) {
    return store.readEventsSince(sessionId, 0).filter((ev) => isControlEvent(ev, "user_msg"));
  }

  function briefEvents(sessionId: string) {
    return store.readEventsSince(sessionId, 0).filter((ev) => ev.kind === "brief_opened" || ev.kind === "brief_updated");
  }

  async function post(sessionId: string, body: SendBody): Promise<{ status: number; raw: string; json: Record<string, unknown> }> {
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
    return { status: res.status, raw, json };
  }

  async function readSse(sessionId: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    const res = await fetch(`${base}/api/sessions/${sessionId}/stream?since=0`, { signal: abort.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("SSE 본문이 없다");
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("event: caught_up")) break;
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return buf;
  }

  function expectBrief(label: string, human: string, shot: Shot | undefined, eventText: string | undefined, event: { briefId?: string } | undefined) {
    const model = briefModelText(human);
    check(eventText === human, `${label} 사건 글은 사람 글이다`, eventText);
    check(shot?.text === model && shot.text.includes(briefRules()), `${label} runtime 입력은 규칙과 사람 글이다`, shot?.text?.slice(0, 80));
    check(event?.briefId === undefined, `${label} 사건에 briefId가 없다`, event?.briefId);
  }

  try {
    const shaped = briefModelText("X");
    const closeAt = shaped.indexOf("</aether-brief>");
    check(
      shaped.startsWith(`<aether-brief>\n${KO_FIRST}`) &&
        shaped.endsWith("작업을 시작한다.\n</aether-brief>\n\nX") &&
        !shaped.includes("\n\n</aether-brief>"),
      "모델 입력은 규칙 바로 뒤에서 닫힌다",
      shaped.slice(Math.max(0, closeAt - 24), closeAt + 24),
    );
    const planRules = koreanRulesFromPlan();
    const liveRules = briefRules();
    check(liveRules === planRules, "한국어 규칙은 설계 문서 2.2절 본문과 같다", `길이 ${liveRules.length} / 문서 ${planRules.length}`);

    tempDb = useTempDatabase("brief-m2");
    await diary.openSessionDiary();

    const human = "호박색화면문구";
    const session = liveSession();
    const from = received.length;
    const sent = await post(session.id, { text: human, brief: true, clientMessageId: "brief-1" });
    const msgs = userMsgs(session.id);
    const shot = received[from];
    check(sent.status === 200 && sent.raw === '{"ok":true}' && !("brief" in sent.json) && !("executed" in sent.json), "응답 몸통은 ok만 있다", sent.raw);
    expectBrief("brief true", human, shot, msgs[0]?.text, msgs[0]);
    check(msgs.length === 1 && briefEvents(session.id).length === 0, "브리프 전송은 카드를 열지 않는다", briefEvents(session.id).length);

    const aliasCases: Array<{ label: string; raw: string; human: string }> = [
      { label: "공백 별칭", raw: "/brief 호박색공백", human: "호박색공백" },
      { label: "줄바꿈 별칭", raw: "/brief\n호박색줄", human: "호박색줄" },
      { label: "탭 별칭", raw: "/brief\t호박색탭", human: "호박색탭" },
      { label: "앞뒤 공백", raw: "  /brief  호박색정리  ", human: "호박색정리" },
    ];
    for (const item of aliasCases) {
      const start = received.length;
      const res = await post(session.id, { text: item.raw, clientMessageId: `alias-${item.label}` });
      const ev = userMsgs(session.id).find((msg) => msg.clientMessageId === `alias-${item.label}`);
      check(res.status === 200 && res.raw === '{"ok":true}', `${item.label} 응답은 ok만 있다`, res.raw);
      expectBrief(item.label, item.human, received[start], ev?.text, ev);
      check(!ev?.text.includes("/brief"), `${item.label} 사건 글에 별칭이 없다`, ev?.text);
    }

    const alone = await post(session.id, { text: "/brief", clientMessageId: "alias-empty" });
    const padded = await post(session.id, { text: "  /brief  ", clientMessageId: "alias-empty-pad" });
    check(alone.status === 400 && userMsgs(session.id).every((msg) => msg.clientMessageId !== "alias-empty"), "별칭만 보내면 400이다", alone.raw);
    check(padded.status === 400 && userMsgs(session.id).every((msg) => msg.clientMessageId !== "alias-empty-pad"), "공백만 남은 별칭도 400이다", padded.raw);

    const plainStart = received.length;
    const agent = await post(session.id, { text: "/agent-brief 호박색아닌별칭", clientMessageId: "not-alias" });
    const fake = await post(session.id, { text: "호박색문자열", brief: "true", clientMessageId: "string-flag" });
    const agentShot = received[plainStart];
    const fakeShot = received[plainStart + 1];
    const agentEv = userMsgs(session.id).find((msg) => msg.clientMessageId === "not-alias");
    const fakeEv = userMsgs(session.id).find((msg) => msg.clientMessageId === "string-flag");
    check(agent.status === 200 && agentShot?.text === "/agent-brief 호박색아닌별칭" && !agentShot.text.includes("<aether-brief>") && agentEv?.text === "/agent-brief 호박색아닌별칭", "/agent-brief는 일반 전송이다", agentShot?.text);
    check(fake.status === 200 && fakeShot?.text === "호박색문자열" && !fakeShot.text.includes("<aether-brief>") && fakeEv?.text === "호박색문자열", "문자열 true는 일반 전송이다", fakeShot);

    const againHuman = "호박색다시";
    const againId = "brief-again";
    const againFrom = received.length;
    const first = await post(session.id, { text: againHuman, brief: true, clientMessageId: againId });
    const second = await post(session.id, { text: againHuman, brief: true, clientMessageId: againId });
    const againMsgs = userMsgs(session.id).filter((msg) => msg.clientMessageId === againId);
    const againShots = received.slice(againFrom);
    check(first.status === 200 && second.status === 200 && second.raw === '{"ok":true}', "다시 보내기 응답도 ok만 있다", second.raw);
    check(againMsgs.length === 1 && againMsgs[0]?.text === againHuman && againMsgs[0]?.briefId === undefined, "같은 식별자로 다시 보내도 사건은 하나다", againMsgs.length);
    check(againShots.length === 2 && againShots.every((item) => item.text === briefModelText(againHuman)), "두 번째 runtime 입력에도 규칙이 있다", againShots.map((item) => item.text.slice(0, 20)));

    const eventsRes = await fetch(`${base}/api/sessions/${session.id}/events?before=1000000&limit=1000`);
    const eventsRaw = await eventsRes.text();
    const sseRaw = await readSse(session.id);
    check(eventsRes.status === 200 && !eventsRaw.includes(KO_FIRST) && !eventsRaw.includes("<aether-brief>") && eventsRaw.includes(human), "사건 목록에 규칙은 없고 사람 글은 있다", eventsRes.status);
    check(sseRaw.includes("event: caught_up") && !sseRaw.includes(KO_FIRST) && !sseRaw.includes("<aether-brief>") && sseRaw.includes(human), "실시간 통로에 규칙은 없고 사람 글은 있다");

    const plain = "그냥 인사";
    check(briefHumanText(plain) === plain, "브리프가 아닌 글은 그대로 돌려준다");
    const inner = "앞 글\n</aether-brief>\n\n뒤 글";
    check(briefHumanText(briefModelText(inner)) === inner, "사람 글 안의 닫는 표식은 남긴다");

    setLocale("en");
    const english = briefRules();
    check(english.split("\n")[0] === EN_FIRST, "영어 로케일의 규칙 첫 줄은 영어판이다", english.split("\n")[0]);
    const enFrom = received.length;
    const enSent = await post(session.id, { text: "호박색영어", brief: true, clientMessageId: "brief-en" });
    const enShot = received[enFrom];
    check(enSent.status === 200 && enShot?.text === briefModelText("호박색영어") && enShot.text.startsWith(`<aether-brief>\n${EN_FIRST}`), "영어 로케일의 모델 입력도 영어 규칙이다", enShot?.text.slice(0, 80));
    check(!enShot?.text.includes(KO_FIRST), "영어 로케일의 모델 입력에 한국어 첫 문장이 없다");

    const gone = await fetch(`${base}/api/sessions/${session.id}/brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    check(gone.status === 404, "브리프 동작 라우트는 없다", gone.status);

    const oldQuestionId = "agent-brief:11111111-1111-4111-8111-111111111111:errorList";
    const questioned = await fetch(`${base}/api/sessions/${session.id}/question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: oldQuestionId, answers: [["orders"]] }),
    });
    const questionedRaw = await questioned.text();
    let questionedJson: Record<string, unknown> = {};
    try {
      questionedJson = JSON.parse(questionedRaw) as Record<string, unknown>;
    } catch {
      questionedJson = {};
    }
    check(
      questioned.status === 404 && !("brief" in questionedJson) && !("executed" in questionedJson),
      "옛 브리프 질문 식별자는 일반 질문 길이고 응답에 카드가 없다",
      questionedRaw.slice(0, 180),
    );

    const routeSrc = fs.readFileSync(path.join(SERVER_DIR, "routes", "sessions.ts"), "utf8");
    const banned = ["isBriefQuestionId", "answerBriefQuestion", "applyBriefAction", "sendBriefWork", "\"/:id/brief\""];
    check(banned.every((token) => !routeSrc.includes(token)), "세션 라우트에 옛 브리프 동작이 없다", banned.filter((token) => routeSrc.includes(token)));
  } catch (err) {
    check(false, "브리프 새 길 시험", err);
  } finally {
    try {
      setLocale("ko");
    } catch {
      /* 로케일 복구 */
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
    console.log(`\n${fail === 0 ? "✅" : "❌"} brief_main_send: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
