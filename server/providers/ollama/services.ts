/**
 * OllamaServices — 세션 밖 Ollama 서비스.
 *
 * 로그인은 없다(로컬 모델 서버라 계정이 없다). 배경 작업은 Ollama 대화 API를 직접 부른다(`./distill`).
 */
import type { ProviderServices } from "../types";
import { runOllamaDistill, listOllamaBackgroundModels } from "./distill";
import { ollamaAvailability } from "./models";

/** 세션은 Codex 실행기 위에서 돈다. 그래서 이어가기 식별자도 Codex 스레드 식별자(UUIDv7)다. */
const RESUME_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidOllamaResumeKey(key: string): boolean {
  return RESUME_KEY_RE.test(key);
}

export const ollamaServices: ProviderServices = {
  provider: "ollama",
  displayName: "Ollama",
  planReview: false,
  distill: runOllamaDistill,
  listBackgroundModels: listOllamaBackgroundModels,
  availability: ollamaAvailability,
};
