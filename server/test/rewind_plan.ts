/**
 * 대화 되돌리기 계획 — 모델 호출 0.
 * 숨김 범위, 경로마다 가장 이른 파일 기록, 작업 폴더 안에서만 복원.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { isControlEvent } from "../types";
import { previewFromUnifiedDiff } from "../sessions/mutationPreview";
import { buildMutationPreview } from "../providers/claude/mutationPreview";
import * as store from "../sessions/persistence";
import {
  appendCheckpoint,
  applyRestore,
  buildReseed,
  checkpointFromMutation,
  checkpointsForApproval,
  isHiddenSeq,
  planRewind,
  rewindDisk,
  rewindTarget,
  RewindError,
  sessionWasRewound,
  type CheckpointNote,
} from "../sessions/rewind";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const ranges = [{ after: 2, until: 5 }];
check(isHiddenSeq(2, ranges) === false, "되돌린 자리의 사용자 말은 남는다");
check(isHiddenSeq(3, ranges) && isHiddenSeq(5, ranges), "그 뒤부터 마지막 숨김 순번까지 가린다");
check(isHiddenSeq(6, ranges) === false, "숨김 끝 다음 말은 보인다");
check(isHiddenSeq(-3, ranges) === false, "화면이 임시로 붙인 음수 순번은 가리지 않는다");

const events = [
  { seq: 1, kind: "user_msg" },
  { seq: 2, kind: "agent" },
  { seq: 3, kind: "user_msg" },
];
check(rewindTarget(events, 1, []).until === 3, "첫 말 뒤의 마지막 보이는 순번까지 숨긴다");
let tail = false;
try {
  rewindTarget(events, 3, []);
} catch (error) {
  tail = error instanceof RewindError && error.code === "tail";
}
check(tail, "뒤에 아무것도 없으면 되돌리지 않는다");
let missing = false;
try {
  rewindTarget(events, 2, []);
} catch (error) {
  missing = error instanceof RewindError && error.code === "notfound";
}
check(missing, "사용자 말이 아닌 순번은 거부한다");
let hidden = false;
try {
  rewindTarget([{ seq: 4, kind: "user_msg" }], 4, [{ after: 1, until: 9 }]);
} catch (error) {
  hidden = error instanceof RewindError && error.code === "notfound";
}
check(hidden, "이미 숨긴 말은 다시 고르지 않는다");

const secret = checkpointFromMutation(4, { kind: "edit", path: "a.ts", before: "secret", redacted: true });
const later = checkpointFromMutation(6, { kind: "edit", path: "a.ts", before: "ok", isCreate: false });
const created = checkpointFromMutation(5, { kind: "write", path: "new.ts", isCreate: true });
const truncated = checkpointFromMutation(5, { kind: "edit", path: "big.ts", before: "x", truncated: true });
assert.ok(secret && later && created && truncated);
const plan = planRewind([later!, secret!, created!, truncated!], 2, 8);
check(plan.restore.length === 1 && plan.restore[0].path === "new.ts", "온전한 새 파일 기록만 되돌린다", plan);
check(
  plan.skipped.map((item) => item.path).join(",") === "a.ts,big.ts",
  "같은 파일의 첫 기록이 비밀이면 나중 기록이 좋아도 건너뛴다",
  plan.skipped,
);

const text = buildReseed(
  [
    { role: "user", text: "안녕" },
    { role: "assistant", text: "응" },
  ],
  40,
);
check(text.includes("되돌려") && text.includes("잘랐다"), "긴 대화는 앞을 자르고 안내 문장은 남긴다");
check(!text.includes("도구"), "재전달 글에는 도구 결과를 넣지 않는다");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-"));
fs.writeFileSync(path.join(cwd, "keep.ts"), "now");
fs.writeFileSync(path.join(cwd, "made.ts"), "created");
const notes: CheckpointNote[] = [
  { seq: 4, path: "keep.ts", before: "then\n", isCreate: false, ok: true },
  { seq: 5, path: "made.ts", before: null, isCreate: true, ok: true },
  { seq: 6, path: "../escape.ts", before: "no", isCreate: false, ok: true },
];
const applied = applyRestore(cwd, notes);
check(fs.readFileSync(path.join(cwd, "keep.ts"), "utf8") === "then\n", "이전 내용으로 덮어쓴다");
check(!fs.existsSync(path.join(cwd, "made.ts")), "새로 만든 파일은 지운다");
check(applied.failed.some((item) => item.path === "../escape.ts" && item.reason === "outside"), "작업 폴더 밖은 쓰지 않는다");
check(applied.restored.includes("keep.ts") && applied.restored.includes("made.ts"), "성공한 경로를 알린다");
fs.rmSync(cwd, { recursive: true, force: true });

const diffWork = fs.mkdtempSync(path.join(os.tmpdir(), "aether-diff-"));
fs.writeFileSync(path.join(diffWork, "a.ts"), "alpha\n");
fs.writeFileSync(path.join(diffWork, "b.ts"), "beta\n");
const preview = previewFromUnifiedDiff(
  [
    { path: "a.ts", diff: "@@ -1 +1 @@\n-alpha\n+next\n" },
    { path: "b.ts", diff: "@@ -1 +1 @@\n-beta\n+next\n" },
    { path: "new.ts", diff: "@@ -0,0 +1 @@\n+made\n", isCreate: true },
  ],
  diffWork,
);
assert.ok(preview);
check(preview.before === undefined && !preview.files?.some((file) => "before" in file), "차이만 있는 미리보기에는 이전 본문이 없다");
const diffNotes = checkpointsForApproval(8, preview, diffWork);
check(diffNotes.map((note) => note.path).join("|") === "a.ts|b.ts|new.ts", "파일마다 복원 경로를 남긴다", diffNotes.map((note) => note.path));
check(!diffNotes.some((note) => note.path.includes(",")), "여러 파일을 쉼표로 이은 한 경로로 저장하지 않는다");
const outsidePreview = previewFromUnifiedDiff([{ path: "/tmp/example-outside/x.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }], diffWork);
check(outsidePreview?.path === "/tmp/example-outside/x.ts" && outsidePreview.files?.[0].path.startsWith("..") === true, "폴더 밖 변경은 화면 경로는 전체이고 복원 기록 경로는 폴더 밖(..)을 가리킨다", outsidePreview);
check(diffNotes.find((note) => note.path === "a.ts")?.before === "alpha\n" && diffNotes.find((note) => note.path === "a.ts")?.ok === true, "첫 파일의 이전 내용을 읽는다");
check(diffNotes.find((note) => note.path === "b.ts")?.before === "beta\n", "둘째 파일의 이전 내용도 따로 읽는다");
check(diffNotes.find((note) => note.path === "new.ts")?.isCreate === true && diffNotes.find((note) => note.path === "new.ts")?.ok === true, "없던 파일은 되돌릴 때 지울 기록이다");
fs.writeFileSync(path.join(diffWork, "a.ts"), "changed");
fs.writeFileSync(path.join(diffWork, "b.ts"), "changed");
fs.writeFileSync(path.join(diffWork, "new.ts"), "made");
applyRestore(diffWork, diffNotes);
check(fs.readFileSync(path.join(diffWork, "a.ts"), "utf8") === "alpha\n", "첫 파일을 이전 내용으로 되돌린다");
check(fs.readFileSync(path.join(diffWork, "b.ts"), "utf8") === "beta\n", "둘째 파일도 따로 되돌린다");
check(!fs.existsSync(path.join(diffWork, "new.ts")), "새로 만든 파일은 지운다");
const legacy = checkpointsForApproval(3, { kind: "edit", path: "a.ts", before: "카드에 있던 내용" }, diffWork);
check(legacy.length === 1 && legacy[0]?.before === "카드에 있던 내용" && legacy[0]?.path === "a.ts", "이전 내용이 이미 있으면 그 한 파일을 그대로 쓴다");
fs.rmSync(diffWork, { recursive: true, force: true });

// 폴더 밖 파일이 같은 이름의 폴더 안 파일로 착각되던 문제의 회귀 시험
{
  const inside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-same-in-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-same-out-")));
  fs.writeFileSync(path.join(inside, "a.ts"), "inside");
  fs.writeFileSync(path.join(outside, "a.ts"), "outside");
  for (const isCreate of [false, true]) {
    const pv = previewFromUnifiedDiff([{ path: path.join(outside, "a.ts"), diff: "@@ -1 +1 @@\n-a\n+b\n", isCreate }], inside);
    const notes = checkpointsForApproval(4, pv, inside);
    check(notes[0]?.ok === false && notes[0].skip === "outside" && notes[0].path.startsWith(".."), `폴더 밖 파일 기록은 outside로 건너뛴다(isCreate=${isCreate})`, notes);
    const applied = applyRestore(inside, [{ seq: 4, path: pv!.files![0].path, before: "x", isCreate, ok: true }]);
    check(fs.readFileSync(path.join(inside, "a.ts"), "utf8") === "inside" && applied.restored.length === 0, `같은 이름의 폴더 안 파일을 건드리지 않는다(isCreate=${isCreate})`, applied);
  }
  fs.rmSync(inside, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

// auth.json 승인 기록은 비밀로 건너뛴다
{
  const authDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-auth-")));
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}");
  const pv = buildMutationPreview("Write", { file_path: "auth.json", content: "x" }, authDir);
  const notes = checkpointsForApproval(4, pv, authDir);
  check(notes.length === 1 && notes[0].skip === "secret" && notes[0].ok === false, "auth.json 승인 기록은 secret으로 건너뛴다", notes);
  fs.rmSync(authDir, { recursive: true, force: true });
}

// 끊긴 링크와 링크 아래 없는 경로를 따라 폴더 밖에 쓰던 문제의 회귀 시험
{
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-link-in-")));
  const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-link-out-")));
  fs.symlinkSync(path.join(away, "target.txt"), path.join(work, "dangling.txt"));
  fs.symlinkSync(away, path.join(work, "dirlink"));
  for (const rel of ["dangling.txt", "dirlink/sub/file.txt"]) {
    const notes = checkpointsForApproval(4, { kind: "write", path: rel, files: [{ path: rel }] }, work);
    check(notes[0]?.skip === "outside", `승인 기록도 outside로 남긴다: ${rel}`, notes);
    const applied = applyRestore(work, [{ seq: 4, path: rel, before: "x", isCreate: false, ok: true, wholeFile: true }]);
    check(applied.failed.some((f) => f.path === rel && f.reason === "outside") && applied.restored.length === 0, `링크를 따라 밖으로 나가는 복원은 outside다: ${rel}`, applied);
  }
  check(fs.readdirSync(away).length === 0, "바깥 폴더에는 파일도 폴더도 생기지 않는다", fs.readdirSync(away));
  fs.mkdirSync(path.join(work, "real"));
  fs.symlinkSync(path.join(work, "real"), path.join(work, "inlink"));
  const okApplied = applyRestore(work, [
    { seq: 4, path: "new.txt", before: "n", isCreate: false, ok: true, wholeFile: true },
    { seq: 4, path: "a/b/new.txt", before: "n", isCreate: false, ok: true, wholeFile: true },
    { seq: 4, path: "inlink/new.txt", before: "n", isCreate: false, ok: true, wholeFile: true },
  ]);
  check(okApplied.restored.length === 3 && okApplied.failed.length === 0, "새 파일, 없는 하위 폴더, 폴더 안 링크 경로는 통과한다", okApplied);
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(away, { recursive: true, force: true });
}

// 조각(Edit old_string, 노트북 셀)이 파일 전체로 기록되어 파일을 덮던 문제의 회귀 시험
{
  const frag = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-frag-")));
  const full = "line1\nTARGET\nline3\n";
  fs.writeFileSync(path.join(frag, "e.ts"), full);
  const p1 = buildMutationPreview("Edit", { file_path: "e.ts", old_string: "TARGET", new_string: "CHANGED" }, frag);
  const n1 = checkpointsForApproval(4, p1, frag);
  fs.writeFileSync(path.join(frag, "e.ts"), "line1\nCHANGED\nline3\n");
  const p2 = buildMutationPreview("Edit", { file_path: "e.ts", old_string: "CHANGED", new_string: "THIRD" }, frag);
  const n2 = checkpointsForApproval(6, p2, frag);
  fs.writeFileSync(path.join(frag, "e.ts"), "line1\nTHIRD\nline3\n");
  applyRestore(frag, planRewind([...n1, ...n2], 5, 9).restore);
  check(fs.readFileSync(path.join(frag, "e.ts"), "utf8") === "line1\nCHANGED\nline3\n", "두 번째 승인 이후만 되돌리면 파일 전체가 그 시점 내용이 된다");
  applyRestore(frag, planRewind([...n1, ...n2], 3, 9).restore);
  check(fs.readFileSync(path.join(frag, "e.ts"), "utf8") === full, "Edit 승인 앞으로 되돌리면 파일 전체가 원본이다(조각으로 덮지 않는다)");

  const nb = JSON.stringify({ cells: [{ id: "c1", cell_type: "code", source: ["a = 1"] }], nbformat: 4 });
  for (const mode of ["replace", "delete", "insert"] as const) {
    fs.writeFileSync(path.join(frag, "n.ipynb"), nb);
    const pv = buildMutationPreview("NotebookEdit", { notebook_path: "n.ipynb", cell_id: "c1", edit_mode: mode, new_source: "b = 2" }, frag);
    const notes = checkpointsForApproval(4, pv, frag);
    fs.writeFileSync(path.join(frag, "n.ipynb"), "{}");
    applyRestore(frag, planRewind(notes, 3, 9).restore);
    check(fs.readFileSync(path.join(frag, "n.ipynb"), "utf8") === nb, `노트북 ${mode}를 되돌리면 .ipynb 전체가 복원된다`);
  }

  const bigBody = "x".repeat(config.diffMaxBytes + 10);
  fs.writeFileSync(path.join(frag, "big.ts"), bigBody);
  const bigNotes = checkpointsForApproval(4, buildMutationPreview("Edit", { file_path: "big.ts", old_string: "x", new_string: "y" }, frag), frag);
  const bigPlan = planRewind(bigNotes, 3, 9);
  fs.writeFileSync(path.join(frag, "big.ts"), "after");
  applyRestore(frag, bigPlan.restore);
  check(bigPlan.skipped.some((s) => s.path === "big.ts" && s.reason === "truncated") && fs.readFileSync(path.join(frag, "big.ts"), "utf8") === "after", "큰 파일의 Edit은 건너뛰고 파일을 그대로 둔다");
  // UTF-8이 아닌 파일은 깨진 글자로 저장되면 복원이 원본 바이트를 못 살리므로 binary로 건너뛴다
  const euc = Buffer.from([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9, 0x0a]);
  fs.writeFileSync(path.join(frag, "euc.txt"), euc);
  const eucPlan = planRewind(checkpointsForApproval(4, buildMutationPreview("Edit", { file_path: "euc.txt", old_string: "x", new_string: "y" }, frag), frag), 3, 9);
  applyRestore(frag, eucPlan.restore);
  check(eucPlan.restore.length === 0 && eucPlan.skipped.some((s) => s.reason === "binary") && fs.readFileSync(path.join(frag, "euc.txt")).equals(euc), "UTF-8이 아닌 파일은 binary로 건너뛰고 파일이 그대로다", eucPlan);
  fs.writeFileSync(path.join(frag, "ko.txt"), "가나다\n");
  const koPlan = planRewind(checkpointsForApproval(4, buildMutationPreview("Edit", { file_path: "ko.txt", old_string: "x", new_string: "y" }, frag), frag), 3, 9);
  check(koPlan.restore.length === 1 && koPlan.restore[0].before === "가나다\n", "정상 UTF-8 파일은 그대로 복원 대상이다", koPlan);
  const koBig = (config.diffMaxBytes % 3 === 0 ? "a" : "") + "가".repeat(Math.ceil(config.diffMaxBytes / 3) + 5);
  fs.writeFileSync(path.join(frag, "kobig.txt"), koBig);
  const koBigPlan = planRewind(checkpointsForApproval(4, buildMutationPreview("Edit", { file_path: "kobig.txt", old_string: "x", new_string: "y" }, frag), frag), 3, 9);
  check(koBigPlan.skipped.some((s) => s.reason === "truncated") && !koBigPlan.skipped.some((s) => s.reason === "binary"), "잘린 경계에서 멀티바이트가 끊겨도 binary가 아니라 truncated다", koBigPlan);
  fs.rmSync(frag, { recursive: true, force: true });
}

await (await import("./support/tempDb")).useTempDiary("rewind_plan"); // 임시 SQLite 일기
const previousData = config.dataDir;
const diskData = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-data-"));
config.dataDir = diskData;
try {
  const id = "rewind-idle-disk";
  const diskCwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-cwd-"));
  store.ensureSessionDir(id);
  store.appendEvent(id, { seq: 1, ts: 1, kind: "user_msg", text: "남겨" });
  store.appendEvent(id, { seq: 2, ts: 2, kind: "status", status: "interrupted" });
  const meta = { id, cwd: diskCwd, createdAt: 1, resumeKey: "old-key" };
  store.saveMeta(meta);
  const outcome = rewindDisk(meta, 1, () => []);
  const visible = store.readEventsSince(id, 0).filter((event) => !isHiddenSeq(event.seq, [{ after: outcome.after, until: outcome.until }]));
  check(visible.some((event) => event.kind === "user_msg" && event.seq === 1), "고른 사용자 말은 남는다");
  check(
    visible.some((event) => isControlEvent(event, "status") && event.status === "completed" && event.seq === outcome.idleSeq),
    "숨김 범위 밖의 완료가 남아 새로고침 뒤에도 쉰 상태로 읽힌다",
    visible.map((event) => event.kind),
  );
  check(!visible.some((event) => isControlEvent(event, "status") && event.status === "interrupted"), "숨은 중단 사건은 다시 보내지 않는다");
  const saved = store.loadMeta(id);
  check(saved?.rewound === true && saved.resumeKey === undefined && sessionWasRewound(saved), "되돌린 메타는 옛 이어가기 키를 비운다");
  fs.rmSync(diskCwd, { recursive: true, force: true });

  // 옛 기록(wholeFile 표시 없음)은 Edit 조각과 전체 내용을 구별할 수 없어 파일을 덮지 않고 건너뛴다
  const oldId = "rewind-old-note";
  const oldCwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-old-"));
  fs.writeFileSync(path.join(oldCwd, "f.ts"), "current");
  fs.writeFileSync(path.join(oldCwd, "made.ts"), "created");
  store.ensureSessionDir(oldId);
  store.appendEvent(oldId, { seq: 1, ts: 1, kind: "user_msg", text: "남겨" });
  store.appendEvent(oldId, { seq: 2, ts: 2, kind: "status", status: "completed" });
  appendCheckpoint(oldId, { seq: 2, path: "f.ts", before: "TARGET", isCreate: false, ok: true });
  appendCheckpoint(oldId, { seq: 2, path: "made.ts", before: null, isCreate: true, ok: true });
  const oldOutcome = rewindDisk({ id: oldId, cwd: oldCwd, createdAt: 1 }, 1, () => []);
  check(fs.readFileSync(path.join(oldCwd, "f.ts"), "utf8") === "current", "옛 내용 기록은 파일을 덮지 않는다");
  check(oldOutcome.skipped.some((s) => s.path === "f.ts" && s.reason === "unknown"), "옛 내용 기록은 unknown으로 알린다", oldOutcome.skipped);
  check(!fs.existsSync(path.join(oldCwd, "made.ts")) && oldOutcome.restored.includes("made.ts"), "옛 새 파일 기록은 그대로 지운다");
  fs.rmSync(oldCwd, { recursive: true, force: true });
} finally {
  config.dataDir = previousData;
  fs.rmSync(diskData, { recursive: true, force: true });
}

void liveRewindChecks();

async function liveRewindChecks(): Promise<void> {
  const { LiveSession } = await import("../sessions/LiveSession");
  const { closeEventLog, eventLogFor } = await import("../sessions/eventLog");
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry, MOCK_PROVIDER } = await import("./support/mockProvider");
  const unregister = __registerProviderForTest(mockEntry);
  const previous = config.dataDir;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-live-"));
  config.dataDir = dataDir;
  const sessions: { dispose: () => void; id: string }[] = [];
  try {
    await checkRewindRejectsInput(LiveSession, eventLogFor, sessions, MOCK_PROVIDER);
    await checkDisposeFailureKeepsInput(LiveSession, eventLogFor, sessions, MOCK_PROVIDER);
    await checkRewoundSessionKeepsNewKey(LiveSession, eventLogFor, sessions, MOCK_PROVIDER);
    await checkSecondRewindDisposeFailure(LiveSession, eventLogFor, sessions, MOCK_PROVIDER);
  } catch (error) {
    fail++;
    console.error(error);
  } finally {
    for (const session of sessions) {
      try {
        session.dispose();
      } catch {
        /* 정리 */
      }
      try {
        closeEventLog(session.id);
      } catch {
        /* 이미 닫힘 */
      }
    }
    unregister();
    config.dataDir = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "✅" : "❌"} rewind_plan: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !ready(); i++) await sleep(10);
}

