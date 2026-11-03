import { reportResponseError } from "../observability/http";
import { reportError } from "../observability/report";
/**
 * 과거이력 검색 라우트.
 *   GET /api/search?q=<검색어>&sessionId=<id>&limit=<n>&sort=newest|oldest
 *   + fromTs·toTs (선택)
 *   GET /api/search/session/:id?after=<id>  — 지운 세션의 대화 글(검색 색인, 읽기 전용)
 * 인증 게이트 뒤(보호). 검색 비활성(config.search=false)이면 index.ts에서 미등록.
 * 세션 글자 색인만 읽는다. 검색 파일은 열지 않는다.
 */
import { Router, type Request, type Response } from "express";
import { st } from "../i18n";
import { getLetterSessionPage, searchSessionLetters, sessionLetterReady } from "../db/sessionLetter";
import { recordSearchAudit } from "../db/searchAudit";
import { readSearchSummarize, writeSearchSummarize } from "../search/summarySetting";
import { sessionManager } from "../sessions/SessionManager";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 지운 세션도 색인에는 남는다. 화면이 열 수 없는 결과를 알아보게 표시한다. */
function sessionExists(id: string): boolean {
  return !!sessionManager.get(id) || sessionManager.hasDiskSession(id);
}

export const searchRouter = Router();

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function optFinite(v: unknown): number | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// 검색 결과 요약 스위치. 저장값이 config보다 우선하고, 다음 검색부터 적용된다.
searchRouter.get("/summary-setting", (_req: Request, res: Response) => {
  res.json({ enabled: readSearchSummarize() });
});

searchRouter.put("/summary-setting", (req: Request, res: Response) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (typeof enabled !== "boolean") return res.status(400).json({ error: st("routes.search.summarySettingInvalid") });
  res.json({ enabled: writeSearchSummarize(enabled) });
});

searchRouter.get("/", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q.trim()) return res.json({ results: [] });
  const sessionId = optStr(req.query.sessionId);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const sort = req.query.sort === "newest" || req.query.sort === "oldest" ? req.query.sort : undefined;
  const chatOnly = req.query.chatOnly === "1" || req.query.chatOnly === "true";
  const fromTs = optFinite(req.query.fromTs);
  const toTs = optFinite(req.query.toTs);
  const filters = {
    ...(sessionId ? { sessionId } : {}),
    ...(fromTs !== undefined ? { fromTs } : {}),
    ...(toTs !== undefined ? { toTs } : {}),
    ...(chatOnly ? { chatOnly: true } : {}),
    ...(sort ? { sort } : {}),
  };
  try {
    if (!sessionLetterReady()) throw new Error("세션 글자 색인을 열지 못했다");
    const hits = await searchSessionLetters({ query: q, sessionId, limit, sort, chatOnly, fromTs, toTs });
    const results = hits.map((h) => (sessionExists(h.sessionId) ? h : { ...h, deleted: true }));
    try {
      await recordSearchAudit({
        actorId: "person",
        query: q,
        filters,
        hits: results.map((h) => ({ sessionId: h.sessionId, seq: h.seq, part: h.part })),
      });
    } catch (err) {
      void reportError(err, { component: "routes", operation: "search.audit.append" }); console.error("[aether] 검색 감사 실패:", err);
    }
    res.json({ results });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "search.query.run" }); console.error("[aether] 검색 실패:", err);
    res.status(500).json({ error: st("routes.search.failed") });
  }
});

searchRouter.get("/session/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!SESSION_ID_RE.test(id)) return res.status(400).json({ error: st("routes.search.failed") });
  const after = optFinite(req.query.after) ?? 0;
  try {
    if (!sessionLetterReady()) throw new Error("세션 글자 색인을 열지 못했다");
    const rows = await getLetterSessionPage(id, after, 100);
    res.json({ rows });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "search.deleted_session.read" }); console.error("[aether] 지운 세션 글 읽기 실패:", err instanceof Error ? err.message : "unknown");
    res.status(500).json({ error: st("routes.search.failed") });
  }
});
