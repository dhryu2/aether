import { randomUUID } from 'node:crypto';
import { Router, type Response, type RequestHandler } from 'express';
import { errorContext, getErrorJournal, reportError } from './report';
import { isExpectedError, type ErrorDetails } from './event';
import type { ClassifiedError } from '../../shared/errors';
import { database, databasePath } from '../db/sqlite';
import { errorGroupDetail, isFingerprint, listErrorGroups, parseErrorQuery } from './errorLog';

/** 이 오류가 지금 만드는 응답의 원인일 때만 제외 표시를 응답에 연결한다. */
export function reportResponseError(res: Response, error: unknown, details: ErrorDetails) {
  res.locals.errorOrigin = isExpectedError(error)
    ? (error as ClassifiedError)?.errorOrigin ?? 'user_action' : undefined;
  return reportError(error, details);
}

/** 정상 입력·기능 거절은 응답 보완 기록에서도 제외한다. */
export function rejectRequest(res: Response, status: number, body: unknown) {
  res.locals.errorOrigin = 'user_action';
  res.setHeader('X-Aether-Error-Origin', 'user_action');
  return res.status(status).json(body);
}
/** 서버가 발급한 요청 번호를 오류와 응답에 같이 둔다. 요청 본문은 수집하지 않는다. */
export const errorRequestContext: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const pathname = req.originalUrl.split('?')[0];
  const collecting = pathname === '/api/errors' || pathname.startsWith('/api/errors/');
  errorContext.run({ requestId }, () => {
    const scope = errorContext.getStore()!;
    // 자식 비동기 작업이 같은 객체를 보더라도 응답 뒤에는 요청 문맥을 쓰지 않는다.
    const endScope = () => { scope.ended = true; scope.receipt = undefined; };
    res.once('close', endScope);
    res.once('finish', () => {
      const origin = res.locals.errorOrigin;
      if (res.statusCode >= 500 && origin !== 'user_action' && origin !== 'external_environment' && !scope.receipt && !collecting) {
        void reportError(new Error(`HTTP ${res.statusCode}`), { component: 'api', operation: 'request.finish', request_id: requestId, context: { status: res.statusCode } });
      }
      endScope();
    });
    const json = res.json.bind(res);
    const send = res.send.bind(res), end = res.end.bind(res);
    let pending = false;
    res.json = (body: unknown) => {
      if (pending) return res;
      const origin = res.locals.errorOrigin;
      const expected = origin === 'user_action' || origin === 'external_environment';
      if (expected && !res.headersSent) res.setHeader('X-Aether-Error-Origin', origin);
      if (res.headersSent || res.statusCode < 500 || expected || collecting) return json(body);
      const scope = errorContext.getStore();
      const receipt = scope?.receipt ?? reportError(new Error(
        typeof (body as {error?: unknown})?.error === 'string' ? (body as {error: string}).error : `HTTP ${res.statusCode}`,
      ), { component: 'api', operation: 'request.response', context: { status: res.statusCode, method: req.method, route: req.route?.path ?? req.path } });
      const status = res.statusCode;
      // 첫 JSON 응답을 예약한다. 기록 대기 중 뒤따른 json/send/end가 앞서 전송되지 않게 한다.
      pending = true;
      res.send = (() => res) as typeof res.send;
      res.end = (() => res) as typeof res.end;
      void receipt.catch(() => undefined).then(r => {
        pending = false; res.send = send; res.end = end;
        if (res.headersSent) return;
        res.statusCode = status;
        if (r?.recorded || r?.durable) res.setHeader('X-Aether-Error-Recorded', '1');
        json(body);
      }).catch(next);
      return res;
    };
    next();
  });
};
// zod는 첫 수집 요청 때 불러온다(부팅 때는 싣지 않는다).
const makeInput = (z: typeof import('zod').z) => z.object({
  id: z.uuid(), occurred_at: z.iso.datetime(), component: z.string().min(1).max(100), operation: z.string().min(1).max(200),
  message: z.string().max(64 * 1024), stack: z.string().max(128 * 1024).optional(), code: z.string().max(100).optional(),
  request_id: z.string().max(100).optional(), session_id: z.string().max(100).optional(), release: z.string().max(100).nullable().optional(),
  severity: z.enum(['error', 'warning']).optional(),
}).strict();
let inputSchema: Promise<ReturnType<typeof makeInput>> | undefined;
const getInput = () => (inputSchema ??= import('zod').then(({ z }) => makeInput(z)));
export const errorsRouter = Router();
errorsRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
// 인증 게이트 뒤에만 장착한다. 인증 off 환경에서도 무제한 쓰기를 막는다.
let windowStart = 0, count = 0;
errorsRouter.post('/', async (req, res) => {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
  if (++count > 120) { res.status(429).json({ error: '오류 수집 요청 한도 초과' }); return; }
  const origin = req.get('origin');
  let originAllowed = !origin;
  try { if (origin) originAllowed = new URL(origin).host === req.get('host'); } catch { /* 잘못된 출처 */ }
  if (!originAllowed) { res.status(403).json({ error: '출처 거부' }); return; }
  const parsed = (await getInput()).safeParse(req.body);
  if (!parsed.success || (parsed.success && (Date.parse(parsed.data.occurred_at) < now - 7 * 86_400_000 || Date.parse(parsed.data.occurred_at) > now + 300_000))) {
    res.status(400).json({ error: '잘못된 오류 기록' }); return;
  }
  const j = getErrorJournal();
  if (!j) { res.status(503).json({ error: '수집기 준비 중' }); return; }
  const v = parsed.data;
  // 출처·환경·instance·지문은 클라이언트가 위조할 수 없다. 메시지와 stack은 그대로 기록한다.
  const error = new Error(v.message); error.stack = v.stack;
  const receipt = await j.record(error, { ...v, source: 'web', context: { ingestion: 'http', authentication: req.auth?.via ?? 'unknown' } });
  res.status(receipt.durable ? 200 : 503).json({ id: v.id, durable: receipt.durable });
});
errorsRouter.get('/', (req, res) => {
  const q = parseErrorQuery(req.query, { cursor: true });
  if (!q) { res.status(400).json({ error: '잘못된 오류 조회 조건' }); return; }
  if (!databasePath()) { res.status(503).json({ error: '오류 기록 DB 없음' }); return; }
  res.json(listErrorGroups(database(), q));
});
errorsRouter.get('/:fingerprint', (req, res) => {
  const q = parseErrorQuery(req.query, { cursor: false });
  if (!q || !isFingerprint(req.params.fingerprint)) { res.status(400).json({ error: '잘못된 오류 조회 조건' }); return; }
  if (!databasePath()) { res.status(503).json({ error: '오류 기록 DB 없음' }); return; }
  const detail = errorGroupDetail(database(), req.params.fingerprint, q);
  if (!detail) { res.status(404).json({ error: '오류 묶음 없음' }); return; }
  res.json(detail);
});
