/**
 * 브리프 5파. 새 저장과 화면 복원은 SQLite 사건 표만 쓴다. 남은 옛 일기 파일은 읽지도 지우지도 않는다.
 * 모델 0. 브리프 카드·전송 갈래·검색 폐기 0.
 * 쓰기는 임시 SQLite 파일만. 끝나면 그 파일을 지운다. 운영 aether.sqlite는 바꾸지 않는다.
 * 라이브 Express는 건드리지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AetherEvent } from "../types";
import { openDatabaseAt } from "../db/sqlite";
import { sessionDiaryMode, __resetCanonicalForTest } from "../db/canonical";
import {
  __resetSessionDiaryForTest,
  appendDiaryDurable,
  loadSessionDiary,
  holdDiaryInput,
  openSessionDiary,
  releaseDiaryInput,
} from "../db/sessionDiary";
import { readEventsPage, readEventsSince } from "../sessions/persistence";
import { setErrorJournal } from "../observability/report";
import type { ErrorJournal } from "../observability/journal";
import { useTempDatabase, type TempDatabase } from "./support/tempDb";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const LIVE_DB = path.join(SERVER_DIR, "data", "aether.sqlite");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

async function expectThrow(name: string, fn: () => Promise<unknown>, part: string): Promise<void> {
  try {
    await fn();
    check(false, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(msg.includes(part) && !msg.includes("hunter2") && !msg.includes("sk-live"), name, msg);
  }
}

async function scenario(title: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    check(false, title, err instanceof Error ? err.message : err);
  }
}

function userText(ev: AetherEvent): string {
  if (ev.kind !== "user_msg") return "";
  const text = (ev as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeDiary(root: string, sessionId: string, text: string): string {
  const file = path.join(root, sessionId, "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const line = (seq: number, text: string) => JSON.stringify({ seq, ts: seq, kind: "user_msg", text });

let diaryRoot = "";
let tempDb: TempDatabase | undefined;
const liveBefore = fs.existsSync(LIVE_DB) ? sha(LIVE_DB) : null;

try {
  const diarySrc = fs.readFileSync(path.join(SERVER_DIR, "db", "sessionDiary.ts"), "utf8");
  const schemaSql = fs.readFileSync(path.join(SERVER_DIR, "db", "schema.sql"), "utf8");
  check(!diarySrc.includes("agent-brief/prepare") && !diarySrc.includes("agent-brief/resolve"), "빈칸 채우기를 화면 복원에 붙이지 않는다");
  check(!diarySrc.includes("SearchIndex") && !diarySrc.includes("search.db"), "검색 파일을 여기서 열지 않는다");
  check(!/INSERT INTO message|UPDATE message/i.test(diarySrc), "칠판 글 표에 일기 사건을 넣지 않는다");
  check(schemaSql.includes("CREATE TABLE IF NOT EXISTS session_event"), "운영 스키마에 세션 사건 표가 있다");
  check(!schemaSql.includes("CREATE TABLE IF NOT EXISTS message"), "지운 칠판 표는 스키마에 없다");
  const banned = ["claude", "anthropic", "openai", "hermes", "codex", "grok"];
  const providerHits = banned.filter((word) => diarySrc.toLowerCase().includes(word));
  check(providerHits.length === 0, "운영 일기 코드에 provider 이름이 없다", providerHits);

  await scenario("없는 데이터베이스는 파일로 되돌리지 않는다", async () => {
    let opened = false;
    try {
      // 파일 아래 경로는 폴더를 만들 수 없어 열기가 실패한다.
      const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aether-diary-absent-")), "blocker");
      fs.writeFileSync(blocker, "");
      await openSessionDiary({ path: path.join(blocker, "aether.sqlite") });
      opened = true;
    } catch {
      opened = false;
    }
    let thrown = false;
    try {
      readEventsSince("missing-session", 0);
    } catch (err) {
      thrown = err instanceof Error && err.message.includes("파일로 되돌리지");
    }
    check(!opened && sessionDiaryMode() === "blocked" && thrown, "데이터베이스가 죽으면 파일 읽기로 빈 성공을 만들지 않는다");
    __resetSessionDiaryForTest();
  });

  diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aether-diary-w5-"));
  const searchFile = path.join(diaryRoot, "search.db");
  fs.writeFileSync(searchFile, "keep-search");
  const searchBefore = sha(searchFile);
  tempDb = useTempDatabase("diary-w5");
  await openSessionDiary();
  check(sessionDiaryMode() === "sqlite", "운영 경로는 SQLite다");
  const db = openDatabaseAt(tempDb.file);
  const table = (name: string) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  check(!table("message") && table("session_event"), "사건 표만 있고 칠판 표는 없다");

  const file = path.join(diaryRoot, "screen-1", "events.jsonl");
  await appendDiaryDurable("screen-1", { seq: 1, ts: 1, kind: "user_msg", text: "첫째" });
  await appendDiaryDurable("screen-1", { seq: 2, ts: 2, kind: "user_msg", text: "둘째" });
  // 저장 계층을 닫았다 다시 열어도 표에서 그대로 올라온다.
  __resetSessionDiaryForTest();
  await openSessionDiary();
  await loadSessionDiary("screen-1", file);
  const restored = readEventsSince("screen-1", 0).map((ev) => userText(ev));
  check(restored.join(",") === "첫째,둘째", "화면 복원이 표의 두 글을 돌려준다", restored);
  const page = readEventsPage("screen-1", 3, 10);
  check(page.events.length === 2 && page.events[0]?.seq === 1, "이전 페이지도 같은 표를 읽는다", page.events.map((ev) => ev.seq));

  await scenario("전환 중에는 새 입력을 받지 않는다", async () => {
    holdDiaryInput("screen-1");
    await expectThrow(
      "잠시 막는 동안 새 글은 거절된다",
      () => appendDiaryDurable("screen-1", { seq: 9, ts: 9, kind: "user_msg", text: "막힘" }),
      "전환",
    );
    check(!fs.existsSync(file), "거절된 글은 일기 파일을 만들지 않는다");
    releaseDiaryInput("screen-1");
  });

  const ev: AetherEvent = { seq: 3, ts: 3, kind: "user_msg", text: "셋째" };
  await appendDiaryDurable("screen-1", ev);
  check(!fs.existsSync(file), "새 글은 일기 파일을 만들지 않는다");
  const texts = readEventsSince("screen-1", 0).map((row) => userText(row));
  check(texts.join(",") === "첫째,둘째,셋째", "새 글은 표에서 화면으로 돌아온다", texts);

  await scenario("비밀번호 글도 그대로 저장하고 .env 이름도 저장한다", async () => {
    await appendDiaryDurable("pw-1", { seq: 1, ts: 1, kind: "user_msg", text: "password=hunter2" });
    const pwSaved = readEventsSince("pw-1", 0).map((ev) => userText(ev)).join("");
    check(pwSaved === "password=hunter2", "비밀번호가 들어 있는 글도 원문 그대로 저장된다", pwSaved);
    await appendDiaryDurable("env-1", {
      seq: 1,
      ts: 1,
      kind: "permission_request",
      req: { id: "p", toolName: "connect", input: { password: "DB_PASSWORD" }, toolUseID: "t", createdAt: 1 },
    });
    const saved = readEventsSince("env-1", 0)[0] as { kind?: string; req?: { input?: { password?: string } } } | undefined;
    const password = saved?.kind === "permission_request" ? saved.req?.input?.password ?? "" : "";
    check(password === "DB_PASSWORD", ".env 변수 이름은 저장한다", password);
  });

  await scenario("코드 안의 secret 단어도 새 글로 그대로 저장한다", async () => {
    await appendDiaryDurable("code-1", {
      seq: 1,
      ts: 1,
      kind: "notice",
      notice: "resumed",
      detail: "const secret = input as { file_path: true }",
    });
    const saved = readEventsSince("code-1", 0).map((ev) => JSON.stringify(ev)).join("\n");
    check(saved.includes("const secret = input as { file_path: true }"), "도구가 남긴 코드 단어는 새 글도 저장한다");
  });

  await scenario("데이터베이스에 없는 옛 일기 파일은 지우지 않고 오류로만 알린다", async () => {
    const left = writeDiary(diaryRoot, "old-1", `${line(1, "옛 대화")}\n`);
    const leftBytes = fs.readFileSync(left);
    const seen: string[] = [];
    setErrorJournal({
      record: async (_error: unknown, details: { operation?: string; session_id?: string }) => {
        seen.push(`${details.operation}:${details.session_id}`);
        return { id: "t", durable: true };
      },
    } as unknown as ErrorJournal);
    try {
      await loadSessionDiary("old-1", left);
      await loadSessionDiary("screen-1", file); // 표에 사건이 있고 파일이 없으면 알릴 것이 없다
    } finally {
      setErrorJournal(undefined);
    }
    check(fs.existsSync(left) && fs.readFileSync(left).equals(leftBytes), "옛 일기 파일은 그대로 남는다");
    check(readEventsSince("old-1", 0).length === 0, "옛 일기 파일은 읽어 들이지 않는다");
    check(seen.length === 1 && seen[0] === "session.diary.leftover_file:old-1", "남은 파일은 오류로 한 번 알린다", seen);
  });

  {
    const count = (db.prepare("SELECT count(*) AS n FROM session_event WHERE session_id = 'screen-1'").get() as { n: number }).n;
    const secret = (db.prepare("SELECT count(*) AS n FROM session_event WHERE line_text LIKE '%hunter2%'").get() as { n: number }).n;
    check(count === 3 && secret === 1 && !table("message"), "화면 세션 표에는 세 줄만 있고 비밀번호 글은 원문으로 한 줄 있고 칠판 표는 없다", count);
  }

  check(sha(searchFile) === searchBefore, "search.db는 지우지 않았다");

  check((fs.existsSync(LIVE_DB) ? sha(LIVE_DB) : null) === liveBefore, "이 시험이 운영 aether.sqlite를 바꾸지 않았다");
} finally {
  __resetSessionDiaryForTest();
  __resetCanonicalForTest();
  if (diaryRoot) {
    for (const name of fs.readdirSync(diaryRoot)) {
      const dir = path.join(diaryRoot, name);
      const file = path.join(dir, "events.jsonl");
      if (fs.existsSync(file)) {
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          /* 권한 복구 실패여도 아래 삭제를 시도한다 */
        }
      }
    }
    fs.rmSync(diaryRoot, { recursive: true, force: true });
  }
  tempDb?.dispose();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} session_diary_cutover: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
