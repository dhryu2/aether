/**
 * Claude 세션의 실효 승인 정책 요약 (Phase 8d-3 ⑥ⓕ · D3).
 *
 * 세션은 `settingSources: ["user","project","local"]`로 스폰된다(2026-07-23 결정 — 터미널 claude와 같은
 * 범위). 그래서 사용자가 설정 파일의 `permissions.allow`에 등록한 패턴은 **폰 승인 카드 없이** 실행되고,
 * 등록되지 않은 변이만 카드로 막힌다. 이건 의도된 동작이고 여기서 바꾸지 않는다.
 *
 * 문제는 그 사실이 화면에 안 보였다는 것이다. 이 모듈은 "몇 개의 규칙이 어느 범위에서 왔는가"와 "기본
 * 동작 자체가 승인을 건너뛰게 설정돼 있는가"만 돌려준다. 허용 패턴 원문은 돌려주지 않는다 — 화면에
 * 목록을 늘어놓는 것은 이번 범위가 아니다.
 *
 * SDK의 `resolveSettings()`와 `filterEscalatingDefaultMode()`를 직접 쓰는 이유는, 설정 병합·범위 우선순위·
 * project 범위의 escalating mode 무시 규칙을 Aether가 흉내 내면 실제 CLI와 갈라지기 때문이다.
 */
import type { ResolvedSettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionPolicy, PermissionPolicyScope } from "../types";
import { loadClaudeSdk } from "./sdk";

const ESCALATING_MODES = new Set(["bypassPermissions", "acceptEdits", "auto"]);
const DISPLAY_SCOPES = new Set<ResolvedSettingSource>(["user", "project", "local"]);

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v.trim())
    : [];
}

/**
 * 이 작업 폴더에서 실제로 적용되는 승인 정책 요약.
 *
 * `effective.permissions.allow`가 실제 병합 결과이므로 규칙 수는 그 배열을 센다. 출처 표시는 그 실효
 * 규칙을 하나라도 제공하거나, 최종 escalating mode를 제공한 user/project/local 범위만 포함한다.
 * managed/flag는 현재 세션 시작 옵션이 자동승인 값을 넣지 않으며 UI 범위 어휘에도 없으므로 제외한다.
 */
export async function claudePermissionPolicy(cwd: string, skipPermissions: boolean): Promise<PermissionPolicy> {
  const { resolveSettings, filterEscalatingDefaultMode } = await loadClaudeSdk();
  const resolved = await resolveSettings({
    cwd,
    settingSources: ["user", "project", "local"],
  });
  const effective = filterEscalatingDefaultMode(resolved);
  const effectiveRules = stringsOf(effective.permissions?.allow);
  const ruleSet = new Set(effectiveRules);
  const mode = effective.permissions?.defaultMode;
  const autoApproveMode = typeof mode === "string" && ESCALATING_MODES.has(mode) ? mode : undefined;

  const sources: PermissionPolicyScope[] = [];
  for (const source of resolved.sources) {
    if (!DISPLAY_SCOPES.has(source.source)) continue;
    const scope = source.source as PermissionPolicyScope;
    const permissions = source.settings.permissions;
    const contributesRule = stringsOf(permissions?.allow).some((rule) => ruleSet.has(rule));
    const contributesMode = !!autoApproveMode && permissions?.defaultMode === autoApproveMode;
    if ((contributesRule || contributesMode) && !sources.includes(scope)) sources.push(scope);
  }

  // `bypassPermissions`는 세션 생성 시 켠 전면 우회와 실질이 같다 — 더 센 표시로 합친다.
  const bypassAll = skipPermissions || autoApproveMode === "bypassPermissions";
  return {
    bypassAll,
    autoApproveRules: effectiveRules.length,
    ...(autoApproveMode ? { autoApproveMode } : {}),
    sources,
  };
}
