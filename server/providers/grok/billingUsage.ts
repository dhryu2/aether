/**
 * Grok `_x.ai/billing` 응답 → 중립 사용량 창.
 *
 * 10a는 handshake에 한도 창이 없어 조회를 안 했다. 실제 조회 이름은 앞에 밑줄이 있다.
 * `x.ai/billing`은 Method not found. `_x.ai/billing`만 과금 설정을 돌려준다(실측 2026-08-22).
 * 창을 못 받으면 빈 목록이다. 5시간 창을 지어내지 않는다.
 */
import type { ProviderUsage, UsageWindow } from "../types";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const rec = asRecord(v);
  if (rec && typeof rec.val === "number" && Number.isFinite(rec.val)) return rec.val;
  return null;
}

function dateMs(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const trimmed = v.replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

function periodKey(type: unknown): string {
  const raw = typeof type === "string" ? type.toLowerCase() : "";
  if (raw.includes("week")) return "weekly";
  if (raw.includes("month")) return "monthly";
  if (raw.includes("day") && !raw.includes("week")) return "daily";
  return "billing_period";
}

function utilizationOf(config: Record<string, unknown>): number | null {
  const used = num(config.includedUsed) ?? num(config.totalUsed);
  const limit = num(config.monthlyLimit);
  if (used != null && limit != null && limit > 0) return Math.round((used / limit) * 100);
  const pct = num(config.creditUsagePercent);
  if (pct == null) return null;
  return pct <= 1 ? Math.round(pct * 100) : pct;
}

function windowFromRange(
  key: string,
  start: unknown,
  end: unknown,
  utilization: number | null,
): UsageWindow | null {
  const from = dateMs(start);
  const to = dateMs(end);
  if (from == null || to == null || to <= from) return null;
  const minutes = Math.round((to - from) / 60_000);
  if (minutes <= 0) return null;
  return {
    key,
    utilization,
    resetsAt: new Date(to).toISOString(),
    windowMinutes: minutes,
  };
}

/** `_x.ai/billing`이 돌려준 본문만 받는다. 요청 실패는 호출자가 빈 값으로 바꾼다. */
export function usageFromGrokBilling(raw: unknown): ProviderUsage {
  const root = asRecord(raw);
  const config = asRecord(root?.config) ?? {};
  const tier = root && typeof root.subscription_tier === "string" ? root.subscription_tier.trim() : "";
  const windows: UsageWindow[] = [];
  const period = asRecord(config.currentPeriod);
  const main = windowFromRange(
    periodKey(period?.type),
    period?.start ?? config.billingPeriodStart,
    period?.end ?? config.billingPeriodEnd,
    utilizationOf(config),
  );
  if (main) windows.push(main);
  const cap = num(config.onDemandCap);
  const used = num(config.onDemandUsed);
  if (cap != null && cap > 0) {
    windows.push({
      key: "overage",
      utilization: used != null ? Math.round((used / cap) * 100) : null,
    });
  }
  return {
    ...(tier ? { subscriptionType: tier } : {}),
    windowsAvailable: windows.length > 0,
    windows,
  };
}
