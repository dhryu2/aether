import { classifyError } from '../../observability/event';
/** 상태 번호는 상위 응답임을 호출자가 확인했을 때만 쓴다. 내부 결함과 분류 불명은 수집한다. */
export function classifyServiceError<T extends Error>(error: T, upstreamResponse = false): T {
  if (error instanceof SyntaxError) return error;
  const info = error as Error & { status?: number; statusCode?: number; code?: number };
  // 요청 형식 거절은 Aether가 잘못 만든 입력일 수 있으므로 서비스 상태 문구보다 우선한다.
  if ([-32700, -32600, -32602].includes(info.code ?? 0)) return error;
  const status = info.status ?? info.statusCode;
  if (upstreamResponse && [401, 403, 408, 429, 500, 502, 503, 504, 529].includes(status ?? 0)) {
    return classifyError(error, 'external_environment');
  }
  // 문구 안의 토큰 이름은 해석하지 않는다. 온전한 서비스 오류 응답만 읽는다.
  try {
    const body = JSON.parse(error.message);
    if (body?.error && typeof body.error.type === 'string') {
      if (["invalid_grant"].includes(body.error.type)) classifyError(error, 'external_environment');
      return error;
    }
  } catch { /* JSON이 아니면 아래의 명확한 서비스 문구만 확인한다. */ }
  const message = error.message.trim();
  const serviceMessage = /^(?:You're out of usage credits(?:[.!].*)?|You've hit your usage limit(?:\..*)?|OAuth token has expired(?:\..*)?)$/i.test(message);
  const upstreamMessage = upstreamResponse && /^(?:Authentication token expired\. Please login again[.!]?|Service overloaded[.!]?|Request timed out[.!]?|rate limit exceeded[.!]?)$/i.test(message);
  if (serviceMessage || upstreamMessage) classifyError(error, 'external_environment');
  return error;
}

/** 생성된 프로토콜의 턴 오류 정보를 이 어댑터 안에서만 해석한다. */
export function codexTurnError(error: {message: string; codexErrorInfo?: unknown}): Error {
  const result = new Error(error.message);
  const info = error.codexErrorInfo;
  if (info == null || info === 'other') return classifyServiceError(result, true);
  if (['usageLimitExceeded', 'rateLimitExceeded', 'serverOverloaded', 'internalServerError', 'unauthorized'].includes(String(info))) {
    classifyError(result, 'external_environment');
  } else if (info && typeof info === 'object') {
    const entry = Object.entries(info)[0];
    if (entry && ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(entry[0])) {
      const status = (entry[1] as {httpStatusCode?: number | null})?.httpStatusCode;
      if (status == null || [401,403,408,429,500,502,503,504].includes(status)) classifyError(result, 'external_environment');
    }
  }
  return result;
}
