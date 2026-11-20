/** Claude SDK의 실험적 usage 응답 → 중립 사용량. 세션과 세션 밖 조회가 함께 쓴다. */
import type { ProviderUsage, UsageWindow } from "../types";

// Claude가 구독 화면에 쓰는 실제 한도 창만 표시한다. SDK의 실험적 usage 응답에는
// 내부 배열·설정 블록도 섞일 수 있으므로, 이름 없는 `limit-1` 같은 항목을 UI까지 보내지 않는다.
const DISPLAYABLE_RATE_LIMIT_KEYS = new Set([
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "extra_usage",
]);

// 창 길이(분). 남은 한도 예측에 쓴다. 모델별 창·extra_usage는 길이를 몰라 비운다.
const WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_oauth_apps: 10080,
};

function modelScopedLimitLabel(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof (raw as { display_name?: unknown }).display_name === "string"
    ? (raw as { display_name: string }).display_name.trim()
    : "";
  // 서버가 모델 이름을 주지 않을 때의 내부 배열 번호는 사용자에게 의미가 없다.
  return label && !/^limits?(?:[\s_-]*\d+)?$/i.test(label) ? label : null;
}

/** SDK 응답 모양이 실험적이라 필드 부재를 방어한다. */
export type ClaudeUsageRaw = {
  rate_limits?: unknown;
  rate_limits_available?: boolean;
  subscription_type?: string | null;
  session?: { total_cost_usd?: number };
} | null | undefined;

export function usageFromClaude(u: ClaudeUsageRaw): ProviderUsage {
  const limits = (u?.rate_limits ?? {}) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  const modelScoped = limits.model_scoped;
  if (Array.isArray(modelScoped)) {
    for (const raw of modelScoped) {
      const label = modelScopedLimitLabel(raw);
      if (!label) continue;
      const w = raw as { utilization?: number | null; resets_at?: string | null };
      windows.push({ key: label, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null });
    }
  }
  for (const [key, raw] of Object.entries(limits)) {
    if (!DISPLAYABLE_RATE_LIMIT_KEYS.has(key) || !raw || typeof raw !== "object") continue;
    // 나머지는 `{utilization, resets_at}` 모양의 창 하나. 그 형태가 아닌 항목(설정 블록 등)은 창이 아니다.
    const w = raw as { utilization?: number | null; resets_at?: string | null };
    if (!("utilization" in w)) continue;
    const windowMinutes = WINDOW_MINUTES[key];
    windows.push({ key, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null, ...(windowMinutes ? { windowMinutes } : {}) });
  }
  // 계약상 못 세는 provider는 이 필드를 비운다. 값이 실제로 온 경우에만 싣는다(0을 지어내지 않는다).
  const cost = u?.session?.total_cost_usd;
  return {
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
    ...(u?.subscription_type ? { subscriptionType: u.subscription_type } : {}),
    windowsAvailable: !!u?.rate_limits_available && windows.length > 0,
    windows,
  };
}
