// 로케일 라우트(인증 게이트 뒤). 프론트가 UI 언어를 통지 → 서버가 LLM 프롬프트·푸시 알림을 그 언어로 생성.
//   POST /api/locale  { locale: "ko" | "en" }
import { Router, type Request, type Response } from "express";
import { getLocale, setLocale, st } from "../i18n";

export const localeRouter = Router();

localeRouter.get("/", (_req: Request, res: Response) => {
  res.json({ locale: getLocale() });
});

localeRouter.post("/", (req: Request, res: Response) => {
  const locale = (req.body as { locale?: string })?.locale;
  if (locale !== "ko" && locale !== "en") {
    res.status(400).json({ error: st("routes.locale.invalid") });
    return;
  }
  setLocale(locale);
  res.json({ ok: true });
});
