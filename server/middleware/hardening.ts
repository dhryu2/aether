import { classifyError, isExpectedError } from '../observability/event';
import { reportError } from "../observability/report";
/**
 * Phase 2 하드닝 미들웨어 팩토리 모음. index.ts를 깔끔히 유지하기 위해 분리.
 * 모두 config 플래그로 게이트되며, 켜고 끄는 책임은 index.ts가 진다.
 */
import compression from "compression";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { config } from "../config";
import { st } from "../i18n";

/**
 * 압축 — SSE는 절대 압축 금지(끝나지 않는 스트림이 압축 버퍼에 갇혀 '얼어붙음').
 * filter로 text/event-stream을 제외. stream.ts의 `no-transform`이 2차 방어.
 */
export function sseSafeCompression(): RequestHandler {
  return compression({
    filter: (req, res) => {
      const ct = String(res.getHeader("Content-Type") || "");
      if (ct.includes("text/event-stream")) return false; // SSE 비압축
      return compression.filter(req, res);
    },
  });
}

/**
 * 중앙 에러 핸들러(4-arg) — 반드시 모든 라우터 뒤, 맨 끝에 mount.
 * SSE 스트리밍 도중 throw면 헤더가 이미 나갔으므로 기본 핸들러에 위임(스트림만 종료).
 * Express 5는 async rejection을 자동 next(err)로 넘긴다.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // 본문 파서가 명시한 입력 거절만 정상 사용자 행동이다. 임의의 4xx 예외는 수집한다.
  const parserRejected = !!err && typeof err === 'object' && ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'charset.unsupported', 'request.aborted', 'parameters.too.many'].includes(err.type);
  if (parserRejected) {
    classifyError(err, 'user_action');
  }
  void reportError(err, { component: "api", operation: "request.handle" });
  if (isExpectedError(err) && !res.headersSent) {
    res.locals.errorOrigin = err?.errorOrigin === 'external_environment' ? 'external_environment' : 'user_action';
    res.setHeader('X-Aether-Error-Origin', res.locals.errorOrigin);
  }
  if (res.headersSent) return next(err); // SSE 도중 → 기본 핸들러(연결 종료)
  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e.status ?? e.statusCode ?? 500;
  // 오류 객체를 통째로 찍으면 파서 오류의 body 속성에 요청 본문(비밀번호 등)이 실려 로그에 남는다.
  if (!parserRejected) console.error("[aether] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  res.status(status).json({ error: status >= 500 ? st("routes.common.internalError") : String(e.message ?? err) });
};
