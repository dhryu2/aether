/**
 * CodexServices — 세션 밖 Codex 서비스(D3). provider당 1개(모듈 싱글톤).
 *
 * 8f에서 둘을 채웠다.
 *   - **인증**(`./auth`) — 기기 코드 로그인. 상대는 대화 스레드를 만들지 않는 전용 프로세스다.
 *   - **배경 작업 모델**(`./distill`) — 기억 자동 저장·압축·검색 요약·스킬 생성의 공용 엔진.
 *     도구를 전부 제거한 격리 실행이다(D6). Claude 모델로 넘어가는 경로는 어디에도 없다
 *     (Phase 8 §0.1-4: provider 장애 시 조용한 fallback 금지).
 */
import { codexAuth } from "./auth";
import { controlRequest } from "../../codex/control";
import { usageFromCodexRateLimits } from "./usage";
import type { GetAccountRateLimitsResponse } from "../../codex/protocol/v2/GetAccountRateLimitsResponse";
import { resolveCodexBin } from "../../codex/appServer";
import { cliAvailability } from "../installed";
import { runCodexDistill, listCodexBackgroundModels, purgeOrphanDistillHomes } from "./distill";
import type { ProviderServices } from "../types";

/** app-server의 스레드 식별자는 UUIDv7이다(8a 실측) — 겉모양은 일반 UUID와 같다. */
const RESUME_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidCodexResumeKey(key: string): boolean {
  return RESUME_KEY_RE.test(key);
}

export const codexServices: ProviderServices = {
  provider: "codex",
  displayName: "Codex",
  planReview: false,
  auth: codexAuth,
  distill: runCodexDistill,
  listBackgroundModels: listCodexBackgroundModels,
  // 로그인 확인에 쓰는 제어 프로세스에 묻는다. 놀면 저절로 내려가고, 임시 인증 사본을 만들지 않는다.
  usage: async (timeoutMs) => usageFromCodexRateLimits(await controlRequest<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined, timeoutMs)),
  availability: () => cliAvailability(resolveCodexBin(), codexAuth),
  // 배경 작업이 강제 종료돼 남긴 임시 설정 폴더(복제된 인증 파일 포함)를 치운다.
  cleanupAtBoot: purgeOrphanDistillHomes,
};
