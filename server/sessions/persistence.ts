import { FailureTracker } from "../providers/failureTracking";
import { reportError } from "../observability/report";
/**
 * 세션별 디스크 영속화.
 *   dataDir/<id>/meta.json — 세션 정보. 일기 파일을 지운 뒤에도 남긴다.
 *   dataDir/<id>/events.jsonl — 옛 일기 파일. 읽지도 쓰지도 지우지도 않는다(부팅 때 남은 것만 알린다).
 *
 * 사건은 SQLite 사건 표에 저장하고, 순번도 그 표에서 잇는다.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { sessionDiaryMode } from "../db/canonical";
import {
  appendDiaryBestEffort,
  diaryAcceptsInput,
  diaryHighSeq,
  insertDiary,
  closeDiaryGeneration,
  noteDiaryHighSeq,
  openDiaryGeneration,
  retireDiary,
  type DiaryGeneration,
} from "../db/sessionDiary";
import { database, transaction } from "../db/sqlite";
import { deleteLetterRows, deleteLetterSession } from "../db/sessionLetter";
import { removeSessionFromAudit } from "../db/searchAudit";
import { deleteSessionRows, eventRowsInSeqRange, eventRowsNewestFirst, eventRowsOfKindNewestFirst, eventRowsOfKinds, firstEventSeq, storedRowEvent } from "../db/sessionEvents";
import type { ProviderEventCodec } from "./codec/types";
import type { AetherEvent, SessionMeta } from "../types";

const failures = new FailureTracker();

export { diaryAcceptsInput };
export type RecordGeneration = DiaryGeneration;

function dir(id: string) {
  return path.join(config.dataDir, id);
}
function eventsFile(id: string) {
  return path.join(dir(id), "events.jsonl");
}
function metaFile(id: string) {
  return path.join(dir(id), "meta.json");
}
function seqHighFile(id: string) {
  return path.join(dir(id), "seq-high");
}

// 사건 저장 실패 뒤의 순번 보존도 디스크 장애 동안에는 첫 실패만 수집한다.
const highSeqWriteFailed = new Set<string>();

/** 공개한 뒤 저장에 실패한 순번. 폴더가 없으면 만들지 않는다. */
function readSeqHigh(id: string): number {
  try {
    const raw = fs.readFileSync(seqHighFile(id), "utf8").trim();
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) failures.file(new Error("세션 순번 파일 형식 손상"), { component: "session", operation: "session.sequence.read", session_id: id }, seqHighFile(id));
    else failures.recoveredFile(seqHighFile(id));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch (error) {
    failures.file(error, { component: "session", operation: "session.sequence.read", session_id: id }, seqHighFile(id));
    return 0;
  }
}

function writeSeqHigh(id: string, seq: number): void {
  if (!Number.isSafeInteger(seq) || seq <= 0) return;
  const folder = dir(id);
  if (!fs.existsSync(folder)) return;
  if (seq <= readSeqHigh(id)) return;
  const tmp = path.join(folder, "seq-high.tmp");
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, String(seq));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, seqHighFile(id));
  try {
    fs.chmodSync(seqHighFile(id), 0o600);
    failures.recoveredFile(seqHighFile(id));
  } catch (error) {
    failures.file(error, { component: "session", operation: "session.sequence.chmod", session_id: id }, seqHighFile(id));
  }
}

export function ensureSessionDir(id: string) {
  fs.mkdirSync(dir(id), { recursive: true, mode: 0o700 }); // 사용자 전용(같은 맥 타유저 차단)
}

export function appendEvent(id: string, ev: AetherEvent) {
  appendDiaryBestEffort(id, ev);
}

export function listDiarySources(): { id: string; jsonlPath: string }[] {
  return listSessionIds().map((id) => ({ id, jsonlPath: eventsFile(id) }));
}

/** 세션 디렉터리·파일 권한을 사용자 전용(dir 0700·파일 0600)으로 조이기 — 부팅 시 기존 0644 영속물 교정(best-effort). */
export function tightenSessionPerms(id: string) {
  try {
    fs.chmodSync(dir(id), 0o700);
    failures.recoveredFile(dir(id));
  } catch (error) {
    failures.file(error, { component: "session", operation: "session.directory.chmod", session_id: id }, dir(id));
  }
  for (const f of [eventsFile(id), metaFile(id)]) {
    try {
      fs.chmodSync(f, 0o600);
      failures.recoveredFile(f);
    } catch (error) {
      failures.file(error, { component: "session", operation: "session.file.chmod", session_id: id }, f);
    }
  }
}

