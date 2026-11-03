/**
 * 브리프 7파·8파. 사람 찾기와 세션 검색이 같은 SQLite 글자 색인을 읽는지 본다.
 * 빈 데이터 폴더로 검색 길을 불러도 search.db가 생기면 안 된다.
 * 검색은 글 안에 낱말이 들어 있는지로 찾는다(소문자 사본에서 instr). 점수는 FTS5 bm25다.
 * 색인은 세션 사건 표에서만 다시 만든다. 그림자 검색과 칠판 글 표는 이 시험의 정본이 아니다.
 * 쓰기는 임시 SQLite 파일만. 끝나면 그 파일을 지운다.
 * 운영 aether.sqlite와 라이브 search.db는 바꾸지 않는다. 라이브 Express는 건드리지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AetherEvent } from "../types";
import { config } from "../config";
import { openDatabaseAt } from "../db/sqlite";
import { __resetSessionDiaryForTest, appendDiaryDurable, openSessionDiary } from "../db/sessionDiary";
import {
  __resetSessionLetterForTest,
  blockSessionLetter,
  explainSessionLetter,
  letterDocId,
  openSessionLetter,
  replaceSessionLetter,
  searchLettersWithContext,
  searchSessionLetters,
  sessionLetterBlocked,
  sessionLetterReady,
} from "../db/sessionLetter";
import { rebuildSessionLetters } from "../search/rebuildLetter";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const LIVE_SEARCH = path.join(SERVER_DIR, "data", "search.db");
const LIVE_DATA = path.resolve(SERVER_DIR, "data");
const LIVE_DB = path.join(SERVER_DIR, "data", "aether.sqlite");
let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  const shown = cond || detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${shown}`);
  cond ? pass++ : fail++;
}

function leak(msg: string): string {
  if (msg.includes("://") || msg.includes("@") || msg.toLowerCase().includes("hunter2")) return "연결 실패";
  return msg;
}

function fileSha(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const um = (seq: number, text: string): AetherEvent => ({ seq, ts: 1000 + seq, kind: "user_msg", text });
const asst = (seq: number, blocks: unknown[]): AetherEvent =>
  ({ seq, ts: 1000 + seq, kind: "sdk", msg: { type: "assistant", message: { content: blocks } } }) as unknown as AetherEvent;
const toolres = (seq: number, results: string[]): AetherEvent =>
  ({
    seq,
    ts: 1000 + seq,
    kind: "sdk",
    msg: {
      type: "user",
      message: { content: results.map((r, i) => ({ type: "tool_result", tool_use_id: `result-${seq}-${i}`, content: r })) },
    },
  }) as unknown as AetherEvent;
const done = (seq: number): AetherEvent =>
  ({ seq, ts: 1000 + seq, kind: "sdk", msg: { type: "result", subtype: "success", duration_ms: 10 } }) as unknown as AetherEvent;
const txt = (text: string) => ({ type: "text", text });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

function writeMeta(id: string, extra: Record<string, unknown>): void {
  const dir = path.join(config.dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, cwd: `/tmp/${id}`, createdAt: 1000, ...extra }));
}

let tempDb: TempDatabase | undefined;
let beforeSha: string | null = null;
let beforeDbSha: string | null = null;
const rows = <T>(sql: string, ...params: (string | number)[]): T[] => openDatabaseAt(tempDb!.file).prepare(sql).all(...params) as T[];
const run = (sql: string, ...params: (string | number)[]): void => {
  openDatabaseAt(tempDb!.file).prepare(sql).run(...params);
};

try {
  if (path.resolve(config.dataDir) === LIVE_DATA) {
    console.error("임시 데이터 폴더가 없다");
    process.exit(1);
  }

  const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const letterSrc = fs.readFileSync(path.join(SERVER_DIR, "db", "sessionLetter.ts"), "utf8");
  const rebuildSrc = fs.readFileSync(path.join(SERVER_DIR, "search", "rebuildLetter.ts"), "utf8");
  const routeSrc = fs.readFileSync(path.join(SERVER_DIR, "routes", "search.ts"), "utf8");
  const agentSrc = fs.readFileSync(path.join(SERVER_DIR, "search", "agentTool.ts"), "utf8");
  const indexSrc = fs.readFileSync(path.join(SERVER_DIR, "index.ts"), "utf8");
  const liveSrc = fs.readFileSync(path.join(SERVER_DIR, "sessions", "LiveSession.ts"), "utf8");
  const managerSrc = fs.readFileSync(path.join(SERVER_DIR, "sessions", "SessionManager.ts"), "utf8");

  check(!self.includes("search/" + "SearchIndex"), "이 시험은 검색 파일을 가져오지 않는다");
  check(!sessionLetterReady() && !sessionLetterBlocked(), "처음에는 글자 색인이 닫혀 있다");
  check(letterDocId(1, 0) === 100_000, "순번 1의 글자 번호는 10만이다");
  check(letterDocId(1, 99999) === 199_999, "조각 99999는 허용한다");
  let partThrew = false;
  try {
    letterDocId(1, 100_000);
  } catch {
    partThrew = true;
  }
  check(partThrew, "조각 10만은 거절한다");

  for (const word of ["SearchIndex", "text_tsv", "events.jsonl", "prepare.ts", "resolve.ts", "message"]) {
    check(!letterSrc.includes(word), `글자 색인 모듈에 ${word} 없음`);
  }
  check(letterSrc.includes("instr(l.content_fold"), "글자 색인은 글 안에 들어 있는지로 찾는다");
  check(!letterSrc.includes("word_similarity"), "단어 닮음 점수는 쓰지 않는다");
  check(!rebuildSrc.includes("jsonl") && !rebuildSrc.includes("search.db"), "재생성은 일기 파일과 검색 파일을 열지 않는다");
  check(!rebuildSrc.includes("SearchIndex"), "재생성은 검색 파일 모듈을 부르지 않는다");
  check(!/=== ["'](?:claude|grok|codex)["']/.test(rebuildSrc), "재생성은 제공자 이름으로 갈라지지 않는다");
  check(!rebuildSrc.includes("prepare.ts") && !rebuildSrc.includes("resolve.ts"), "빈칸 채우기를 재생성에 붙이지 않는다");
  check(
    !routeSrc.includes("searchIndex") && !routeSrc.includes("search.db") && !routeSrc.includes("searchCanon"),
    "사람 찾기는 검색 파일과 검색 스위치를 쓰지 않는다",
  );
  check(routeSrc.includes("searchSessionLetters") && !routeSrc.includes("searchChat"), "사람 찾기는 글자 색인만 본다");
  const handler = agentSrc.slice(agentSrc.indexOf("async handler"));
  check(!handler.includes("searchIndex"), "세션 검색은 검색 파일을 부르지 않는다");
  check(handler.includes("searchLettersWithContext") && !handler.includes("searchChatWithContext"), "세션 검색은 글자 색인만 본다");
  check(handler.includes("excludeSessionId: ctx.sessionId"), "같은 폴더 검색은 지금 세션 묶음을 뺀다");
  check(liveSrc.includes("projectLiveLetter") && !liveSrc.includes("searchIndex"), "라이브 사건은 글자 색인만 반영한다");
  check(!managerSrc.includes("sessionLetter") && !managerSrc.includes("searchIndex"), "세션을 지워도 글자 색인은 남긴다");
  check(!indexSrc.includes("backfillSearchIndex"), "부팅은 검색 파일을 다시 만들지 않는다");
  check(indexSrc.includes("openSessionLetter") && indexSrc.includes("rebuildSessionLetters") && indexSrc.includes("blockSessionLetter"), "부팅이 글자 색인을 열고 실패하면 막는다");
  check(indexSrc.indexOf("openSessionDiary") < indexSrc.indexOf("openSessionLetter"), "일기를 연 뒤에 글자 색인을 연다");
  check(indexSrc.indexOf("openSessionLetter") < indexSrc.indexOf("restoreFromDisk"), "화면을 복원하기 전에 글자 색인을 연다");
  const bootSlice = indexSrc.slice(indexSrc.indexOf("openSessionLetter"), indexSrc.indexOf("restoreFromDisk"));
  check(!bootSlice.includes("process.exit"), "글자 색인을 열지 못해도 프로세스를 끄지 않는다");
  check(bootSlice.includes("세션 글자 색인을 열지 못했다"), "실패하면 검색 파일로 돌아가지 않는다고 적는다");

  const dbPath = path.join(config.dataDir, "search.db");
  await import("../routes/search");
  await import("../search/agentTool");
  await import("../sessions/SessionManager");
  check(
    !fs.existsSync(dbPath) && !fs.existsSync(`${dbPath}-wal`) && !fs.existsSync(`${dbPath}-shm`),
    "빈 폴더에 검색 파일이 없다",
  );

  beforeSha = fileSha(LIVE_SEARCH);
  beforeDbSha = fileSha(LIVE_DB);
  tempDb = useTempDatabase("letter-w7");
  await openSessionDiary();
  await openSessionLetter();
  check(sessionLetterReady() && !sessionLetterBlocked(), "시험 파일에서 글자 색인이 열린다");

  // 널 문자는 검색용 글에서만 공백으로 바꾸고 원본 사건은 쓰지 않는다.
  {
    const sessionId = "sess-nul";
    const unchanged = "  원문보존표식\t줄바꿈\n끝\r\u0001\u001f\u007f  ";
    let threw = false;
    try {
      await replaceSessionLetter(sessionId, [
        { seq: 1, part: 0, role: "user", ts: 1, content: "널앞낱말\u0000널뒤낱말\u0000끝낱말" },
        { seq: 2, part: 0, role: "user", ts: 2, content: unchanged },
        { seq: 3, part: 0, role: "user", ts: 3, content: "\u0000\u0000" },
        { seq: 4, part: 0, role: "user", ts: 4, content: "" },
      ], [], {
        displayName: "널\u0000문자 시험",
        cwd: "/tmp/sess-nul",
        model: null,
        createdAt: 1,
        lineageId: sessionId,
      });
    } catch {
      threw = true;
    }
    const stored = rows<{ seq: string; content: string }>(
      "SELECT CAST(seq AS TEXT) AS seq, content FROM session_letter WHERE session_id = ? ORDER BY seq",
      sessionId,
    );
    check(!threw && stored.length === 3 && stored.some((row) => row.seq === "2"), "널 문자가 든 글과 나머지 글을 오류 없이 함께 저장한다", { threw, count: stored.length });
    check(stored.find((row) => row.seq === "1")?.content === "널앞낱말 널뒤낱말 끝낱말", "모든 널 문자 자리를 공백 한 칸으로 저장한다");
    for (const query of ["널앞낱말", "널뒤낱말"]) {
      const hits = await searchSessionLetters({ query, sessionId });
      check(hits.length === 1 && hits[0]?.seq === 1, `널 문자 앞뒤 낱말을 각각 검색한다: ${query}`);
    }
    check(stored.find((row) => row.seq === "2")?.content === unchanged, "널 문자가 없는 글은 공백과 다른 제어 문자까지 그대로 저장한다");
    check(stored.find((row) => row.seq === "3")?.content === "  ", "널 문자만 있던 글은 바뀐 공백을 그대로 저장한다");
    check(!stored.some((row) => row.seq === "4"), "빈 글은 기존처럼 저장하지 않는다");
    const storedName =
      rows<{ display_name: string | null }>("SELECT display_name FROM session_letter_session WHERE session_id = ?", sessionId)[0]?.display_name ?? null;
    check(storedName === "널 문자 시험", "세션 이름의 널 문자도 공백으로 바꿔 저장한다", { storedName });
  }

  writeMeta("sess-a", { name: "세션 에이", cwd: "/tmp/sess-a", model: "haiku", createdAt: 1000, resumeKey: "line-sess-a" });
  writeMeta("sess-b", { name: "세션 비", cwd: "/tmp/sess-b", createdAt: 2000 });
  writeMeta("sess-c", { name: "세션 씨", cwd: "/tmp/sess-c", createdAt: 3000 });
  await appendDiaryDurable(
    "sess-a",
    um(1, "alpha beta together"),
  );
  await appendDiaryDurable(
    "sess-a",
    asst(2, [txt("작업 도중 말입니다"), use("call-2", "Bash", { command: "pip install torch" })]),
  );
  await appendDiaryDurable("sess-a", toolres(3, ["installed-ok"]));
  await appendDiaryDurable("sess-a", asst(4, [txt("완료 답변 입니다")]));
  await appendDiaryDurable("sess-a", done(5));
  await appendDiaryDurable("sess-a", um(6, "어제 재배포했습니다"));
  await appendDiaryDurable("sess-a", um(8, "형제문장고유"));
  await appendDiaryDurable("sess-b", um(1, "alpha then beta"));
  await appendDiaryDurable("sess-c", um(1, "고아표식고유"));
  writeMeta("sess-ko", { name: "조사", resumeKey: "line-ko" });
  writeMeta("sess-en", { name: "대소문자", resumeKey: "line-en" });
  writeMeta("sess-rank", { name: "순위", resumeKey: "line-rank" });
  writeMeta("sess-quote", { name: "구절", resumeKey: "line-quote" });
  writeMeta("sess-and", { name: "모두", resumeKey: "line-and" });
  writeMeta("sess-ex-cur", { name: "배제 현재", resumeKey: "line-ex-shared" });
  writeMeta("sess-ex-kin", { name: "배제 같은묶음", resumeKey: "line-ex-shared" });
  writeMeta("sess-ex-other", { name: "배제 다른묶음", resumeKey: "line-ex-other" });
  writeMeta("sess-pct", { name: "기호", resumeKey: "line-pct" });
  writeMeta("sess-new", { name: "최신", resumeKey: "line-new" });
  writeMeta("sess-old", { name: "오래됨", resumeKey: "line-old" });
  writeMeta("sess-role", { name: "역할", resumeKey: "line-role" });
  writeMeta("sess-span", { name: "기간", resumeKey: "line-span" });
  await appendDiaryDurable("sess-ko", um(1, "조사표식 환경은 좋다"));
  await appendDiaryDurable("sess-en", um(1, "대소문자표식 staging이다. 끝"));
  await appendDiaryDurable("sess-rank", { ...um(1, "순위베타 순위감마 둘"), ts: 5_000 });
  await appendDiaryDurable("sess-rank", { ...um(2, "순위알파 하나"), ts: 9_000 });
  await appendDiaryDurable("sess-quote", um(1, "따옴표표식 고유구절 가나다 있다"));
  await appendDiaryDurable("sess-quote", um(2, "따옴표표식 고유구절  가나다 두칸"));
  await appendDiaryDurable("sess-quote", um(3, "따옴표표식 고유구절가나다붙음"));
  await appendDiaryDurable("sess-and", um(1, "모두표식 모두알파 모두베타"));
  await appendDiaryDurable("sess-and", um(2, "모두표식 모두알파뿐"));
  await appendDiaryDurable("sess-and", um(3, "모두표식 모두베타뿐"));
  await appendDiaryDurable("sess-ex-cur", um(1, "배제표식고유 현재"));
  await appendDiaryDurable("sess-ex-kin", um(1, "배제표식고유 같은"));
  await appendDiaryDurable("sess-ex-other", um(1, "배제표식고유 다른"));
  await appendDiaryDurable("sess-pct", um(1, "퍼센트표식 100%퍼센트고유"));
  await appendDiaryDurable("sess-pct", um(2, "퍼센트표식 100X퍼센트고유"));
  await appendDiaryDurable("sess-pct", um(3, "밑줄표식 코드_이름고유"));
  await appendDiaryDurable("sess-pct", um(4, "밑줄표식 코드X이름고유"));
  await appendDiaryDurable("sess-pct", um(5, "백슬래시표식 경로\\끝고유"));
  await appendDiaryDurable("sess-pct", um(6, "백슬래시표식 경로끝고유"));
  // 기호만 있는 검색어가 걸러졌는지 가리려고, 그 기호들이 실제로 든 글을 둔다.
  await appendDiaryDurable("sess-pct", um(7, "기호대조 foo() 50%% a--b 😀😀 \"\""));
  await appendDiaryDurable("sess-new", { ...um(1, "새정렬둘 새정렬하나"), ts: 31_000 });
  await appendDiaryDurable("sess-new", { ...um(2, "새정렬하나"), ts: 39_000 });
  await appendDiaryDurable("sess-old", { ...um(1, "옛정렬하나"), ts: 41_000 });
  await appendDiaryDurable("sess-old", { ...um(2, "옛정렬하나 옛정렬둘"), ts: 49_000 });
  await appendDiaryDurable("sess-role", { ...um(1, "역할표식고유 사용자글"), ts: 51_000 });
  await appendDiaryDurable("sess-role", { ...asst(2, [txt("역할표식고유 말한줄")]), ts: 52_000 });
  await appendDiaryDurable("sess-role", { ...done(3), ts: 52_001 });
  await appendDiaryDurable("sess-role", { ...toolres(4, ["역할표식고유 도구결과"]), ts: 53_000 });
  await appendDiaryDurable("sess-span", { ...um(1, "기간표식고유 이른"), ts: 61_000 });
  await appendDiaryDurable("sess-span", { ...um(2, "기간표식고유 중간"), ts: 62_000 });
  await appendDiaryDurable("sess-span", { ...um(3, "기간표식고유 늦은"), ts: 63_000 });

  const probeText = "token=sk-live-w7secret";
  {
    const max = rows<{ n: number }>("SELECT COALESCE(MAX(byte_offset), 0) AS n FROM session_event WHERE session_id = ?", "sess-a");
    const line = JSON.stringify({ seq: 7, ts: 1007, kind: "user_msg", text: probeText });
    const offset = Number(max[0]?.n ?? 0) + 1_000_000;
    run(
      `INSERT INTO session_event (session_id, seq, ts, kind, byte_offset, byte_length, line_text)
       VALUES (?, 7, 1007, 'user_msg', ?, ?, ?)`,
      "sess-a",
      offset,
      Buffer.byteLength(line),
      line,
    );
  }

  await rebuildSessionLetters();
  check(!fs.existsSync(path.join(config.dataDir, "sess-a", "events.jsonl")), "재생성은 일기 파일을 만들지 않는다");

  const phrase = await searchSessionLetters({ query: "alpha beta" });
  check(phrase.length >= 2, "alpha beta는 두 세션에서 찾는다", phrase.length);
  check(phrase[0]?.sessionId === "sess-a" && phrase[0]?.seq === 1, "붙어 있는 구절이 앞에 온다", phrase[0]?.sessionId);
  check(phrase.some((hit) => hit.sessionId === "sess-b"), "떨어져 있는 단어도 함께 찾는다");
  check(phrase[0]?.session.displayName === "세션 에이", "표시 이름을 함께 돌려준다", phrase[0]?.session.displayName);
  check(phrase[0]?.session.cwd === "/tmp/sess-a", "작업 폴더를 함께 돌려준다", phrase[0]?.session.cwd);
  check(phrase[0]?.session.lineageId === "line-sess-a", "이어가기 키를 함께 돌려준다", phrase[0]?.session.lineageId);

  const korean = await searchSessionLetters({ query: "재배포" });
  check(korean.length === 1 && korean[0]?.sessionId === "sess-a" && korean[0]?.seq === 6, "세 글자 한글은 그 글자가 든 글을 찾는다", korean.length);
  const toolHits = await searchSessionLetters({ query: "pip install" });
  const plainSnippet = (snippet: string) => snippet.replace(/[\u0001\u0002]/g, "");
  check(
    toolHits.length === 2 && toolHits.some((hit) => hit.seq === 3 && plainSnippet(hit.snippet).includes("installed-ok")),
    "pip install은 도구 결과 행(installed-ok)도 찾는다",
    toolHits.map((hit) => ({ seq: hit.seq, role: hit.role, snippet: plainSnippet(hit.snippet) })),
  );
  check(
    toolHits[0]?.seq === 2 &&
      toolHits[0]?.role === "tool" &&
      plainSnippet(toolHits[0].snippet).includes("pip") &&
      plainSnippet(toolHits[0].snippet).includes("install"),
    "맨 앞은 두 낱말이 다 든 도구 호출 행",
    toolHits[0] ? { seq: toolHits[0].seq, role: toolHits[0].role, snippet: plainSnippet(toolHits[0].snippet) } : null,
  );
  check((await searchSessionLetters({ query: "pip install", chatOnly: true })).length === 0, "사람 찾기는 도구 호출을 빼는다");
  const answer = await searchSessionLetters({ query: "완료 답변" });
  check(answer.length === 1 && answer[0]?.role === "assistant" && answer[0]?.seq === 4, "턴의 마지막 말만 답변으로 남는다", answer.length);
  check((await searchSessionLetters({ query: "작업 도중" })).length === 0, "앞선 말은 검색에서 빠진다");
  check((await searchSessionLetters({ query: "배" })).length === 0, "한 글자 검색은 빈 결과다");

  const secretCount = rows<{ n: number }>("SELECT count(*) AS n FROM session_letter WHERE instr(content, ?) > 0", probeText)[0]?.n ?? -1;
  check(secretCount >= 1, "비밀번호 문장도 글자 색인에 들어간다", secretCount);

  const flat = await searchSessionLetters({ query: "형제문장고유" });
  const around = await searchLettersWithContext({ query: "형제문장고유" });
  check(flat.length === 1 && around.length === 1, "같은 문장을 목록과 맥락에서 찾는다", { flat: flat.length, around: around.length });
  check(
    flat[0]?.sessionId === around[0]?.sessionId && flat[0]?.seq === around[0]?.anchor.seq && flat[0]?.part === around[0]?.anchor.part,
    "목록과 맥락의 세션·순번·조각이 같다",
  );

  const englishPlan = await explainSessionLetter({ query: "alpha" });
  check(englishPlan.includes("session_letter_fts"), "영어 계획은 FTS5 점수 색인을 쓴다", englishPlan);
  const koreanPlan = await explainSessionLetter({ query: "재배포" });
  check(koreanPlan.includes("session_letter_fts"), "한글 계획은 FTS5 점수 색인을 쓴다", koreanPlan);
  const shortPlan = await explainSessionLetter({ query: "배" });
  check(shortPlan === "", "한 글자 검색은 계획을 만들지 않는다", shortPlan);

  const envHit = await searchSessionLetters({ query: "환경" });
  check(envHit.length === 1 && envHit[0]?.sessionId === "sess-ko" && plainSnippet(envHit[0].snippet).includes("환경은"), "환경은 환경은을 찾는다", envHit.length);
  const stagingHit = await searchSessionLetters({ query: "STAGING" });
  check(
    stagingHit.length === 1 && stagingHit[0]?.sessionId === "sess-en" && plainSnippet(stagingHit[0].snippet).includes("staging이다."),
    "STAGING은 staging이다.를 찾는다",
    stagingHit.map((hit) => plainSnippet(hit.snippet)),
  );
  const ranked = await searchSessionLetters({ query: "순위알파 순위베타 순위감마" });
  check(
    ranked.length === 2 && ranked[0]?.seq === 1 && ranked[1]?.seq === 2,
    "둘 맞은 글이 하나 맞은 글보다 앞이다",
    ranked.map((hit) => hit.seq),
  );
  const quoted = await searchSessionLetters({ query: '"고유구절 가나다"' });
  check(quoted.length === 1 && quoted[0]?.sessionId === "sess-quote" && quoted[0]?.seq === 1, "따옴표 구절은 그 구절이 그대로 든 글만 찾는다", quoted.map((hit) => hit.seq));
  const spaced = await searchSessionLetters({ query: '"고유구절  가나다"' });
  check(spaced.length === 1 && spaced[0]?.seq === 2, "공백이 다른 구절은 한 칸 구절을 찾지 못한다", spaced.map((hit) => hit.seq));
  const anyWord = await searchSessionLetters({ query: "모두알파 모두베타" });
  check(anyWord.length === 3 && anyWord[0]?.seq === 1, "낱말 중 하나라도 맞으면 찾고 많이 맞은 글이 앞이다", anyWord.map((hit) => hit.seq));
  const allWords = await searchSessionLetters({ query: "모두알파 모두베타", requireAll: true });
  check(allWords.length === 1 && allWords[0]?.seq === 1, "requireAll이면 낱말이 모두 든 글만 찾는다", allWords.map((hit) => hit.seq));
  const excluded = await searchSessionLetters({ query: "배제표식고유", excludeSessionId: "sess-ex-cur" });
  check(
    excluded.length === 1 && excluded[0]?.sessionId === "sess-ex-other",
    "excludeSessionId는 그 세션과 같은 묶음을 빼고 다른 묶음은 남긴다",
    excluded.map((hit) => hit.sessionId),
  );
  const absentExclude = await searchSessionLetters({ query: "배제표식고유", excludeSessionId: "sess-not-in-index" });
  check(absentExclude.length === 3, "색인에 없는 세션 번호는 아무것도 빼지 않는다", absentExclude.map((hit) => hit.sessionId));
  const weirdQueries = ["%", "_", "\\", "\u0000", "a\u0000b", '"', '""', "()", '"()"', "%%", "--", "😀😀", "AND OR NOT", "-", "😀", "   "];
  for (const query of weirdQueries) {
    let threw = false;
    let count = -1;
    try {
      count = (await searchSessionLetters({ query })).length;
    } catch {
      threw = true;
    }
    check(!threw && count === 0, `이상한 검색어는 오류 없이 빈 결과다: ${JSON.stringify(query)}`, { threw, count });
  }
  const percent = await searchSessionLetters({ query: "100%퍼센트고유" });
  check(percent.length === 1 && percent[0]?.seq === 1, "%가 든 낱말은 %가 든 글만 찾는다", percent.map((hit) => hit.seq));
  const underscore = await searchSessionLetters({ query: "코드_이름고유" });
  check(underscore.length === 1 && underscore[0]?.seq === 3, "_가 든 낱말은 _가 든 글만 찾는다", underscore.map((hit) => hit.seq));
  const backslash = await searchSessionLetters({ query: "경로\\끝고유" });
  check(backslash.length === 1 && backslash[0]?.seq === 5, "\\가 든 낱말은 \\가 든 글만 찾는다", backslash.map((hit) => hit.seq));
  const newest = await searchSessionLetters({ query: "새정렬둘 새정렬하나", sort: "newest" });
  const oldestDefault = await searchSessionLetters({ query: "새정렬둘 새정렬하나" });
  check(newest[0]?.ts === 39_000 && newest[1]?.ts === 31_000, "newest는 더 최근 글이 앞이다", newest.map((hit) => hit.ts));
  check(oldestDefault[0]?.seq === 1, "기본 정렬은 더 많이 맞은 글이 시각보다 앞이다", oldestDefault.map((hit) => hit.seq));
  const oldest = await searchSessionLetters({ query: "옛정렬하나 옛정렬둘", sort: "oldest" });
  const oldestByCount = await searchSessionLetters({ query: "옛정렬하나 옛정렬둘" });
  check(oldest[0]?.ts === 41_000 && oldest[1]?.ts === 49_000, "oldest는 더 오래된 글이 앞이다", oldest.map((hit) => hit.ts));
  check(oldestByCount[0]?.seq === 2, "기본 정렬은 oldest와 다르게 많이 맞은 글을 앞에 둔다", oldestByCount.map((hit) => hit.seq));
  const roleUser = await searchSessionLetters({ query: "역할표식고유", role: "user" });
  const roleAssistant = await searchSessionLetters({ query: "역할표식고유", role: "assistant" });
  const roleTool = await searchSessionLetters({ query: "역할표식고유", role: "tool" });
  check(roleUser.length === 1 && roleUser[0]?.role === "user", "role=user는 사용자 글만 찾는다", roleUser.map((hit) => hit.role));
  check(roleAssistant.length === 1 && roleAssistant[0]?.role === "assistant", "role=assistant는 답변만 찾는다", roleAssistant.map((hit) => hit.role));
  check(roleTool.length === 1 && roleTool[0]?.role === "tool", "role=tool은 도구 글만 찾는다", roleTool.map((hit) => hit.role));
  const fromMid = await searchSessionLetters({ query: "기간표식고유", fromTs: 62_000 });
  const toMid = await searchSessionLetters({ query: "기간표식고유", toTs: 62_000 });
  const onlyMid = await searchSessionLetters({ query: "기간표식고유", fromTs: 62_000, toTs: 62_000 });
  check(fromMid.length === 2 && fromMid.every((hit) => hit.ts >= 62_000), "fromTs 이후만 찾는다", fromMid.map((hit) => hit.ts));
  check(toMid.length === 2 && toMid.every((hit) => hit.ts <= 62_000), "toTs 이전만 찾는다", toMid.map((hit) => hit.ts));
  check(onlyMid.length === 1 && onlyMid[0]?.ts === 62_000, "fromTs와 toTs를 같이 주면 그 시각만 찾는다", onlyMid.map((hit) => hit.ts));

  const snap = async () =>
    JSON.stringify(rows("SELECT session_id, CAST(seq AS TEXT) AS seq, part, role, content FROM session_letter ORDER BY session_id, seq, part"));
  const firstSnap = await snap();
  await rebuildSessionLetters();
  const secondSnap = await snap();
  check(firstSnap === secondSnap && firstSnap !== "[]", "두 번 다시 만들어도 행이 같다");

  const rolled = JSON.stringify({ seq: 6, ts: 1006, kind: "user_msg", text: "오늘 롤백했습니다" });
  run("UPDATE session_event SET line_text = ?, byte_length = ? WHERE session_id = ? AND seq = 6", rolled, Buffer.byteLength(rolled), "sess-a");
  // 사건 줄을 직접 고쳤으므로 최대 순번은 그대로다. 건너뛰지 않게 재생성 기록을 지운다.
  run("DELETE FROM session_letter_progress WHERE session_id = ?", "sess-a");
  await rebuildSessionLetters();
  check((await searchSessionLetters({ query: "재배포" })).length === 0, "다시 만든 뒤 옛 한글은 없다");
  check((await searchSessionLetters({ query: "롤백했습니다" })).length === 1, "다시 만든 뒤 새 문장 한 건");

  // 세션 폴더를 지운 세션(사건은 남음)은 다시 만들지 않고 색인을 그대로 둔다.
  const bLetters = async () =>
    JSON.stringify(rows("SELECT CAST(seq AS TEXT) AS seq, part, role, content FROM session_letter WHERE session_id = ? ORDER BY seq, part", "sess-b"));
  const bBefore = await bLetters();
  fs.rmSync(path.join(config.dataDir, "sess-b"), { recursive: true, force: true });
  await rebuildSessionLetters();
  check(bBefore !== "[]" && (await bLetters()) === bBefore, "지운 세션의 글자 색인을 다시 만들 때 그대로 둔다");
  const deletedMeta =
    rows<{ cwd: string | null; display_name: string | null }>("SELECT cwd, display_name FROM session_letter_session WHERE session_id = ?", "sess-b")[0] ?? null;
  check(deletedMeta?.cwd === "/tmp/sess-b" && deletedMeta?.display_name === "세션 비", "지운 세션의 이름·폴더를 다시 만들 때 지킨다", deletedMeta);

  run("DELETE FROM session_event WHERE session_id = ?", "sess-c");
  run("DELETE FROM session_event_cursor WHERE session_id = ?", "sess-c");
  await rebuildSessionLetters();
  check((await searchSessionLetters({ query: "고아표식고유" })).length > 0, "사건 표에서 빠진 세션도 검색 글자가 남아 검색된다");
  const orphanMeta = rows<{ n: number }>("SELECT count(*) AS n FROM session_letter_session WHERE session_id = ?", "sess-c")[0]?.n ?? -1;
  check(orphanMeta === 1, "사건 표에 없는 세션 정보 행은 재생성이 지우지 않는다", orphanMeta);

  // 사람 찾기: 지운 세션(서버가 모르는 세션) 결과에 표시를 붙이고, 남은 글을 쪽으로 읽는다.
  {
    const express = (await import("express")).default;
    const { searchRouter } = await import("../routes/search");
    const gone = "0f0e0d0c-0b0a-4908-8706-050403020100";
    await replaceSessionLetter(gone, [{ seq: 1, part: 0, role: "user", ts: 1, content: "지운세션표식고유 첫 글" }, { seq: 2, part: 0, role: "assistant", ts: 2, content: "둘째 글" }], [2], {
      displayName: "지운 세션",
      cwd: "/tmp/gone",
      model: null,
      createdAt: 1,
      lineageId: gone,
    });
    const app = express();
    app.use("/api/search", searchRouter);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/search`;
    try {
      const found = (await (await fetch(`${base}?q=${encodeURIComponent("지운세션표식고유")}`)).json()) as { results: { sessionId: string; deleted?: boolean }[] };
      check(found.results.length === 1 && found.results[0].sessionId === gone && found.results[0].deleted === true, "서버가 모르는 세션 결과에 지운 표시를 붙인다", found.results);
      const page1 = (await (await fetch(`${base}/session/${gone}?after=0`)).json()) as { rows: { id: number; seq: number; content: string }[] };
      check(page1.rows.map((r) => r.seq).join(",") === "1,2", "지운 세션의 남은 글을 차례로 돌려준다", page1.rows);
      const page2 = (await (await fetch(`${base}/session/${gone}?after=${page1.rows[0].id}`)).json()) as { rows: { seq: number }[] };
      check(page2.rows.map((r) => r.seq).join(",") === "2", "after 뒤 글만 돌려준다", page2.rows);
      check((await fetch(`${base}/session/not-a-session`)).status === 400, "세션 ID 모양이 아니면 거절한다");
    } finally {
      server.close();
    }
  }

  blockSessionLetter();
  check(sessionLetterBlocked() && !sessionLetterReady(), "열기에 실패하면 글자 색인을 막는다");
  let refused = false;
  try {
    await searchSessionLetters({ query: "alpha" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    refused = msg.includes("열려 있지 않다");
  }
  check(refused, "막힌 색인은 조회하지 않는다");
} catch (err) {
  check(false, "시험이 중단됐다", leak(err instanceof Error ? err.message : String(err)));
} finally {
  __resetSessionLetterForTest();
  __resetSessionDiaryForTest();
  tempDb?.dispose();
  if (beforeDbSha !== null || fs.existsSync(LIVE_DB)) {
    check(fileSha(LIVE_DB) === beforeDbSha, "운영 aether.sqlite 해시는 그대로다");
  }
  if (beforeSha !== null || fs.existsSync(LIVE_SEARCH)) {
    check(fileSha(LIVE_SEARCH) === beforeSha, "라이브 search.db 해시는 그대로다");
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} session_letter_search ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
