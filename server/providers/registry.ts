/**
 * provider 등록표 (Phase 8d · D3/D12). "provider 이름 → 구현" 연결이 여기 한 곳에만 있다.
 *
 * 8d에선 claude만 등록했고, **8e가 codex를 더했다** — 세션 생성·복원 경로는 한 줄도 안 고쳤다.
 * 그게 8d~8d-3에서 추상화를 끝까지 관철한 이유이고, 세 번째 provider도 여기 한 줄로 붙어야 한다.
 * 등록되지 않은 이름은 조용히 다른 provider로 넘기지 않고 명시적 에러를 낸다(§0.1-4 — 조용한 fallback 금지).
 */
import { config } from "../config";
import { st } from "../i18n";
import { ClaudeRuntime } from "../sessions/runtimes/claude";
import { CodexRuntime } from "../sessions/runtimes/codex";
import { GrokRuntime } from "../sessions/runtimes/grok";
import { claudeCodec } from "../sessions/codec/claude";
import { codexCodec, codexCodecFor } from "../sessions/codec/codex";
import { grokCodec } from "../sessions/codec/grok";
import { withAetherEvents } from "../sessions/codec/aetherEvents";
import { claudeServices, isValidClaudeResumeKey } from "./claude/services";
import { codexServices, isValidCodexResumeKey } from "./codex/services";
import { grokServices, isValidGrokResumeKey } from "./grok/services";
import { ollamaBackend } from "./ollama/backend";
import { isValidOllamaResumeKey, ollamaServices } from "./ollama/services";
import type { ProviderEventCodec } from "../sessions/codec/types";
import { bindDistillPinLookup } from "./distillModel";
import type { AgentRuntime, ProviderAvailability, ProviderId, ProviderServices, RuntimeStartOptions } from "./types";

export type ProviderEntry = {
  readonly id: ProviderId;
  readonly services: ProviderServices;
  /**
   * 사용자가 모델을 안 고른 세션이 쓸 이름(미설정이면 그 provider의 계정 기본 모델).
   * provider마다 모델 이름 어휘가 다르므로 설정도 provider별로 따로 읽는다.
   */
  readonly defaultModel?: string;
  /**
   * 운영자가 못 박은 배경 작업 모델. 공통 distill 선택은 여기만 본다.
   * 없으면 저장값·자동 고르기. 환경변수 이름은 이 항목을 채우는 adapter 쪽 설정이다.
   */
  readonly distillModel?: string;
  /** 핀이 실패했을 때 로그에 찍을 출처 이름(환경변수). */
  readonly distillModelPinSource?: string;
  /** 배경 작업 모델 저장 파일 이름(데이터 폴더 기준). 없으면 `distill-model-<id>.json`. 옛 파일을 이어 쓰는 provider만 적는다. */
  readonly distillCacheFile?: string;
  /** 이 provider 이벤트의 수명주기 판정(D2.6). provider당 1개(순수 — 세션 상태는 persistFilter()가 든다). */
  readonly codec: ProviderEventCodec;
  /**
   * 클라가 넘긴 이어가기 식별자가 이 provider의 형식인가 — 임의 문자열 주입 차단.
   * 코어는 식별자의 의미를 모르므로(D12) 형식 판정도 provider 몫이다.
   */
  isValidResumeKey(key: string): boolean;
  createRuntime(opts: RuntimeStartOptions): AgentRuntime;
};

/** provider 칸이 생기기 전에 만들어진 세션이 쓰던 provider. 옛 데이터를 읽을 때만 쓰는 상수다. */
const UNTAGGED_META_PROVIDER: ProviderId = "claude";

/**
 * 디스크에서 읽은 provider 값을 해석한다. provider 칸이 생기기 전 세션은 모두 Claude였다(무마이그레이션 호환 — D12).
 * 디스크에서 읽은 값을 해석할 때만 부른다. 새 세션을 만드는 경로에서는 부르지 않는다.
 */
export function storedProviderId(saved: string | undefined): string {
  return saved?.trim() || UNTAGGED_META_PROVIDER;
}

