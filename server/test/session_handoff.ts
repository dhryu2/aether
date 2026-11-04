/**
 * 새 세션으로 넘기기 — 가짜 provider, 모델 호출 0.
 * 인계서 집어내기·요청 글·형식 거절·정상 흐름·질문 대기(asking)·뼈대·한도 대기(A1 연결)·멈춤·복사만·첫 말 표시·복원.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AetherEvent } from "../types";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-handoff-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-handoff-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { attachNotify } = await import("../notify/coordinator");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("session_handoff"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const { config } = await import("../config");
const { setLocale } = await import("../i18n");
const mock = await import("./support/mockProvider");
const ho = await import("../sessions/handoff");
const { __registerProviderForTest } = await import("../providers/registry");
const express = (await import("express")).default;
const { sessionsRouter } = await import("../routes/sessions");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const eq = (name: string, a: unknown, b: unknown) => check(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ── 순수 함수 ──
const ev = (seq: number, msg: import("./support/mockProvider").MockRaw) => ({ seq, ts: seq, kind: mock.MOCK_PROVIDER, msg }) as unknown as AetherEvent;
const say = (seq: number, text: string) => ev(seq, { t: "say", text });
const codec = mock.mockCodec;

console.log("\n=== 인계서 집어내기 ===");
{
  eq("표식 한 쌍 안쪽만", ho.pickHandoffText([say(1, "잡담"), say(2, "<aether-handoff>\n본문 1\n본문 2\n</aether-handoff>\n끝")], codec), "본문 1\n본문 2");
  eq("두 쌍이면 마지막 쌍", ho.pickHandoffText([say(1, "<aether-handoff>\n옛\n</aether-handoff>\n<aether-handoff>\n새\n</aether-handoff>")], codec), "새");
  eq("표식이 문장 안에만 있으면 마지막 글 전체", ho.pickHandoffText([say(1, "앞"), say(2, "<aether-handoff> 표식을 쓰라는 말")], codec), "<aether-handoff> 표식을 쓰라는 말");
  eq("닫히지 않은 표식은 마지막 글 전체", ho.pickHandoffText([say(1, "<aether-handoff>\n열기만")], codec), "<aether-handoff>\n열기만");
  eq("코드 상자를 품어도 잘리지 않는다", ho.pickHandoffText([say(1, "<aether-handoff>\n앞\n```ts\nconst a = 1;\n```\n뒤\n</aether-handoff>")], codec), "앞\n```ts\nconst a = 1;\n```\n뒤");
  eq("두 조각에 걸친 표식도 이어 붙여 잡는다", ho.pickHandoffText([say(1, "<aether-handoff>\n가"), say(2, "나\n</aether-handoff>")], codec), "가\n나");
  eq("글이 없으면 null", ho.pickHandoffText([ev(1, { t: "done" })], codec), null);
  eq("60000자에서 자른다", ho.pickHandoffText([say(1, "x".repeat(70_000))], codec)?.length, 60_000);
  eq("결과: 정상", ho.handoffTurnOutcome([ev(1, { t: "done" })], codec), "ok");
  eq("결과: 실패", ho.handoffTurnOutcome([ev(1, { t: "done", failed: true })], codec), "failed");
  eq("결과: 한도", ho.handoffTurnOutcome([ev(1, { t: "limit" }), ev(2, { t: "done", failed: true })], codec), "limit");
  eq("결과: 멈춤", ho.handoffTurnOutcome([ev(1, { t: "done", interrupted: true })], codec), "interrupted");
  eq("바뀐 파일은 중복 없이, 대상 글은 쪼개지 않는다", ho.changedFiles([ev(1, { t: "edit", text: "a.ts" }), ev(2, { t: "edit", text: "a.ts" }), ev(3, { t: "edit", text: "b.ts,c.ts" })], codec), ["a.ts", "b.ts,c.ts"]);
  eq("바뀐 파일은 50개까지", ho.changedFiles(Array.from({ length: 80 }, (_, i) => ev(i + 1, { t: "edit", text: `f${i}.ts` })), codec).length, 50);
}

console.log("\n=== 질문 턴과 인계서 ===");
{
  const box = "```aether-questions\n{\"questions\":[{\"id\":\"q1\",\"text\":\"어느 쪽?\",\"kind\":\"single\",\"options\":[{\"label\":\"A\"},{\"label\":\"B\"}]}]}\n```";
  eq("표식 없이 질문지 상자만 있으면 인계서가 아니다", ho.pickHandoffText([say(1, `정리\n${box}`)], codec), null);
  eq("표식이 있으면 표식이 이긴다", ho.pickHandoffText([say(1, `${box}\n<aether-handoff>\n본문\n</aether-handoff>`)], codec), "본문");
  eq("markerOnly: 표식 없는 평문은 null", ho.pickHandoffText([say(1, "딴말에 대한 답")], codec, true), null);
  eq("markerOnly: 표식이 있으면 받는다", ho.pickHandoffText([say(1, "<aether-handoff>\nx\n</aether-handoff>")], codec, true), "x");
  eq("표식 없는 평문 폴백은 그대로", ho.pickHandoffText([say(1, "그냥")], codec), "그냥");
}

console.log("\n=== 브리프 규칙 문자열 불변 ===");
{
  // 질문지 형식 안내를 상수로 뽑아도 브리프 규칙은 글자 하나 달라지면 안 된다(뽑기 전 지문).
  const { createHash } = await import("node:crypto");
  const { briefRules } = await import("../agent-brief/rules");
  const want = { ko: "b49c43670ed980fd1c737a673f6a6db615ce9948", en: "d3ee8dcfdfcea32dc8a7d7d0261c983aeeb53115" };
  for (const l of ["ko", "en"] as const) {
    setLocale(l);
    eq(`${l}: briefRules 지문`, createHash("sha1").update(briefRules()).digest("hex"), want[l]);
  }
  setLocale("ko");
}

console.log("\n=== 요청 글 ===");
{
  const provider = /claude|codex|grok|ollama|anthropic|openai|xai|mock3/i;
  for (const locale of ["ko", "en"] as const) {
    setLocale(locale);
    for (const focus of [undefined, "초점 글"]) {
      const r = ho.handoffRequest(focus);
      const tag = `${locale}/${focus ? "글 있음" : "글 없음"}`;
      check(r.modelText.startsWith("<aether-handoff-request>") && r.modelText.endsWith(r.text), `${tag}: 규칙 블록 뒤에 사람용 요청문`);
      check(!r.text.includes("<aether-handoff-request>"), `${tag}: 대화에 남는 글에는 규칙이 없다`);
      check(!provider.test(r.modelText), `${tag}: provider 이름이 없다`);
      check(focus ? r.text.includes(focus) : !r.text.includes(":"), `${tag}: 사람 글은 있을 때만 요청문에 든다`, r.text);
      const toc = locale === "ko" ? "목표 → 지금 상태 → 정한 것과 이유 → 해 봤는데 안 된 것 → 주의할 점 → 다음 단계 → 먼저 읽을 파일 → 확인하지 못한 것" : "Goal → Current state → Decisions and reasons → Tried and failed → Watch out → Next steps → Files to read first → Not confirmed";
      check(r.modelText.includes(toc), `${tag}: 제목과 순서`);
      check(r.modelText.includes("3,000"), `${tag}: 3,000자 권고`);
      check(r.modelText.includes("aether-questions") && r.modelText.includes("<aether-handoff>"), `${tag}: 질문지 형식과 표식 규칙`);
      check(r.modelText.includes(locale === "ko" ? "사람만 정할 수 있고" : "only the person can make"), `${tag}: 질문 조건`);
      check(!r.modelText.includes("purpose") && !r.modelText.includes("목적:"), `${tag}: 목적 안내가 없다`);
    }
    check(ho.handoffForceWriteText().length > 10 && !provider.test(ho.handoffForceWriteText()), `${locale}: 마지막 강제 요청 글`);
    const framed = ho.withHandoffFrame("본문", { focus: "  내 글 원문  ", name: "이름", id: "abc-123-full" });
    check(framed.startsWith(locale === "ko" ? "사람이 적은 요청 (원문)\n내 글 원문\n\n본문" : "Request written by the person (verbatim)\n내 글 원문\n\n본문"), `${locale}: 글 원문이 맨 위에 그대로`, framed);
    check(framed.endsWith(locale === "ko" ? "이전 세션: 이름 (abc-123-full)\n과거 검색 도구가 있으면 세부 내용은 이 세션을 찾아 읽는다." : "Previous session: 이름 (abc-123-full)\nIf a past-search tool is available, find and read this session for details."), `${locale}: 이전 세션 전체 id가 끝에`, framed);
    eq(`${locale}: 글이 없으면 맨 위 줄이 없다`, ho.withHandoffFrame("본문", { name: "n", id: "i" }).startsWith("본문"), true);
  }
  setLocale("ko");
  const skel = ho.skeletonHandoff({ name: "n", id: "12345678-aaaa", cwd: "/x", focus: "다음 일", reason: "r", userTexts: [], todo: null, files: [], gitChanges: null });
  check(skel.includes("다음 일") && !skel.includes("목적"), "뼈대에는 글만 있고 목적 줄이 없다");
}

// ── 통합 ──
const unregister = __registerProviderForTest(mock.mockEntry);
const sent: { kind?: string; title: string }[] = [];
const notifyOut = (i: { kind?: string; title: string }) => sent.push(i);
sessionManager.setOnLive((session) => attachNotify(session, notifyOut));
sessionManager.setNotifyOut(notifyOut);
const cwd = config.projectRootReal ?? config.projectRoot;
sessionManager.handoffLimitGraceMs = 150; // 글 없이 실패한 턴 뒤 한도 알림을 기다리는 시간. 시험에서는 줄인다

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = async (id: string, body: unknown) => {
  const r = await fetch(`${base}/api/sessions/${id}/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { state?: string; error?: string } };
};
const getInfo = async (id: string) => (await fetch(`${base}/api/sessions/${id}/handoff`)).json() as Promise<{ incoming?: { fromSessionId: string; text: string; source: string }; result?: { text: string; source: string; error?: string } }>;
const del = (id: string) => fetch(`${base}/api/sessions/${id}/handoff`, { method: "DELETE" });
const item = (id: string) => sessionManager.list().find((s) => s.id === id);
const userMsgs = (id: string) => store.readRecentEvents(id).filter((e) => e.kind === "user_msg") as unknown as { text: string; sentBy?: string; handoffFrom?: string; clientMessageId?: string }[];
const nextOf = (id: string) => item(id)?.handoffTo;

/** 세션을 만들고 그 실행부를 돌려준다. 만든 직후의 lastMockRuntime이 이 세션 것이다. */
function mk(opts: { cwd?: string; model?: string } = {}) {
  const live = sessionManager.create({ cwd: opts.cwd ?? cwd, provider: mock.MOCK_PROVIDER, model: opts.model });
  return { live, rt: mock.lastMockRuntime! };
}
const cleanup = (...ids: (string | undefined)[]) => ids.forEach((i) => i && sessionManager.delete(i));

