// 쉬는 세션 잠재우기 설정 라우트(인증 게이트 뒤).
//   GET /api/idle-sleep  { minutes, choices }  — minutes 0은 끔
//   PUT /api/idle-sleep  { minutes }           — choices에 있는 값만 받는다
import { Router, type Request, type Response } from "express";
import { st } from "../i18n";
import { IDLE_SLEEP_CHOICES_MIN, readIdleSleepMs, writeIdleSleepMinutes } from "../sessions/idleSleepSetting";

export const idleSleepRouter = Router();

const body = (ms: number) => ({ minutes: Math.round(ms / 60_000), choices: IDLE_SLEEP_CHOICES_MIN });

idleSleepRouter.get("/", (_req: Request, res: Response) => {
  res.json(body(readIdleSleepMs()));
});

idleSleepRouter.put("/", (req: Request, res: Response) => {
  const minutes = (req.body ?? {}).minutes as unknown;
  if (typeof minutes !== "number" || !(IDLE_SLEEP_CHOICES_MIN as readonly number[]).includes(minutes)) {
    return res.status(400).json({ error: st("routes.idleSleep.invalid") });
  }
  res.json(body(writeIdleSleepMinutes(minutes)));
});
