// 작업 대기열 라우트(인증 게이트 뒤).
//   GET    /api/task-queue                  { run, startAt?, deadlineAt?, limitHours, limitChoices, stopReason?, items, maxItems }
//   POST   /api/task-queue/items            { sessionId, text } — 작업 복사본에서 도는, 아직 입력이 없는 세션만
//   DELETE /api/task-queue/items/:itemId    도는 작업은 409. 끝난 작업을 빼는 것은 줄 정리다
//   POST   /api/task-queue/start            { startAt?, limitHours } — startAt은 지금부터 48시간 안(ms)
//   POST   /api/task-queue/stop             도는 작업은 그대로 둔다
import { Router, type Request, type Response } from "express";
import { st } from "../i18n";
import { AUTO_RESUME_TEXT_MAX } from "../sessions/autoResume";
import { TASK_QUEUE_LIMIT_CHOICES, TASK_QUEUE_MAX_ITEMS, TASK_QUEUE_START_WITHIN_MS, type TaskQueueRunner } from "../sessions/taskQueue";

const ADD_ERRORS = {
  notFound: [404, "routes.common.sessionNotFound"],
  archived: [409, "routes.taskQueue.archived"],
  external: [409, "routes.taskQueue.external"],
  notIsolated: [409, "routes.taskQueue.notIsolated"],
  hasInput: [409, "routes.taskQueue.hasInput"],
  duplicate: [409, "routes.taskQueue.duplicate"],
  full: [409, "routes.taskQueue.full"],
  textInvalid: [400, "routes.taskQueue.textInvalid"],
} as const;

export function createTaskQueueRouter(runner: TaskQueueRunner): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json(runner.getState());
  });

  router.post("/items", (req: Request, res: Response) => {
    const { sessionId, text } = (req.body ?? {}) as { sessionId?: unknown; text?: unknown };
    if (typeof sessionId !== "string" || !sessionId || typeof text !== "string" || !text.trim() || text.trim().length > AUTO_RESUME_TEXT_MAX) {
      return res.status(400).json({ error: st("routes.taskQueue.textInvalid") });
    }
    const r = runner.add(sessionId, text);
    if (r.ok) return res.json({ item: r.item });
    const [status, key] = ADD_ERRORS[r.code];
    res.status(status).json({ error: st(key, { max: TASK_QUEUE_MAX_ITEMS }) });
  });

  router.delete("/items/:itemId", (req: Request, res: Response) => {
    const r = runner.remove(String(req.params.itemId));
    if (r === "notFound") return res.status(404).json({ error: st("routes.taskQueue.itemNotFound") });
    if (r === "running") return res.status(409).json({ error: st("routes.taskQueue.itemRunning") });
    res.json({ ok: true });
  });

  router.post("/start", (req: Request, res: Response) => {
    const { startAt, limitHours } = (req.body ?? {}) as { startAt?: unknown; limitHours?: unknown };
    if (typeof limitHours !== "number" || !TASK_QUEUE_LIMIT_CHOICES.includes(limitHours)) {
      return res.status(400).json({ error: st("routes.taskQueue.limitInvalid", { choices: TASK_QUEUE_LIMIT_CHOICES.join(", ") }) });
    }
    if (startAt !== undefined && (typeof startAt !== "number" || !Number.isFinite(startAt) || startAt > Date.now() + TASK_QUEUE_START_WITHIN_MS)) {
      return res.status(400).json({ error: st("routes.taskQueue.startAtInvalid") });
    }
    // 이미 지난 시각은 "지금 시작"으로 본다.
    const r = runner.startRun({ startAt: typeof startAt === "number" && startAt > Date.now() ? startAt : undefined, limitHours });
    if (r === "already") return res.status(409).json({ error: st("routes.taskQueue.alreadyRunning") });
    if (r === "empty") return res.status(409).json({ error: st("routes.taskQueue.empty") });
    res.json(runner.getState());
  });

  router.post("/stop", (_req: Request, res: Response) => {
    runner.stop();
    res.json(runner.getState());
  });

  return router;
}
