/**
 * Grok 세션의 실효 승인 정책 요약 (Phase 10c).
 *
 * 10c는 전역 always-approve를 CLI `--permission-mode`로 이긴다. 그래서 full이 아닌 세션은 "카드를 묻는다"가
 * 이 프로세스의 실효 동작이다. 사용자 전역 파일을 읽어 다른 축을 세는 일은 아직 하지 않는다 — 못 본 것을
 * 0으로 지어내면 배지가 거짓말을 한다. 지금은 우리가 못 박은 전면 우회만 정직하게 보고한다.
 */
import type { PermissionPolicy } from "../types";

export function grokPermissionPolicy(bypassAll: boolean): PermissionPolicy {
  return {
    bypassAll,
    autoApproveRules: 0,
    sources: [],
  };
}
