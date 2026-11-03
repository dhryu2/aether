/**
 * effort 플래그 매핑 + "서버는 모델·강도 목록을 들고 있지 않다"는 계약 (Claude 모델 호출 0).
 *
 * 예전엔 여기서 하드코딩된 카탈로그(모델 4종·강도 6종·가문 어휘)의 내용을 검사했다. 그 목록 자체가
 * 사라졌으므로 이제 검사할 것은 정반대다 — **어디에도 목록이 남아 있지 않은가**, 그리고 강도 값이
 * SDK 플래그로 그대로 넘어가는가.
 */
import { effortToFlagSettings } from "../sessions/runtimes/claude";
import { claudeServices } from "../providers/claude/services";
import { listProviders } from "../providers/registry";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

// ── 1. effortToFlagSettings: 받은 값을 그대로 effortLevel로 넘긴다(판정은 SDK 몫) ──
for (const lv of ["low", "medium", "high", "xhigh", "max"] as const) {
  const r = effortToFlagSettings(lv);
  check(r.effortLevel === lv, `1a ${lv} → {effortLevel:${lv}}`);
}
// 폐기된 ultracode가 특례로 되살아나지 않는가 — 되살아나면 다른 키가 섞여 나온다.
const keys = Object.keys(effortToFlagSettings("high"));
check(keys.length === 1 && keys[0] === "effortLevel", "1b 결과에 effortLevel 말고 다른 키가 없다(ultracode 특례 제거)");
check(!("ultracode" in effortToFlagSettings("xhigh")), "1c ultracode 키가 아예 나오지 않는다");
// 서버가 모르는 값이어도 막지 않고 그대로 넘긴다 — 아는 목록을 서버가 들고 있지 않다는 뜻이다.
check(effortToFlagSettings("brand-new-level" as never).effortLevel === "brand-new-level", "1d 처음 보는 강도 값도 그대로 전달(서버 화이트리스트 없음)");

// ── 2. provider 서비스에 모델·강도 목록이 남아 있지 않다 ──
const svc = claudeServices as unknown as Record<string, unknown>;
check(!("modelCatalog" in svc), "2a ProviderServices에 modelCatalog가 없다(개념 삭제)");
for (const gone of ["efforts", "models", "modelFamilies"]) {
  check(!(gone in svc), `2b ProviderServices에 ${gone} 목록이 없다`);
}
check(typeof claudeServices.distill === "function" && claudeServices.displayName === "Claude", "2c 남겨야 할 표면(distill·displayName)은 그대로다");

// ── 3. 등록표를 도는 경로에도 목록이 없다(REST /api/providers가 이걸 직렬화한다) ──
const listed = listProviders();
check(listed.length >= 1 && listed[0].id === "claude", "3a 등록된 provider 목록에 claude");
check(
  listed.every((e) => !("modelCatalog" in (e.services as unknown as Record<string, unknown>))),
  "3b 등록된 어느 provider에도 카탈로그가 없다",
);

console.log("─".repeat(50));
console.log(`effort flags: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
