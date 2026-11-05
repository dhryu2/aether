/**
 * 작업 검토함 라우트 — 모델 호출 0. 임시 데이터 폴더와 임시 git 저장소만 쓴다.
 * 목록·상세(git 저장소 / 저장소 아님 / 사라진 폴더)·검토 완료·되돌리기·재시작 뒤 유지·5,000건 절단을 본다.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-review-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-review-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("review_route"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const express = (await import("express")).default;
const { reviewRouter } = await import("../routes/review");
const { clampString } = await import("../sessions/persistFilter");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    check(true, name);
  } catch {
    check(false, name, { actual, expected });
  }
}

const app = express();
app.use(express.json());
app.use("/api/review", reviewRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

function git(args: string[], cwd: string) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

// ── 임시 작업 폴더 ──
const repo = path.join(ROOT, "repo");
fs.mkdirSync(repo);
git(["init", "-q"], repo);
fs.writeFileSync(path.join(repo, "a.ts"), "1");
fs.writeFileSync(path.join(repo, "b.ts"), "1");
git(["add", "."], repo);
git(["commit", "-q", "-m", "init"], repo);
fs.writeFileSync(path.join(repo, "a.ts"), "2"); // 세션이 고친 파일(커밋 안 됨)
fs.writeFileSync(path.join(repo, "other.txt"), "x"); // 기록에 없는 변경
// 경로 모양 시험용 저장소: 한글·공백 경로, 삭제, 이름 바뀜, 무시된 파일.
const repo2 = path.join(ROOT, "repo2");
fs.mkdirSync(repo2);
git(["init", "-q"], repo2);
for (const f of ["keep.ts", "d.ts", "r1.ts"]) fs.writeFileSync(path.join(repo2, f), "1");
fs.writeFileSync(path.join(repo2, ".gitignore"), "ignored.log\n");
git(["add", "."], repo2);
git(["commit", "-q", "-m", "init"], repo2);
fs.rmSync(path.join(repo2, "d.ts"));
git(["mv", "r1.ts", "r2.ts"], repo2);
fs.writeFileSync(path.join(repo2, "한글 파일.ts"), "x");
fs.writeFileSync(path.join(repo2, "with space.ts"), "x");
fs.writeFileSync(path.join(repo2, "ignored.log"), "x");
const plain = path.join(ROOT, "plain");
fs.mkdirSync(plain);
const gone = path.join(ROOT, "gone");
fs.mkdirSync(gone);

const now = Date.now();
type Spec = { cwd: string; provider: string; name: string; events: object[]; at: number; archivedAt?: number };
function seed(spec: Spec): string {
  const id = randomUUID();
  fs.mkdirSync(path.join(DATA, id), { recursive: true });
  fs.writeFileSync(path.join(DATA, id, "meta.json"), JSON.stringify({ id, cwd: spec.cwd, provider: spec.provider, name: spec.name, createdAt: spec.at - 1000, ...(spec.archivedAt ? { archivedAt: spec.archivedAt } : {}) }));
  spec.events.forEach((e, i) => store.appendEvent(id, { seq: i + 1, ts: spec.at + i, ...e } as never));
  return id;
}
const done = { kind: "status", status: "completed" };
const claudeCall = (id: string, name: string, input: object) => ({ kind: "sdk", msg: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } } });
const claudeRes = (id: string, err = false) => ({ kind: "sdk", msg: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "o", ...(err ? { is_error: true } : {}) }] } } });
const codexItem = (method: string, item: object) => ({ kind: "codex", msg: { method, params: { item } } });
const grokUpd = (update: object) => ({ kind: "grok", msg: { method: "session/update", params: { update } } });

const sClaude = seed({ cwd: repo, provider: "claude", name: "클로드 작업", at: now - 5000, events: [
  claudeCall("c1", "Bash", { command: "npm test" }), claudeRes("c1", true),
  claudeCall("c2", "Edit", { file_path: path.join(repo, "a.ts") }), claudeRes("c2"),
  claudeCall("c3", "Edit", { file_path: path.join(repo, "b.ts") }), claudeRes("c3"),
  done,
] });
const editOk = (id: string, p: string) => [claudeCall(id, "Edit", { file_path: p }), claudeRes(id)];
const sPaths = seed({ cwd: repo2, provider: "claude", name: "경로 모양", at: now - 1500, events: [
  ...editOk("p1", path.join(repo2, "한글 파일.ts")), ...editOk("p2", path.join(repo2, "with space.ts")), ...editOk("p3", path.join(repo2, "d.ts")),
  ...editOk("p4", path.join(repo2, "ignored.log")), ...editOk("p5", path.join(repo2, "keep.ts")), ...editOk("p6", path.join(plain, "o.txt")),
  done,
] });
// 도중에 실패했지만 뒤에 다른 명령이 성공: 목록에는 변경 때문에 오르고 먼저 볼 것은 아니다.
const sOther = seed({ cwd: plain, provider: "claude", name: "도중 실패", at: now - 2500, events: [
  claudeCall("o1", "Bash", { command: "grep nope" }), claudeRes("o1", true), claudeCall("o2", "Bash", { command: "ls" }), claudeRes("o2"),
  ...editOk("o3", path.join(plain, "x.ts")), done,
] });
// 마지막 턴이 실패로 끝남: 실패 명령이 없어도 먼저 볼 것이다.
const sTurn = seed({ cwd: plain, provider: "claude", name: "턴 실패", at: now - 3500, events: [
  ...editOk("t1", path.join(plain, "y.ts")),
  { kind: "sdk", msg: { type: "result", subtype: "error_during_execution", is_error: true, result: "boom" } },
] });
// 변경도 실패도 없고 도중 실패만 있는 세션은 목록에 오르지 않는다.
const sOnlyOther = seed({ cwd: plain, provider: "claude", name: "도중 실패만", at: now - 1200, events: [
  claudeCall("q1", "Bash", { command: "grep nope" }), claudeRes("q1", true), claudeCall("q2", "Bash", { command: "ls" }), claudeRes("q2"), done,
] });
const sCodex = seed({ cwd: plain, provider: "codex", name: "코덱스 작업", at: now - 4000, events: [
  codexItem("item/started", { type: "fileChange", id: "i1", status: "inProgress", changes: [{ path: path.join(plain, "x, y.ts"), kind: { type: "add" }, diff: "d" }] }),
  codexItem("item/completed", { type: "fileChange", id: "i1", status: "completed", changes: [{ path: path.join(plain, "x, y.ts"), kind: { type: "add" }, diff: "d" }] }),
  done,
] });
const sGrok = seed({ cwd: gone, provider: "grok", name: "그록 작업", at: now - 3000, events: [
  grokUpd({ sessionUpdate: "tool_call", toolCallId: "g1", title: "run_terminal_command", rawInput: { command: "make" } }),
  grokUpd({ sessionUpdate: "tool_call_update", toolCallId: "g1", status: "failed", content: { type: "text", text: "e" } }),
  grokUpd({ sessionUpdate: "tool_call", toolCallId: "g2", title: "search_replace", kind: "edit", rawInput: { file_path: path.join(gone, "m.ts") } }),
  grokUpd({ sessionUpdate: "tool_call_update", toolCallId: "g2", status: "completed", content: { type: "text", text: "o" } }),
  done,
] });
const sEmpty = seed({ cwd: plain, provider: "claude", name: "대화만", at: now - 2000, events: [{ kind: "user_msg", text: "안녕" }, done] });
const sArchived = seed({ cwd: repo, provider: "claude", name: "보관됨", at: now - 1000, archivedAt: now, events: [claudeCall("c1", "Edit", { file_path: path.join(repo, "a.ts") }), claudeRes("c1"), done] });
const sOld = seed({ cwd: plain, provider: "claude", name: "오래됨", at: now - 20 * 24 * 3600 * 1000, events: [claudeCall("c1", "Edit", { file_path: path.join(plain, "o.ts") }), claudeRes("c1"), done] });
// 5,000건 넘는 기록(마지막 활동이 가장 늦다): 앞쪽 수정은 읽기 범위 밖이고 뒤쪽 수정만 보인다.
const filler = Array.from({ length: 5100 }, () => ({ kind: "user_msg", text: "." }));
const sBig = seed({ cwd: plain, provider: "claude", name: "긴 기록", at: now - 6000, events: [
  claudeCall("e1", "Edit", { file_path: path.join(plain, "early.ts") }), claudeRes("e1"), ...filler,
  claudeCall("e2", "Edit", { file_path: path.join(plain, "late.ts") }), claudeRes("e2"), done,
] });

sessionManager.restoreFromDisk();
fs.rmSync(gone, { recursive: true, force: true }); // 복원 뒤 폴더가 사라진 경우

console.log("\n=== 목록 ===");
const list = await call("GET", "/api/review");
const rows = list.json.rows as any[];
eq("검토할 것이 있는 세션만, 최신순", rows.map((r) => r.id), [sBig, sPaths, sOther, sGrok, sTurn, sCodex, sClaude]);
check(!rows.some((r) => r.id === sOnlyOther), "도중 실패만 있는 세션은 목록에 오르지 않는다");
const rOther = rows.find((r) => r.id === sOther);
eq("도중 실패는 먼저 볼 것도 실패 개수도 아니다", [rOther.needsAttention, rOther.failureCount, rOther.fileCount], [false, 0, 1]);
const rTurn = rows.find((r) => r.id === sTurn);
eq("실패로 끝난 턴은 먼저 볼 것", [rTurn.needsAttention, rTurn.turnFailed, rTurn.failureCount], [true, "failed", 0]);
check(!rows.some((r) => [sEmpty, sArchived, sOld].includes(r.id)), "빈 세션·보관·14일 지난 세션은 빠진다");
const rClaude = rows.find((r) => r.id === sClaude);
eq("Claude 행 개수", [rClaude.fileCount, rClaude.failureCount, rClaude.todoCount, rClaude.needsAttention, rClaude.title], [2, 1, 0, true, "클로드 작업"]);
eq("프로젝트 이름", rClaude.projectName, "repo");
eq("Codex 행(변경만)", (({ fileCount, failureCount, needsAttention }) => [fileCount, failureCount, needsAttention])(rows.find((r) => r.id === sCodex)), [1, 0, false]);
eq("Grok 행", (({ fileCount, failureCount }) => [fileCount, failureCount])(rows.find((r) => r.id === sGrok)), [1, 1]);
const rBig = rows.find((r) => r.id === sBig);
eq("5,000건 넘는 기록은 partial이고 최근 쪽만 읽는다", [rBig.partial, rBig.fileCount], [true, 1]);
check(rClaude.partial === false, "짧은 기록은 partial이 아니다");

console.log("\n=== 상세: git 저장소 ===");
const d = await call("GET", `/api/review/${sClaude}`);
eq("git ok", d.json.git, "ok");
eq("파일별 상태(커밋 안 됨 / 변경 없음)", d.json.fileStates, ["uncommitted", "clean"]);
eq("기록에 없는 변경", d.json.unrecorded, ["other.txt"]);
eq("실패한 명령", d.json.failedCommands.map((c: any) => c.text), ["npm test"]);
const skip = await call("GET", `/api/review/${sClaude}?git=0`);
eq("?git=0은 git을 건너뛴다", [skip.json.git, skip.json.fileStates, skip.json.changedFiles.length], ["skipped", [], 2]);

console.log("\n=== 상세: 경로 모양 ===");
const dp2 = await call("GET", `/api/review/${sPaths}`);
eq("한글·공백·삭제·무시·저장소 밖·변경 없음", dp2.json.fileStates, ["uncommitted", "uncommitted", "uncommitted", "unknown", "clean", "unknown"]);
eq("이름 바뀜은 옛 경로와 새 경로가 모두 기록에 없는 변경", [...dp2.json.unrecorded].sort(), ["r1.ts", "r2.ts"]);
eq("응답 머리에 cwd", dp2.json.cwd, repo2);
const dOther = await call("GET", `/api/review/${sOther}`);
eq("도중 실패는 상세의 otherFailures에 있다", [dOther.json.otherFailures.map((c: any) => c.text), dOther.json.failedCommands.length], [["grep nope"], 0]);

console.log("\n=== 상세: 저장소 아님·폴더 없음·없는 세션 ===");
const dp = await call("GET", `/api/review/${sCodex}`);
eq("저장소가 아니면 unavailable이고 기록은 그대로", [dp.json.git, dp.json.changedFiles.map((f: any) => f.path)], ["unavailable", [path.join(plain, "x, y.ts")]]);
const dg = await call("GET", `/api/review/${sGrok}`);
eq("폴더가 사라져도 unavailable + 기록 그대로", [dg.status, dg.json.git, dg.json.failedCommands.length], [200, "unavailable", 1]);
eq("없는 세션은 404", (await call("GET", `/api/review/${randomUUID()}`)).status, 404);
eq("id 모양이 틀려도 404(경로를 받지 않는다)", (await call("GET", "/api/review/..%2F..%2Fetc")).status, 404);

console.log("\n=== 파일 변경 내용(diff) ===");
const repo3 = path.join(ROOT, "repo3");
fs.mkdirSync(repo3);
git(["init", "-q"], repo3);
fs.writeFileSync(path.join(repo3, "base.txt"), "1\n");
fs.writeFileSync(path.join(repo3, "big.ts"), "old\n");
git(["add", "."], repo3);
git(["commit", "-q", "-m", "init"], repo3);
const f = (n: string) => path.join(repo3, n);
const edit = (id: string, file: string, o: string, n: string, extra: object = {}) => claudeCall(id, "Edit", { file_path: file, old_string: o, new_string: n, ...extra });
const cut = clampString("z".repeat(3000), 100); // 저장 때 잘린 내용(표식이 붙는다)
const sDiff = seed({ cwd: repo3, provider: "claude", name: "diff 시험", at: now - 800, events: [
  edit("d1", f("f.ts"), "aaa", "bbb"), claudeRes("d1"),
  edit("d2", f("f.ts"), "x", "y"), claudeRes("d2", true), // 실패한 수정은 뺀다
  edit("d3", f("f.ts"), "ccc", "ddd", { replace_all: true }), claudeRes("d3"),
  claudeCall("d4", "Write", { file_path: f("w.ts"), content: "hello\nworld\n" }), claudeRes("d4"),
  claudeCall("d5", "Write", { file_path: f(".env"), content: "TOP_SECRET_VALUE=1" }), claudeRes("d5"),
  claudeCall("d6", "Write", { file_path: f("big.ts"), content: cut }), claudeRes("d6"),
  claudeCall("d7", "Write", { file_path: f("fresh.ts"), content: cut }), claudeRes("d7"),
  edit("d8", f("noop.ts"), "same", "same"), claudeRes("d8"),
  done,
] });
fs.writeFileSync(f("big.ts"), "new\nlines\n"); // 커밋 전 변경(추적 중)
fs.writeFileSync(f("fresh.ts"), "brand\nnew\n"); // 추적하지 않는 새 파일
sessionManager.restoreFromDisk();
const dq = (id: string, p: unknown) => call("GET", `/api/review/${id}/diff?path=${encodeURIComponent(String(p))}`);
const r1 = await dq(sDiff, f("f.ts"));
eq("여러 조각은 시간순, 실패한 수정 제외", [r1.status, r1.json.source, r1.json.edits.length, r1.json.edits.map((e: any) => [e.kind, e.fragment, e.replaceAll ?? false])], [200, "record", 2, [["edit", true, false], ["edit", true, true]]]);
check(r1.json.edits[0].hunks[0].lines.some((l: string) => l === "-aaa") && r1.json.edits[0].hunks[0].lines.some((l: string) => l === "+bbb"), "조각에 지운 줄과 더한 줄이 있다");
const r2 = await dq(sDiff, f("w.ts"));
eq("전체 쓰기는 수정 전 내용을 모른다고 표시", [r2.json.source, r2.json.edits.length, r2.json.edits[0].kind, r2.json.edits[0].beforeUnknown, r2.json.edits[0].additions], ["record", 1, "write", true, 2]);
const r3 = await dq(sDiff, f(".env"));
eq("비밀 파일은 가려지고 본문이 없다", [r3.json.edits, JSON.stringify(r3.json).includes("TOP_SECRET")], [[{ kind: "edit", path: f(".env"), redacted: true }], false]);
const r4 = await dq(sDiff, f("big.ts"));
eq("잘린 쓰기는 기록 대신 커밋 안 된 변경(git)을 보여 준다", [r4.json.source, r4.json.edits.length, r4.json.edits[0].hunks?.length > 0, r4.json.edits[0].truncated], ["git", 1, true, undefined]);
const r5 = await dq(sDiff, f("fresh.ts"));
eq("추적하지 않는 새 파일은 새 파일로 보여 준다", [r5.json.source, r5.json.edits[0].isCreate, r5.json.edits[0].additions], ["git", true, 2]);
git(["add", "."], repo3);
git(["commit", "-q", "-m", "later"], repo3);
const r6 = await dq(sDiff, f("big.ts"));
eq("커밋한 뒤에는 none이고 잘림 표시만 남는다", [r6.json.source, r6.json.edits.map((e: any) => e.truncated), r6.json.edits[0].hunks], ["none", [true], undefined]);
const r7 = await dq(sDiff, f("noop.ts"));
eq("내용이 없으면 none과 빈 목록", [r7.json.source, r7.json.edits], ["none", []]);
for (const [name, p] of [["바뀐 파일 목록 밖", f("base.txt")], ["상위 경로", path.join(repo3, "..", "repo", "a.ts")], ["상대 경로", "f.ts"], ["빈 값", ""]] as const) {
  eq(`${name}는 400`, (await dq(sDiff, p)).status, 400);
}
eq("path가 없으면 400", (await call("GET", `/api/review/${sDiff}/diff`)).status, 400);
eq("path가 여러 개여도 400", (await call("GET", `/api/review/${sDiff}/diff?path=a&path=b`)).status, 400);
eq("없는 세션은 404", (await dq(randomUUID(), f("f.ts"))).status, 404);

const sSeq = seed({ cwd: repo3, provider: "claude", name: "검토 위치", at: now - 700, events: [
  edit("s1", f("one.ts"), "a", "b"), claudeRes("s1"), edit("s2", f("two.ts"), "a", "b"), claudeRes("s2"), done,
] });
sessionManager.restoreFromDisk();
await call("POST", `/api/review/${sSeq}/done`, { seq: 2 });
eq("검토 위치 이전의 수정은 제외", [(await dq(sSeq, f("one.ts"))).status, (await dq(sSeq, f("two.ts"))).json.edits.length], [400, 1]);

const sHide = seed({ cwd: repo3, provider: "claude", name: "숨긴 구간", at: now - 600, events: [
  edit("h1", f("hid.ts"), "a", "b"), claudeRes("h1"), edit("h2", f("vis.ts"), "a", "b"), claudeRes("h2"), done,
] });
const hm = path.join(DATA, sHide, "meta.json");
fs.writeFileSync(hm, JSON.stringify({ ...JSON.parse(fs.readFileSync(hm, "utf8")), hiddenRanges: [{ after: 0, until: 2 }] }));
sessionManager.restoreFromDisk();
eq("숨긴 구간의 수정은 제외", [(await dq(sHide, f("hid.ts"))).status, (await dq(sHide, f("vis.ts"))).json.edits.length], [400, 1]);

const sCodexDiff = seed({ cwd: plain, provider: "codex", name: "코덱스 diff", at: now - 500, events: [
  codexItem("item/started", { type: "fileChange", id: "k1", status: "inProgress", changes: [{ path: path.join(plain, "c.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }] }),
  codexItem("item/completed", { type: "fileChange", id: "k1", status: "completed", changes: [{ path: path.join(plain, "c.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }] }),
  done,
] });
sessionManager.restoreFromDisk();
const rc = await dq(sCodexDiff, path.join(plain, "c.ts"));
eq("Codex 시작·완료가 같은 내용을 실어도 한 번만 보인다", [rc.json.source, rc.json.edits.length, rc.json.edits[0].additions], ["record", 1, 1]);

console.log("\n=== diff: 비밀·링크·이름 바꿈·하위 폴더·대소문자 ===");
fs.writeFileSync(f(".env"), "LINK_SECRET_VALUE=1\n");
fs.symlinkSync(f(".env"), f("settings.txt"));
fs.symlinkSync(path.join(repo3, ".git", "config"), f("gitcfg.txt"));
fs.mkdirSync(f("subd"));
for (const n of ["x.ts", "y.ts", "ci.ts"]) fs.writeFileSync(path.join(repo3, n === "ci.ts" ? "" : "subd", n), "1\n");
git(["add", "-f", "."], repo3);
git(["commit", "-q", "-m", "more"], repo3);
fs.writeFileSync(f("subd/x.ts"), "2\n");
fs.writeFileSync(f("ci.ts"), "2\n");
const mvEv = (id: string, from: string, to: string, m = "item/started") => codexItem(m, { type: "fileChange", id, status: "completed", changes: [{ path: f(from), kind: { type: "update", move_path: f(to) }, diff: "@@ -1 +1 @@\n-LEAK_OLD\n+LEAK_NEW\n" }] });
const sSecret = seed({ cwd: repo3, provider: "claude", name: "비밀 링크", at: now - 400, events: [
  edit("l1", f("settings.txt"), "LEAK_A", "LEAK_B"), claudeRes("l1"),
  claudeCall("l2", "Write", { file_path: f("gitcfg.txt"), content: cut }), claudeRes("l2"),
  done,
] });
const sMove = seed({ cwd: repo3, provider: "codex", name: "이름 바꿈", at: now - 300, events: [mvEv("m1", "old.txt", ".env.prod"), mvEv("m1", "old.txt", ".env.prod", "item/completed"), mvEv("m2", ".env", "config.txt"), mvEv("m2", ".env", "config.txt", "item/completed"), done] });
const sSub = seed({ cwd: path.join(repo3, "subd"), provider: "claude", name: "하위 폴더", at: now - 200, events: [
  claudeCall("u1", "Write", { file_path: f("subd/x.ts"), content: cut }), claudeRes("u1"),
  claudeCall("u2", "Write", { file_path: f("subd/y.ts"), content: cut }), claudeRes("u2"), done,
] });
const ciDir = path.join(ROOT, "REPO3");
const ci = fs.existsSync(ciDir); // 대소문자를 구분하지 않는 파일시스템일 때만
const sCase = ci ? seed({ cwd: ciDir, provider: "claude", name: "대소문자", at: now - 100, events: [claudeCall("w1", "Write", { file_path: path.join(ciDir, "ci.ts"), content: cut }), claudeRes("w1"), done] }) : "";
sessionManager.restoreFromDisk();
for (const [label, id, p] of [["링크가 가리키는 .env", sSecret, f("settings.txt")], ["링크가 가리키는 .git/config", sSecret, f("gitcfg.txt")]] as const) {
  const r = await dq(id, p);
  eq(`${label}: 기록·git 어느 쪽도 읽지 않고 redacted`, [r.status, r.json.edits, JSON.stringify(r.json).includes("LEAK_") || JSON.stringify(r.json).includes("[core]")], [200, [{ kind: "edit", path: p, redacted: true }], false]);
}
for (const n of ["old.txt", ".env.prod", "config.txt", ".env"]) {
  const r = await dq(sMove, f(n));
  eq(`이름 바꿈(${n}): 어느 이름으로 물어도 redacted`, [r.json.edits.map((e: any) => e.redacted), JSON.stringify(r.json).includes("LEAK_")], [[true], false]);
}
const rs1 = await dq(sSub, f("subd/x.ts"));
eq("하위 폴더 세션: 수정된 추적 파일은 git 수정으로", [rs1.json.source, rs1.json.edits[0]?.isCreate, rs1.json.edits[0]?.hunks?.length > 0], ["git", undefined, true]);
const rs2 = await dq(sSub, f("subd/y.ts"));
eq("하위 폴더 세션: 커밋된 파일은 none", rs2.json.source, "none");
if (ci) {
  const rc2 = await dq(sCase, path.join(ciDir, "ci.ts"));
  eq("대소문자가 다른 작업 폴더 경로도 git 대체가 된다", [rc2.json.source, rc2.json.edits[0]?.hunks?.length > 0], ["git", true]);
} else console.log("  (대소문자를 구분하는 파일시스템 — 대소문자 시험 생략)");

console.log("\n=== 검토 완료와 되돌리기 ===");
const last = d.json.lastSeq as number;
eq("마지막 순번", last, 7);
eq("숫자가 아니면 400", (await call("POST", `/api/review/${sClaude}/done`, { seq: "7" })).status, 400);
eq("음수는 400", (await call("POST", `/api/review/${sClaude}/done`, { seq: -1 })).status, 400);
eq("마지막 순번을 넘으면 400", (await call("POST", `/api/review/${sClaude}/done`, { seq: last + 1 })).status, 400);
eq("없는 세션은 404", (await call("POST", `/api/review/${randomUUID()}/done`, { seq: 1 })).status, 404);
const ok = await call("POST", `/api/review/${sClaude}/done`, { seq: last });
eq("완료 응답은 이전 값을 돌려준다", [ok.status, ok.json], [200, { reviewedSeq: last, previous: null }]);
const lower = await call("POST", `/api/review/${sClaude}/done`, { seq: 2 });
eq("완료는 위치를 낮추지 않는다(max)", [lower.json.reviewedSeq, sessionManager.reviewedSeqOf(sClaude)], [last, last]);
check(!((await call("GET", "/api/review")).json.rows as any[]).some((r) => r.id === sClaude), "완료한 세션은 목록에서 빠진다");
eq("메타 파일에 저장된다", JSON.parse(fs.readFileSync(path.join(DATA, sClaude, "meta.json"), "utf8")).reviewedSeq, last);

console.log("\n=== 재시작 뒤 유지 ===");
sessionManager.restoreFromDisk();
eq("재시작 복원 뒤에도 같은 위치", sessionManager.reviewedSeqOf(sClaude), last);
check(!((await call("GET", "/api/review")).json.rows as any[]).some((r) => r.id === sClaude), "재시작 뒤에도 목록에서 빠져 있다");

console.log("\n=== 새 활동은 완료 뒤 사건만 ===");
store.appendEvent(sClaude, { seq: last + 1, ts: now, ...claudeCall("c9", "Edit", { file_path: path.join(repo, "b.ts") }) } as never);
store.appendEvent(sClaude, { seq: last + 2, ts: now + 1, ...claudeRes("c9") } as never);
store.appendEvent(sClaude, { seq: last + 3, ts: now + 2, ...done } as never);
const again = ((await call("GET", "/api/review")).json.rows as any[]).find((r) => r.id === sClaude);
eq("완료 위치 뒤의 변경만 센다", [again?.fileCount, again?.failureCount], [1, 0]);

console.log("\n=== 되돌리기 ===");
eq("expected가 현재 값과 다르면 되돌리기는 409", (await call("POST", `/api/review/${sClaude}/undo`, { seq: 0, expected: 1 })).status, 409);
eq("거절되면 위치는 그대로", sessionManager.reviewedSeqOf(sClaude), last);
const undo = await call("POST", `/api/review/${sClaude}/undo`, { seq: 0, expected: last });
eq("되돌리기 응답", [undo.status, undo.json.reviewedSeq, undo.json.previous], [200, 0, last]);
const undo2 = await call("POST", `/api/review/${sClaude}/undo`, { expected: 0 });
eq("seq가 없으면 위치를 지운다", [undo2.json.reviewedSeq], [null]);
check(((await call("GET", "/api/review")).json.rows as any[]).some((r) => r.id === sClaude), "되돌리면 다시 목록에 나온다");
eq("메타에서 지워진다", JSON.parse(fs.readFileSync(path.join(DATA, sClaude, "meta.json"), "utf8")).reviewedSeq, undefined);

console.log(`\n${fail === 0 ? "✅" : "❌"} review_route: ${pass} pass / ${fail} fail`);
server.close();
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
