/**
 * Grok `_x.ai/billing` → 중립 사용량 창. 모델 호출 0.
 * 실행: tsx test/grok_billing_usage.ts
 */
import { usageFromGrokBilling } from "../providers/grok/billingUsage";

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const weekly = usageFromGrokBilling({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-20T00:00:00.000Z",
      end: "2026-08-27T00:00:00.000Z",
    },
    creditUsagePercent: 42,
  },
  subscription_tier: "SuperGrok Plus",
});
check(weekly.windowsAvailable && weekly.windows.length === 1, "주 창 하나");
check(weekly.windows[0]?.key === "weekly", "주 창 키", weekly.windows[0]);
check(weekly.windows[0]?.windowMinutes === 10080, "주 창 길이 10080분", weekly.windows[0]);
check(weekly.windows[0]?.utilization === 42, "퍼센트는 그대로 0–100", weekly.windows[0]);
check(weekly.windows[0]?.resetsAt === "2026-08-27T00:00:00.000Z", "리셋 시각", weekly.windows[0]);
check(weekly.subscriptionType === "SuperGrok Plus", "구독 이름", weekly.subscriptionType);
check(!weekly.windows.some((w) => w.key === "five_hour"), "5시간 창을 안 만든다");

const fraction = usageFromGrokBilling({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-20T00:00:00.000Z",
      end: "2026-08-27T00:00:00.000Z",
    },
    creditUsagePercent: 0.42,
  },
});
check(fraction.windows[0]?.utilization === 42, "0–1 비율은 퍼센트로 올린다", fraction.windows[0]);

const counted = usageFromGrokBilling({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_MONTHLY",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    },
    includedUsed: { val: 30 },
    monthlyLimit: { val: 100 },
  },
});
check(counted.windows[0]?.key === "monthly", "월 창 키", counted.windows[0]);
check(counted.windows[0]?.utilization === 30, "used/limit로 퍼센트", counted.windows[0]);

const live = usageFromGrokBilling({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-20T23:56:55.577210+00:00",
      end: "2026-08-27T23:56:55.577210+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: "2026-08-20T23:56:55.577210+00:00",
    billingPeriodEnd: "2026-08-27T23:56:55.577210+00:00",
  },
  subscription_tier: "SuperGrok Plus",
});
check(live.windowsAvailable && live.windows.length === 1, "실측 SuperGrok 주 창(사용률 없음)");
check(live.windows[0]?.utilization == null, "사용률 필드가 없으면 비운다", live.windows[0]);
check(live.windows[0]?.windowMinutes === 10080, "마이크로초 시각도 7일이다", live.windows[0]);

const overage = usageFromGrokBilling({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-20T00:00:00.000Z",
      end: "2026-08-27T00:00:00.000Z",
    },
    onDemandCap: { val: 10 },
    onDemandUsed: { val: 3 },
  },
});
check(overage.windows.length === 2 && overage.windows[1]?.key === "overage", "한도 밖 창", overage.windows);
check(overage.windows[1]?.utilization === 30, "한도 밖 사용률", overage.windows[1]);

const empty = usageFromGrokBilling({});
check(empty.windowsAvailable === false && empty.windows.length === 0, "빈 응답은 창을 안 만든다", empty);
check(usageFromGrokBilling(null).windows.length === 0, "null은 창을 안 만든다");
check(usageFromGrokBilling({ config: {} }).windows.length === 0, "기간 없는 설정은 창을 안 만든다");

if (fail) {
  console.log(`\n❌ ${fail} 실패 / ${pass} 통과`);
  process.exit(1);
}
console.log(`\n✅ 전체 ${pass}개 통과`);
