import { currentRelease } from './release';
import { createHash, randomUUID } from 'node:crypto';
import type { ClassifiedError, ErrorOrigin, ErrorEvent } from '../../shared/errors';
export type ErrorDetails = Partial<ErrorEvent> & { component: string; operation: string };
export function isExpectedError(error: unknown): boolean {
  const e = error as (ClassifiedError & { name?: string; code?: string }) | null;
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' ||
    e?.code === 'USER_CANCELLED' || e?.errorOrigin === 'external_environment' || e?.errorOrigin === 'user_action';
}
/** 원래 Error와 stack을 유지한 채 경계 어댑터가 원인을 표시한다. */
export function classifyError<T extends object>(error: T, errorOrigin: ErrorOrigin): T & ClassifiedError {
  return Object.assign(error, { errorOrigin });
}
function jsonContext(value: Record<string, unknown>): Record<string, unknown> {
  const parents = new WeakSet<object>();
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item && typeof item === 'object') {
      if (parents.has(item)) return '[Circular]';
      parents.add(item);
    }
    return item;
  }));
}
/** 원인 사슬은 진단 필드만 보존한다. Error의 임의 속성에는 요청·대화 본문이 있을 수 있다. */
function errorCauses(error: unknown): Record<string, unknown>[] {
  const causes: Record<string, unknown>[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause !== undefined && !seen.has(cause)) {
    seen.add(cause);
    const e = cause as { message?: unknown; stack?: unknown; code?: unknown } | null;
    causes.push({
      message: typeof e?.message === 'string' ? e.message : String(cause),
      ...(typeof e?.stack === 'string' ? { stack: e.stack } : {}),
      ...(typeof e?.code === 'string' || typeof e?.code === 'number' ? { code: e.code } : {}),
    });
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return causes;
}
export function makeErrorEvent(error: unknown, details: ErrorDetails, instance: string): ErrorEvent {
  const e = error as { message?: unknown; stack?: unknown; code?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const stack = typeof e?.stack === 'string' ? e.stack : null;
  const causes = errorCauses(error);
  const code = details.code ?? (typeof e?.code === 'string' ? e.code : 'UNEXPECTED_ERROR');
  // 메시지(세션 번호·시각 등 가변 값)는 지문에 넣지 않는다.
  const site = stack?.split('\n').find(line => /^\s+at /.test(line))?.trim() ?? '';
  return {
    id: randomUUID(), occurred_at: new Date().toISOString(), severity: 'error', source: 'server',
    message, stack, request_id: null, session_id: null, session_seq: null,
    environment: process.env.NODE_ENV ?? 'development', release: currentRelease,
    instance_id: instance, provider: null, model: null, ...details, code, context: { ...jsonContext(details.context ?? {}), ...(causes.length ? { causes } : {}) },
    fingerprint: createHash('sha256').update([details.component, details.operation, code, site].join('\n')).digest('hex'),
  };
}