async function checkRewindRejectsInput(
  LiveSession: typeof import("../sessions/LiveSession").LiveSession,
  eventLogFor: typeof import("../sessions/eventLog").eventLogFor,
  sessions: { dispose: () => void; id: string }[],
  provider: string,
): Promise<void> {
  const id = randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-work-"));
  let releaseDispose: () => void = () => {};
  const disposeHold = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  let disposeEntered = false;
  let pushes = 0;
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry } = await import("./support/mockProvider");
  const unregister = __registerProviderForTest({
    ...mockEntry,
    id: provider,
    createRuntime(opts) {
      const runtime = mockEntry.createRuntime(opts);
      const originalDispose = runtime.dispose.bind(runtime);
      const originalPush = runtime.push.bind(runtime);
      runtime.push = (input) => {
        pushes += 1;
        originalPush(input);
      };
      runtime.dispose = async () => {
        disposeEntered = true;
        await disposeHold;
        await originalDispose();
      };
      return runtime;
    },
  });
  try {
    const session = new LiveSession({
      id,
      cwd,
      provider,
      eventLog: eventLogFor(id),
    });
    sessions.push(session);
    let userSeq = 0;
    let restedSeq = 0;
    session.subscribe((event) => {
      if (event.kind === "user_msg") userSeq = event.seq;
      // 저장이 동기라 사람 말의 공개가 push() 호출 안에서 일어나 그때는 턴이 아직 안 열려 있다. 턴이 끝났다는 완료 사건까지 기다린다.
      if (event.kind === "status" && (event as { status?: string }).status === "completed" && userSeq > 0 && event.seq > userSeq) restedSeq = event.seq;
    });
    session.push("남겨");
    await waitUntil(() => restedSeq > 0 && !session.isTurnOpen);
    check(userSeq > 0 && !session.isTurnOpen, "되돌리기 전에 턴이 쉬어 있다", { userSeq, open: session.isTurnOpen });
    let finished = false;
    const pending = session.rewind(userSeq).then((result) => {
      finished = true;
      return result;
    });
    await waitUntil(() => disposeEntered);
    let busy = false;
    try {
      session.push("다음");
    } catch (error) {
      busy = error instanceof RewindError && error.code === "busy";
    }
    check(busy, "되돌리는 중 새 입력은 거절된다");
    check(pushes === 1, "거절된 입력은 꺼지는 실행기로 들어가지 않는다", pushes);
    releaseDispose();
    const result = await pending;
    check(finished && store.loadMeta(id)?.rewound === true, "되돌린 메타를 저장한 뒤 성공으로 답한다");
    const visible = store.readEventsSince(id, 0).filter((event) => !isHiddenSeq(event.seq, session.hiddenRanges));
    check(
      visible.some((event) => event.kind === "user_msg" && event.seq === userSeq) &&
        visible.some((event) => isControlEvent(event, "status") && event.status === "completed" && event.seq === result.idleSeq),
      "되돌린 뒤 고른 말과 조용한 완료만 남아 턴이 쉰다",
    );
    check(!visible.some((event) => isControlEvent(event, "status") && event.status === "interrupted"), "되돌린 목록에 중단 사건은 없다");
  } finally {
    unregister();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function checkDisposeFailureKeepsInput(
  LiveSession: typeof import("../sessions/LiveSession").LiveSession,
  eventLogFor: typeof import("../sessions/eventLog").eventLogFor,
  sessions: { dispose: () => void; id: string }[],
  provider: string,
): Promise<void> {
  const id = randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-fail-"));
  let originalDispose: (() => Promise<void>) | null = null;
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry } = await import("./support/mockProvider");
  const unregister = __registerProviderForTest({
    ...mockEntry,
    id: provider,
    createRuntime(opts) {
      const runtime = mockEntry.createRuntime(opts);
      originalDispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        throw new Error("dispose 실패");
      };
      return runtime;
    },
  });
  try {
    const session = new LiveSession({ id, cwd, provider, eventLog: eventLogFor(id) });
    sessions.push(session);
    let userSeq = 0;
    let restedSeq = 0;
    session.subscribe((event) => {
      if (event.kind === "user_msg") userSeq = event.seq;
      // 저장이 동기라 사람 말의 공개가 push() 호출 안에서 일어나 그때는 턴이 아직 안 열려 있다. 턴이 끝났다는 완료 사건까지 기다린다.
      if (event.kind === "status" && (event as { status?: string }).status === "completed" && userSeq > 0 && event.seq > userSeq) restedSeq = event.seq;
    });
    const keptKey = store.loadMeta(id)?.resumeKey;
    session.push("남겨");
    await waitUntil(() => restedSeq > 0 && !session.isTurnOpen);
    let failed = false;
    try {
      await session.rewind(userSeq);
    } catch {
      failed = true;
    }
    const saved = store.loadMeta(id);
    check(failed, "실행기 종료가 실패하면 되돌리기는 실패다");
    check(saved?.rewound !== true && saved?.resumeKey === keptKey, "종료 실패 때는 되돌린 메타를 저장하지 않는다");
    let accepted = false;
    try {
      session.push("다시");
      accepted = true;
    } catch (error) {
      accepted = !(error instanceof RewindError);
    }
    check(accepted, "종료 실패 뒤에는 입력을 다시 받는다");
  } finally {
    try {
      // createRuntime 콜백에서만 대입된다. 이 줄은 그 대입을 못 봐서 null로만 본다.
      const dispose = originalDispose as (() => Promise<void>) | null;
      await dispose?.();
    } catch {
      /* 정리 */
    }
    unregister();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function checkRewoundSessionKeepsNewKey(
  LiveSession: typeof import("../sessions/LiveSession").LiveSession,
  eventLogFor: typeof import("../sessions/eventLog").eventLogFor,
  sessions: { dispose: () => void; id: string }[],
  provider: string,
): Promise<void> {
  const id = randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-newkey-"));
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry, MOCK_RESUME_KEY } = await import("./support/mockProvider");
  const unregister = __registerProviderForTest(mockEntry);
  try {
    const session = new LiveSession({
      id,
      cwd,
      provider,
      rewound: true,
      eventLog: eventLogFor(id),
    });
    sessions.push(session);
    const saved = store.loadMeta(id);
    check(saved?.resumeKey === MOCK_RESUME_KEY && saved.rewound === true, "되돌린 뒤 새 프로세스가 발급한 키는 저장한다", saved?.resumeKey);
  } finally {
    unregister();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function checkSecondRewindDisposeFailure(
  LiveSession: typeof import("../sessions/LiveSession").LiveSession,
  eventLogFor: typeof import("../sessions/eventLog").eventLogFor,
  sessions: { dispose: () => void; id: string }[],
  provider: string,
): Promise<void> {
  const id = randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-again-"));
  let originalDispose: (() => Promise<void>) | null = null;
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry } = await import("./support/mockProvider");
  const unregister = __registerProviderForTest({
    ...mockEntry,
    id: provider,
    createRuntime(opts) {
      const runtime = mockEntry.createRuntime(opts);
      originalDispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        throw new Error("dispose 실패");
      };
      return runtime;
    },
  });
  try {
    store.ensureSessionDir(id);
    store.appendEvent(id, { seq: 1, ts: 1, kind: "user_msg", text: "남겨" });
    store.appendEvent(id, { seq: 2, ts: 2, kind: "status", status: "completed" });
    const session = new LiveSession({ id, cwd, provider, rewound: true, eventLog: eventLogFor(id) });
    sessions.push(session);
    let failed = false;
    try {
      await session.rewind(1);
    } catch {
      failed = true;
    }
    let accepted = false;
    try {
      session.push("다시");
      accepted = true;
    } catch (error) {
      accepted = !(error instanceof RewindError);
    }
    check(failed && accepted, "이미 되돌린 세션도 종료 실패 뒤에는 입력을 다시 받는다");
  } finally {
    try {
      // createRuntime 콜백에서만 대입된다. 이 줄은 그 대입을 못 봐서 null로만 본다.
      const dispose = originalDispose as (() => Promise<void>) | null;
      await dispose?.();
    } catch {
      /* 정리 */
    }
    unregister();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
