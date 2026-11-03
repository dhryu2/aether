// 자동 재개 설정 라우트(인증 게이트 뒤).
//   GET /api/auto-resume  { enabled, text, defaultText }
//   PUT /api/auto-resume  { enabled?, text? } — text가 빈 문자열이면 기본 문장으로 되돌린다
import { Router, type Request, type Response } from "express";
import { st } from "../i18n";
import { AUTO_RESUME_TEXT_MAX, readAutoResumeSettings, writeAutoResumeSettings } from "../sessions/autoResume";

export const autoResumeRouter = Router();

autoResumeRouter.get("/", (_req: Request, res: Response) => {
  res.json(readAutoResumeSettings());
});

autoResumeRouter.put("/", (req: Request, res: Response) => {
  const { enabled, text } = (req.body ?? {}) as { enabled?: unknown; text?: unknown };
  if ((enabled !== undefined && typeof enabled !== "boolean") || (text !== undefined && (typeof text !== "string" || text.length > AUTO_RESUME_TEXT_MAX))) {
    return res.status(400).json({ error: st("routes.autoResume.settingsInvalid") });
  }
  res.json(writeAutoResumeSettings({ enabled: enabled as boolean | undefined, text: text as string | undefined }));
});
