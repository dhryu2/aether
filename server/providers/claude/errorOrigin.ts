import { UnknownModelNameError } from "../distillModel";
import { classifyError } from '../../observability/event';
import { st } from '../../i18n';
/** SDK가 실행 파일을 못 찾을 때 영어로 던지는 문구. 이 어댑터만 안다. */
const BINARY_MISSING = /^Claude Code (?:native binary|executable) not found at /;
/** 상태 번호는 상위 응답임을 호출자가 확인했을 때만 쓴다. 내부 결함과 분류 불명은 수집한다. */
export function classifyServiceError<T extends Error>(error: T, upstreamResponse = false): T {
  if (error instanceof SyntaxError || (error as { errorOrigin?: unknown }).errorOrigin) return error;
  // 프로그램이 없는 것은 사용자 환경 문제다. 안내 문구로 바꾸고 원래 오류는 cause에 남긴다.
  if (BINARY_MISSING.test(error.message.trim())) {
    return classifyError(new Error(st('notice.claude.binaryMissing'), { cause: error }), 'external_environment') as unknown as T;
  }
  const info = error as Error & { status?: number; statusCode?: number };
  const status = info.status ?? info.statusCode;
  if (upstreamResponse && [401, 403, 408, 429, 500, 502, 503, 504, 529].includes(status ?? 0)) {
    return classifyError(error, 'external_environment');
  }
  // 문구 안의 토큰 이름은 해석하지 않는다. 온전한 서비스 오류 응답만 읽는다.
  try {
    const body = JSON.parse(error.message);
    if (body?.error && typeof body.error.type === 'string') {
      if (["authentication_error", "rate_limit_error", "overloaded_error", "invalid_grant"].includes(body.error.type)) classifyError(error, 'external_environment');
      return error;
    }
  } catch { /* JSON이 아니면 아래의 명확한 서비스 문구만 확인한다. */ }
  const message = error.message.trim();
  const serviceMessage = /^(?:You're out of usage credits(?:[.!].*)?|API Error: (?:401|403|408|429|500|502|503|504|529)(?:\s.*)?|Failed to authenticate(?:\. API Error: (?:401|403)\b.*)?|OAuth token has expired\. Please obtain a new token or refresh your existing token\.)$/i.test(message);
  const upstreamMessage = upstreamResponse && /^(?:Authentication token expired\. Please login again[.!]?|Service overloaded[.!]?|Request timed out[.!]?|rate limit exceeded[.!]?)$/i.test(message);
  if (serviceMessage || upstreamMessage) classifyError(error, 'external_environment');
  return error;
}

/** CLI의 모델 이름 거절은 이 어댑터에서만 해석한다. 원래 오류도 보존한다. */
export function modelSelectionError(error: unknown, model: string): unknown {
  if (error instanceof UnknownModelNameError || /not a recognized model id/i.test(String((error as Error)?.message ?? error))) {
    return classifyError(Object.assign(new UnknownModelNameError(model), { cause: error }), 'external_environment');
  }
  return error;
}
