/**
 * 작업 검토함 라우트(인증 게이트 뒤).
 *   GET  /api/review               끝난 세션 중 검토할 것이 있는 목록(기록만 읽고 git은 부르지 않는다)
 *   GET  /api/review/recap?project=  같은 프로젝트(폴더)의 최근 세션 5개 요약(새 세션 빈 화면용)
 *   GET  /api/review/trace?session=&path=  그 파일을 고친 같은 프로젝트의 세션 기록(최신이 위)
 *   GET  /api/review/:id[?git=0]   상세. git 상태는 ?git=0이면 건너뛴다
 *   GET  /api/review/:id/diff?path=  바뀐 파일 하나의 변경 내용(기록 → 없으면 커밋 안 된 git 변경). path는 요약의 바뀐 파일 목록에 든 값만
 *   POST /api/review/:id/done      { seq }  검토 완료 위치 저장
 *   POST /api/review/:id/undo      { seq? } 이전 위치로 되돌림(없으면 지움)
 *   POST /api/review/:id/request   { provider } 다른 AI에게 검토 맡기기 — 같은 폴더에 수동 권한 새 세션을 열고 검토 요청 글을 초안으로 넣는다(모델 호출 없음). 201 {id}
 * 요약은 AI 없이 저장된 기록(중립 사건)에서만 모은다. 경로는 diff 주소에서만 받고, 그것도 요약의 바뀐 파일 목록에 든 값만 허용한다(그 밖의 경로는 읽지 않는다).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { AgentEvent } from "../../shared/agentEvent";
import type { FileTraceEntry, FileTraceResponse, ProjectRecapResponse, ProjectRecapSession, ReviewDetailResponse, ReviewFileDiffResponse, ReviewLeftover, ReviewListResponse, ReviewMarkResponse, ReviewRequestResponse, ReviewRow, ReviewSessionHead, ReviewSummary } from "../../shared/brain";
import { st } from "../i18n";
import { reportResponseError, rejectRequest } from "../observability/http";
import { folderFileDiffAsync, folderGrepAsync, folderReviewStateAsync, folderUncommittedChanges, isGitRepo, isolatedWorkspaceExists, type FolderReviewState } from "../sessions/isolatedWorkspace";
import { lastSeqFromDisk, readEventsPage } from "../sessions/persistence";
import { isHiddenSeq } from "../sessions/rewind";
import { sessionManager } from "../sessions/SessionManager";
import { summarizeReview } from "../sessions/reviewSummary";
import { recentUserTexts } from "../sessions/handoff";
import { reviewRequestText } from "../sessions/reviewRequest";
import { listProviders, providerAvailability } from "../providers/registry";
import { deletedFileStems, removedDefinitions } from "../sessions/reviewLeftovers";
import { createFileTouches, type FileTouch } from "../sessions/fileTrace";
import { isSensitivePath, resolveFileUnderCwd, resolveWorkFolder } from "../sessions/safePath";
import { fileEditPreview } from "../sessions/fileEdits";
import { canonPath, isSecretTarget } from "../sessions/workspaceFiles";
import type { FileEdit } from "../sessions/codec/types";
import type { MutationPreview } from "../../shared/http";

export const reviewRouter = Router();

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 30;
const MAX_SCAN = 100; // 비어서 빠지는 세션까지 포함해 훑는 최대 수
const MAX_EVENTS = 5000;
const MAX_UNRECORDED = 200;
const GIT_TIMEOUT_MS = 10_000;
const CACHE_MAX = 200;

type Computed = { summary: ReviewSummary; lastSeq: number; partial: boolean };

// 같은 (세션, 검토 위치, 마지막 순번)은 다시 계산하지 않는다. 가장 오래된 것부터 밀어낸다.
const cache = new Map<string, Computed>();

/** 검토 위치 이후의 원본 사건을 읽는다(숨긴 구간 제외, 최대 MAX_EVENTS건). 요약과 파일 diff가 같은 범위를 본다. */
function readRange(id: string, reviewedSeq: number, diskLast: number) {
  const page = readEventsPage(id, diskLast + 1, MAX_EVENTS);
  const ranges = sessionManager.hiddenRangesOf(id);
  const codec = sessionManager.codecOf(id);
  const raw = page.events.filter((ev) => ev.seq > reviewedSeq && (!ranges.length || !isHiddenSeq(ev.seq, ranges)));
  const first = page.events[0]?.seq ?? 0;
  return { page, codec, raw, partial: page.hasOlder && first > reviewedSeq + 1 };
}

