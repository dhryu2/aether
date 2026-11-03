/**
 * M1. session_search의 scope.
 * scope="project"는 서버 작업 폴더와 같은 세션만, 요약 없이 행마다 지역 날짜를 붙인다.
 * 지금 세션과 같은 이어가기 묶음은 뺀다.
 * 생략과 "all"은 지금 세션을 포함해 모든 세션을 보여 준다.
 * 쓰기는 임시 SQLite 파일만. 끝나면 그 파일을 지운다.
 * 실제 모델은 부르지 않는다. 운영 aether.sqlite는 바꾸지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";
import { setLocale } from "../i18n";
import type { ProviderServices } from "../providers/types";
import { __setSearchAuditFailure } from "../db/searchAudit";
import {
  __resetSessionLetterForTest,
  letterDocId,
  openSessionLetter,
  replaceSessionLetter,
  sessionLetterReady,
  type LetterDoc,
} from "../db/sessionLetter";
import { searchToolDef } from "../search/agentTool";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

process.env.TZ = "Asia/Seoul";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const LIVE_DATA = path.resolve(SERVER_DIR, "data");
const LIVE_DB = path.join(SERVER_DIR, "data", "aether.sqlite");

const PROJ = "/private/tmp/aether-m1-proj";
const OTHER = "/private/tmp/aether-m1-other";
const SUB = "/private/tmp/aether-m1-proj/sub";
const TMP = "/tmp/aether-m1-proj";
const REL = "private/tmp/aether-m1-proj";

const TS = {
  start: Date.UTC(2026, 8, 26),
  mid: Date.UTC(2026, 8, 27),
  d0928: Date.UTC(2026, 8, 28),
  d0929: Date.UTC(2026, 8, 29),
  d0929b: Date.UTC(2026, 8, 29, 8),
  anchor: Date.UTC(2026, 8, 30),
  slash: Date.UTC(2026, 8, 29, 15),
  other: Date.UTC(2026, 8, 30, 12),
  sub: Date.UTC(2026, 9, 1),
  tmp: Date.UTC(2026, 9, 2),
  nil: Date.UTC(2026, 9, 3),
  rel: Date.UTC(2026, 9, 4),
  end: Date.UTC(2026, 9, 5),
  exact: Date.UTC(2026, 8, 28, 3),
};

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

function stamp(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function doc(seq: number, ts: number, content: string, role: LetterDoc["role"] = "user"): LetterDoc {
  return { seq, part: 0, role, ts, content };
}

function sessionIds(text: string): string[] {
  return [...text.matchAll(/session=([A-Za-z0-9_-]+)/g)].map((item) => item[1]);
}

function rowLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("    ["));
}

const DATED = /^    \[(유저|어시|도구|user|asst|tool) #\d+ \d{4}-\d{2}-\d{2}\] /;
const UNDATED = /^    \[(유저|어시|도구|user|asst|tool) #\d+\] /;

function firstDiff(actual: string, expected: string): string {
  if (actual === expected) return "";
  const n = Math.min(actual.length, expected.length);
  let i = 0;
  while (i < n && actual[i] === expected[i]) i += 1;
  return `길이 ${actual.length}/${expected.length} 위치 ${i} 실제=${JSON.stringify(actual.slice(i, i + 48))} 기대=${JSON.stringify(expected.slice(i, i + 48))}\n실제:\n${actual}`;
}

function fileSha(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const distillCalls: { prompt: string; cwd: string }[] = [];
let distillReply = "가짜요약 한줄";
const services = {
  distill(prompt: string, cwd: string) {
    distillCalls.push({ prompt, cwd });
    return Promise.resolve(distillReply);
  },
} as unknown as ProviderServices;

const tool = searchToolDef();

async function call(args: Record<string, unknown>, cwd: string, sessionId = "m1-runner"): Promise<string> {
  const result = await tool.handler(args, { cwd, services, sessionId });
  return result.content.map((part) => part.text).join("\n");
}

function folderReject(sessionId: string): string {
  return `session=${sessionId}는 같은 작업 폴더의 세션이 아니다.`;
}

function descriptorTests(): void {
  console.log("\n[서술자]");
  setLocale("ko");
  const ko = searchToolDef();
  const names = Object.keys(ko.parameters);
  check(!names.some((name) => name.toLowerCase() === "cwd"), "인자 이름에 cwd가 없다", names);
  const scope = ko.parameters.scope;
  check(
    scope?.kind === "enum" && scope.optional === true && scope.values[0] === "project" && scope.values[1] === "all" && scope.values.length === 2,
    "scope는 선택 enum project, all",
    scope,
  );
  check(ko.description.includes('scope="project"') && ko.description.includes('"all"'), "한국어 설명에 scope가 있다");
  check(scope?.kind === "enum" && scope.description.includes("project") && scope.description.includes("all"), "한국어 파라미터 설명에 범위가 있다");
  setLocale("en");
  const en = searchToolDef();
  const enScope = en.parameters.scope;
  check(en.description.includes('scope="project"') && en.description.includes('"all"'), "영어 설명에 scope가 있다");
  check(enScope?.kind === "enum" && enScope.description.toLowerCase().includes("project"), "영어 파라미터 설명에 범위가 있다");
  setLocale("ko");
  check(config.searchSummarize === true, "검색 요약 기본값이 켜져 있다");
}

async function closedTests(): Promise<void> {
  console.log("\n[색인 닫힘]");
  check(!sessionLetterReady(), "색인을 열기 전에는 닫혀 있다");
  const closed = await call({ query: "m1token" }, PROJ);
  check(closed === "세션 글자 색인을 열지 못했다", "색인이 닫혀 있으면 지금과 같은 문장", closed);
  const closedProject = await call({ query: "m1token", scope: "project" }, PROJ);
  check(closedProject === closed, "project도 색인이 닫혀 있으면 같은 문장", closedProject);
}

async function plant(
  sessionId: string,
  cwd: string | null,
  docs: LetterDoc[],
  displayName: string | null = null,
  lineageId = sessionId,
): Promise<void> {
  await replaceSessionLetter(sessionId, docs, [], {
    displayName,
    cwd,
    model: null,
    createdAt: 1,
    lineageId,
  });
}

async function dbTests(): Promise<void> {
  console.log("\n[데이터베이스]");
  let tempDb: TempDatabase | undefined;
  const beforeDbSha = fileSha(LIVE_DB);
  try {
    tempDb = useTempDatabase("m1scope");
    await openSessionLetter();

    await plant("m1-a", PROJ, [
      doc(1, TS.start, "앞머리 오래된"),
      doc(2, TS.mid, "m1token"),
      doc(3, TS.d0928, "m1token"),
      doc(4, TS.d0929, "m1token"),
      doc(5, TS.d0929b, "m1token"),
      doc(6, TS.anchor, "m1token", "assistant"),
      doc(7, TS.anchor + 1, "뒤채움"),
      doc(8, TS.anchor + 2, "뒤채움"),
      doc(9, TS.anchor + 3, "뒤채움"),
      doc(10, TS.anchor + 4, "뒤채움"),
      doc(11, TS.end, "세션끝 메모"),
    ]);
    await plant("m1-slash", `${PROJ}/`, [doc(1, TS.slash, "m1token")]);
    await plant("m1-other", OTHER, [doc(1, TS.other, "m1token")]);
    await plant("m1-sub", SUB, [doc(1, TS.sub, "m1token")]);
    await plant("m1-tmp", TMP, [doc(1, TS.tmp, "m1token")]);
    await plant("m1-null", null, [doc(1, TS.nil, "m1token")]);
    await plant("m1-rel", REL, [doc(1, TS.rel, "m1token")]);
    await plant("m1-exact", OTHER, [doc(1, TS.exact, "m1exactphrase 원문한줄")], "정확");
    await plant("m1-kin", PROJ, [doc(1, TS.start, "m1kinmarker")], "같은묶음", "m1-a");
    await plant("m1-kst", PROJ, [doc(1, Date.UTC(2026, 9, 10, 18), "m1kstmarker")]);
    for (let i = 0; i < 12; i += 1) {
      const day = String(i).padStart(2, "0");
      await plant(`m1-fill-${day}`, OTHER, [doc(1, Date.UTC(2026, 10, 1) + i * 86_400_000, "m1token")]);
    }

    const beforeProject = distillCalls.length;
    const full = await call({ scope: "project", query: "m1token", limit: 20 }, PROJ, "m1-runner");
    const fullIds = sessionIds(full);
    check(fullIds.length === 2 && fullIds[0] === "m1-a" && fullIds[1] === "m1-slash", "같은 폴더 두 세션만 나온다", fullIds);
    const wide = await call({ scope: "project", query: "m1token", limit: 20 }, PROJ, "m1-a");
    const wideSlash = await call({ scope: "project", query: "m1token", limit: 20 }, `${PROJ}/`, "m1-a");
    const wideIds = sessionIds(wide);
    check(wideSlash === wide, "작업 폴더 끝 슬래시를 붙여도 결과가 같다");
    check(!wide.includes("session=m1-other") && !wide.includes("session=m1-sub") && !wide.includes("session=m1-tmp"), "다른 폴더와 하위 폴더와 /tmp 세션은 없다");
    check(!wide.includes("session=m1-null") && !wide.includes("session=m1-rel") && !wide.includes("session=m1-fill-11"), "빈 폴더와 상대 경로와 더 최근인 다른 폴더는 없다");
    const capped = await call({ scope: "project", query: "m1token", limit: 1 }, PROJ);
    const cappedIds = sessionIds(capped);
    check(cappedIds.length === 1 && cappedIds[0] === "m1-a", "더 최근인 다른 폴더가 많아도 같은 폴더 글이 남는다", cappedIds);
    const tmpOnly = await call({ scope: "project", query: "m1token", limit: 20 }, TMP);
    const tmpIds = sessionIds(tmpOnly);
    check(tmpIds.length === 1 && tmpIds[0] === "m1-tmp", "/tmp 폴더는 /private/tmp와 다른 폴더다", tmpIds);
    check(!tmpOnly.includes("/private/"), "/tmp 검색 결과에 private 경로가 없다");
    check(distillCalls.length === beforeProject, "scope=project는 distill을 부르지 않는다", distillCalls.length - beforeProject);
    check(!wide.includes("과거 검색 요약"), "scope=project 결과에 과거 검색 요약이 없다");
    const lines = rowLines(wide);
    check(lines.length > 0 && lines.every((line) => DATED.test(line)), "project 결과의 모든 행에 날짜가 있다", lines.filter((line) => !DATED.test(line)));
    check(full.includes(`    [유저 #${letterDocId(1, 0)} ${stamp(TS.start)}] 앞머리 오래된`), "세션 시작 행의 날짜가 심은 시각과 같다");
    check(full.includes(`    [어시 #${letterDocId(6, 0)} ${stamp(TS.anchor)}] m1token  ◀매칭`), "매칭 행에 날짜와 매칭 표시가 붙는다");
    check(full.includes(`    [유저 #${letterDocId(11, 0)} ${stamp(TS.end)}] 세션끝 메모`), "세션 끝 행의 날짜가 심은 시각과 같다");
    check(wide.includes(`    [유저 #${letterDocId(1, 0)} ${stamp(TS.slash)}] m1token  ◀매칭`), "끝 슬래시 세션 행의 날짜가 그 글의 시각과 같다");
    check(wide.includes('scope="project"'), "DISCOVERY 안내에 scope=project가 있다");
    check(!wideIds.includes("m1-a") && wideIds.includes("m1-slash"), "project는 지금 세션을 빼고 같은 폴더의 다른 세션은 남긴다", wideIds);
    const kinGone = await call({ scope: "project", query: "m1kinmarker" }, PROJ, "m1-a");
    check(!kinGone.includes("session=m1-kin"), "project는 같은 이어가기 묶음 세션을 뺀다", kinGone);
    const kinKept = await call({ scope: "project", query: "m1kinmarker" }, PROJ, "m1-slash");
    check(sessionIds(kinKept).includes("m1-kin"), "다른 이어가기 묶음 세션은 남는다", sessionIds(kinKept));
    const absent = await call({ scope: "project", query: "m1token", limit: 20 }, PROJ, "m1-not-in-index");
    const absentIds = sessionIds(absent);
    check(
      absentIds.length === 2 && absentIds.includes("m1-a") && absentIds.includes("m1-slash"),
      "색인에 없는 세션 번호는 아무것도 빼지 않는다",
      absentIds,
    );
    const kst = await call({ scope: "project", query: "m1kstmarker" }, PROJ, "m1-runner");
    check(
      kst.includes("#1 [2026-10-11]") && kst.includes(`    [유저 #${letterDocId(1, 0)} 2026-10-11] m1kstmarker`),
      "UTC 2026-10-10 18:00 글은 한국 날짜 2026-10-11로 찍힌다",
      kst,
    );

    const scrolled = await call({ scope: "project", session_id: "m1-a", around_id: letterDocId(6, 0) }, PROJ);
    const scrollLines = rowLines(scrolled);
    check(scrollLines.length > 0 && scrollLines.every((line) => DATED.test(line)), "같은 폴더 SCROLL 행에 날짜가 있다", scrollLines.filter((line) => !DATED.test(line)));
    check(scrolled.includes(`    [유저 #${letterDocId(1, 0)} ${stamp(TS.start)}] 앞머리 오래된`), "SCROLL에도 그 행의 날짜가 붙는다");
    check(scrolled.includes('scope="project"로 SCROLL'), "SCROLL 안내에 scope=project가 있다");
    const slashScroll = await call({ scope: "project", session_id: "m1-slash", around_id: letterDocId(1, 0) }, PROJ);
    check(
      slashScroll.includes(`    [유저 #${letterDocId(1, 0)} ${stamp(TS.slash)}] m1token`) && slashScroll.includes('scope="project"'),
      "끝 슬래시로 저장된 세션도 SCROLL이 열린다",
    );
    const browsed = await call({ scope: "project", session_id: "m1-a" }, PROJ);
    const browseLines = rowLines(browsed);
    check(browseLines.length > 0 && browseLines.every((line) => DATED.test(line)), "같은 폴더 BROWSE 행에 날짜가 있다", browseLines.filter((line) => !DATED.test(line)));
    check(
      browsed.includes(`다음 페이지: session_search(session_id="m1-a", after_id=${letterDocId(11, 0)}, scope="project")`),
      "BROWSE 안내에 scope=project가 있다",
    );
    for (const id of ["m1-other", "m1-sub", "m1-absent"]) {
      const scrollText = await call({ scope: "project", session_id: id, around_id: letterDocId(1, 0) }, PROJ);
      const browseText = await call({ scope: "project", session_id: id }, PROJ);
      check(scrollText === folderReject(id), `SCROLL ${id}는 거절 문장만 돌려준다`, scrollText);
      check(browseText === folderReject(id), `BROWSE ${id}는 거절 문장만 돌려준다`, browseText);
    }
    check(distillCalls.length === beforeProject, "거절과 SCROLL에서도 distill을 부르지 않는다", distillCalls.length - beforeProject);

    const beforeSummary = distillCalls.length;
    const open = await call({ query: "m1token", limit: 20 }, PROJ, "m1-a");
    const openIds = sessionIds(open);
    check(openIds.includes("m1-other") && openIds.includes("m1-sub") && openIds.includes("m1-tmp"), "scope를 빼면 다른 폴더도 나온다", openIds);
    check(openIds.includes("m1-null") && openIds.includes("m1-rel") && openIds.includes("m1-fill-11"), "scope를 빼면 빈 폴더와 상대 경로와 최근 세션도 나온다");
    check(distillCalls.length === beforeSummary + 1, "요약을 켜 두면 distill이 한 번 불린다", distillCalls.length - beforeSummary);
    check(open.includes("과거 검색 요약") && open.includes("가짜요약 한줄"), "distill이 돌려준 요약이 결과에 있다");
    check(!open.includes('scope="project"'), "생략 검색의 안내에는 scope=project가 없다");
    const all = await call({ query: "m1token", scope: "all", limit: 20 }, PROJ, "m1-a");
    check(all === open, "scope=all과 생략의 결과 문자열이 같다");
    check(sessionIds(all).includes("m1-a"), "scope=all은 지금 세션을 보여 준다");

    distillReply = "NONE";
    const raw = await call({ query: "m1exactphrase" }, PROJ);
    const rawAll = await call({ query: "m1exactphrase", scope: "all" }, PROJ);
    const expectedRaw = [
      '"m1exactphrase" 검색 1건 — 각 세션의 매칭 전후 맥락(⚙=도구호출, ▸=도구결과):',
      "",
      "#1 [2026-09-28] 정확  (session=m1-exact)",
      "  ┄매칭 맥락(요청→action→결과 시퀀스):",
      "    [유저 #100000] m1exactphrase 원문한줄  ◀매칭",
      "",
      '더 파고들려면 session_search(session_id="…", around_id=<위 #숫자>)로 SCROLL.',
    ].join("\n");
    check(stamp(TS.exact) === "2026-09-28" && letterDocId(1, 0) === 100_000, "기대 문자열의 날짜와 행 번호 기준이 맞다");
    check(raw === expectedRaw, "요약이 NONE이면 날짜 없는 원문 그대로다", firstDiff(raw, expectedRaw));
    check(rawAll === raw, "scope=all의 NONE 원문도 생략과 같다");
    const rawLines = rowLines(raw);
    check(rawLines.length === 1 && rawLines.every((line) => UNDATED.test(line)) && rawLines.every((line) => !DATED.test(line)), "생략 원문 행에는 날짜가 없다", rawLines);

    const otherScroll = await call({ session_id: "m1-other", around_id: letterDocId(1, 0) }, PROJ);
    const otherScrollLines = rowLines(otherScroll);
    check(
      otherScroll.includes("m1token") && otherScrollLines.length > 0 && otherScrollLines.every((line) => UNDATED.test(line)),
      "생략 SCROLL은 다른 폴더를 열고 행에 날짜가 없다",
      otherScrollLines,
    );
    check(otherScroll.includes("같은 session_id로 SCROLL") && !otherScroll.includes('scope="project"'), "생략 SCROLL 안내는 지금 문장 그대로다");
    const otherBrowse = await call({ session_id: "m1-other" }, PROJ);
    const otherBrowseLines = rowLines(otherBrowse);
    check(
      otherBrowseLines.length > 0 && otherBrowseLines.every((line) => UNDATED.test(line)) && otherBrowse.includes('다음 페이지: session_search(session_id="m1-other", after_id='),
      "생략 BROWSE는 다른 폴더를 열고 행에 날짜가 없다",
      otherBrowseLines,
    );
    check(!otherBrowse.includes('scope="project"'), "생략 BROWSE 안내에는 scope=project가 없다");

    setLocale("en");
    const enFolder = await call({ scope: "project", session_id: "m1-other", around_id: letterDocId(1, 0) }, PROJ);
    check(enFolder === "session=m1-other is not a session in the same working folder.", "영어 폴더 거절 문장", enFolder);
    const enWide = await call({ scope: "project", query: "m1token", limit: 1 }, PROJ);
    check(rowLines(enWide).every((line) => /^    \[(user|asst|tool) #\d+ \d{4}-\d{2}-\d{2}\] /.test(line)), "영어 행은 user 역할과 날짜다", rowLines(enWide));
    setLocale("ko");
  } catch (err) {
    check(false, "시험이 중단됐다", leak(err instanceof Error ? err.message : String(err)));
  } finally {
    __resetSessionLetterForTest();
    tempDb?.dispose();
    check(fileSha(LIVE_DB) === beforeDbSha, "운영 aether.sqlite 해시는 그대로다");
  }
}

async function main(): Promise<void> {
  if (path.resolve(config.dataDir) === LIVE_DATA) {
    console.error("임시 데이터 폴더가 없다");
    process.exit(1);
  }
  __setSearchAuditFailure(() => true);
  try {
    descriptorTests();
    await closedTests();
    await dbTests();
  } finally {
    __setSearchAuditFailure(null);
    __resetSessionLetterForTest();
  }
}

main()
  .catch((err) => {
    check(false, "시험이 예외로 끝났다", leak(err instanceof Error ? err.message : String(err)));
  })
  .finally(() => {
    console.log(`\n${fail === 0 ? "✅" : "❌"} session_search_scope ${pass} pass / ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  });
