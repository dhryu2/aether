/**
 * 전역 주의 통로: GET /api/presence/stream
 *
 * 대화 통로와 다르다. 세션마다 더 열지 않고 하나다.
 * 처음 스냅샷, 이후 바뀐 방만. 대화 글자·도구 인자·카드 원문은 안 실는다.
 * 잠든 세션을 이 통로 때문에 깨우지 않는다.
 * 자동 재개 예약 문장(사람이 정한 짧은 문장)은 싣는다.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { sessionManager } from "../sessions/SessionManager";
import { AGENT_EVENT_CONTRACT_VERSION } from "../../shared/agentEvent";
import type { PresenceSnapshot } from "../../shared/http";

export const presenceRouter = Router();

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function buildSnapshot(): PresenceSnapshot {
  const sessions = sessionManager.presenceSnapshot();
  // 웹 사이드바는 dm 방 id로도 찾는다.
  const channels = sessions.map((row) => ({ ...row, id: `dm:${row.id}` }));
  return { contractVersion: AGENT_EVENT_CONTRACT_VERSION, channels, sessions };
}

presenceRouter.get("/stream", (req: Request, res: Response) => {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();

  let closed = false;
  const write = (chunk: string) => {
    if (closed) return;
    try {
      if (!res.write(chunk)) {
        // 역압이어도 스냅샷·갱신은 드롭하지 않는다.
      }
    } catch {
      // 끊긴 클라이언트 연결은 구독만 정리한다.
      cleanup();
    }
  };

  write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot())}\n\n`);

  const unsub = sessionManager.subscribePresence((update) => {
    write(`data: ${JSON.stringify(update)}\n\n`);
  });

  const hb = setInterval(() => {
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