console.log("\n=== 형식 오류는 400, 모델 호출 0번 ===");
{
  const { live } = mk();
  try {
    const before = mock.mockState.pushCalls;
    eq("초점 4001자", (await post(live.id, { focus: "x".repeat(4001) })).status, 400);
    eq("초점 자리에 숫자", (await post(live.id, { focus: 3 })).status, 400);
    eq("copyOnly 자리에 숫자", (await post(live.id, { copyOnly: 1 })).status, 400);
    eq("없는 세션", (await post("no-such-session", {})).status, 404);
    eq("받을 AI가 등록되지 않음", (await post(live.id, { provider: "no-such-ai" })).status, 409);
    eq("받을 폴더가 없음", (await post(live.id, { cwd: path.join(ROOT, "nope-nope") })).status, 409);
    eq("모델 호출 0번", mock.mockState.pushCalls - before, 0);
    eq("작업이 남지 않는다", item(live.id)?.handoffState, undefined);
  } finally {
    cleanup(live.id);
  }
}

console.log("\n=== 409: 보관·일하는 중·두 번째 요청 ===");
{
  const a = mk();
  const b = mk();
  const c = mk();
  try {
    sessionManager.setArchived(a.live.id, true);
    eq("보관된 세션", (await post(a.live.id, {})).status, 409);
    b.live.push("ASK:foo");
    check(await waitUntil(() => item(b.live.id)?.attention === "waiting"), "승인 대기에 들어갔다");
    eq("승인을 기다리는 중", (await post(b.live.id, {})).status, 409);
    mock.mockState.manualReply = true;
    eq("첫 요청은 202", (await post(c.live.id, {})).status, 202);
    eq("작업 상태는 writing", item(c.live.id)?.handoffState, "writing");
    eq("두 번째 요청은 409", (await post(c.live.id, {})).status, 409);
    eq("쓰는 중 DELETE는 409", (await del(c.live.id)).status, 409);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(a.live.id, b.live.id, c.live.id);
  }
}