/** seq > since 인 이벤트를 읽어 반환(메모리 버퍼 상한 밖 복원용). 사건 표에서 행을 흘려 읽는다. */
export function readEventsSince(id: string, since: number): AetherEvent[] {
  return eventsInRange(id, since + 1);
}

/** 지정한 종류의 이벤트만 파일 순서로 읽는다. 부팅 때 카드 판정처럼 종류만 필요한 곳이 쓴다. */
export function readEventsOfKinds(id: string, kinds: readonly string[]): AetherEvent[] {
  assertReadable(id);
  const out: AetherEvent[] = [];
  for (const row of eventRowsOfKinds(id, kinds)) out.push(storedRowEvent(row));
  return out;
}

/**
 * 최신 이벤트부터 거꾸로 하나씩 넘긴다. 호출부가 break하면 나머지는 읽지 않는다.
 * 화면 첫 진입이 꼬리 밖을 훑을 때 쓴다. 숨긴 순번 걸러내기는 호출부 몫이다.
 */
export function* eventsNewestFirst(id: string): Generator<AetherEvent> {
  assertReadable(id);
  for (const row of eventRowsNewestFirst(id)) yield storedRowEvent(row);
}

/** 첫 사용자 말 본문을 찾는다. 목록 자동 제목용이라 시작부터 훑고 첫 `user_msg`에서 멈춘다. */
export function firstUserMessageText(id: string): string | null {
  if (sessionDiaryMode() === "blocked") return null;
  assertReadable(id);
  for (const row of eventRowsOfKinds(id, ["user_msg"])) {
    const text = eventUserText(storedRowEvent(row));
    if (text) return text;
  }
  return null;
}

/** 사람이 마지막으로 글을 보낸 시각. 이 값이 저장되기 전에 만든 세션을 복원할 때 쓴다. */
export function lastUserInputTs(id: string): number | undefined {
  if (sessionDiaryMode() === "blocked") return undefined;
  assertReadable(id);
  for (const row of eventRowsOfKindNewestFirst(id, "user_msg")) {
    if (!(storedRowEvent(row) as { sentBy?: string }).sentBy) return row.ts;
  }
  return undefined;
}

/** 최신부터 64KB를 넘기는 첫 이벤트까지의 꼬리. 파일 순서로 돌려준다. */
export function readRecentEvents(id: string): AetherEvent[] {
  assertReadable(id);
  const budget = 64 * 1024;
  let size = 0;
  const out: AetherEvent[] = [];
  for (const row of eventRowsNewestFirst(id)) {
    out.push(storedRowEvent(row));
    size += row.byteLength + 1;
    if (size >= budget) break;
  }
  return out.reverse();
}

/**
 * 이전 페이지 읽기(무한스크롤): seq < before 인 이벤트 중
 *  - from 미지정: 최신 limit개(꼬리) — 위로 스크롤 페이징
 *  - from 지정: from ≤ seq < before 전 구간 — 검색 점프로 특정 seq까지 한 번에 채우기
 * hasOlder = 반환분보다 더 오래된 이벤트가 남아 있는지.
 */
export function readEventsPage(id: string, before: number, limit: number, from?: number): { events: AetherEvent[]; hasOlder: boolean } {
  assertReadable(id);
  let events: AetherEvent[];
  if (from == null) {
    events = [];
    for (const row of eventRowsNewestFirst(id, before)) {
      if (events.length >= limit) break;
      events.push(storedRowEvent(row));
    }
    events.reverse();
  } else {
    events = eventsInRange(id, from, before);
  }
  const first = events.length > 0 ? firstEventSeq(id) : null;
  const hasOlder = first !== null && first < events[0].seq;
  return { events, hasOlder };
}

/** 공개된 마지막 순번(재시작 후 seq 이어가기). 없으면 0. 저장된 최대 순번, 저장에 실패한 빈 번호, seq-high 파일 중 큰 값이다. */
export function lastSeqFromDisk(id: string): number {
  if (sessionDiaryMode() === "blocked") return 0;
  assertReadable(id);
  return Math.max(diaryHighSeq(id), readSeqHigh(id));
}