function compute(id: string, reviewedSeq: number): Computed {
  const diskLast = lastSeqFromDisk(id);
  const key = `${id}:${reviewedSeq}:${diskLast}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { page, codec, raw, partial } = readRange(id, reviewedSeq, diskLast);
  const events: AgentEvent[] = raw.flatMap((ev) => codec.normalize(ev));
  const out: Computed = {
    summary: summarizeReview(events),
    lastSeq: Math.max(diskLast, page.events[page.events.length - 1]?.seq ?? 0),
    partial,
  };
  cache.set(key, out);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return out;
}

type Item = ReturnType<typeof sessionManager.list>[number];

function head(item: Item, c: Computed): ReviewSessionHead {
  const projectPath = item.workspaceSource || item.cwd;
  return {
    id: item.id,
    title: item.displayName,
    projectPath,
    projectName: path.basename(projectPath) || projectPath,
    cwd: item.cwd,
    lastActivityAt: item.lastActivityAt ?? item.createdAt,
    lastSeq: c.lastSeq,
    partial: c.partial,
  };
}

reviewRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const since = Date.now() - WINDOW_MS;
    const busy = new Set(["running", "waiting", "background"]);
    const candidates = sessionManager
      .list()
      .filter((s) => !s.archivedAt && !busy.has(s.attention ?? "idle") && (s.lastActivityAt ?? s.createdAt) >= since)
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
      .slice(0, MAX_SCAN);
    const rows: ReviewRow[] = [];
    for (const item of candidates) {
      if (rows.length >= MAX_ROWS) break;
      try {
        const c = compute(item.id, sessionManager.reviewedSeqOf(item.id) ?? 0);
        const { changedFiles, failedCommands, openTodos, turnFailed } = c.summary;
        // 도중에 실패한 명령(otherFailures)은 목록에 올리는 이유도, 먼저 볼 이유도 아니다.
        const needsAttention = failedCommands.length > 0 || openTodos.length > 0 || !!turnFailed;
        if (!changedFiles.length && !needsAttention) continue;
        rows.push({
          ...head(item, c),
          fileCount: changedFiles.length,
          failureCount: failedCommands.length,
          todoCount: openTodos.length,
          needsAttention,
          ...(turnFailed ? { turnFailed } : {}),
        });
      } catch (error) {
        // 읽을 수 없는 세션 하나가 목록 전체를 막지 않는다.
        void reportResponseError(res, error, { component: "routes", operation: "review.session.summarize", session_id: item.id });
      }
      await new Promise((r) => setImmediate(r)); // 콜드 계산이 길어도 다른 요청이 끼어들게 한다
    }
    const body: ReviewListResponse = { rows };
    res.json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "review.list" });
    res.status(500).json({ error: st("routes.review.readFailed") });
  }
});

async function gitState(cwd: string, files: string[]): Promise<FolderReviewState | null> {
  if (!isolatedWorkspaceExists(cwd)) return null;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), GIT_TIMEOUT_MS).unref());
  return Promise.race([folderReviewStateAsync(cwd, files), timeout]);
}

// 대체 수단(git)도 같은 제한 시간 안에서만 기다린다.
async function gitFileDiff(cwd: string, abs: string): Promise<MutationPreview | null> {
  if (!isolatedWorkspaceExists(cwd)) return null;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), GIT_TIMEOUT_MS).unref());
  return Promise.race([folderFileDiffAsync(cwd, abs), timeout]);
}

reviewRouter.get("/:id/diff", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!SESSION_ID_RE.test(id) || (!sessionManager.get(id) && !sessionManager.hasDiskSession(id))) {
    return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
  }
  try {
    const item = sessionManager.list().find((s) => s.id === id);
    if (!item) return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
    const want = req.query.path;
    const reviewedSeq = sessionManager.reviewedSeqOf(id) ?? 0;
    // 요약이 말한 바뀐 파일만 읽는다. 임의 경로(절대·상위 경로 포함)는 목록과 정확히 같지 않으면 거절한다.
    if (typeof want !== "string" || !compute(id, reviewedSeq).summary.changedFiles.some((f) => f.path === want)) {
      return rejectRequest(res, 400, { error: st("routes.review.pathInvalid") });
    }
    const { codec, raw, partial } = readRange(id, reviewedSeq, lastSeqFromDisk(id));
    const done = (source: ReviewFileDiffResponse["source"], edits: MutationPreview[]) => {
      const body: ReviewFileDiffResponse = { path: want, source, edits, partial };
      res.json(body);
    };
    const target = path.resolve(item.cwd, want);
    const real = canonPath(target);
    // 비밀 판정은 요청 글자만 보지 않는다: 링크를 푼 실제 경로, 저장소 내부(.git), 이름이 바뀐 쪽의 경로도 본다.
    const secret = (p: string) => isSecretTarget(item.cwd, p);
    const redacted = () => done("record", [{ kind: "edit", path: want, redacted: true }]);
    if (secret(want)) return redacted();

    // 같은 도구 호출의 뒤 사건이 앞 사건의 내용을 통째로 대체한다(시작·완료가 둘 다 내용을 싣는 경우). 처음 나온 순서는 유지한다.
    const byTool = new Map<string, FileEdit[]>();
    for (const ev of raw) {
      const group = new Map<string, FileEdit[]>();
      for (const e of codec.fileEdits(ev)) group.set(e.toolId, [...(group.get(e.toolId) ?? []), e]);
      for (const [toolId, edits] of group) byTool.set(toolId, edits);
    }
    // 실패한 도구 호출은 뺀다(요약과 같은 기준: 같은 id의 마지막 결과).
    const failed = new Map<string, boolean>();
    for (const e of raw.flatMap((ev) => codec.normalize(ev))) if (e.type === "tool_result") failed.set(e.toolId, e.isError === true);
    const mine = [...byTool.values()].flat().filter((e) => [e.path, e.movePath].some((p) => p && path.resolve(item.cwd, p) === target));
    // 이름을 바꾼 쪽 중 하나라도 비밀이면 어느 쪽 이름으로 물어도 내용을 주지 않는다(실패한 호출 포함 — 보수적으로).
    if (mine.some((e) => [e.path, e.movePath].some((p) => p && secret(p)))) return redacted();
    const previews = mine.filter((e) => failed.get(e.toolId) !== true).map((e) => fileEditPreview(e, want));
    const usable = previews.filter((p) => p.hunks?.length || p.truncated);
    if (previews.some((p) => p.hunks?.length)) return done("record", usable);

    // 기록에 쓸 만한 내용이 없으면 커밋 안 된 변경을 대신 보여 준다.
    const fromGit = await gitFileDiff(item.cwd, real);
    if (fromGit && (fromGit.hunks?.length || fromGit.truncated || fromGit.binary)) return done("git", [{ ...fromGit, path: want }]);
    done("none", usable);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "review.diff", session_id: id });
    res.status(500).json({ error: st("routes.review.readFailed") });
  }
});

const RECAP_SESSIONS = 5;
const RECAP_CANDIDATES = 20;
const TRACE_SESSIONS = 100;
const TRACE_ENTRIES = 50;
const TRACE_BUDGET_MS = 8000;
const TRACE_PAGE = 2000;

/** 끝 슬래시만 걷어 같은 글자인지 본다(web/src/lib/sessionGroups.ts와 같은 규칙). */
const projectOf = (item: Item) => (item.workspaceSource || item.cwd || "").trim().replace(/\/+$/, "") || (item.workspaceSource || item.cwd || "").trim();

export function recapState(item: Item, s: ReviewSummary): ProjectRecapSession["state"] {
  const att = item.attention ?? "idle";
  if (att === "running" || att === "background") return "running";
  if (att === "waiting") return "waiting";
  if (att === "failed" || s.turnFailed === "failed") return "failed";
  if (s.turnFailed === "interrupted") return "interrupted";
  return "done";
}

reviewRouter.get("/recap", async (req: Request, res: Response) => {
  const project = req.query.project;
  if (typeof project !== "string" || !project.trim()) return rejectRequest(res, 400, { error: st("routes.review.pathInvalid") });
  try {
    const want = project.trim().replace(/\/+$/, "") || project.trim();
    const candidates = sessionManager
      .list()
      .filter((s) => !s.archivedAt && projectOf(s) === want)
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
      .slice(0, RECAP_CANDIDATES);
    const sessions: ProjectRecapSession[] = [];
    for (const item of candidates) {
      if (sessions.length >= RECAP_SESSIONS) break;
      try {
        const c = compute(item.id, 0);
        const s = c.summary;
        if (!s.lastPrompt) continue;
        const err = s.turnError ?? s.failedCommands[s.failedCommands.length - 1];
        sessions.push({
          id: item.id,
          title: item.displayName,
          lastActivityAt: item.lastActivityAt ?? item.createdAt,
          lastSeq: c.lastSeq,
          state: recapState(item, s),
          lastPrompt: s.lastPrompt,
          ...(err ? { lastError: { text: err.text, seq: err.seq } } : {}),
          recentFiles: s.changedFiles.slice(-3),
          openTodos: s.openTodos.slice(0, 5),
        });
      } catch (error) {
        void reportResponseError(res, error, { component: "routes", operation: "review.recap.session", session_id: item.id });
      }
      await new Promise((r) => setImmediate(r));
    }
    const body: ProjectRecapResponse = { sessions };
    res.json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "review.recap" });
    res.status(500).json({ error: st("routes.review.readFailed") });
  }
});

// 세션 하나의 "파일 → 고친 턴" 지도. 칸은 세션 id 하나이고 마지막 순번이 같으면 다시 훑지 않는다(다르면 덮어쓴다).
//   열쇠 규칙은 세션의 cwd·workspaceSource에만 달려 있어 값에 넣지 않는다.
const traceCache = new Map<string, { lastSeq: number; map: Map<string, FileTouch[]> }>();

/**
 * 세션 기록을 오래된 것부터 2,000건씩 읽어 파일별로 고친 턴을 모은다. 숨긴 구간은 뺀다.
 * 경로 열쇠: 기록의 경로를 세션 cwd 기준 절대 경로로 풀고, 복사본 세션이면 cwd 아래를 원본 폴더 아래로 옮긴 뒤 실제 경로로 푼다.
 * shortcut: 사용자가 저장소의 하위 폴더를 골라 복사본을 만든 세션은 옮긴 경로가 어긋날 수 있다. 어긋나면 그 세션의 기록은 이 파일에서 안 보인다.
 */
function traceKeyOf(item: Item): (p: string) => string {
  const cwd = path.resolve(item.cwd);
  const source = item.workspaceSource && path.resolve(item.workspaceSource) !== cwd ? path.resolve(item.workspaceSource) : null;
  return (p) => {
    const abs = path.resolve(item.cwd, p);
    return canonPath(source && abs.startsWith(cwd + path.sep) ? path.join(source, abs.slice(cwd.length + 1)) : abs);
  };
}

/** 제한 시간(deadline) 안에 다 못 읽으면 지금까지 모은 것과 complete:false를 주고 캐시에 넣지 않는다. */
async function traceOf(item: Item, deadline: number): Promise<{ map: Map<string, FileTouch[]>; complete: boolean }> {
  const diskLast = lastSeqFromDisk(item.id);
  const hit = traceCache.get(item.id);
  if (hit && hit.lastSeq === diskLast) return { map: hit.map, complete: true };
  const touches = createFileTouches(traceKeyOf(item));
  const codec = sessionManager.codecOf(item.id);
  const ranges = sessionManager.hiddenRangesOf(item.id);
  for (let from = 1; from <= diskLast; from += TRACE_PAGE) {
    if (from > 1) {
      await new Promise((r) => setImmediate(r)); // 긴 기록도 2,000건마다 다른 요청에 차례를 넘긴다
      if (Date.now() > deadline) return { map: touches.result(), complete: false };
    }
    const page = readEventsPage(item.id, from + TRACE_PAGE, TRACE_PAGE, from);
    for (const ev of page.events) {
      if (ranges.length && isHiddenSeq(ev.seq, ranges)) continue;
      for (const e of codec.normalize(ev)) touches.add(e);
    }
  }
  const out = touches.result();
  traceCache.set(item.id, { lastSeq: diskLast, map: out });
  if (traceCache.size > CACHE_MAX) traceCache.delete(traceCache.keys().next().value as string);
  return { map: out, complete: true };
}

reviewRouter.get("/trace", async (req: Request, res: Response) => {
  const id = req.query.session;
  const want = req.query.path;
  if (typeof id !== "string" || !SESSION_ID_RE.test(id) || typeof want !== "string" || !want) {
    return rejectRequest(res, 400, { error: st("routes.review.pathInvalid") });
  }
  const origin = sessionManager.list().find((s) => s.id === id);
  if (!origin) return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
  try {
    // /api/files와 같은 경계·비밀 검사. 폴더 밖이면 거절하고 비밀 파일이면 빈 결과다. 응답에 서버 절대 경로를 싣지 않는다.
    let real: string;
    try {
      real = resolveFileUnderCwd(fs.realpathSync(origin.cwd), want).real;
    } catch {
      return rejectRequest(res, 400, { error: st("routes.files.pathInvalid") });
    }
    const empty: FileTraceResponse = { path: want, entries: [], partial: false };
    if (isSecretTarget(origin.cwd, want) || isSecretTarget(origin.cwd, real) || isSensitivePath(real)) return res.json(empty);
    const target = traceKeyOf(origin)(want); // 경계는 real로 이미 확인했다. 열쇠는 기록 쪽과 같은 규칙으로 want에서 만든다
    const project = projectOf(origin);
    const items = sessionManager
      .list()
      .filter((s) => projectOf(s) === project)
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
      .slice(0, TRACE_SESSIONS);
    const deadline = Date.now() + TRACE_BUDGET_MS;
    const entries: FileTraceEntry[] = [];
    let partial = false;
    for (const item of items) {
      if (Date.now() > deadline) { partial = true; break; }
      try {
        const traced = await traceOf(item, deadline);
        if (!traced.complete) partial = true;
        for (const t of traced.map.get(target) ?? []) {
          entries.push({ sessionId: item.id, title: item.displayName, at: t.at, seq: t.seq, ...(t.prompt ? { prompt: t.prompt } : {}), commands: t.commands });
        }
      } catch (error) {
        void reportResponseError(res, error, { component: "routes", operation: "review.trace.session", session_id: item.id });
      }
      await new Promise((r) => setImmediate(r)); // 다른 요청에 차례를 넘긴다
    }
    entries.sort((a, b) => b.at - a.at);
    const body: FileTraceResponse = { path: want, entries: entries.slice(0, TRACE_ENTRIES), partial };
    res.json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "review.trace", session_id: id });
    res.status(500).json({ error: st("routes.review.readFailed") });
  }
});

/** 이 세션이 성공시킨 파일 수정 조각(순번 포함)과 셸 명령 글. 지운 이름 찾기가 쓴다. */
function sessionWork(id: string, reviewedSeq: number) {
  const { codec, raw } = readRange(id, reviewedSeq, lastSeqFromDisk(id));
  const failed = new Map<string, boolean>();
  const commands: string[] = [];
  for (const e of raw.flatMap((ev) => codec.normalize(ev))) {
    if (e.type === "tool_result") failed.set(e.toolId, e.isError === true);
    else if (e.type === "tool_call" && e.toolKind === "bash" && e.target) commands.push(e.target);
  }
  // 같은 도구 호출의 뒤 사건이 앞 사건의 내용을 통째로 대체한다.
  const byTool = new Map<string, (FileEdit & { seq: number })[]>();
  for (const ev of raw) {
    const group = new Map<string, (FileEdit & { seq: number })[]>();
    for (const e of codec.fileEdits(ev)) group.set(e.toolId, [...(group.get(e.toolId) ?? []), { ...e, seq: ev.seq }]);
    for (const [toolId, edits] of group) byTool.set(toolId, edits);
  }
  const edits = [...byTool].filter(([toolId]) => failed.get(toolId) !== true).flatMap(([, v]) => v);
  return { edits, commands };
}

/** 지운 파일·정의의 이름이 저장소에 아직 남은 곳. git 상태를 읽은 경우에만 부른다. */
async function leftoversOf(item: Item, id: string, files: string[], state: FolderReviewState): Promise<{ leftovers: ReviewLeftover[]; incomplete: boolean }> {
  const { edits, commands } = sessionWork(id, sessionManager.reviewedSeqOf(id) ?? 0);
  const stems = deletedFileStems(state.deleted, files, commands);
  const defs = removedDefinitions(edits).filter((d) => !stems.includes(d.name));
  const found = await folderGrepAsync(item.cwd, [...stems, ...defs.map((d) => d.name)], (rel) => isSecretTarget(item.cwd, rel));
  if (!found) return { leftovers: [], incomplete: false };
  const leftovers: ReviewLeftover[] = [
    ...stems.map((name): ReviewLeftover => ({ name, from: "file", hits: found.hits.get(name) ?? [] })),
    ...defs.map((d): ReviewLeftover => ({ name: d.name, from: "definition", ...(d.seq !== undefined ? { seq: d.seq } : {}), hits: found.hits.get(d.name) ?? [] })),
  ].filter((l) => l.hits.length > 0);
  return { leftovers, incomplete: found.incomplete };
}

reviewRouter.get("/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!SESSION_ID_RE.test(id) || (!sessionManager.get(id) && !sessionManager.hasDiskSession(id))) {
    return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
  }
  try {
    const item = sessionManager.list().find((s) => s.id === id);
    if (!item) return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
    const c = compute(id, sessionManager.reviewedSeqOf(id) ?? 0);
    const base = { ...head(item, c), ...c.summary };
    const skipGit = req.query.git === "0";
    // 기록의 경로와 저장소 경로는 실제 경로로 풀어 비교한다(맥의 /var와 /private/var 차이).
    const files = c.summary.changedFiles.map((f) => canonPath(path.resolve(item.cwd, f.path)));
    const cwdReal = canonPath(item.cwd);
    const tmpRoots = [os.tmpdir(), "/tmp"].map(canonPath);
    const under = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
    const outsideFiles = c.summary.changedFiles.filter((_, i) => !under(files[i], cwdReal) && !tmpRoots.some((r) => under(files[i], r))).map((f) => f.path);
    const state = skipGit ? null : await gitState(item.cwd, files);
    if (!state) {
      const body: ReviewDetailResponse = { ...base, git: skipGit ? "skipped" : "unavailable", fileStates: [], unrecorded: [], outsideFiles, leftovers: [] };
      return res.json(body);
    }
    const dirty = state.dirty.map(canonPath);
    const covers = (g: string, f: string) => g === f || (g.endsWith("/") && f.startsWith(g));
    const left = await leftoversOf(item, id, files, state);
    const unrecorded = dirty
      .filter((g) => !files.some((f) => covers(g, f)))
      .slice(0, MAX_UNRECORDED)
      .map((g) => (g.startsWith(cwdReal + path.sep) ? g.slice(cwdReal.length + 1) : g));
    const body: ReviewDetailResponse = {
      ...base,
      git: "ok",
      fileStates: files.map((f) => {
        if (dirty.some((g) => covers(g, f))) return "uncommitted";
        // 저장소 밖이거나 무시된 파일(또는 무시 여부를 못 읽은 경우)은 "변경 없음"이라 단정하지 않는다.
        return f.startsWith(state.root + path.sep) && state.ignored && !state.ignored.has(f) ? "clean" : "unknown";
      }),
      unrecorded,
      outsideFiles,
      leftovers: left.leftovers,
      ...(left.incomplete ? { leftoversIncomplete: true as const } : {}),
    };
    res.json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "review.detail", session_id: id });
    res.status(500).json({ error: st("routes.review.readFailed") });
  }
});

/** 본문 seq가 0 이상의 정수이고 세션의 마지막 순번 이하인지. 아니면 null. */
function validSeq(raw: unknown, id: string): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return raw <= lastSeqFromDisk(id) ? raw : null;
}

function mark(kind: "done" | "undo") {
  return (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!SESSION_ID_RE.test(id) || (!sessionManager.get(id) && !sessionManager.hasDiskSession(id))) {
      return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
    }
    const raw = (req.body ?? {}).seq;
    const expected = (req.body ?? {}).expected;
    try {
      // undo는 seq를 생략하면 검토 위치를 지운다.
      let seq = kind === "undo" && raw === undefined ? undefined : validSeq(raw, id);
      if (seq === null) return rejectRequest(res, 400, { error: st("routes.review.seqInvalid") });
      const current = sessionManager.reviewedSeqOf(id);
      // 되돌리기는 그 완료가 저장한 값(expected)이 아직 그대로일 때만 한다. 다른 기기에서 먼저 처리했으면 거절한다.
      if (kind === "undo" && expected !== undefined && expected !== (current ?? null)) {
        return rejectRequest(res, 409, { error: st("routes.review.undoConflict") });
      }
      // 완료는 위치를 앞으로만 옮긴다. 늦게 도착한 옛 순번이 이미 저장된 더 큰 값을 낮추지 않게 한다.
      if (kind === "done" && seq !== undefined && current !== undefined) seq = Math.max(current, seq);
      if (!sessionManager.setReviewedSeq(id, seq)) return rejectRequest(res, 409, { error: st("routes.review.saveFailed") });
      const body: ReviewMarkResponse = { reviewedSeq: seq ?? null, previous: current ?? null };
      res.json(body);
    } catch (error) {
      // operation 이름은 고정 문자열이어야 해서 갈래마다 따로 적는다.
      if (kind === "done") void reportResponseError(res, error, { component: "routes", operation: "review.done", session_id: id });
      else void reportResponseError(res, error, { component: "routes", operation: "review.undo", session_id: id });
      res.status(500).json({ error: st("routes.review.saveFailed") });
    }
  };
}

reviewRouter.post("/:id/done", mark("done"));
reviewRouter.post("/:id/undo", mark("undo"));

// 다른 AI에게 검토 맡기기. 형식 → 존재 → 보관·일하는 중 → provider → 폴더 → 변경 있음 순으로 거르고, 모델은 부르지 않는다.
reviewRouter.post("/:id/request", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!SESSION_ID_RE.test(id) || (!sessionManager.get(id) && !sessionManager.hasDiskSession(id))) {
    return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
  }
  const rawProvider = (req.body ?? {}).provider;
  const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
  if (!provider) return rejectRequest(res, 400, { error: st("routes.reviewRequest.bodyInvalid") });
  try {
    const item = sessionManager.list().find((s) => s.id === id);
    if (!item) return rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
    if (sessionManager.isArchived(id)) return rejectRequest(res, 409, { error: st("routes.sessions.archivedReadOnly") });
    if (["running", "waiting", "background"].includes(item.attention ?? "idle")) return rejectRequest(res, 409, { error: st("routes.reviewRequest.busy") });
    const entry = listProviders().find((e) => e.id === provider);
    if (!entry) return rejectRequest(res, 409, { error: st("routes.reviewRequest.providerUnknown") });
    const availability = await providerAvailability(entry);
    if (!availability.available) {
      const key = availability.requires ? "requires" : availability.reason;
      return rejectRequest(res, 409, { error: st(`routes.sessions.providerUnavailable.${key}`, { provider: entry.services.displayName, requires: availability.requires ?? "" }) });
    }
    try {
      resolveWorkFolder(item.cwd);
    } catch {
      return rejectRequest(res, 409, { error: st("routes.reviewRequest.folderMissing") });
    }
    // 세션 전체를 한 번 읽어 요약과 사람 말을 함께 만든다.
    const { codec, raw, partial } = readRange(id, 0, lastSeqFromDisk(id));
    const summary = summarizeReview(raw.flatMap((ev) => codec.normalize(ev)));
    if (!summary.changedFiles.length && !folderUncommittedChanges(item.cwd)?.length) return rejectRequest(res, 409, { error: st("routes.reviewRequest.nothingToReview") });
    const text = reviewRequestText({ name: item.displayName, id, cwd: item.cwd, isGit: isGitRepo(item.cwd), partial, userTexts: recentUserTexts(raw), summary });
    const next = sessionManager.createReviewSession(id, { provider: entry.id, cwd: item.cwd, name: st("routes.reviewRequest.title", { name: item.displayName }), text });
    const body: ReviewRequestResponse = { id: next.id };
    res.status(201).json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "review.request", session_id: id });
    res.status(500).json({ error: st("routes.review.readFailed") });
  }
});