console.log("\n=== 넘기기는 권한을 넓히지 않는다 ===");
for (const [from, want] of [["manual", "manual"], ["edits", "edits"], ["auto", "auto"], ["full", "auto"]] as const) {
  const { live, rt } = mk({ model: "mock-small" });
  try {
    await live.setPermissionMode(from);
    mock.mockState.manualReply = true;
    await post(live.id, { focus: "초점" });
    rt.emitRaw({ t: "say", text: "<aether-handoff>\n본문\n</aether-handoff>" });
    rt.emitRaw({ t: "done" });
    await waitUntil(() => !!nextOf(live.id));
    const n = sessionManager.get(nextOf(live.id)!)!;
    await waitUntil(() => n.permissionMode === want);
    eq(`${from}에서 넘기면 새 세션은 ${want}`, n.permissionMode, want);
    cleanup(n.id);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}

console.log("\n=== 정상 흐름 ===");
{
  const { live, rt } = mk({ model: "mock-small" });
  let next: string | undefined;
  try {
    live.setName("원래 작업");
    mock.mockState.manualReply = true;
    const before = mock.mockState.pushCalls;
    const r = await post(live.id, { focus: "초점" });
    eq("202 writing", [r.status, r.body.state], [202, "writing"]);
    eq("모델 호출은 한 번", mock.mockState.pushCalls - before, 1);
    const asked = userMsgs(live.id).at(-1);
    check(!!asked && !asked.text.includes("<aether-handoff-request>") && asked.text.includes("초점"), "대화의 사용자 말은 사람용 요청문이다", asked);
    check(asked?.clientMessageId?.startsWith("handoff-") === true && asked?.sentBy === undefined, "요청에는 handoff- 식별자, 자동 전송 표시는 없다");
    rt.emitRaw({ t: "say", text: "앞 잡담" });
    rt.emitRaw({ t: "say", text: "<aether-handoff>\n본문 한 줄\n```\n코드\n```" });
    rt.emitRaw({ t: "say", text: "</aether-handoff>\n뒤 잡담" });
    rt.emitRaw({ t: "done" });
    check(await waitUntil(() => !!nextOf(live.id)), "새 세션이 생기고 연결된다", item(live.id));
    next = nextOf(live.id)!;
    eq("이전 쪽 작업은 끝났다", item(live.id)?.handoffState, undefined);
    eq("저장 파일에 handoffTo", store.loadMeta(live.id)?.handoffTo, next);
    eq("저장 파일에 handoffFrom", store.loadMeta(next)?.handoffFrom, live.id);
    eq("목록에 handoffFrom과 초안 표시", [item(next)?.handoffFrom, item(next)?.handoffDraftPending], [live.id, true]);
    const info = await getInfo(next);
    eq("초안은 표식 안쪽 글에 사람 글과 이전 세션 표시를 붙인 것", [info.incoming?.text, info.incoming?.source, info.incoming?.fromSessionId],
      [`사람이 적은 요청 (원문)\n초점\n\n본문 한 줄\n\`\`\`\n코드\n\`\`\`\n\n이전 세션: 원래 작업 (${live.id})\n과거 검색 도구가 있으면 세부 내용은 이 세션을 찾아 읽는다.`, "model", live.id]);
    const n = sessionManager.get(next)!;
    eq("같은 AI·모델·폴더", [n.provider, n.model, n.cwd], [live.provider, live.model, live.cwd]);
    eq("권한 우회는 넘기지 않는다", n.permissionMode === "full", false);
    eq("이전 세션 이름을 물려받지 않는다", resolveTitle(n), undefined);

    // 첫 말, 둘째 말
    mock.mockState.manualReply = false;
    await n.push("확인했습니다");
    check(await waitUntil(() => userMsgs(next!).length === 1), "첫 말이 기록됐다");
    check(resolveTitle(n) !== undefined && resolveTitle(n) !== "원래 작업", "첫 말에서 새 세션처럼 제목이 정해진다", resolveTitle(n));
    await sleep(30);
    await n.push("둘째 말");
    check(await waitUntil(() => userMsgs(next!).length === 2), "둘째 말이 기록됐다");
    const msgs = userMsgs(next);
    eq("첫 말에만 handoffFrom", [msgs[0].handoffFrom, msgs[1].handoffFrom], [live.id, undefined]);
    eq("초안이 지워지고 표시도 꺼진다", [store.loadMeta(next)?.handoffDraft, item(next)?.handoffDraftPending], [undefined, undefined]);
    eq("GET에 incoming이 없다", (await getInfo(next)).incoming, undefined);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id, next);
  }
}

function resolveTitle(s: { name?: string; generatedName?: string }) {
  return s.name?.trim() || s.generatedName?.trim();
}

