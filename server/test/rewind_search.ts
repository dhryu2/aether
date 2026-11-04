/**
 * 되돌린 대화가 검색 색인에서 지워지는지 — 모델 호출 0.
 * 사람 검색, 모델 검색(session_search), 부팅 재생성, 기존 DB 정리, 삭제 직전 채우기가 모두 같은 결과를 내야 한다.
 * 임시 데이터 폴더와 임시 SQLite만 쓴다. 표지 글자는 더미 값이다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useTempDatabase } from "./support/tempDb";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rewind-search-"));
process.env.AETHER_DATA_DIR = dataDir;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || extra === undefined ? "" : ` — ${String(JSON.stringify(extra)).slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}

const tmp = useTempDatabase("rewind-search");
const store = await import("../sessions/persistence");
const diary = await import("../db/sessionDiary");
const letter = await import("../db/sessionLetter");
const { rebuildSessionLetters, ensureLettersBeforeDelete } = await import("../search/rebuildLetter");
const { sessionManager } = await import("../sessions/SessionManager");
const { searchToolDef } = await import("../search/agentTool");

const KEEP = "DUMMYKEEPWORD";
const GONE = "DUMMYREWOUND";
const um = (seq: number, text: string) => ({ seq, ts: 1000 + seq, kind: "user_msg", text }) as never;
const hit = async (word: string, sessionId?: string) => (await letter.searchSessionLetters({ query: word, sessionId })).length;
const db = () => new DatabaseSync(tmp.file);
const count = (id: string, word: string) =>
  Number((db().prepare("SELECT count(*) AS n FROM session_letter WHERE session_id = ? AND content LIKE ?").get(id, `%${word}%`) as { n: number }).n);

async function mkSession(events: [number, string][], extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  store.saveMeta({ id, cwd: os.tmpdir(), createdAt: 1000, name: id.slice(0, 4), ...extra } as never);
  for (const [seq, text] of events) await diary.appendDiaryDurable(id, um(seq, text));
  return id;
}

try {
  await diary.openSessionDiary();
  await letter.openSessionLetter();

  console.log("\n=== 되돌린 뒤 검색 ===");
  const a = await mkSession([[1, `${KEEP} one`], [2, `${GONE} two`], [3, `${GONE} three`]]);
  await rebuildSessionLetters();
  check((await hit(GONE)) === 2 && (await hit(KEEP)) === 1, "되돌리기 전에는 모두 찾힌다");
  await sessionManager.rewind(a, 1);
  check((await hit(GONE)) === 0, "숨긴 글은 사람 검색에서 0건이다");
  check((await hit(KEEP)) === 1, "남긴 말은 찾힌다");
  check((await letter.searchLettersWithContext({ query: GONE })).length === 0, "문맥 검색에서도 0건이다");
  const page = await letter.getLetterSessionPage(a, 0, 40);
  check(page.length > 0 && !page.some((r) => r.content.includes(GONE)), "세션 쪽 넘기기에 숨긴 글이 없다", page.map((r) => r.content));
  const anchor = (await letter.searchSessionLetters({ query: KEEP }))[0];
  const around = await letter.getLetterContext(a, anchor.id, 4, 3);
  check(![...around.window, ...around.bookendStart, ...around.bookendEnd].some((r) => r.content.includes(GONE)), "앞뒤 문맥에도 숨긴 글이 없다");
  const tool = searchToolDef();
  const services = {} as never;
  const text = async (args: Record<string, unknown>) => (await tool.handler(args, { cwd: os.tmpdir(), services, sessionId: "runner" })).content.map((p) => p.text).join("\n");
  check((await text({ query: KEEP, scope: "project" })).includes(KEEP), "session_search는 남긴 말을 보여 준다");
  check(!(await text({ query: GONE, scope: "project" })).includes(`${GONE} two`), "session_search 검색에 숨긴 글이 없다");
  check(!(await text({ session_id: a })).includes(GONE), "session_search 원문 탐색에 숨긴 글이 없다");

  console.log("\n=== 부팅 재생성 ===");
  db().prepare("DELETE FROM session_letter_progress WHERE session_id = ?").run(a);
  const first = await rebuildSessionLetters();
  check(first.rebuilt >= 1 && (await hit(GONE)) === 0 && (await hit(KEEP)) === 1, "진행 기록을 지워 재생성해도 숨긴 글은 0건이다", first);
  const second = await rebuildSessionLetters();
  check(second.rebuilt === 0, "한 번 더 돌리면 다시 만들지 않는다", second);

  console.log("\n=== 기존 DB 정리 ===");
  const b = await mkSession([[1, `${KEEP} b-one`], [2, `${GONE} b-two`], [3, `${GONE} b-three`]]);
  await rebuildSessionLetters();
  check(count(b, GONE) === 2, "정리 전에는 숨긴 행이 색인에 있다");
  store.saveMeta({ ...store.loadMeta(b)!, hiddenRanges: [{ after: 1, until: 3 }], rewound: true });
  await rebuildSessionLetters();
  check(count(b, GONE) === 0 && count(b, KEEP) === 1, "건너뛰는 세션도 숨긴 행을 지우고 남긴 행은 그대로 둔다");

  console.log("\n=== 삭제 직전 채우기 ===");
  const c = await mkSession([[1, `${KEEP} c-one`], [2, `${GONE} c-two`], [5, `${KEEP} c-late`]], { hiddenRanges: [{ after: 1, until: 3 }], rewound: true });
  await letter.replaceSessionLetter(c, [{ seq: 1, part: 0, role: "user", ts: 1001, content: `${KEEP} c-one` }], [], { displayName: null, cwd: os.tmpdir(), model: null, createdAt: 1000, lineageId: c });
  const okDelete = ensureLettersBeforeDelete(c, store.loadMeta(c));
  check(okDelete === true, "삭제 전 확인이 통과한다");
  check(count(c, GONE) === 0, "숨긴 글이 되살아나지 않는다");
  check(count(c, "c-late") === 1, "숨긴 범위 밖의 빠진 글은 채운다");

  console.log("\n=== 색인이 닫혀 있을 때 ===");
  const d = await mkSession([[1, `${KEEP} d-one`], [2, `${GONE} d-two`]]);
  letter.__resetSessionLetterForTest();
  let threw = false;
  try {
    await sessionManager.rewind(d, 1);
  } catch {
    threw = true;
  }
  check(!threw && (store.loadMeta(d)?.hiddenRanges?.length ?? 0) === 1, "색인이 닫혀 있어도 되돌리기는 성공한다");
  await letter.openSessionLetter();

  console.log("\n=== 범위 경계 ===");
  const e = await mkSession([[1, `${KEEP} e1`], [2, `${GONE} e2`], [3, `${GONE} e3`], [4, `${KEEP} e4`]]);
  await rebuildSessionLetters();
  await letter.deleteLetterRanges(e, [{ after: 1, until: 3 }]);
  check(count(e, "e1") === 1 && count(e, "e2") === 0 && count(e, "e3") === 0 && count(e, "e4") === 1, "after 순번은 남고 until 순번은 지워진다");
} catch (error) {
  fail++;
  console.error(error);
} finally {
  tmp.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "✅" : "❌"} rewind_search: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
