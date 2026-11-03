/**
 * 글자 색인 재생성 건너뛰기. 부팅마다 모든 세션을 다시 만들지 않고, 바뀐 세션만 다시 만든다.
 * 임시 SQLite와 임시 데이터 폴더만 쓴다.
 */
import fs from "node:fs";
import path from "node:path";
import type { AetherEvent } from "../types";
import { config } from "../config";
import { openDatabaseAt } from "../db/sqlite";
import { __resetSessionDiaryForTest, appendDiaryDurable, openSessionDiary } from "../db/sessionDiary";
import { __resetSessionLetterForTest, openSessionLetter, projectLiveLetter, readLetterProgress, searchSessionLetters } from "../db/sessionLetter";
import { rebuildSessionLetters } from "../search/rebuildLetter";
import { letterRulesVersion } from "../search/refineLetter";
import { useTempDatabase } from "./support/tempDb";

let pass = 0, fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const um = (seq: number, text: string): AetherEvent => ({ seq, ts: 1000 + seq, kind: "user_msg", text });
function writeMeta(id: string): void {
  const dir = path.join(config.dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: `/tmp/${id}`, createdAt: 1000, name: id }));
}

const tmp = useTempDatabase("letter-progress");
const sql = (q: string, ...p: (string | number)[]) => openDatabaseAt(tmp.file).prepare(q).all(...p) as Record<string, unknown>[];
const count = (id: string) => Number(sql("SELECT count(*) AS n FROM session_letter WHERE session_id = ?", id)[0].n);
const live = (id: string, seq: number, text: string) =>
  projectLiveLetter({ sessionId: id, seq, ts: 1000 + seq, turnEnded: false, items: [{ part: 0, role: "user", content: text }], displayName: id, cwd: `/tmp/${id}`, model: null, createdAt: 1000, lineageId: id });

try {
  await openSessionDiary();
  await openSessionLetter();
  for (const id of ["s-a", "s-b", "s-fail"]) writeMeta(id);
  await appendDiaryDurable("s-a", um(1, "알파고유어 하나"));
  await appendDiaryDurable("s-a", um(2, "알파고유어 둘"));
  await appendDiaryDurable("s-b", um(1, "베타고유어"));
  await appendDiaryDurable("s-fail", um(1, "실패고유어"));
  sql("CREATE TRIGGER fail_ins BEFORE INSERT ON session_letter WHEN new.session_id = 's-fail' BEGIN SELECT RAISE(ABORT, '시험용 실패'); END");

  const first = await rebuildSessionLetters();
  check(first.rebuilt === 2, "첫 부팅은 성공하는 세션을 모두 만든다", first);
  check((await readLetterProgress("s-fail")) === null, "재생성이 실패하면 기록을 쓰지 않는다");
  check((await readLetterProgress("s-a"))?.highSeq === 2, "성공하면 최대 순번을 기록한다");
  const snap = JSON.stringify(sql("SELECT session_id, seq, part, role, content FROM session_letter ORDER BY 1,2,3"));

  sql("DROP TRIGGER fail_ins");
  const second = await rebuildSessionLetters();
  check(second.rebuilt === 1, "두 번째 부팅은 기록 없는 실패 세션만 다시 시도한다", second);
  sql("DELETE FROM session_letter WHERE session_id = 's-fail'");
  sql("DELETE FROM session_letter_progress WHERE session_id = 's-fail'");
  const third = await rebuildSessionLetters();
  check(third.rebuilt === 1, "기록을 지운 세션만 다시 만든다", third);
  const fourth = await rebuildSessionLetters();
  check(fourth.rebuilt === 0, "바뀐 것이 없으면 재생성 0회", fourth);

  // 일기에만 늘고 색인에는 못 닿은 경우(비정상 종료)
  await appendDiaryDurable("s-a", um(3, "빈틈고유어"));
  check((await searchSessionLetters({ query: "빈틈고유어" })).length === 0, "일기만 늘면 색인에는 아직 없다");
  const fifth = await rebuildSessionLetters();
  check(fifth.rebuilt === 1 && (await searchSessionLetters({ query: "빈틈고유어" })).length === 1, "최대 순번이 달라진 세션만 다시 만든다", fifth);

  // 실시간 색인이 중간 순번을 빠뜨린 채 뒤 순번을 써도 빈틈이 메워진다
  await appendDiaryDurable("s-b", um(2, "누락고유어"));
  await appendDiaryDurable("s-b", um(3, "뒤순번고유어"));
  await live("s-b", 3, "뒤순번고유어");
  check((await readLetterProgress("s-b")) === null, "실시간 색인은 기록을 무효화한다");
  check((await searchSessionLetters({ query: "누락고유어" })).length === 0, "순번 2는 색인에 빠져 있다");
  const sixth = await rebuildSessionLetters();
  check(sixth.rebuilt === 1 && (await searchSessionLetters({ query: "누락고유어" })).length === 1, "다음 부팅이 빈틈을 메운다", sixth);
  check((await rebuildSessionLetters()).rebuilt === 0, "메운 뒤에는 다시 건너뛴다");

  // 규칙 버전
  check(letterRulesVersion() !== letterRulesVersion({ longMin: 1 }), "정제 규칙 값이 바뀌면 버전이 달라진다");
  const bumped = await rebuildSessionLetters({ refine: { longMin: 4001 } });
  check(bumped.rebuilt === 3, "규칙 버전이 오르면 전체를 다시 만든다", bumped);
  check((await rebuildSessionLetters({ refine: { longMin: 4001 } })).rebuilt === 0, "같은 버전이면 다시 건너뛴다");

  // 결과 동일: 건너뛰기 없이 다시 만든 것과 같은 행
  await rebuildSessionLetters();
  const before = JSON.stringify(sql("SELECT session_id, seq, part, role, content FROM session_letter ORDER BY 1,2,3"));
  sql("DELETE FROM session_letter_progress");
  await rebuildSessionLetters();
  check(before === JSON.stringify(sql("SELECT session_id, seq, part, role, content FROM session_letter ORDER BY 1,2,3")) && snap !== "[]", "건너뛴 결과와 처음부터 만든 결과가 같다");

  // 원본이 사라진 세션(기록만 남기고 삭제)의 글자는 재생성이 지우지 않는다
  sql("DELETE FROM session_event WHERE session_id = 's-b'");
  const nb = count("s-b");
  await rebuildSessionLetters();
  check(nb > 0 && count("s-b") === nb && (await readLetterProgress("s-b")) !== null, "원본이 사라진 세션의 색인과 기록은 그대로 둔다");
} catch (err) {
  check(false, "시험이 중단됐다", err instanceof Error ? err.message : String(err));
} finally {
  __resetSessionLetterForTest();
  __resetSessionDiaryForTest();
  tmp.dispose();
}
console.log(`\n${fail === 0 ? "✅" : "❌"} session_letter_progress ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