console.log("\n=== 표식이 없는 답 ===");
{
  const { live, rt } = mk();
  let next: string | undefined;
  try {
    mock.mockState.manualReply = true;
    await post(live.id, { focus: "로그인 화면을 만든다" });
    rt.emitRaw({ t: "say", text: "그냥 이렇게 씁니다" });
    rt.emitRaw({ t: "done" });
    check(await waitUntil(() => !!nextOf(live.id)), "새 세션이 생긴다");
    next = nextOf(live.id)!;
    const draft = (await getInfo(next)).incoming?.text ?? "";
    check(draft.startsWith("사람이 적은 요청 (원문)\n로그인 화면을 만든다\n\n그냥 이렇게 씁니다\n\n이전 세션:"), "마지막 글 전체가 초안(앞뒤 틀 포함)", draft);
    eq("초점 글로 제목을 미리 정하지 않는다", resolveTitle(sessionManager.get(next)!), undefined);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id, next);
  }
}

console.log("\n=== 실패 턴은 뼈대 인계서 ===");
{
  const repo = fs.mkdtempSync(path.join(ROOT, "repo-"));
  let git = true;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  } catch {
    git = false;
  }
  fs.writeFileSync(path.join(repo, "untracked.txt"), "x");
  const { live, rt } = mk({ cwd: repo });
  let next: string | undefined;
  try {
    live.setName("뼈대 시험");
    mock.mockState.manualReply = false;
    await live.push("첫 사람 말");
    check(await waitUntil(() => !live.isTurnOpen), "앞 턴이 끝났다");
    rt.emitRaw({ t: "edit", text: "src/a.ts" });
    rt.emitRaw({ t: "edit", text: "src/b.ts" });
    check(await waitUntil(() => store.readRecentEvents(live.id).filter((e) => e.kind === "mock3").length >= 4), "편집 사건이 쌓였다");
    mock.mockState.manualReply = true;
    await post(live.id, {});
    rt.emitRaw({ t: "done", failed: true });
    check(await waitUntil(() => !!nextOf(live.id)), "새 세션이 생긴다");
    next = nextOf(live.id)!;
    const info = await getInfo(next);
    const text = info.incoming?.text ?? "";
    eq("source는 skeleton", info.incoming?.source, "skeleton");
    check(text.includes("첫 사람 말"), "최근 사용자 말 원문");
    check(!text.startsWith("사람이 적은 요청") && text.split("이전 세션:").length === 2 && !text.includes("과거 검색 도구가 있으면"), "뼈대에는 틀을 이중으로 붙이지 않는다");
    check(!text.includes("새 세션으로 넘길 프롬프트를 써 줘"), "넘기기 요청은 뺀다");
    check(text.includes("src/a.ts") && text.includes("src/b.ts"), "기록에서 모은 두 경로");
    check(text.includes("뼈대 시험") && text.includes(live.id.slice(0, 8)), "이전 세션 이름과 id 앞 8자");
    check(text.includes("session_search"), "과거 검색 안내");
    if (git) check(text.includes("untracked.txt"), "git 변경(추적 안 된 파일)");
    else console.log("  (git 없음 — git 항목 건너뜀)");
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id, next);
  }
}

console.log("\n=== 한도: 쓰는 중 막힘, 이미 막힘, 취소 ===");
{
  const { live, rt } = mk();
  try {
    mock.mockState.manualReply = true;
    await post(live.id, {});
    rt.emitRaw({ t: "limit" });
    rt.emitRaw({ t: "done", failed: true });
    check(await waitUntil(() => item(live.id)?.handoffState === "waiting_limit"), "상태가 waiting_limit", item(live.id));
    eq("새 세션이 없다", nextOf(live.id), undefined);
    const plan = item(live.id)?.autoResume;
    eq("A1 예약에 인계서 쓰기가 얹혔다", [plan?.action.type, plan?.at !== undefined], ["handoff", true]);
    eq("취소하면 200", (await del(live.id)).status, 200);
    eq("작업과 예약이 모두 지워진다", [item(live.id)?.handoffState, item(live.id)?.autoResume], [undefined, undefined]);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}
{
  const { live } = mk();
  try {
    live.push("LIMIT:");
    check(await waitUntil(() => live.attentionHold?.kind === "rate_limit" && !live.isTurnOpen), "이미 한도에 막혔다");
    const before = mock.mockState.pushCalls;
    const r = await post(live.id, {});
    eq("바로 waiting_limit", [r.status, r.body.state], [202, "waiting_limit"]);
    eq("모델 호출 0번", mock.mockState.pushCalls - before, 0);
    eq("예약 종류는 handoff", item(live.id)?.autoResume?.action.type, "handoff");
    eq("사람 메시지는 한도 대기를 취소한다", (await live.push("직접 말"), await waitUntil(() => item(live.id)?.handoffState === undefined)), true);
  } finally {
    cleanup(live.id);
  }
}

console.log("\n=== 한도 대기 뒤 자동 실행과 포기 ===");
{
  const { live, rt } = mk();
  let next: string | undefined;
  try {
    live.push("LIMIT:");
    check(await waitUntil(() => live.attentionHold?.kind === "rate_limit" && !live.isTurnOpen), "이미 한도에 막혔다");
    await post(live.id, {});
    const before = mock.mockState.pushCalls;
    mock.mockState.manualReply = true;
    live.setAutoResume({ action: { type: "handoff" }, attempts: 0, at: Date.now() - 1 });
    await sessionManager.fireAutoResume(live.id);
    eq("예약이 실행되면 인계서를 요청한다", mock.mockState.pushCalls - before, 1);
    const last = userMsgs(live.id).at(-1);
    check(last?.sentBy === "aether" && last.clientMessageId?.startsWith("handoff-") === true, "요청에 자동 전송 표시가 붙는다", last);
    eq("상태는 writing", item(live.id)?.handoffState, "writing");
    // 세 번을 다 쓴 뒤 또 막힘 → 뼈대 인계서로 새 세션
    live.setAutoResume({ action: { type: "handoff" }, attempts: 3 });
    rt.emitRaw({ t: "limit" });
    rt.emitRaw({ t: "done", failed: true });
    check(await waitUntil(() => !!nextOf(live.id)), "포기하면 새 세션이 생긴다", item(live.id));
    next = nextOf(live.id)!;
    eq("초안은 skeleton", (await getInfo(next)).incoming?.source, "skeleton");
    eq("작업과 예약이 정리된다", [item(live.id)?.handoffState, item(live.id)?.autoResume], [undefined, undefined]);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id, next);
  }
}

