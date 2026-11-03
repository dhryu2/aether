/**
 * ClaudeServices — 세션 밖 Claude 서비스(D3). provider당 1개(모듈 싱글톤).
 *
 * 담는 것: ① 인증(구독 OAuth PTY 재인증 중계) ② 백그라운드 경량 모델(distill).
 *
 * 모델·effort 목록은 여기 없다. 세션이 뜨면서 Claude가 실제로 주는 목록(`AgentRuntime.handshake()`)이
 * 유일한 정본이다 — 하드코딩 목록을 두면 계정마다 다른 실제 목록과 조용히 어긋난다.
 */
import { claudeLogin } from "../../auth/claudeLogin";
import { resolveClaudeBin } from "../../auth/claudeLogin";
import { cliAvailability, isCommandInstalled } from "../installed";
import type { ProviderServices } from "../types";
import { runDistill, listClaudeBackgroundModels, readClaudeAccountUsage } from "./distill";
import { claudeSdkLoadable } from "./sdk";

/**
 * Claude SDK의 이어가기 식별자는 UUID다(8a 실측). 클라가 임의 문자열을 넣지 못하게 형식만 본다.
 * 8d-2 이동: 8d-1까지 이 정규식은 공통 등록표(`providers/registry.ts`)에 있었다. 코어는 이 문자열의
 *   의미를 모른다는 게 D12의 요지이므로, 형식 지식도 provider 쪽에 둔다.
 */
const RESUME_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidClaudeResumeKey(key: string): boolean {
  return RESUME_KEY_RE.test(key);
}

export const claudeServices: ProviderServices = {
  provider: "claude",
  displayName: "Claude",
  planReview: false,
  // 기존 PTY 로그인 매니저가 ProviderAuth 형태를 그대로 만족(status/start/submitCode/cancel/disposeAll).
  auth: claudeLogin,
  distill: runDistill,
  listBackgroundModels: listClaudeBackgroundModels,
  usage: readClaudeAccountUsage,
  availability: async () => {
    const bin = resolveClaudeBin();
    // 프로그램이 없으면 SDK를 불러오지 않는다. 프로그램이 있어도 SDK 모듈이 없으면 세션을 못 연다.
    if (!isCommandInstalled(bin)) return { available: false, reason: "not_installed" };
    if (!(await claudeSdkLoadable())) return { available: false, reason: "sdk_unavailable" };
    return cliAvailability(bin, claudeLogin);
  },
};
