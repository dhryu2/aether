// 세션 제목 자동 요약 스위치 라우트(인증 게이트 뒤).
//   GET /api/title-summary  { enabled }
//   PUT /api/title-summary  { enabled }  — boolean만 받는다
import { Router, type Request, type Response } from "express";
import { st } from "../i18n";
import { readTitleSummarize, writeTitleSummarize } from "../sessions/titleSummarySetting";

export const titleSummaryRouter = Router();

titleSummaryRouter.get("/", (_req: Request, res: Response) => {
  res.json({ enabled: readTitleSummarize() });
});

titleSummaryRouter.put("/", (req: Request, res: Response) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (typeof enabled !== "boolean") return res.status(400).json({ error: st("routes.search.summarySettingInvalid") });
  res.json({ enabled: writeTitleSummarize(enabled) });
});