console.log("\n=== 쓰는 중 멈춤 ===");
{
  const { live, rt } = mk();
  try {
    mock.mockState.manualReply = true;
    await post(live.id, {});
    rt.emitRaw({ t: "done", interrupted: true });
    check(await waitUntil(() => item(live.id)?.handoffState === undefined), "작업이 지워진다");
    await sleep(50);
    eq("새 세션이 없다", nextOf(live.id), undefined);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}

console.log("\n=== 멈춤 요청은 턴이 어떻게 끝나도 넘기기를 그만둔다 ===");
{
  const { live } = mk();
  try {
    mock.mockState.manualReply = true;
    mock.mockState.interruptFails = true; // 멈춘 턴이 실패로 끝나는 provider
    await post(live.id, {});
    await live.interrupt();
    check(await waitUntil(() => item(live.id)?.handoffState === undefined), "작업이 지워진다");
    await sleep(300);
    eq("새 세션이 없다", nextOf(live.id), undefined);
  } finally {
    mock.mockState.manualReply = false;
    mock.mockState.interruptFails = false;
    cleanup(live.id);
  }
}

console.log("\n=== 복사 결과가 남은 세션의 평범한 한도 턴은 문장 예약 ===");
{
  const { live, rt } = mk();
  try {
    mock.mockState.manualReply = true;
    await post(live.id, { copyOnly: true });
    rt.emitRaw({ t: "say", text: "<aether-handoff>\n글\n</aether-handoff>" });
    rt.emitRaw({ t: "done" });
    check(await waitUntil(() => item(live.id)?.handoffState === "copy_ready"), "copy_ready가 남았다");
    mock.mockState.manualReply = false;
    live.push("LIMIT:");
    check(await waitUntil(() => item(live.id)?.autoResume?.at !== undefined), "예약이 생겼다");
    eq("종류는 send", item(live.id)?.autoResume?.action.type, "send");
    eq("복사 결과는 그대로", item(live.id)?.handoffState, "copy_ready");
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}

console.log("\n=== 한도 알림이 실패 턴보다 늦게 와도 뼈대를 만들지 않는다 ===");
{
  const { live, rt } = mk();
  try {
    sessionManager.handoffLimitGraceMs = 1500;
    mock.mockState.manualReply = true;
    await post(live.id, {});
    rt.emitRaw({ t: "done", failed: true });
    await sleep(300);
    rt.emitRaw({ t: "limit" });
    check(await waitUntil(() => item(live.id)?.handoffState === "waiting_limit"), "대기로 바뀐다", item(live.id));
    await sleep(1600);
    eq("새 세션이 없다", nextOf(live.id), undefined);
    eq("대기가 유지된다", item(live.id)?.handoffState, "waiting_limit");
  } finally {
    sessionManager.handoffLimitGraceMs = 150;
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}

console.log("\n=== 복사만 ===");
{
  const { live, rt } = mk();
  try {
    mock.mockState.manualReply = true;
    await post(live.id, { copyOnly: true });
    rt.emitRaw({ t: "say", text: "<aether-handoff>\n복사할 글\n</aether-handoff>" });
    rt.emitRaw({ t: "done" });
    check(await waitUntil(() => item(live.id)?.handoffState === "copy_ready"), "copy_ready");
    eq("새 세션이 없다", nextOf(live.id), undefined);
    check((await getInfo(live.id)).result?.text.includes("복사할 글") === true, "GET으로 글이 온다");
    eq("DELETE 성공", (await del(live.id)).status, 200);
    eq("지워진다", [item(live.id)?.handoffState, (await getInfo(live.id)).result], [undefined, undefined]);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}

console.log("\n=== 새 세션 생성 실패 ===");
{
  const { live, rt } = mk();
  const folder = fs.mkdtempSync(path.join(ROOT, "gone-"));
  try {
    mock.mockState.manualReply = true;
    eq("폴더가 있을 때는 202", (await post(live.id, { cwd: folder })).status, 202);
    fs.rmSync(folder, { recursive: true, force: true });
    rt.emitRaw({ t: "say", text: "<aether-handoff>\n잃으면 안 되는 글\n</aether-handoff>" });
    rt.emitRaw({ t: "done" });
    check(await waitUntil(() => item(live.id)?.handoffState === "copy_ready"), "copy_ready로 남는다");
    const res = (await getInfo(live.id)).result;
    check(res?.text?.includes("잃으면 안 되는 글") === true, "글을 잃지 않는다", res);
    check(!!res?.error, "result.error가 있다", res);
  } finally {
    mock.mockState.manualReply = false;
    cleanup(live.id);
  }
}

console.log("\n=== 복사본 세션은 원 폴더로 ===");
{
  const repo = fs.mkdtempSync(path.join(ROOT, "src-"));
  let ok = true;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  } catch {
    ok = false;
  }
  if (!ok) console.log("  (git 없음 — 건너뜀)");
  else {
    const live = sessionManager.create({ cwd: repo, provider: mock.MOCK_PROVIDER, isolateWorkspace: true });
    const rt = mock.lastMockRuntime!;
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      rt.emitRaw({ t: "say", text: "<aether-handoff>\n글\n</aether-handoff>" });
      rt.emitRaw({ t: "done" });
      check(await waitUntil(() => !!nextOf(live.id)), "새 세션이 생긴다");
      next = nextOf(live.id)!;
      eq("받은 폴더는 복사본이 아니라 원 폴더", fs.realpathSync(sessionManager.get(next)!.cwd), fs.realpathSync(repo));
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }
}

console.log("\n=== 질문 대기(asking) ===");
{
  const qbox = (n: number) => `정리\n\`\`\`aether-questions\n${JSON.stringify({ questions: [{ id: "q1", text: `질문${n}`, kind: "single", options: [{ label: "A" }, { label: "B" }], recommended: "A" }] })}\n\`\`\``;
  const qevs = (id: string) => store.readRecentEvents(id).filter((e) => e.kind === "questionnaire") as unknown as { id: string }[];
  const answerCard = async (live: ReturnType<typeof mk>["live"], tag: string) => {
    const q = await live.openQuestionnaire();
    if (!q) return { ok: false as const, status: 0, error: "열린 질문지 없음" };
    return live.submitQuestionnaireAnswer({ questionnaireId: q.id, answers: { q1: { chosen: ["A"] } }, clientMessageId: tag, resendOnDuplicate: false });
  };
  const ask = (rt: ReturnType<typeof mk>["rt"], n: number) => {
    rt.emitRaw({ t: "say", text: qbox(n) });
    rt.emitRaw({ t: "done" });
  };
  const finishWith = (rt: ReturnType<typeof mk>["rt"], body: string) => {
    rt.emitRaw({ t: "say", text: `<aether-handoff>\n${body}\n</aether-handoff>` });
    rt.emitRaw({ t: "done" });
  };

  // 질문 → asking → 카드 답 → 인계서 → 새 세션
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      live.setName("질문 시험");
      mock.mockState.manualReply = true;
      await post(live.id, { focus: "로그인 만들기" });
      ask(rt, 1);
      check(await waitUntil(() => item(live.id)?.handoffState === "asking"), "질문 턴이 끝나면 asking이다", item(live.id));
      eq("질문 턴을 인계서로 착각하지 않는다", [nextOf(live.id), (await getInfo(live.id)).result], [undefined, undefined]);
      eq("질문지 사건이 하나 생겼다", qevs(live.id).length, 1);
      await sleep(250); // 뼈대 유예보다 길게 기다려도 asking이 유지된다
      eq("asking은 유지된다", [item(live.id)?.handoffState, nextOf(live.id)], ["asking", undefined]);
      eq("두 번째 요청은 already(409)", (await post(live.id, {})).status, 409);
      const r = await answerCard(live, "ho-ans-1");
      check(r.ok === true, "카드 답이 받아들여진다", r);
      check(await waitUntil(() => item(live.id)?.handoffState === "writing"), "카드 답이 오면 writing으로 돌아온다");
      finishWith(rt, "답을 반영한 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "인계서가 나오면 새 세션이 생긴다");
      next = nextOf(live.id)!;
      const text = (await getInfo(next)).incoming?.text ?? "";
      check(text.startsWith("사람이 적은 요청 (원문)\n로그인 만들기\n\n답을 반영한 본문") && text.endsWith(`(${live.id})\n과거 검색 도구가 있으면 세부 내용은 이 세션을 찾아 읽는다.`), "초안 맨 위에 글 원문, 끝에 이전 세션 id", text);
      eq("작업이 정리된다", item(live.id)?.handoffState, undefined);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }

  // 뒤에서 도는 작업을 기다리며 멈춘 턴의 글은 인계서가 아니다
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      rt.emitRaw({ t: "bg", tasks: ["t1"] });
      rt.emitRaw({ t: "say", text: "에이전트를 띄웠다. 결과를 기다린다." });
      rt.emitRaw({ t: "done" });
      await new Promise((r) => setTimeout(r, 50));
      eq("작업을 기다리는 턴에서는 넘기지 않는다", [item(live.id)?.handoffState, nextOf(live.id)], ["writing", undefined]);
      rt.emitRaw({ t: "bg", tasks: [] });
      rt.emitRaw({ t: "done" });
      await new Promise((r) => setTimeout(r, 50));
      eq("기다리는 중에 글 없이 끝난 턴에서도 넘기지 않는다", [item(live.id)?.handoffState, nextOf(live.id)], ["writing", undefined]);
      rt.emitRaw({ t: "start" });
      finishWith(rt, "작업 뒤에 쓴 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "작업이 끝난 뒤의 인계서로 넘어간다");
      next = nextOf(live.id)!;
      const text = (await getInfo(next)).incoming?.text ?? "";
      check(text.includes("작업 뒤에 쓴 본문") && !text.includes("결과를 기다린다"), "기다린 턴의 글은 인계서에 들어가지 않는다", text);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
      if (next) cleanup(next);
    }
  }
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      rt.emitRaw({ t: "bg", tasks: ["t1"] });
      finishWith(rt, "작업이 도는 중에 쓴 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "표식 있는 인계서는 작업이 돌아도 바로 받는다");
      next = nextOf(live.id)!;
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
      if (next) cleanup(next);
    }
  }
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      rt.emitRaw({ t: "bg", tasks: ["t1"] });
      ask(rt, 1);
      check(await waitUntil(() => item(live.id)?.handoffState === "asking"), "질문 턴은 작업이 돌아도 질문 대기가 된다");
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }

  // 물을 게 없으면 바로 인계서 + 요청은 질문지 판독을 켠다(briefOpen이 저장된다)
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      eq("요청을 보내면 질문지 판독이 켜진다", store.loadMeta(live.id)?.briefOpen, true);
      finishWith(rt, "바로 쓴 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "질문 없이 바로 새 세션이 생긴다");
      next = nextOf(live.id)!;
      eq("글이 없으면 맨 위 줄이 없다", (await getInfo(next)).incoming?.text.startsWith("바로 쓴 본문"), true);
      eq("질문지 판독은 턴 끝에 꺼진다", store.loadMeta(live.id)?.briefOpen, undefined);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }

  // 질문은 2회까지. 세 번째 질문이면 강제 요청
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt, 1);
      check(await waitUntil(() => item(live.id)?.handoffState === "asking"), "1회째 질문");
      await answerCard(live, "ho-r1");
      await waitUntil(() => item(live.id)?.handoffState === "writing");
      ask(rt, 2);
      check(await waitUntil(() => item(live.id)?.handoffState === "asking" && qevs(live.id).length === 2), "2회째 질문");
      await answerCard(live, "ho-r2");
      await waitUntil(() => item(live.id)?.handoffState === "writing");
      const before = mock.mockState.pushCalls;
      ask(rt, 3);
      check(await waitUntil(() => mock.mockState.pushCalls - before === 1), "3회째 질문이면 강제 요청을 보낸다");
      const forced = userMsgs(live.id).at(-1);
      check(forced?.text === ho.handoffForceWriteText() && forced?.sentBy === "aether" && forced?.clientMessageId?.startsWith("handoff-") === true, "강제 요청은 Aether 글이다", forced);
      eq("상태는 writing", item(live.id)?.handoffState, "writing");
      finishWith(rt, "마무리 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "강제 요청 뒤 인계서가 나온다");
      next = nextOf(live.id)!;
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }
  // 강제 요청 뒤에도 또 물으면 뼈대로 넘긴다(무한 반복 없음)
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      live.setName("끝없는 질문");
      mock.mockState.manualReply = true;
      await post(live.id, {});
      for (let n = 1; n <= 2; n++) {
        ask(rt, n);
        await waitUntil(() => item(live.id)?.handoffState === "asking" && qevs(live.id).length === n);
        await answerCard(live, `ho-loop-${n}`);
        await waitUntil(() => item(live.id)?.handoffState === "writing");
      }
      ask(rt, 3); // 강제 요청이 나간다
      await waitUntil(() => userMsgs(live.id).at(-1)?.sentBy === "aether");
      ask(rt, 4); // 그래도 또 묻는다
      check(await waitUntil(() => !!nextOf(live.id)), "또 물으면 뼈대로 넘긴다", item(live.id));
      next = nextOf(live.id)!;
      eq("초안은 skeleton", (await getInfo(next)).incoming?.source, "skeleton");
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }

  // 사람이 카드 대신 채팅으로 딴말
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt, 1);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      await live.push("그런데 오늘 날씨 어때?");
      check(await waitUntil(() => item(live.id)?.handoffState === "writing"), "채팅이 오면 writing");
      rt.emitRaw({ t: "say", text: "날씨는 모릅니다" });
      rt.emitRaw({ t: "done" });
      check(await waitUntil(() => item(live.id)?.handoffState === "asking"), "딴말 턴은 asking으로 돌아온다", item(live.id));
      await sleep(250);
      eq("딴말에 대한 답을 인계서로 쓰지 않는다", [nextOf(live.id), item(live.id)?.handoffState], [undefined, "asking"]);
      await live.push("그냥 알아서 써");
      await waitUntil(() => item(live.id)?.handoffState === "writing");
      finishWith(rt, "알아서 쓴 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "이어서 인계서가 나오면 새 세션이 생긴다");
      next = nextOf(live.id)!;
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }

  // 취소
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt, 1);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      eq("asking 취소는 200", (await del(live.id)).status, 200);
      eq("작업이 지워진다", item(live.id)?.handoffState, undefined);
      await live.push("취소 뒤 말");
      rt.emitRaw({ t: "say", text: "<aether-handoff>\n취소 뒤 글\n</aether-handoff>" });
      rt.emitRaw({ t: "done" });
      await sleep(250);
      eq("취소 뒤에는 인계서를 받지 않는다", [nextOf(live.id), item(live.id)?.handoffState], [undefined, undefined]);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }

  // 질문 대기 중 세션이 끝나도 뼈대를 만들지 않는다
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt, 1);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      rt.emitRaw({ t: "done", failed: true }); // 턴 끝 사건이 질문 대기 중에 와도 무시한다
      await sleep(300);
      eq("뼈대가 생기지 않는다", [nextOf(live.id), item(live.id)?.handoffState], [undefined, "asking"]);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }
}

