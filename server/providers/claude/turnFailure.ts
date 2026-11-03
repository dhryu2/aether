import { classifyServiceError } from './errorOrigin';
import { classifyError, isExpectedError } from '../../observability/event';
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
/** 명령 결과(tool_result)의 실패는 대상이 아니다. 실행기 턴 자체의 실패만 중립 Error로 바꾼다. */
const externalAssistantErrors = new Set<SDKAssistantMessageError>([
  'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit', 'overloaded', 'server_error',
]);
export function claudeTurnFailure(msg: SDKMessage, assistantError?: SDKAssistantMessageError): Error | null {
  if (msg.type !== 'result') return null;
  if (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools') return null;
  if (!msg.is_error && msg.subtype === 'success') return null;
  if (msg.subtype === 'success') {
    const error = Object.assign(new Error(msg.result), { status: msg.api_error_status });
    // 요청·설정·출력 해석 문제일 수 있는 구조화 원인은 서비스 문구나 상태로 덮어쓰지 않는다.
    if (assistantError) return classifyError(error, externalAssistantErrors.has(assistantError) ? 'external_environment' : 'aether_defect');
    return classifyServiceError(error, true);
  }
  const error = new Error((msg.errors ?? []).join('\n'));
  if (assistantError && !externalAssistantErrors.has(assistantError)) return classifyError(error, 'aether_defect');
  // 여러 원인 중 분류 불명·해석 실패가 하나라도 있으면 전체 실패를 수집한다.
  if ((msg.subtype === 'error_during_execution' && !msg.errors?.length && assistantError && externalAssistantErrors.has(assistantError)) ||
      (msg.errors?.length && msg.errors.every(message => isExpectedError(classifyServiceError(new Error(message), true))))) {
    classifyError(error, 'external_environment');
  }
  return error;
}

/** 마지막 주 응답만 같은 턴의 결과에 연결한다. 결과는 성공·중단 여부와 관계없이 기억을 비운다. */
export function createClaudeTurnFailureTracker(): (msg: SDKMessage) => Error | null {
  let lastAssistantError: SDKAssistantMessageError | undefined;
  return msg => {
    // 하위 작업의 오류나 재시도 알림은 주 턴의 최종 원인이라는 근거가 없다.
    if (msg.type === 'assistant' && msg.parent_tool_use_id == null) lastAssistantError = msg.error;
    if (msg.type !== 'result') return null;
    const failure = claudeTurnFailure(msg, lastAssistantError);
    lastAssistantError = undefined;
    return failure;
  };
}
