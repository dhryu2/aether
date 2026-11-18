/**
 * 관리 앱 전용 API(토큰으로만 지킨다. 로그인 전략과 섞지 않는다). 토큰이 없으면 index.ts가 아예 붙이지 않는다.
 *   GET /api/admin/screens   등록된 화면 목록
 *   PUT /api/admin/screens   목록 교체 {screens:[{prefix,dir}]}
 *   GET /api/admin/status    {runningSessions} — 일하는 중인 세션 수
 */
import crypto from "node:crypto";
import { Router } from "express";
import { bearerToken } from "../middleware/auth";
import type { createScreenRegistry } from "./screens";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export function createAdminRouter(token: string, registry: ReturnType<typeof createScreenRegistry>, countRunning: () => number): Router {
  const r = Router();
  const want = sha(token);
  r.use((req, res, next) => {
    const got = bearerToken(req);
    if (got && crypto.timingSafeEqual(sha(got), want)) return next();
    res.status(401).json({ error: "unauthorized" });
  });
  r.get("/screens", (_req, res) => void res.json({ screens: registry.list() }));
  r.put("/screens", (req, res) => {
    const out = registry.replace(req.body?.screens);
    if (!out.ok) return void res.status(400).json({ error: out.error });
    res.json({ screens: out.screens });
  });
  r.get("/status", (_req, res) => void res.json({ runningSessions: countRunning() }));
  return r;
}