console.log("\n=== 질문 대기: 예외 경로 ===");
{
  const qbox = (n: number) => `정리\n\`\`\`aether-questions\n${JSON.stringify({ questions: [{ id: "q1", text: `질문${n}`, kind: "single", options: [{ label: "A" }, { label: "B" }], recommended: "A" }] })}\n\`\`\``;
  const ask = (rt: ReturnType<typeof mk>["rt"], n = 1) => {
    rt.emitRaw({ t: "say", text: qbox(n) });
    rt.emitRaw({ t: "done" });
  };
  const marker = (rt: ReturnType<typeof mk>["rt"], body: string) => {
    rt.emitRaw({ t: "say", text: `<aether-handoff>\n${body}\n</aether-handoff>` });
    rt.emitRaw({ t: "done" });
  };

  // 글 상한: 끝의 이전 세션 id가 잘리지 않는다
  {
    const framed = ho.withHandoffFrame("x".repeat(70_000), { focus: "글", name: "이름", id: "full-id-0001" });
    check(framed.length <= ho.HANDOFF_TEXT_MAX && framed.endsWith("찾아 읽는다.") && framed.includes("(full-id-0001)"), "상한에 걸려도 끝의 이전 세션 id가 남는다", framed.length);
  }

  // 재전송: user_msg 없이 도는 턴
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      rt.emitRaw({ t: "say", text: "표식 없는 평문 답" });
      rt.emitRaw({ t: "done" });
      await sleep(300);
      eq("user_msg 없는 턴이 표식 없이 끝나면 asking을 유지한다", [item(live.id)?.handoffState, nextOf(live.id)], ["asking", undefined]);
      marker(rt, "재전송 턴의 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "user_msg 없는 턴에 표식 있는 글이 오면 넘긴다", item(live.id));
      next = nextOf(live.id);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }

  // 실패한 딴말
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      await live.push("딴말");
      await waitUntil(() => item(live.id)?.handoffState === "writing");
      rt.emitRaw({ t: "done", failed: true });
      check(await waitUntil(() => item(live.id)?.handoffState === "asking"), "딴말 턴이 실패해도 asking으로 돌아온다", item(live.id));
      await sleep(300);
      eq("뼈대 새 세션이 생기지 않는다", nextOf(live.id), undefined);
      eq("질문지 판독이 다시 켜져 있다", store.loadMeta(live.id)?.briefOpen, true);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }

  // 딴말 턴에서 질문 상자가 오면 질문으로 센다
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt, 1);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      await live.push("딴말");
      await waitUntil(() => item(live.id)?.handoffState === "writing");
      ask(rt, 2);
      check(await waitUntil(() => store.readRecentEvents(live.id).filter((e) => e.kind === "questionnaire").length === 2), "딴말 뒤 질문도 질문지 사건이 된다");
      eq("횟수가 늘고 asking이다", [item(live.id)?.handoffState, store.loadMeta(live.id)?.handoffJob?.askRounds], ["asking", 2]);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }

  // 취소 뒤 카드 답은 409
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await post(live.id, {});
      ask(rt);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      const q = await live.openQuestionnaire();
      await del(live.id);
      eq("취소하면 질문지 판독이 꺼진다", store.loadMeta(live.id)?.briefOpen, undefined);
      const r = await live.submitQuestionnaireAnswer({ questionnaireId: q!.id, answers: { q1: { chosen: ["A"] } }, clientMessageId: "after-cancel", resendOnDuplicate: false });
      check(!r.ok && r.status === 409, "취소 뒤 그 카드에 답하면 409다", r);
      await live.push("다른 말");
      ask(rt);
      await waitUntil(() => userMsgs(live.id).length > 0 && !live.hasPendingInput);
      const next = await live.openQuestionnaire();
      const again = await live.submitQuestionnaireAnswer({ questionnaireId: next!.id, answers: { q1: { chosen: ["A"] } }, clientMessageId: "after-new", resendOnDuplicate: false });
      check(again.ok, "취소 뒤 새로 나온 카드에는 답할 수 있다", again);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }

  // 되돌리기로 요청이 숨겨지면 작업을 지운다
  {
    const { live, rt } = mk();
    try {
      mock.mockState.manualReply = true;
      await live.push("첫 말");
      rt.emitRaw({ t: "done" });
      await waitUntil(() => !live.isTurnOpen);
      const first = userMsgs(live.id)[0] as unknown as { seq: number };
      await post(live.id, {});
      ask(rt);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      await sessionManager.rewind(live.id, first.seq);
      eq("되돌리면 질문 대기 작업이 지워진다", [item(live.id)?.handoffState, store.loadMeta(live.id)?.briefOpen], [undefined, undefined]);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id);
    }
  }

  // 잠들었다 깨도 감시가 새 실행기에 걸린다
  {
    const { live, rt } = mk();
    let next: string | undefined;
    try {
      mock.mockState.manualReply = true;
      await live.push("첫 말");
      rt.emitRaw({ t: "done" });
      await waitUntil(() => !live.isTurnOpen);
      await post(live.id, {});
      ask(rt);
      await waitUntil(() => item(live.id)?.handoffState === "asking");
      const slept = await sessionManager.sweepIdle(Date.now() + 31 * 60_000);
      check(slept >= 1 && !sessionManager.get(live.id), "질문 대기 중에는 잠들 수 있다", slept);
      eq("작업은 남는다", item(live.id)?.handoffState, "asking");
      const woke = sessionManager.getOrResume(live.id);
      const wokeRt = mock.lastMockRuntime!;
      await woke.push("그냥 써 줘");
      check(await waitUntil(() => item(live.id)?.handoffState === "writing"), "깬 뒤 사람의 글이 오면 writing이 된다");
      marker(wokeRt, "깬 뒤 본문");
      check(await waitUntil(() => !!nextOf(live.id)), "깬 뒤에도 인계서가 새 세션으로 간다", item(live.id));
      next = nextOf(live.id);
    } finally {
      mock.mockState.manualReply = false;
      cleanup(live.id, next);
    }
  }

  // 강제 문장을 붙인 재개 요청에는 질문지 판독을 켜지 않는다
  {
    const r = ho.handoffRequest("글", true);
    check(r.modelText.endsWith(ho.handoffForceWriteText()), "forced 요청의 모델 입력 끝에 강제 문장이 붙는다");
    check(!ho.handoffRequest("글").modelText.endsWith(ho.handoffForceWriteText()), "보통 요청에는 붙지 않는다");
  }
}

