/**
 * Web Push 구독 라우트(인증 게이트 뒤 mount). 공개키는 GET /api/push/vapid.
 *   GET  /api/push/vapid       {vapidPublic?}  구독에 쓸 공개키(키 없으면 빈 객체)
 *   POST /api/push/subscribe   {subscription}  브라우저 PushSubscription 저장
 *   POST /api/push/unsubscribe {endpoint}      구독 해제
 */
import { Router, type Request, type Response } from "express";
import { addSubscription, removeSubscription, vapidPublicIfEnabled } from "../push";
import { st } from "../i18n";

export const pushRouter = Router();

pushRouter.get("/vapid", (_req: Request, res: Response) => {
  const vapidPublic = vapidPublicIfEnabled();
  res.json(vapidPublic ? { vapidPublic } : {});
});

// 알려진 브라우저 푸시 서비스 호스트만 허용 — 임의 endpoint 주입(아웃바운드 릴레이·페이로드 유출) 차단.
const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

function validSubscription(sub: unknown): boolean {
  if (!sub || typeof sub !== "object") return false;
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== "string") return false;
  let u: URL;
  try {
    u = new URL(s.endpoint);
  } catch {
    // 사용자가 제출한 구독 URL의 형식 거절이다.
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) return false;
  // 암호화 키(p256dh/auth) 필수 — 없으면 sendNotification이 암호화 단계에서 throw하며 자동정리도 안 됨(poison).
  return typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}

pushRouter.post("/subscribe", (req: Request, res: Response) => {
  const sub = req.body?.subscription;
  if (!validSubscription(sub)) return res.status(400).json({ error: st("routes.push.invalidSubscription") });
  addSubscription(sub, req.auth?.tokenId);
  res.json({ ok: true });
});

pushRouter.post("/unsubscribe", (req: Request, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string") return res.status(400).json({ error: st("routes.push.endpointRequired") });
  removeSubscription(endpoint);
  res.json({ ok: true });
});
