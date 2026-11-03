/** Codex 계정 한도 응답 → 중립 사용량. 세션과 세션 밖 조회가 함께 쓴다. */
import type { GetAccountRateLimitsResponse } from "../../codex/protocol/v2/GetAccountRateLimitsResponse";
import type { ProviderUsage, UsageWindow } from "../types";

export function usageFromCodexRateLimits(res: GetAccountRateLimitsResponse): ProviderUsage {
  const buckets = Object.keys(res.rateLimitsByLimitId ?? {}).length
    ? Object.entries(res.rateLimitsByLimitId ?? {}).map(([id, snap]) => ({ id, snap }))
    : [{ id: res.rateLimits?.limitId ?? "codex", snap: res.rateLimits }];
  const windows: UsageWindow[] = [];
  let plan: string | undefined;
  for (const { id, snap } of buckets) {
    if (!snap) continue;
    plan ??= snap.planType ?? undefined;
    for (const which of ["primary", "secondary"] as const) {
      const w = snap[which];
      if (!w) continue;
      windows.push({
        // 이름이 없는 창이라 키는 **식별자**로만 쓰고, 사람이 읽는 이름은 아래 길이에서 나온다.
        //   ⚠️ 프로토콜상 길이는 null일 수 있다(실측에서는 항상 왔다). 그런 창이 오면 화면이 만들 이름이
        //   없어 이 키를 그대로 띄운다 — 드물지만 그때는 사용자에게 뜻 없는 글자가 보인다.
        key: `${id}_${which}`,
        utilization: typeof w.usedPercent === "number" ? w.usedPercent : null,
        // 실측값 1787617478은 초 단위다(밀리초면 1970년이 된다).
        resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
        ...(typeof w.windowDurationMins === "number" ? { windowMinutes: w.windowDurationMins } : {}),
      });
    }
  }
  return { ...(plan ? { subscriptionType: plan } : {}), windowsAvailable: windows.length > 0, windows };
}