// 원자적 쓰기(temp+fsync+rename) — 매 턴 덮어쓰기 중 전원차단 시 resumeKey(이어가기 식별자) 통째 유실 방지.
export function saveMeta(meta: SessionMeta) {
  ensureSessionDir(meta.id);
  const f = metaFile(meta.id);
  const tmp = `${f}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600); // 사용자 전용 — rename이 mode 보존하므로 매 저장마다 meta.json도 0600로 교정
  try {
    fs.writeFileSync(fd, JSON.stringify(meta, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f); // 동일 FS rename(2)은 원자적
}

/**
 * 사건 꼬리 요약: 마지막 seq·마지막 status·미완 턴 여부.
 * ★ lastStatus는 *마지막 유효 이벤트가 status일 때만* 채운다(중간 status 무시) — 완료(completed) 후
 *   재개→중단으로 새 status 없이 끝난 세션을 'ended'로 오분류하던 결함 방지(restoreFromDisk 파생상태 정확화).
 * ★ turnOpen = 마지막 유효 이벤트가 '턴 진행 중'을 가리킴(종료 status·notice·턴 종료 이벤트가 아님).
 *   정상 턴은 provider의 턴 종료 이벤트로 끝나므로 turnOpen=false. 백엔드 재시작/크래시로 종료 이벤트 없이
 *   끊기면 true → restoreFromDisk가 합성 status:interrupted를 영속해 재연결 클라의 'running' 고착을 자동 해제한다.
 *
 * ⚠️ codec(D2.6): 턴 종료 판정을 스스로 하지 않고 호출부가 넘긴 codec에 맡긴다. 호출부는 `meta.json`의 provider로
 *   codec을 고른다(값이 없으면 claude — 무마이그레이션 호환). 이걸 Claude 규약으로 박아두면 Codex 세션
 *   재시작에서 가짜 interrupted 합성이나 미완 턴 오판이 난다.
 */
export function tailInfo(id: string, codec: ProviderEventCodec): { lastSeq: number; lastTs?: number; lastStatus?: string; lastNotice?: string; turnOpen: boolean } {
  if (sessionDiaryMode() === "blocked") {
    return { lastSeq: 0, turnOpen: false };
  }
  const tail = tailFromEvents(eventsNewestFirst(id), codec);
  tail.lastSeq = Math.max(tail.lastSeq, diaryHighSeq(id), readSeqHigh(id));
  return tail;
}

/**
 * meta.json 읽기 — **구 meta 승격의 유일한 자리**(D12).
 * 8d-1 이전 파일에는 `resumeKey`가 없고 `sdkSessionId`만 있다. 여기서 `resumeKey`로 올려주고 옛 이름은
 * 걷어내므로, 코어 로직은 provider 프로토콜 용어(`sdkSessionId`)를 보지 않는다. 쓰기는 항상 새 이름으로만
 * 나가고(`saveMeta`), 마이그레이션 스크립트는 없다 — 기존 세션은 처음 저장될 때 자연히 새 이름이 된다.
 */
function promoteMeta(raw: SessionMeta): SessionMeta {
  const { sdkSessionId, skipPermissions, ...rest } = raw;
  // 옛 skipPermissions: true는 full, 그 밖(false·없음)은 manual로 읽는다. 자동으로 올리지 않는다.
  const permissionMode = raw.permissionMode ?? (skipPermissions === true ? "full" : "manual");
  return { ...rest, permissionMode, ...(raw.resumeKey ?? sdkSessionId ? { resumeKey: raw.resumeKey ?? sdkSessionId } : {}) };
}

/** 손으로 고친 파일이나 사고로 칸 형태가 틀어진 meta를 읽는 순간 걸러, 뒤의 문자열 처리가 한 세션 때문에 던지지 않게 한다. */
function assertMetaShape(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("meta.json 형식이 객체가 아니다");
  for (const k of ["name", "generatedName", "cwd", "model", "provider"]) {
    const v = (raw as Record<string, unknown>)[k];
    if (v != null && typeof v !== "string") throw new Error(`meta.json의 ${k} 칸이 문자열이 아니다`);
  }
}

export function loadMeta(id: string, strict = false): SessionMeta | null {
  const f = metaFile(id);
  if (!fs.existsSync(f)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(f, "utf8"));
    assertMetaShape(parsed);
    const meta = promoteMeta(parsed as SessionMeta);
    failures.recoveredFile(f);
    return meta;
  } catch (error) {
    if (!strict) failures.file(error, { component: "session", operation: "session.metadata.read", session_id: id }, f);
    // 복원 경로는 정상 부재와 실제 읽기·해석 실패를 구분한다. 기존 조회 호출의 반환 계약은 유지한다.
    if (strict) throw error;
    return null;
  }
}

/** dataDir 전체 바이트 크기(재귀 합산, best-effort). 진단 표시용 — 실패 파일은 skip. */
export function dataDirBytes(): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      failures.file(error, { component: "session", operation: "session.storage.scan" }, dir);
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch (error) {
        failures.file(error, { component: "session", operation: "session.storage.stat" }, p);
        /* 삭제 경합 등 — skip */
      }
    }
  };
  if (fs.existsSync(config.dataDir)) walk(config.dataDir);
  return total;
}

const DIARY_READ_ERROR = "일기 데이터베이스를 읽을 수 없다. 파일로 되돌리지 않는다";

function eventUserText(ev: AetherEvent): string | null {
  if (ev.kind !== "user_msg") return null;
  const text = (ev as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text : null;
}

function eventStatus(ev: AetherEvent): string | undefined {
  if (ev.kind !== "status") return undefined;
  const status = (ev as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

/** 기록기 한 세대. 데이터베이스가 닫혀 있으면 표지만 만든다. */
export function openRecordGeneration(id: string): RecordGeneration {
  if (sessionDiaryMode() === "sqlite") return openDiaryGeneration(id);
  return { token: 0, closed: false };
}

/** 이 세대를 닫는다. 세션 ID를 영구히 막지는 않는다. */
export function closeRecordGeneration(id: string, gen: RecordGeneration): void {
  if (sessionDiaryMode() === "sqlite") {
    closeDiaryGeneration(id, gen);
    return;
  }
  gen.closed = true;
}

/** 데이터베이스에 동기로 쓴다. 실패하면 던진다. */
export function insertEventRow(id: string, ev: AetherEvent, gen?: RecordGeneration): void {
  insertDiary(id, ev, gen);
}

/** 저장에 실패한 순번을 다시 쓰지 않게 기억한다. 메모리 상한(일기 상한)을 파일보다 먼저 올린다. 폴더가 없으면 파일을 만들지 않는다. 파일 기록 실패는 삼킨다. */
export function noteHighSeq(id: string, seq: number, gen?: RecordGeneration): void {
  noteDiaryHighSeq(id, seq);
  try {
    writeSeqHigh(id, seq);
    highSeqWriteFailed.delete(id);
  } catch (err) {
    if (!highSeqWriteFailed.has(id)) void reportError(err, { component: "database", operation: "session.sequence.persist", session_id: id, session_seq: seq });
    highSeqWriteFailed.add(id);
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[aether] 순번 상한 기록 실패:", msg.includes("://") || msg.includes("@") ? "기록 실패" : msg);
  }
}

/** 지운 세션의 늦은 저장을 막는다. */
export function retireSessionRecord(id: string): void {
  highSeqWriteFailed.delete(id);
  retireDiary(id);
}

function assertReadable(id: string): void {
  if (!diaryAcceptsInput(id)) throw new Error(DIARY_READ_ERROR);
}

function eventsInRange(id: string, from: number, before?: number): AetherEvent[] {
  assertReadable(id);
  const out: AetherEvent[] = [];
  for (const row of eventRowsInSeqRange(id, from, before)) out.push(storedRowEvent(row));
  return out;
}

function tailFromEvents(
  newestFirst: Iterable<AetherEvent>,
  codec: ProviderEventCodec,
): { lastSeq: number; lastTs?: number; lastStatus?: string; lastNotice?: string; turnOpen: boolean } {
  let lastSeq = 0;
  let lastTs: number | undefined;
  let lastStatus: string | undefined;
  let lastNotice: string | undefined;
  let turnOpen = false;
  for (const ev of newestFirst) {
    if (lastSeq === 0 && typeof ev.seq === "number") {
      lastSeq = ev.seq;
      if (typeof ev.ts === "number") lastTs = ev.ts;
    }
    // ctx와 옛 브리프 사건은 턴을 열지도 닫지도 않는다. 그 앞 사건으로 판정한다.
    if (ev.kind === "ctx" || (ev.kind as string) === "brief_opened" || (ev.kind as string) === "brief_updated") continue;
    if (codec.isTurnNeutral?.(ev)) continue;
    const status = eventStatus(ev);
    if (status) lastStatus = status;
    if (ev.kind === "notice") lastNotice = (ev as { notice?: string }).notice;
    const closed = ev.kind === "status" || ev.kind === "notice" || codec.endsTurn(ev);
    turnOpen = lastSeq > 0 && !closed;
    break;
  }
  return { lastSeq, lastTs, lastStatus, lastNotice, turnOpen };
}

export function listSessionIds(): string[] {
  if (!fs.existsSync(config.dataDir)) return [];
  return fs
    .readdirSync(config.dataDir, { withFileTypes: true })
    // 세션 디렉토리만 = meta.json 또는 events.jsonl을 가진 dir. dot-dir(.trash-*)·내부 폴더(memory 등)·
    // 잡파일(search.db·activity.json)을 제외 — 비세션이 corrupted 카드로 오표시되는 것 차단.
    // (UUID 형식 대신 내용으로 판별 → 향후 내부 디렉토리가 늘어도 견고. 실제 세션 id는 UUID지만 여기선 무관.)
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        (fs.existsSync(path.join(config.dataDir, d.name, "meta.json")) ||
          fs.existsSync(path.join(config.dataDir, d.name, "events.jsonl"))),
    )
    .map((d) => d.name);
}

/**
 * 세션 디렉터리 전체 영구 삭제(되돌릴 수 없음). dataDir *직속 하위*만 허용 — 경로 traversal 차단.
 * id는 호출부(SessionManager.delete)에서 UUID로 검증된다(여기선 방어적 경계 재확인). 없으면 false.
 *
 * ★ 부활 방지(2026-06-18 버그): 먼저 .trash-* 로 *원자적 rename* → 그 후 rm.
 *   list()는 메모리 맵만 읽어 삭제 즉시 UI에서 사라지지만, rm이 부분 실패하면 dir가 남아 다음 재시작 때
 *   restoreFromDisk가 부활시켰다. rename은 원자적이라 성공 즉시 UUID dir가 없어져(listSessionIds 제외) 부활 불가.
 *   남은 .trash-* 는 다음 부팅의 purgeTrash가 청소(rm 미완분). 제거 성공으로 간주되면 true.
 */
export function deleteSession(id: string): boolean {
  const root = path.resolve(config.dataDir);
  const target = path.resolve(dir(id));
  if (target !== path.join(root, id) || !target.startsWith(root + path.sep)) return false; // dataDir 직속만
  if (!fs.existsSync(target)) return false;
  const trash = path.join(root, `.trash-${id}-${Date.now()}`);
  try {
    fs.renameSync(target, trash); // 원자적 — 성공 즉시 세션 dir 소멸(부활 불가). 같은 FS라 rename(2).
  } catch {
    // rename 실패(드묾) → 직접 rm 폴백. 제거됐는지 검증해 반환(미완이면 false로 호출부가 경고).
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* rm 실패 → 아래 존재검사가 false 반환 */
    }
    return !fs.existsSync(target);
  }
  try {
    fs.rmSync(trash, { recursive: true, force: true });
  } catch {
    /* trash rm 미완 — 부팅 시 purgeTrash가 청소. 세션은 이미 부활 불가라 성공 처리 */
  }
  return true;
}

/**
 * 지운 세션의 DB 기록을 지운다. 세션 폴더가 이미 없을 때만 부른다(폴더가 남았는데 행을 지우면 부활한 세션이 빈 채로 열린다).
 * withLetters면 글자·FTS·재생성 기록·감사 표의 항목까지 지우고, 아니면 deleteEvents일 때 사건 행과 커서만 지운다.
 * 실패하면 던진다. 호출자가 사용자에게 알리고, 같은 세션 id로 삭제 요청을 다시 보내면 남은 행이 지워진다(화면에는 지운 세션이 없어 지금은 API로만 된다).
 * shortcut: 폴더 이름 바꾸기와 이 트랜잭션 사이에 프로세스가 죽으면 글자와 원본이 남는다. 지운 세션이라 목록에는 안 보인다. 원본은 정리 도구가 지우지만 글자는 같은 id로 완전 삭제를 다시 요청해야 지워진다.
 */
export function purgeSessionRecord(id: string, withLetters: boolean, deleteEvents = true): void {
  if (fs.existsSync(dir(id))) throw new Error("세션 폴더가 남아 있어 기록을 지우지 않았다");
  if (!withLetters && !deleteEvents) return;
  const db = database();
  transaction(db, () => {
    deleteSessionRows(db, id);
    if (withLetters) {
      deleteLetterRows(db, id);
      removeSessionFromAudit(db, id);
    }
  });
  if (withLetters) void deleteLetterSession(id).catch((err) => reportError(err, { component: "database", operation: "session.letter.purge", session_id: id }));
}

/** 부팅 시 이전 삭제의 .trash-* 잔재 정리(rm 미완분). best-effort — 실패해도 세션 동작 무관. */
export function purgeTrash(): void {
  if (!fs.existsSync(config.dataDir)) return;
  let names: string[];
  try {
    names = fs.readdirSync(config.dataDir);
  } catch (error) {
    failures.file(error, { component: "session", operation: "session.trash.list" }, config.dataDir);
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".trash-")) continue;
    try {
      fs.rmSync(path.join(config.dataDir, name), { recursive: true, force: true });
    } catch {
      /* 잔재 청소 실패 — 다음 부팅 재시도 */
    }
  }
}
