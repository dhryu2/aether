import { classifyError, isExpectedError } from "../../observability/event";
import { FailureTracker } from "../failureTracking";

/** fetch의 명확한 연결 실패와 시간 초과만 외부 환경이다. JSON 해석과 원인 불명은 수집한다. */
export function classifyOllamaServiceError<T extends Error>(error: T): T {
  if ((error instanceof TypeError && error.message === "fetch failed") || error.name === "TimeoutError") return classifyError(error, "external_environment");
  return error;
}
/**
 * Ollama 모델 목록 — Ollama 서버에 직접 묻는다.
 *
 * Codex 실행기의 `model/list`는 Codex 계정 모델(OpenAI)을 돌려준다. 공급처를 Ollama로 바꿔도 그대로라서
 * 쓸 수 없다(1단계 실측). 그래서 Ollama의 `/api/tags`가 정본이다.
 */
import { config } from "../../config";
import { st } from "../../i18n";
import type { ProviderAvailability, RuntimeModel } from "../types";
import { resolveCodexBin } from "../../codex/appServer";
import { isCommandInstalled } from "../installed";

const failures = new FailureTracker();

/** `/api/tags`의 모델 한 줄 중 쓰는 부분. `capabilities`는 Ollama가 모델마다 알려 주는 능력 목록이다. */
export type OllamaTag = { name: string; capabilities?: string[] };

/**
 * 추론 강도. Ollama는 `none`이면 생각 모드를 끄고, 다른 값이면 켠다(1단계 실측 — `low`와 `high`의 차이는 없었다).
 * 그래서 두 값만 내놓는다.
 */
const EFFORTS = ["none", "medium"] as const;
const EFFORT_TEXT: Record<(typeof EFFORTS)[number], { ko: string; en: string }> = {
  none: { ko: "생각 모드 끔 — 바로 답한다", en: "Thinking off — answers directly" },
  medium: { ko: "생각 모드 켬 — 답하기 전에 생각한다", en: "Thinking on — reasons before answering" },
};

/**
 * Ollama 모델 목록을 화면이 아는 모양으로 옮긴다.
 *
 * 도구 호출을 못 하는 모델은 뺀다. Codex 실행기는 파일 읽기와 명령 실행을 전부 도구 호출로 하므로,
 * 그런 모델을 고르면 첫 턴부터 실패한다. 능력 목록을 안 주는 옛 Ollama면 거르지 않는다.
 * 임베딩 모델도 뺀다. 능력 목록에 tools가 함께 있어도 대화 API가 거부한다(실측: Ollama 0.40.13, HTTP 400).
 * 기본 모델은 설정값이 목록에 있으면 그것, 없으면 첫 모델이다.
 */
export function toRuntimeModels(tags: readonly OllamaTag[], preferred?: string): RuntimeModel[] {
  const usable = tags.filter((t) => !t.capabilities || (t.capabilities.includes("tools") && !t.capabilities.includes("embedding")));
  const def = usable.some((t) => t.name === preferred) ? preferred : usable[0]?.name;
  return usable.map((t) => {
    const thinks = !!t.capabilities?.includes("thinking");
    return {
      value: t.name,
      displayName: t.name,
      isDefault: t.name === def,
      supportsEffort: thinks,
      ...(thinks
        ? {
            supportedEffortLevels: [...EFFORTS],
            supportedEffortDescriptions: Object.fromEntries(EFFORTS.map((e) => [e, { byLocale: EFFORT_TEXT[e] }])),
          }
        : {}),
    };
  });
}

/**
 * 이 모델을 Ollama가 올리는 대화 길이(토큰). 모델 설정(`PARAMETER num_ctx`)에 있으면 그 값이다.
 *
 * 없으면 Ollama가 메모리를 보고 자동으로 정하는데, 그 값은 미리 물어볼 길이 없다. 그때는 운영자 설정
 * (`AETHER_OLLAMA_CONTEXT_WINDOW`)을 쓴다. 자동 값과 어긋날 수 있으니 모델 설정에 길이를 박아 두는 편이 안전하다.
 */
export async function ollamaModelWindow(model: string): Promise<number> {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { parameters?: string };
      const n = parseNumCtx(body.parameters);
      failures.clear(model);
      if (n) return n;
    }
  } catch (error) {
    const source = error instanceof Error ? classifyOllamaServiceError(error) : error;
    failures.report(source, { component: "provider", operation: "provider.model_window.load", severity: "warning" }, model);
    /* 못 읽으면 운영자 설정으로 */
  }
  return config.ollamaContextWindow;
}

/** `/api/show`의 `parameters` 글에서 `num_ctx` 값을 읽는다. 없으면 undefined. */
export function parseNumCtx(parameters?: string): number | undefined {
  const m = /^num_ctx\s+(\d+)\s*$/m.exec(parameters ?? "");
  const n = m ? Number(m[1]) : NaN;
  return n > 0 ? n : undefined;
}

/** Ollama 서버에 모델 목록을 묻는다. 서버가 꺼져 있으면 주소를 담아 실패한다(세션 시작 오류로 보인다). */
export async function fetchOllamaModels(): Promise<RuntimeModel[]> {
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const error = new Error(st("notice.ollama.unreachable", { url: config.ollamaUrl, error: String((e as Error)?.message ?? e) }), { cause: e });
    const source = e instanceof Error ? classifyOllamaServiceError(e) : e;
    throw isExpectedError(source) ? classifyError(error, "external_environment") : error;
  }
  if (!res.ok) {
    const error = new Error(st("notice.ollama.listFailed", { status: String(res.status) }));
    throw [401, 403, 408, 429, 500, 502, 503, 504].includes(res.status) ? classifyError(error, "external_environment") : error;
  }
  const body = (await res.json()) as { models?: OllamaTag[] };
  const models = toRuntimeModels(body.models ?? [], config.ollamaDefaultModel);
  if (!models.length) throw new Error(st("notice.ollama.noModels"));
  return models;
}

/**
 * Ollama 세션을 지금 열 수 있는가. 세션은 Codex 실행기 위에서 돌므로 그 프로그램이 있어야 하고,
 * Ollama 서버가 응답하고 모델이 하나 이상 있어야 한다. 로그인은 없다.
 */
export async function ollamaAvailability(): Promise<ProviderAvailability> {
  if (!isCommandInstalled(resolveCodexBin())) return { available: false, reason: "not_installed", requires: "Codex" };
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  } catch {
    // 꺼진 모델 서버는 고를 수 없다는 정상 결과다. 기록하지 않는다.
    return { available: false, reason: "unreachable" };
  }
  if (!res.ok) return { available: false, reason: "unreachable" };
  try {
    const body = (await res.json()) as { models?: OllamaTag[] };
    return body.models?.length ? { available: true } : { available: false, reason: "no_models" };
  } catch {
    // 응답 모양이 틀린 서버도 쓸 수 없다고만 답한다.
    return { available: false, reason: "check_failed" };
  }
}
