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
  const serviceMessage = /^You're out of usage credits(?:[.!].*)?$/i.test(message);
  const upstreamMessage = upstreamResponse && /^(?:Authentication token expired\. Please login again[.!]?|Service overloaded[.!]?|Request timed out[.!]?|rate limit exceeded[.!]?)$/i.test(message);
  if (serviceMessage || upstreamMessage) classifyError(error, 'external_environment');
  return error;
}

export type GrokRateLimitKind = "plan" | "weekly" | "free" | "credits";

/**
 * Grok 한도 오류인가, 어떤 종류인가. 종류에 따라 풀리는 시각을 정하는 방법이 다르다(plan은 시각 없음).
 * shortcut: 실제 Grok 한도 오류 표본 없이 1.0.50 문구로 판별한다. 실제 표본이 생기면 오는 모양을 대조해 고친다.
 */
export function grokRateLimitKind(message: string | undefined, status: number | undefined): GrokRateLimitKind | undefined {
  if (message) {
    // shortcut: 문구는 대소문자까지 그대로 들어 있을 때만 한도로 본다. 버전이 문구를 바꾸면 판별되지 않고 지금처럼 실패로만 보인다.
    if (message.includes("You hit your weekly limit.")) return "weekly";
    if (message.includes("You hit your free usage limit.")) return "free";
    if (message.includes("You've hit the rate limit for your plan.")) return "plan";
  }
  if (status === 429) return "plan";
  if (status === 402) return "credits";
  return undefined;
}

/** 오류 객체에서 HTTP 상태 숫자를 꺼낸다. JSON-RPC 오류의 data 안이나 객체 자체 어디에 있어도 읽는다. */
export function grokErrorStatus(error: unknown): number | undefined {
  const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
  const e = rec(error);
  const d = rec(e?.data);
  for (const v of [d?.status, d?.statusCode, e?.status, e?.statusCode]) if (typeof v === "number") return v;
  return undefined;
}

/**
 * 요금 정보에서 한도가 풀리는 시각(ms)을 고른다.
 * weekly는 기간 종류가 weekly일 때만, free·credits는 요금 기간 끝을 쓴다. plan(짧은 속도 제한)은 시각을 쓰지 않는다.
 * shortcut: 요금 기간 끝을 풀리는 시각으로 본다. 기간 끝이 실제 복구 시각과 다르면 일찍 깨어 다시 막힌다(세 번 뒤 포기).
 */
export function grokLimitResetsAt(kind: GrokRateLimitKind, usage: { windows: { key: string; resetsAt?: string | null }[] }): number | undefined {
  if (kind === "plan") return undefined;
  const main = usage.windows.find((w) => w.resetsAt && w.key !== "overage");
  if (!main?.resetsAt || (kind === "weekly" && main.key !== "weekly")) return undefined;
  const t = Date.parse(main.resetsAt);
  return Number.isFinite(t) ? t : undefined;
}
