/**
 * 작업 검토함 라우트(인증 게이트 뒤).
 *   GET  /api/review               끝난 세션 중 검토할 것이 있는 목록(기록만 읽고 git은 부르지 않는다)
 *   GET  /api/review/:id[?git=0]   상세. git 상태는 ?git=0이면 건너뛴다
 *   POST /api/review/:id/done      { seq }  검토 완료 위치 저장
 *   POST /api/review/:id/undo      { seq? } 이전 위치로 되돌림(없으면 지움)
 * 요약은 AI 없이 저장된 기록(중립 사건)에서만 모은다. 요청에서 경로를 받지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { AgentEvent } from "../../shared/agentEvent";
import type { ReviewDetailResponse, ReviewListResponse, ReviewMarkResponse, ReviewRow, ReviewSessionHead, ReviewSummary } from "../../shared/brain";
import { st } from "../i18n";
import { reportResponseError, rejectRequest } from "../observability/http";
import { folderReviewStateAsync, isolatedWorkspaceExists, type FolderReviewState } from "../sessions/isolatedWorkspace";
import { lastSeqFromDisk, readEventsPage } from "../sessions/persistence";
import { isHiddenSeq } from "../sessions/rewind";
import { sessionManager } from "../sessions/SessionManager";
import { summarizeReview } from "../sessions/reviewSummary";

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

function compute(id: string, reviewedSeq: number): Computed {
  const diskLast = lastSeqFromDisk(id);
  const key = `${id}:${reviewedSeq}:${diskLast}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const page = readEventsPage(id, diskLast + 1, MAX_EVENTS);
  const ranges = sessionManager.hiddenRangesOf(id);
  const codec = sessionManager.codecOf(id);
  const raw = page.events.filter((ev) => ev.seq > reviewedSeq && (!ranges.length || !isHiddenSeq(ev.seq, ranges)));
  const events: AgentEvent[] = raw.flatMap((ev) => codec.normalize(ev));
  const first = page.events[0]?.seq ?? 0;
  const out: Computed = {
    summary: summarizeReview(events),
    lastSeq: Math.max(diskLast, page.events[page.events.length - 1]?.seq ?? 0),
    partial: page.hasOlder && first > reviewedSeq + 1,
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

/** 없는 폴더도 다룬다: 존재하는 가장 가까운 조상을 실제 경로로 풀고 나머지를 붙인다(git은 실제 경로로 답한다). */
function canon(p: string): string {
  const trailing = p.endsWith("/") ? "/" : "";
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest) + trailing;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p) + trailing;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

async function gitState(cwd: string, files: string[]): Promise<FolderReviewState | null> {
  if (!isolatedWorkspaceExists(cwd)) return null;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), GIT_TIMEOUT_MS).unref());
  return Promise.race([folderReviewStateAsync(cwd, files), timeout]);
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
    const files = c.summary.changedFiles.map((f) => canon(path.resolve(item.cwd, f.path)));
    const state = skipGit ? null : await gitState(item.cwd, files);
    if (!state) {
      const body: ReviewDetailResponse = { ...base, git: skipGit ? "skipped" : "unavailable", fileStates: [], unrecorded: [] };
      return res.json(body);
    }
    const dirty = state.dirty.map(canon);
    const covers = (g: string, f: string) => g === f || (g.endsWith("/") && f.startsWith(g));
    const cwdReal = canon(item.cwd);
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
