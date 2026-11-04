/**
 * 데스크톱 알림 SSE — GET /api/notify/stream.
 * 인증 게이트 뒤에서만 붙는다. 웹소켓·질의 토큰 없음.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { endIfRevoked } from "../middleware/auth";
import { subscribeDesktopNotify } from "../notify/desktop";
import type { NotifyIntent } from "../notify/worthNotifying";

export const notifyRouter = Router();

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

notifyRouter.get("/stream", (req: Request, res: Response) => {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();

  let closed = false;
  const write = (chunk: string) => {
    if (closed) return;
    try {
      res.write(chunk);
    } catch {
      // 끊긴 클라이언트 연결은 구독만 정리한다.
      cleanup();
    }
  };

  const send = (intent: NotifyIntent) => {
    write(`data: ${JSON.stringify(intent)}\n\n`);
  };
  const unsub = subscribeDesktopNotify(send);

  const hb = setInterval(() => {
    endIfRevoked(req, res, cleanup);
    if (closed) return;
    write("event: ping\ndata: {}\n\n");
  }, config.heartbeatMs);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    unsub();
  }

  req.on("close", cleanup);
  res.on("error", cleanup);
});