console.log("\n=== 재시작 복원 ===");
{
  const mkDisk = (id: string, job: unknown) => {
    const dir = path.join(DATA, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: ROOT, provider: mock.MOCK_PROVIDER, createdAt: 1, resumeKey: "mock-thread-ho", handoffJob: job }));
    store.appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" } as never);
  };
  mkDisk("ho-writing-1", { purpose: "continue", includeMethod: true, state: "writing", requestedAt: 1 });
  mkDisk("ho-waiting-1", { purpose: "continue", includeMethod: true, state: "waiting_limit", requestedAt: 1 }); // 옛 저장 작업(purpose 포함)
  mkDisk("ho-asking-1", { focus: "f", state: "asking", requestedAt: 1, askRounds: 1 });
  sessionManager.restoreFromDisk();
  eq("쓰던 작업은 버려진다", item("ho-writing-1")?.handoffState, undefined);
  eq("한도 대기는 남는다", item("ho-waiting-1")?.handoffState, "waiting_limit");
  eq("질문 대기는 남는다", item("ho-asking-1")?.handoffState, "asking");
  // 재시작 뒤 세션을 새로 띄우면 지켜보기가 다시 걸린다
  mock.mockState.manualReply = true;
  const woke = sessionManager.getOrResume("ho-asking-1");
  const wokeRt = mock.lastMockRuntime!;
  await woke.push("그냥 써 줘");
  check(await waitUntil(() => item("ho-asking-1")?.handoffState === "writing"), "사람의 글이 오면 writing으로 바뀐다(감시 재무장)", item("ho-asking-1"));
  wokeRt.emitRaw({ t: "say", text: "<aether-handoff>\n재시작 뒤 본문\n</aether-handoff>" });
  wokeRt.emitRaw({ t: "done" });
  check(await waitUntil(() => !!nextOf("ho-asking-1")), "재시작 뒤에도 인계서가 새 세션으로 간다");
  const restartedNext = nextOf("ho-asking-1");
  mock.mockState.manualReply = false;
  cleanup("ho-writing-1", "ho-waiting-1", "ho-asking-1", restartedNext);
}

server.close();
unregister();
console.log(`\n${fail === 0 ? "✅" : "❌"} session_handoff: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
