/**
 * GrokServices — 세션 밖 Grok 서비스 (Phase 10d).
 *
 * 인증은 기기코드(`grok login --device-auth`). 배경 작업은 격리 `grok -p`(D6).
 */
import type { ProviderServices } from "../types";
import { grokAuth } from "./auth";
import { resolveGrokBin } from "./transport";
import { cliAvailability } from "../installed";
import { runGrokDistill, listGrokBackgroundModels, purgeOrphanGrokDistillHomes } from "./distill";

/** ACP sessionId는 UUIDv7 형태다(10a). 겉모양은 일반 UUID와 같다. */
const RESUME_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidGrokResumeKey(key: string): boolean {
  return RESUME_KEY_RE.test(key);
}

export const grokServices: ProviderServices = {
  provider: "grok",
  displayName: "Grok",
  planReview: true,
  auth: grokAuth,
  distill: runGrokDistill,
  listBackgroundModels: listGrokBackgroundModels,
  availability: () => cliAvailability(resolveGrokBin(), grokAuth),
  cleanupAtBoot: purgeOrphanGrokDistillHomes,
};