const PROVIDERS: Partial<Record<ProviderId, ProviderEntry>> = {
  claude: {
    id: "claude",
    services: claudeServices,
    defaultModel: config.claudeDefaultModel,
    distillModel: config.reflectModel,
    distillModelPinSource: "AETHER_REFLECT_MODEL",
    distillCacheFile: "distill-model.json",
    codec: withAetherEvents(claudeCodec),
    isValidResumeKey: isValidClaudeResumeKey,
    createRuntime: (opts) => new ClaudeRuntime(opts),
  },
  codex: {
    id: "codex",
    services: codexServices,
    defaultModel: config.codexDefaultModel,
    distillModel: config.codexDistillModel,
    distillModelPinSource: "AETHER_CODEX_DISTILL_MODEL",
    codec: withAetherEvents(codexCodec),
    isValidResumeKey: isValidCodexResumeKey,
    createRuntime: (opts) => new CodexRuntime(opts),
  },
  grok: {
    id: "grok",
    services: grokServices,
    defaultModel: config.grokDefaultModel || "grok-4.6",
    distillModel: config.grokDistillModel,
    distillModelPinSource: "AETHER_GROK_DISTILL_MODEL",
    codec: withAetherEvents(grokCodec),
    isValidResumeKey: isValidGrokResumeKey,
    createRuntime: (opts) => new GrokRuntime(opts),
  },
  // 실행기는 Codex이고 모델만 로컬 Ollama다. 이벤트 모양이 Codex와 같아 Codex codec을 쓰되 이름만 ollama로 찍는다.
  ollama: {
    id: "ollama",
    services: ollamaServices,
    defaultModel: config.ollamaDefaultModel,
    distillModel: config.ollamaDistillModel,
    distillModelPinSource: "AETHER_OLLAMA_DISTILL_MODEL",
    codec: withAetherEvents(codexCodecFor("ollama")),
    isValidResumeKey: isValidOllamaResumeKey,
    createRuntime: (opts) => new CodexRuntime(opts, ollamaBackend()),
  },
};

/**
 * 계약 검증용 임시 등록(테스트 전용) — 반환 함수로 원복한다.
 *
 * 8d-2 완료 게이트 ③은 "Claude가 아닌 provider를 끼워도 세션 생성·정규화·영속·복원·턴 종료 판정이
 * 그대로 성립하는가"를 실모델 없이 반증하는 것이다. 그러려면 두 번째 항목을 이 표에 실제로 넣어봐야 하는데,
 * 표가 파일 안에 닫혀 있으면 그 검증 자체가 불가능하다. 통로를 여기 하나만 두고 이름으로 용도를 못박는다.
 * 프로덕션 경로는 이 함수를 부르지 않는다(`test:boundary`가 호출처를 test/로 제한한다).
 */
export function __registerProviderForTest(entry: ProviderEntry): () => void {
  const prev = PROVIDERS[entry.id];
  PROVIDERS[entry.id] = { ...entry, codec: withAetherEvents(entry.codec) };
  return () => {
    if (prev) PROVIDERS[entry.id] = prev;
    else delete PROVIDERS[entry.id];
  };
}

/** 등록된 provider의 구현 묶음. 미등록이면 throw(호출부가 사용자에게 이유를 노출). */
export function providerEntry(id: string): ProviderEntry {
  const entry = PROVIDERS[id as ProviderId];
  if (!entry) throw new Error(st("notice.session.providerUnsupported", { provider: String(id) }));
  return entry;
}

/** 등록된 provider 전부(등록 순). 카탈로그 노출·설정 UI가 쓴다 — 8e에서 codex가 더해지면 자동 반영된다. */
export function listProviders(): ProviderEntry[] {
  return Object.values(PROVIDERS).filter((e): e is ProviderEntry => !!e);
}

/** 지금 쓸 수 있는 provider(등록 순). 전부에 가용성을 동시에 물어, 쓸 수 있는 것만 남긴다. */
export async function availableProviders(): Promise<ProviderEntry[]> {
  const all = listProviders();
  const results = await Promise.all(all.map((e) => providerAvailability(e)));
  return all.filter((_, i) => results[i].available);
}

/** 확인 하나가 이보다 오래 걸리면 고를 수 없다고 답한다. 새 세션 창이 오래 멈추지 않게 한다. */
const AVAILABILITY_TIMEOUT_MS = 15_000;

/** 등록된 provider를 지금 쓸 수 있는가. 확인이 던지거나 늦으면 check_failed로 답한다. */
export async function providerAvailability(entry: ProviderEntry): Promise<ProviderAvailability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ProviderAvailability>((resolve) => {
    timer = setTimeout(() => resolve({ available: false, reason: "check_failed" }), AVAILABILITY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([entry.services.availability(), late]);
  } catch {
    // 어댑터의 확인 실패는 고를 수 없다는 뜻으로만 쓴다. 원인은 어댑터가 기록한다.
    return { available: false, reason: "check_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 세션 인스턴스가 없는 저수준 경로(디스크 replay·검색 백필·꼬리 판정)에서 codec을 고를 때 쓴다.
 * 디스크에서 읽은 값이면 호출부가 storedProviderId를 거친다. 등록되지 않은 이름이면 providerEntry가 throw한다.
 */
export function codecFor(id: string): ProviderEventCodec {
  return providerEntry(id).codec;
}

bindDistillPinLookup((id) => {
  const entry = PROVIDERS[id];
  if (!entry) return undefined;
  return { model: entry.distillModel, source: entry.distillModelPinSource, cacheFile: entry.distillCacheFile };
});
