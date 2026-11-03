/**
 * Ollama 세션을 띄우는 Codex 실행기 설정.
 *
 * Ollama는 모델 서버일 뿐 파일 읽기·명령 실행을 하지 않는다. 그래서 Codex 실행기를 띄우고 모델 공급처만
 * Ollama로 바꾼다. 1단계 실측(내부 실측)에서 스레드 시작·승인 카드·재시작 뒤 이어가기가
 * 모두 이 설정으로 동작했다. 로그인은 필요 없다.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config";
import type { CodexBackend } from "../../sessions/runtimes/codex";
import { fetchOllamaModels, ollamaModelWindow } from "./models";
import { ollamaServices } from "./services";

/** Aether가 Codex에 등록하는 공급처 이름. 사용자 `~/.codex` 설정과 겹치지 않게 접두사를 붙인다. */
const PROVIDER_KEY = "aether_ollama";

/**
 * Codex 실행별 설정. 공급처 정의만 넘긴다.
 * 대화 길이는 모델마다 달라서 프로세스가 아니라 대화(스레드)를 열 때 넘긴다(`contextWindow`).
 */
export function ollamaConfigOverrides(url = config.ollamaUrl): string[] {
  return [
    `model_provider="${PROVIDER_KEY}"`,
    `model_providers.${PROVIDER_KEY}.name="Ollama"`,
    `model_providers.${PROVIDER_KEY}.base_url=${JSON.stringify(`${url}/v1`)}`,
    `model_providers.${PROVIDER_KEY}.wire_api="responses"`,
  ];
}

/**
 * Ollama 세션 전용 Codex 설정 폴더.
 *
 * 진짜 Codex 세션과 따로 둔다. 같이 쓰면 Ollama 대화가 Codex 대화 목록에 섞이고, 사용자의 Codex
 * 승인 규칙(`rules/*.rules`)이 Ollama 세션에도 걸린다. 이어가기 기록이 여기 쌓이므로 임시 폴더가 아니다.
 */
function ollamaCodexHome(): string {
  const dir = path.join(config.dataDir, "ollama-codex-home");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ollamaBackend(): CodexBackend {
  return {
    provider: "ollama",
    services: ollamaServices,
    // 사용량 한도는 없다(로컬 모델). 화면은 그 칸을 그리지 않는다.
    capabilities: { supportedModels: true, usage: false, planReview: false },
    configOverrides: ollamaConfigOverrides(),
    env: { CODEX_HOME: ollamaCodexHome() },
    listModels: fetchOllamaModels,
    contextWindow: ollamaModelWindow,
    autoReview: false,
    fileChangeApproval: false,
  };
}
