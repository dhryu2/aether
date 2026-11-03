/**
 * 삭제 범위(기록만 남기고 삭제 / 완전 삭제)와 일회용 정리 도구 — 모델 호출 0.
 * 임시 데이터 폴더와 임시 SQLite만 쓴다. 도구는 별도 프로세스로 돌린다.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { useTempDatabase } from "./support/tempDb";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-delete-scope-"));
process.env.AETHER_DATA_DIR = dataDir;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || extra === undefined ? "" : ` — ${String(JSON.stringify(extra)).slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}

const tmp = useTempDatabase("delete-scope");
const { openDatabaseAt } = await import("../db/sqlite");
const store = await import("../sessions/persistence");
const diary = await import("../db/sessionDiary");
const letter = await import("../db/sessionLetter");
const { rebuildSessionLetters } = await import("../search/rebuildLetter");
const { recordSearchAudit } = await import("../db/searchAudit");
const { sessionManager } = await import("../sessions/SessionManager");
const { sessionsRouter } = await import("../routes/sessions");
const express = (await import("express")).default;

const sql = (q: string, ...p: (string | number)[]) => openDatabaseAt(tmp.file).prepare(q).all(...p) as Record<string, unknown>[];
const n = (table: string, id: string) => Number(sql(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, id)[0].n);
const um = (seq: number, text: string) => ({ seq, ts: 1000 + seq, kind: "user_msg", text }) as never;
const hit = async (word: string) => (await letter.searchSessionLetters({ query: word })).length;
const folder = (id: string) => path.join(dataDir, id);

async function boot() {
  diary.__resetSessionDiaryForTest();
  letter.__resetSessionLetterForTest();
  await diary.openSessionDiary();
  await letter.openSessionLetter();
  await rebuildSessionLetters();
}

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const del = (id: string, q = "") => fetch(`${base}/api/sessions/${id}${q}`, { method: "DELETE" });

try {
  await diary.openSessionDiary();
  await letter.openSessionLetter();
  const [keep, alive, full, legacy] = [0, 1, 2, 3].map(() => crypto.randomUUID());
  const words: Record<string, string> = { [keep]: "보존고유어", [alive]: "생존고유어", [full]: "완전고유어", [legacy]: "옛호출고유어" };
  for (const id of [keep, alive, full, legacy]) {
    store.saveMeta({ id, cwd: os.tmpdir(), createdAt: 1000, name: id.slice(0, 4) } as never);
    for (let s = 1; s <= 3; s++) await diary.appendDiaryDurable(id, um(s, `${words[id]} ${s}번째 말`));
  }
  sessionManager.restoreFromDisk();
  await rebuildSessionLetters();
  const keepEvents = n("session_event", keep);
  const aliveCount = n("session_event", alive);
  const aliveEvents = JSON.stringify(sql("SELECT * FROM session_event WHERE session_id = ? ORDER BY byte_offset", alive));
  const aliveLetters = JSON.stringify(sql("SELECT seq, part, role, content FROM session_letter WHERE session_id = ? ORDER BY 1,2", alive));
  await recordSearchAudit({ actorId: "t", query: "완전고유어", hits: [{ sessionId: full, seq: 1, part: 0 }, { sessionId: keep, seq: 1, part: 0 }] });

  // 기본 삭제(인자 없는 옛 호출 포함)는 대화 글자를 남긴다
  const bad400 = await del(keep, "?purge=2");
  check(bad400.status === 400 && fs.existsSync(folder(keep)) && n("session_event", keep) === keepEvents, "잘못된 purge 값은 400이고 아무것도 지우지 않는다", [bad400.status, fs.existsSync(folder(keep)), n("session_event", keep)]);
  const r = await del(keep);
  check(r.status === 200 && !fs.existsSync(folder(keep)), "인자 없는 삭제는 성공하고 폴더가 없어진다");
  check(n("session_event", keep) === 0 && n("session_event_cursor", keep) === 0, "기본 삭제는 사건 원본을 지운다");
  check(n("session_letter", keep) === 3 && (await hit("보존고유어")) === 3, "기본 삭제 뒤에도 검색이 된다");
  const anchor = (await letter.searchSessionLetters({ query: "보존고유어" }))[0];
  const ctx = await letter.getLetterContext(keep, anchor.id);
  check(ctx.window.length >= 3, "앞뒤 문맥이 남는다", ctx.window.length);
  await del(legacy, "?purge=0");
  check(n("session_event", legacy) === 0 && (await hit("옛호출고유어")) === 3, "purge=0도 기록을 남긴다");

  // 완전 삭제
  check((await del(full, "?purge=1")).status === 200, "완전 삭제 요청 성공");
  check(n("session_event", full) + n("session_letter", full) + n("session_letter_session", full) + n("session_letter_progress", full) === 0, "완전 삭제는 원본·글자·세션 정보·재생성 기록을 모두 지운다");
  check((await hit("완전고유어")) === 0 && sql("SELECT 1 FROM session_letter_fts WHERE session_letter_fts MATCH '완전고유어'").length === 0, "완전 삭제 뒤 검색에서 사라진다");
  check(!String(sql("SELECT hit_keys FROM search_audit")[0].hit_keys).includes(full) && String(sql("SELECT hit_keys FROM search_audit")[0].hit_keys).includes(keep), "검색 감사의 hit_keys에서 지운 세션만 빠진다");

  // 재부팅
  sessionManager.restoreFromDisk();
  await boot();
  check((await hit("보존고유어")) === 3 && (await hit("옛호출고유어")) === 3, "재부팅 뒤에도 기록만 남기고 지운 세션의 글자가 남는다");
  check((await hit("완전고유어")) === 0 && n("session_letter_session", full) === 0 && n("session_letter_progress", full) === 0, "재부팅 뒤 완전 삭제된 세션이 되살아나지 않는다");
  check(sessionManager.list().every((s) => s.id === alive), "삭제된 세션이 목록에 되살아나지 않는다");
  check(JSON.stringify(sql("SELECT * FROM session_event WHERE session_id = ? ORDER BY byte_offset", alive)) === aliveEvents
    && JSON.stringify(sql("SELECT seq, part, role, content FROM session_letter WHERE session_id = ? ORDER BY 1,2", alive)) === aliveLetters, "살아 있는 세션의 행은 그대로다");

  // ── 삭제 실패는 사용자에게 알린다(완전 삭제) ──
  const failId = crypto.randomUUID();
  store.saveMeta({ id: failId, cwd: os.tmpdir(), createdAt: 1000, name: "fail" } as never);
  for (let s = 1; s <= 2; s++) await diary.appendDiaryDurable(failId, um(s, `실패고유어 ${s}`));
  sessionManager.restoreFromDisk();
  await rebuildSessionLetters();
  sql(`CREATE TRIGGER block_del BEFORE DELETE ON session_event WHEN old.session_id = '${failId}' BEGIN SELECT RAISE(ABORT, '시험용 삭제 실패'); END`);
  const failed = await del(failId, "?purge=1");
  check(failed.status === 400 && n("session_letter", failId) > 0, "완전 삭제가 DB에서 실패하면 400이고 글자도 그대로다", failed.status);
  sql("DROP TRIGGER block_del");
  const retried = await del(failId, "?purge=1");
  check(retried.status === 200 && n("session_event", failId) + n("session_letter", failId) === 0, "같은 요청을 다시 보내면 남은 것이 지워진다");

  // ── 해석기 추정: 폴더가 없는 codex 세션은 답변도 색인된다(예전엔 기본 해석기로 읽어 답변이 빠졌다) ──
  const codexEv = (seq: number, text: string) =>
    ({ seq, ts: 2000 + seq, kind: "codex", msg: { method: "item/completed", params: { threadId: "t", turnId: "u", item: { type: "agentMessage", id: `m${seq}`, text, phase: null } } } }) as never;
  const codexDone = (seq: number) => ({ seq, ts: 2000 + seq, kind: "codex", msg: { method: "turn/completed", params: { threadId: "t", turn: { id: "u", items: [], status: "completed" } } } }) as never;
  const codexId = crypto.randomUUID();
  await diary.appendDiaryDurable(codexId, um(1, "코덱스질문"));
  await diary.appendDiaryDurable(codexId, codexEv(2, "코덱스고유답변"));
  await diary.appendDiaryDurable(codexId, codexDone(3));
  await rebuildSessionLetters();
  check((await hit("코덱스고유답변")) === 1, "폴더가 없는 codex 세션도 재생성이 답변을 색인한다", await hit("코덱스고유답변"));
  sql("DELETE FROM session_event WHERE session_id = ?", codexId);
  for (const t of ["session_letter", "session_letter_session", "session_letter_progress"]) sql(`DELETE FROM ${t} WHERE session_id = ?`, codexId);

  // ── 기본 삭제 전 글자 확인(글자가 없으면 만든다 / 못 만들면 원본을 남긴다) ──
  const lazyId = crypto.randomUUID();
  store.saveMeta({ id: lazyId, cwd: os.tmpdir(), createdAt: 1000, name: "lazy", provider: "codex" } as never);
  await diary.appendDiaryDurable(lazyId, um(1, "게으른질문"));
  await diary.appendDiaryDurable(lazyId, codexEv(2, "게으른고유답변"));
  await diary.appendDiaryDurable(lazyId, codexDone(3));
  sessionManager.restoreFromDisk();
  check(n("session_letter", lazyId) === 0, "(준비) 글자가 아직 없는 세션");
  await del(lazyId);
  check(n("session_event", lazyId) === 0 && (await hit("게으른고유답변")) === 1, "글자가 없는 세션을 기본 삭제하면 글자를 만든 뒤 원본을 지운다");
  const richId = crypto.randomUUID();
  store.saveMeta({ id: richId, cwd: os.tmpdir(), createdAt: 1000, name: "rich" } as never);
  await diary.appendDiaryDurable(richId, um(1, "풍부한질문"));
  sessionManager.restoreFromDisk();
  await rebuildSessionLetters();
  sql("UPDATE session_letter SET content = '원본과다른말', content_fold = '원본과다른말' WHERE session_id = ?", richId);
  const richEvents = n("session_event", richId);
  await del(richId);
  check(!fs.existsSync(folder(richId)) && n("session_event", richId) === richEvents && richEvents > 0, "글자를 원본과 맞출 수 없으면 원본을 남긴다");
  sql("DELETE FROM session_event WHERE session_id = ?", richId);
  for (const t of ["session_letter", "session_letter_session", "session_letter_progress"]) sql(`DELETE FROM ${t} WHERE session_id = ?`, richId);

  // ── 해석기 추정은 사건 전체를 본다: 앞 2000줄이 제어 사건뿐인 codex 세션 ──
  const longId = crypto.randomUUID();
  for (let s = 1; s <= 2100; s++) await diary.appendDiaryDurable(longId, { seq: s, ts: 1000 + s, kind: "notice", notice: "resumed", detail: "x" } as never);
  await diary.appendDiaryDurable(longId, codexEv(2101, "긴앞부분고유답변"));
  await diary.appendDiaryDurable(longId, codexDone(2102));
  await rebuildSessionLetters();
  check((await hit("긴앞부분고유답변")) === 1, "앞 2000줄이 제어 사건뿐이어도 codex로 고른다", await hit("긴앞부분고유답변"));
  sql("DELETE FROM session_event WHERE session_id = ?", longId);
  for (const t of ["session_letter", "session_letter_session", "session_letter_progress"]) sql(`DELETE FROM ${t} WHERE session_id = ?`, longId);

  // ── 도구 결과 비교: 정제 전이라 더 길게 저장된 글은 정상, 같은 자리에 더 짧거나 다른 글은 원본을 남긴다 ──
  const { checkLetters } = await import("../search/letterBuild");
  const fakeCodec = { provider: "fake", normalize: (ev: { seq: number }) => [{ type: "tool_result", provider: "fake", seq: ev.seq, part: 0, ts: 1, toolId: "t", output: "짧은 결과" }] } as never;
  const toolId = crypto.randomUUID();
  const src = (visit: (r: { seq: number; ts: number; line: string }) => void) => visit({ seq: 1, ts: 1, line: "{}" });
  const putTool = (content: string) => {
    sql("DELETE FROM session_letter WHERE session_id = ?", toolId);
    sql("INSERT INTO session_letter (session_id, seq, part, role, ts, content, content_fold) VALUES (?, 1, 0, 'tool', 1, ?, ?)", toolId, content, content);
  };
  putTool("▸ 짧은 결과 그리고 정제 전에 더 길게 저장된 부분");
  const longer = checkLetters(openDatabaseAt(tmp.file), toolId, src, fakeCodec);
  check(longer.state === "match" && longer.unrefined === 1, "정제 전이라 더 긴 도구 결과는 일치로 본다", longer);
  putTool("▸ 짧은");
  check(checkLetters(openDatabaseAt(tmp.file), toolId, src, fakeCodec).state === "keep", "같은 자리의 더 짧은 도구 결과는 원본을 남긴다");
  sql("DELETE FROM session_letter WHERE session_id = ?", toolId);
  check(checkLetters(openDatabaseAt(tmp.file), toolId, src, fakeCodec).state === "recover", "빠진 도구 결과는 채운다");

  // ── 정리 도구 ──
  // 옛 방식으로 지운 세션을 흉내 낸다: 사건은 남고 폴더만 없음.
  //   g1=글자 일치(저장에만 있는 글 1행 있음), g2=codex 답변 글자가 빠짐, g3=색인할 내용 없음(남김),
  //   g4=같은 자리에 다른 내용(남김), g7=개수는 같지만 한 행이 다른 자리에 있음(채우기), g8=최근 활동
  const [g1, g2, g3, g4, g7, g8] = [0, 1, 2, 3, 4, 5].map(() => crypto.randomUUID());
  for (const id of [g1, g2, g3, g4, g7, g8]) store.saveMeta({ id, cwd: os.tmpdir(), createdAt: 1000, name: id.slice(0, 4) } as never);
  for (let s = 1; s <= 2; s++) await diary.appendDiaryDurable(g1, um(s, `도구대상어 ${s}`));
  await diary.appendDiaryDurable(g2, um(1, "도구복구질문"));
  await diary.appendDiaryDurable(g2, codexEv(2, "도구복구고유답변"));
  await diary.appendDiaryDurable(g2, codexDone(3));
  await diary.appendDiaryDurable(g3, { seq: 1, ts: 1001, kind: "notice", notice: "resumed", detail: "x" } as never);
  await diary.appendDiaryDurable(g4, um(1, "도구과다어"));
  for (let s = 1; s <= 2; s++) await diary.appendDiaryDurable(g7, um(s, `자리다름어 ${s}`));
  await diary.appendDiaryDurable(g8, { seq: 1, ts: Date.now(), kind: "user_msg", text: "최근활동어" } as never);
  await rebuildSessionLetters();
  const stray = (id: string, seq: number, content: string) =>
    sql("INSERT INTO session_letter (session_id, seq, part, role, ts, content, content_fold) VALUES (?, ?, 0, 'user', 1, ?, ?)", id, seq, content, content);
  sql("DELETE FROM session_letter WHERE session_id = ? AND role <> 'user'", g2); // 옛 버그가 남긴 모양: 질문만 있고 답변이 없다
  stray(g1, 9, "저장에만있는말");
  sql("UPDATE session_letter SET content = '다른내용', content_fold = '다른내용' WHERE session_id = ?", g4);
  sql("UPDATE session_letter SET seq = 9 WHERE session_id = ? AND seq = 2", g7); // 개수는 같지만 seq 2 자리가 비었다
  for (const id of [g1, g2, g3, g4, g7, g8]) fs.rmSync(folder(id), { recursive: true, force: true });
  sql("PRAGMA wal_checkpoint(TRUNCATE)");

  const tool = fileURLToPath(new URL("../scripts/purge-deleted-session-events.ts", import.meta.url));
  const runIn = (dir: string, dbFile: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", tool, ...args], { env: { ...process.env, AETHER_DATA_DIR: dir, AETHER_DB_PATH: dbFile }, encoding: "utf8" });
  const run = (...args: string[]) => runIn(dataDir, tmp.file, ...args);
  const snapshot = () => JSON.stringify([sql("SELECT count(*) AS n FROM session_event"), sql("SELECT count(*) AS n FROM session_letter")]);
  const dbBytes = () => crypto.createHash("sha256").update(fs.readFileSync(tmp.file)).digest("hex");
  const listing = () => fs.readdirSync(path.dirname(tmp.file)).sort().join(",");

  // 미리 보기: 서버(다른 프로세스) 잠금이 있어도 돌고, DB 파일과 잠금 파일을 쓰지 않는다
  const before = snapshot();
  const bytesBefore = dbBytes();
  fs.writeFileSync(`${tmp.file}.server.lock`, String(process.pid)); // 서버가 떠 있는 것으로 본다
  const filesWithLock = listing();
  const preview = run();
  const fp = /대상 지문: ([0-9a-f]{16})/.exec(preview.stdout)?.[1] ?? "";
  check(preview.status === 0 && preview.stdout.includes("대상 세션 4개") && preview.stdout.includes("글자 채우기 2개") && fp !== "", "미리 보기: 대상 4개(일치 2, 채우기 2)와 지문", preview.stdout + preview.stderr);
  const line = (id: string) => preview.stdout.split("\n").find((l) => l.includes(id)) ?? "";
  check(line(g3).includes("색인할 내용이 없다") && line(g4).includes("다른") && line(g4).includes("남김"), "미리 보기: 남기는 세션과 이유를 알린다", [line(g3), line(g4)]);
  check(line(g1).includes("저장에만 있는 글 1행") && line(g1).includes("도구대상어 1".slice(0, 5)) && /마지막 \d{4}-\d{2}-\d{2}/.test(line(g1)), "미리 보기: 마지막 활동, 첫 사용자 말, 저장에만 있는 글 수를 보인다", line(g1));
  check(line(g8).includes("경고") && !line(g1).includes("경고"), "미리 보기: 최근 7일 안에 활동한 대상만 경고한다", line(g8));
  check(line(g2).includes("codex"), "미리 보기: 세션 정보 없이도 codex 해석기를 골랐다");
  check(line(g7).includes("채우기 1행"), "개수가 같아도 자리가 비면 채우기 대상이다 (내용·순번 비교)", line(g7));
  check(snapshot() === before && dbBytes() === bytesBefore, "미리 보기는 DB 파일을 바꾸지 않는다");
  check(fs.readFileSync(`${tmp.file}.server.lock`, "utf8") === String(process.pid) && listing() === filesWithLock, "미리 보기는 잠금 파일을 건드리지 않고 파일을 늘리지 않는다", [filesWithLock, listing()]);

  // 거부 조건
  const good = path.join(dataDir, "백업.sqlite");
  openDatabaseAt(tmp.file).exec(`VACUUM INTO '${good}'`);
  check(run("--apply", "--backup", good).status !== 0, "--expect-fingerprint 없이 --apply는 거부한다");
  const locked = run("--apply", "--backup", good, "--expect-fingerprint", fp);
  check(locked.status !== 0 && /같은 DB를 쓰고 있다/.test(locked.stderr) && snapshot() === before, "서버 잠금이 있으면 --apply를 거부한다", locked.stderr);
  fs.rmSync(`${tmp.file}.server.lock`);
  const wrong = run("--apply", "--backup", good, "--expect-fingerprint", "0000000000000000");
  check(wrong.status !== 0 && /대상이 미리 보기와 다르다/.test(wrong.stderr) && snapshot() === before, "미리 보기와 다른 지문은 거부한다", wrong.stderr);
  // 폴더가 잠깐 안 보이던 세션이 돌아오면 대상이 달라져 지문이 맞지 않는다
  fs.mkdirSync(folder(g1));
  const changed = run("--apply", "--backup", good, "--expect-fingerprint", fp);
  check(changed.status !== 0 && /대상이 미리 보기와 다르다/.test(changed.stderr) && snapshot() === before, "대상이 하나라도 바뀌면 거부한다", changed.stderr);
  fs.rmSync(folder(g1), { recursive: true, force: true });
  check(run("--apply", "--backup", path.join(dataDir, "없음.sqlite"), "--expect-fingerprint", fp).status !== 0, "없는 백업 파일은 거부한다");
  const bad = path.join(dataDir, "깨진.sqlite");
  fs.writeFileSync(bad, "not a database");
  check(run("--apply", "--backup", bad, "--expect-fingerprint", fp).status !== 0, "무결성 검사에 실패하는 백업은 거부한다");
  const empty = path.join(dataDir, "빈.sqlite");
  new DatabaseSync(empty).exec("CREATE TABLE x (a)");
  const emptyRun = run("--apply", "--backup", empty, "--expect-fingerprint", fp);
  check(emptyRun.status !== 0 && snapshot() === before, "관계없는 빈 SQLite 파일은 백업으로 인정하지 않는다", emptyRun.stderr);
  // 살아 있는 세션의 행이 백업보다 늘었으면(옛 백업) 거부한다
  sql("INSERT INTO session_event (session_id, seq, ts, kind, byte_offset, byte_length, line_text) VALUES (?, 9999, 1, 'user_msg', 99999999, 5, '{\"a\":1}')", alive);
  const stale = run("--apply", "--backup", good, "--expect-fingerprint", fp);
  check(stale.status !== 0 && /백업에 사건이 모자란다/.test(stale.stderr), "살아 있는 세션 행이 백업에 모자라면 거부한다", stale.stderr);
  const aliveNow = n("session_event", alive);
  const before2 = snapshot();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-empty-data-"));
  const noData = runIn(emptyDir, tmp.file);
  check(noData.status !== 0 && /살아 있는 세션/.test(noData.stderr), "데이터 폴더에 살아 있는 세션이 없으면 거부한다", noData.stderr);
  const noDir = runIn(path.join(emptyDir, "없는폴더"), tmp.file, "--apply", "--backup", good, "--expect-fingerprint", fp);
  check(noDir.status !== 0 && snapshot() === before2, "데이터 폴더가 없으면 --apply를 거부한다", noDir.stderr);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  const good2 = path.join(dataDir, "백업2.sqlite");
  openDatabaseAt(tmp.file).exec(`VACUUM INTO '${good2}'`);
  const sizeBefore = fs.statSync(tmp.file).size;
  const applied = run("--apply", "--backup", good2, "--expect-fingerprint", fp);
  check(applied.status === 0 && applied.stdout.includes("글자를 채운 세션 2개"), "--apply 성공", applied.stdout + applied.stderr);
  check([g1, g2, g7, g8].every((id) => n("session_event", id) === 0) && n("session_event", g3) === 1 && n("session_event", g4) === 1 && n("session_event", alive) === aliveNow, "대상 세션의 원본만 지우고 남기는 세션과 살아 있는 세션은 그대로다");
  check((await hit("도구대상어")) === 2 && (await hit("도구복구고유답변")) === 1 && (await hit("자리다름어")) === 3, "검색 글자는 그대로고, 빠졌던 글은 채워졌다");
  check(n("session_letter", g1) === 3 && n("session_letter", g4) === 1, "저장에만 있던 글과 다른 내용 글은 건드리지 않는다");
  check(fs.statSync(tmp.file).size <= sizeBefore && fs.existsSync(good), "VACUUM 뒤 크기가 늘지 않고 백업은 그대로다", [sizeBefore, fs.statSync(tmp.file).size]);
} catch (err) {
  check(false, "시험이 중단됐다", err instanceof Error ? err.stack : String(err));
} finally {
  server.close();
  letter.__resetSessionLetterForTest();
  diary.__resetSessionDiaryForTest();
  tmp.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "✅" : "❌"} session_delete_scope ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
