/**
 * 다른 AI에게 검토 맡기기 — 가짜 provider, 모델 호출 0.
 * 요청 글(순수 함수)·오류 응답·정상 흐름(새 세션 설정과 초안)·격리 복사본·세 provider 기록의 동일성.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-reviewreq-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-reviewreq-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("review_request"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const mock = await import("./support/mockProvider");
const { setLocale } = await import("../i18n");
const { __registerProviderForTest } = await import("../providers/registry");
const { reviewRequestText } = await import("../sessions/reviewRequest");
const { HANDOFF_TEXT_MAX } = await import("../sessions/handoff");
const express = (await import("express")).default;
const { reviewRouter } = await import("../routes/review");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}
const eq = (name: string, a: unknown, b: unknown) => check(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

const unregister = __registerProviderForTest(mock.mockEntry);
const app = express();
app.use(express.json());
app.use("/api/review", reviewRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const request = async (id: string, body: unknown) => {
  const r = await fetch(`${base}/api/review/${id}/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as { id?: string; error?: string } };
};
const git = (args: string[], cwd: string) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const item = (id: string) => sessionManager.list().find((s) => s.id === id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ── 작업 폴더 ──
const repo = path.join(ROOT, "repo");
fs.mkdirSync(repo);
git(["init", "-q"], repo);
fs.writeFileSync(path.join(repo, "a.ts"), "1");
git(["add", "."], repo);
git(["commit", "-q", "-m", "init"], repo);
fs.writeFileSync(path.join(repo, "a.ts"), "2");
const plain = path.join(ROOT, "plain");
fs.mkdirSync(plain);

// ── 원본 사건 심기 ──
const now = Date.now();
function seed(spec: { cwd: string; provider: string; name: string; events: object[]; archivedAt?: number }): string {
  const id = randomUUID();
  fs.mkdirSync(path.join(DATA, id), { recursive: true });
  fs.writeFileSync(path.join(DATA, id, "meta.json"), JSON.stringify({ id, cwd: spec.cwd, provider: spec.provider, name: spec.name, createdAt: now - 1000, ...(spec.archivedAt ? { archivedAt: spec.archivedAt } : {}) }));
  spec.events.forEach((e, i) => store.appendEvent(id, { seq: i + 1, ts: now + i, ...e } as never));
  return id;
}
const done = { kind: "status", status: "completed" };
const userMsg = (text: string) => ({ kind: "user_msg", text });
const claudeCall = (id: string, name: string, input: object) => ({ kind: "sdk", msg: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } } });
const claudeRes = (id: string, err = false) => ({ kind: "sdk", msg: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "o", ...(err ? { is_error: true } : {}) }] } } });
const codexItem = (method: string, it: object) => ({ kind: "codex", msg: { method, params: { item: it } } });
const grokUpd = (update: object) => ({ kind: "grok", msg: { method: "session/update", params: { update } } });
const aFile = path.join(repo, "src", "a.ts");

const sMain = seed({ cwd: repo, provider: "claude", name: "원래 작업", events: [
  userMsg("a.ts를 고쳐 줘"),
  claudeCall("c1", "Bash", { command: "npm test" }), claudeRes("c1", true),
  claudeCall("c2", "Edit", { file_path: aFile }), claudeRes("c2"),
  done,
] });
const sArchived = seed({ cwd: repo, provider: "claude", name: "보관됨", archivedAt: now, events: [claudeCall("c1", "Edit", { file_path: aFile }), claudeRes("c1"), done] });
const sChatOnly = seed({ cwd: plain, provider: "claude", name: "대화만", events: [userMsg("안녕"), done] });
sessionManager.restoreFromDisk();

console.log("\n=== 요청 글(순수 함수) ===");
{
  const summary = {
    changedFiles: [{ path: path.join(repo, "src", "a.ts"), seq: 1 }, { path: "/elsewhere/b.ts", seq: 2 }],
    failedCommands: [{ text: "npm test", seq: 3 }],
    otherFailures: [],
    openTodos: [{ text: "시험 추가", seq: 4 }],
  };
  const input = { name: "Name", id: "abcd-1234", cwd: repo, isGit: true, partial: true, userTexts: ["첫 말", "둘째 말"], summary };
  setLocale("ko");
  const ko = reviewRequestText(input);
  check(ko.includes("검토한다") && ko.includes("만들거나 고치거나 지우지 않는다"), "지시 규칙이 들어간다");
  check(ko.includes("Name (abcd-1234)"), "이전 세션 이름과 id");
  check(ko.includes("1. 첫 말") && ko.includes("2. 둘째 말"), "사람의 말 원문");
  check(ko.includes("- src/a.ts") && !ko.includes(path.join(repo, "src")), "폴더 안 파일은 상대 경로");
  check(ko.includes("- /elsewhere/b.ts"), "폴더 밖 파일은 그대로");
  check(ko.includes("npm test") && ko.includes("시험 추가"), "실패한 명령과 남은 할 일");
  check(ko.includes("앞부분이 빠졌다"), "partial 한 줄");
  check(ko.includes("git 저장소다") && !ko.includes("git 저장소가 아니다"), "git 폴더 안내");
  check(reviewRequestText({ ...input, isGit: false }).includes("git 저장소가 아니다"), "저장소가 아니면 다른 안내");
  check(!reviewRequestText({ ...input, partial: false }).includes("앞부분이 빠졌다"), "partial이 아니면 줄이 없다");
  check(!/claude|codex|grok|ollama|anthropic|openai/i.test(ko), "provider 이름이 없다");
  setLocale("en");
  const en = reviewRequestText(input);
  check(en.includes("reviewing work") && en.includes("Previous session") && !/[가-힣]/.test(en.replace("첫 말", "").replace("둘째 말", "").replace("시험 추가", "")), "영어로 바꾸면 영어로 나온다");
  setLocale("ko");
  const many = { ...summary, changedFiles: Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.ts`, seq: i })), failedCommands: Array.from({ length: 15 }, (_, i) => ({ text: `cmd${i}`, seq: i })), openTodos: Array.from({ length: 30 }, (_, i) => ({ text: `todo${i}`, seq: i })) };
  const big = reviewRequestText({ ...input, summary: many });
  check(big.includes("f49.ts") && !big.includes("f50.ts") && big.includes("외 10개"), "파일은 50개까지, 넘치면 외 N개");
  check(big.includes("cmd9") && !big.includes("cmd10") && big.includes("todo19") && !big.includes("todo20"), "실패 명령 10개, 할 일 20개까지");
  check(reviewRequestText({ ...input, userTexts: ["x".repeat(70_000)] }).length <= HANDOFF_TEXT_MAX, "전체 길이 상한");
  check(!ko.includes("@@") && !ko.includes("diff --git"), "diff 본문이 들어가지 않는다");
}

console.log("\n=== 오류 응답, 모델 호출 0번 ===");
{
  let calls = 0; // 시험이 직접 보낸 말(ASK)은 빼고 요청이 부른 모델만 센다
  const before = mock.mockState.pushCalls;
  eq("provider 빠짐", (await request(sMain, {})).status, 400);
  eq("provider 자리에 숫자", (await request(sMain, { provider: 3 })).status, 400);
  eq("없는 세션", (await request(randomUUID(), { provider: mock.MOCK_PROVIDER })).status, 404);
  eq("등록 안 된 provider", (await request(sMain, { provider: "no-such-ai" })).status, 409);
  eq("보관된 세션", (await request(sArchived, { provider: mock.MOCK_PROVIDER })).status, 409);
  const none = await request(sChatOnly, { provider: mock.MOCK_PROVIDER });
  check(none.status === 409 && none.json.error === "검토할 변경이 없어요", "대화만 있고 변경이 없으면 409", none);
  const live = sessionManager.create({ cwd: repo, provider: mock.MOCK_PROVIDER });
  try {
    calls += mock.mockState.pushCalls - before;
    live.push("ASK:foo");
    check(await waitUntil(() => item(live.id)?.attention === "waiting"), "승인 대기에 들어갔다");
    const mid = mock.mockState.pushCalls;
    eq("일하는 중", (await request(live.id, { provider: mock.MOCK_PROVIDER })).status, 409);
    calls += mock.mockState.pushCalls - mid;
  } finally {
    sessionManager.delete(live.id);
  }
  eq("모델 호출 0번", calls, 0);
}

console.log("\n=== 정상 흐름 ===");
{
  const before = mock.mockState.pushCalls;
  const before2 = sessionManager.list().length;
  const r = await request(sMain, { provider: mock.MOCK_PROVIDER });
  eq("201", r.status, 201);
  const nid = r.json.id!;
  const next = sessionManager.get(nid)!;
  eq("새 세션의 provider", next.provider, mock.MOCK_PROVIDER);
  // 런타임이 시작 권한 모드를 맞춘 뒤에 본다. 맞추기 전에는 세션이 늘 manual이라 검사가 헛돈다.
  check(await waitUntil(() => next.permissionModes !== undefined), "권한 모드 목록을 받았다");
  eq("권한 모드는 수동", next.permissionMode, "manual");
  eq("작업 폴더는 같다", next.cwd, repo);
  eq("세션이 하나 늘었다", sessionManager.list().length - before2, 1);
  check(item(nid)?.displayName.startsWith("검토:") === true, "이름은 검토:로 시작", item(nid)?.displayName);
  const info = sessionManager.handoffInfo(nid)!;
  eq("초안 출처는 review", info.incoming?.source, "review");
  eq("이전 세션 id", info.incoming?.fromSessionId, sMain);
  check(!!info.incoming?.text.includes("src/a.ts") && info.incoming.text.includes("a.ts를 고쳐 줘") && info.incoming.text.includes("npm test") && info.incoming.text.includes(sMain), "초안에 파일·사람 말·실패 명령·이전 세션 id");
  eq("원래 세션의 handoffTo는 그대로", item(sMain)?.handoffTo, undefined);
  eq("원래 세션에 넘기기 작업이 생기지 않는다", item(sMain)?.handoffState, undefined);
  eq("성공한 뒤에도 모델 호출 0번", mock.mockState.pushCalls - before, 0);
  sessionManager.delete(nid);
}

console.log("\n=== 격리 복사본 ===");
{
  const src = path.join(ROOT, "iso-src");
  fs.mkdirSync(src);
  git(["init", "-q"], src);
  fs.writeFileSync(path.join(src, "f.txt"), "1");
  git(["add", "."], src);
  git(["commit", "-q", "-m", "init"], src);
  const orig = sessionManager.create({ cwd: src, provider: mock.MOCK_PROVIDER, isolateWorkspace: true });
  let nid: string | undefined;
  try {
    const copy = orig.cwd;
    check(copy !== src, "복사본 경로가 따로 있다", copy);
    fs.writeFileSync(path.join(copy, "f.txt"), "2");
    const r = await request(orig.id, { provider: mock.MOCK_PROVIDER });
    eq("201", r.status, 201);
    nid = r.json.id!;
    eq("새 세션의 cwd는 복사본 경로", sessionManager.get(nid)!.cwd, copy);
    eq("새 세션은 복사본이 아니다", item(nid)?.isolated, false);
    sessionManager.delete(nid);
    nid = undefined;
    check(fs.existsSync(copy), "검토 세션을 지워도 복사본 폴더가 남는다");
  } finally {
    if (nid) sessionManager.delete(nid);
    sessionManager.delete(orig.id);
  }
}

console.log("\n=== 세 provider 기록의 동일성 ===");
{
  const dir = path.join(ROOT, "same");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "x.ts"), "x");
  const target = path.join(dir, "pkg", "x.ts");
  const ids = {
    claude: seed({ cwd: dir, provider: "claude", name: "C", events: [userMsg("하라"), claudeCall("e1", "Edit", { file_path: target }), claudeRes("e1"), done] }),
    codex: seed({ cwd: dir, provider: "codex", name: "X", events: [userMsg("하라"),
      codexItem("item/started", { type: "fileChange", id: "i1", status: "inProgress", changes: [{ path: target, kind: { type: "add" }, diff: "d" }] }),
      codexItem("item/completed", { type: "fileChange", id: "i1", status: "completed", changes: [{ path: target, kind: { type: "add" }, diff: "d" }] }), done] }),
    grok: seed({ cwd: dir, provider: "grok", name: "G", events: [userMsg("하라"),
      grokUpd({ sessionUpdate: "tool_call", toolCallId: "g2", title: "search_replace", kind: "edit", rawInput: { file_path: target } }),
      grokUpd({ sessionUpdate: "tool_call_update", toolCallId: "g2", status: "completed", content: { type: "text", text: "o" } }), done] }),
  };
  sessionManager.restoreFromDisk();
  const shape = (t: string, id: string) => t.replace(id, "<id>").replace(/\(.*?\)$/m, "").split("\n").map((l) => l.replace(/^(이전 세션: ).*/, "$1")).join("\n");
  const texts: string[] = [];
  for (const [name, id] of Object.entries(ids)) {
    const r = await request(id, { provider: mock.MOCK_PROVIDER });
    eq(`${name}: 201`, r.status, 201);
    const text = sessionManager.handoffInfo(r.json.id!)?.incoming?.text ?? "";
    check(text.includes("- pkg/x.ts") && text.includes("1. 하라"), `${name}: 파일 경로와 사람 말이 들어간다`, text);
    texts.push(shape(text, id));
    sessionManager.delete(r.json.id!);
  }
  check(texts[0] === texts[1] && texts[1] === texts[2], "셋 모두 같은 구성의 글", texts);
}

server.close();
unregister();
console.log(`\n${fail === 0 ? "✅" : "❌"} review_request: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
