import { classifyError, isExpectedError } from "../../observability/event";
/**
 * Ollama 배경 작업 — 기억 자동 저장·압축·검색 요약·스킬 생성 (D6).
 *
 * Codex 실행기를 거치지 않고 Ollama 대화 API를 직접 한 번 부른다. 이유는 둘이다.
 *   ① 도구가 구조적으로 없다. 요청에 도구 정의를 아예 싣지 않으므로 모델이 무엇을 실행할 길이 없다.
 *      Codex 배경 작업처럼 도구를 하나씩 끄고 격리를 관측할 필요가 없다.
 *   ② 빠르다. Codex의 기본 지시문(약 9천 토큰)을 매번 처리하지 않는다. 로컬 모델에서는 이 차이가 크다.
 *
 * 생각 모드는 끈다 — 짧은 글을 정해진 형식으로 뽑는 일이라 필요 없고, 생각 글이 답에 섞이지 않는다.
 * `cwd`는 받지만 쓰지 않는다. 프롬프트에 필요한 내용이 이미 다 들어 있다.
 *
 * 옵션 세 형태(배경 작업 모델 측정 계획 8절): 옵션이 없으면 운영자 고정값, 없으면 공통 고르기(`resolveAndApply`),
 * 그래도 못 정하면 아래 `distillModel` 규칙. 계정 기본이면 목록의 기본 모델.
 * 명시면 로컬 목록과 대조해 없으면 `UnknownModelNameError`를 던진다. effort는 대화 목록과 같은 두 값이다 —
 * `none`이거나 없으면 생각 모드를 끄고, 그 밖의 값이면 켠다.
 */
import { config } from "../../config";
import { st } from "../../i18n";
import { reportError } from "../../observability/report";
import { UnknownModelNameError, resolveAndApply } from "../distillModel";
import type { DistillOptions, RuntimeModel } from "../types";
import { classifyOllamaServiceError, fetchOllamaModels } from "./models";

/** 공통 고르기가 못 정했을 때의 모델: 운영자 핀 → Ollama 목록의 기본 모델. 세션 기본 모델은 고정값이 아니다. */
async function distillModel(): Promise<string> {
  const pinned = config.ollamaDistillModel;
  if (pinned) return pinned;
  const models = await fetchOllamaModels();
  return models.find((m) => m.isDefault)?.value ?? models[0].value;
}

/** 요청 본문. 도구 정의가 없다는 것이 격리의 전부라 테스트가 이 모양을 대조한다. */
export function distillRequestBody(model: string, prompt: string, effort?: string) {
  return { model, stream: false, think: !!effort && effort !== "none", messages: [{ role: "user", content: prompt }] };
}

/** 이번 실행의 모델과 effort. */
async function distillChoice(opts: DistillOptions): Promise<{ model: string; effort?: string }> {
  if (opts?.use === "explicit") {
    const models = await fetchOllamaModels();
    if (!models.some((m) => m.value === opts.model)) throw classifyError(new UnknownModelNameError(opts.model), "external_environment");
    return { model: opts.model, effort: opts.effort };
  }
  if (opts?.use === "account_default") {
    const models = await fetchOllamaModels();
    return { model: models.find((m) => m.isDefault)?.value ?? models[0].value };
  }
  // 공통 고르기(운영자 고정값 → 저장값 → 새로 고르기). 못 고르면 아래 기존 규칙(고정값 → 목록의 기본 모델)으로 간다.
  // 예외 없음: 로컬 모델이 모두 단가 0이라 한 가격대로 묶이면, 그 안에서 가장 최근 모델이 골라질 수 있다.
  try {
    const models = await fetchOllamaModels();
    const names = new Set(models.map((m) => m.value));
    const picked = await resolveAndApply(
      "ollama",
      models,
      async (m) => { if (!names.has(m)) throw classifyError(new UnknownModelNameError(m), "external_environment"); },
      (p) => runOllamaDistill(p, "", { use: "account_default" }),
      (model, p) => runOllamaDistill(p, "", { use: "explicit", model }),
    );
    if (picked) return { model: picked };
  } catch (e) {
    void reportError(e, { component: "providers", operation: "provider.ollama.distill_pick", severity: "warning" });
    console.error("[aether] Ollama 배경 작업 모델 고르기 실패 — 기본 모델로 진행한다:", e);
  }
  return { model: await distillModel() };
}

/** 턴을 쓰지 않는 모델 목록 조회 — 배경 작업 측정용. 로컬 Ollama 목록 그대로다(별칭·기본값 선택지 없음). */
export function listOllamaBackgroundModels(): Promise<RuntimeModel[]> {
  return fetchOllamaModels();
}

export async function runOllamaDistill(prompt: string, _cwd: string, opts?: DistillOptions): Promise<string> {
  const { model, effort } = await distillChoice(opts);
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(distillRequestBody(model, prompt, effort)),
      signal: AbortSignal.timeout(config.distillTimeoutMs),
    });
  } catch (e) {
    const error = new Error(st("notice.ollama.distillFailed", { model, error: String((e as Error)?.message ?? e) }), { cause: e });
    const source = e instanceof Error ? classifyOllamaServiceError(e) : e;
    throw isExpectedError(source) ? classifyError(error, "external_environment") : error;
  }
  if (!res.ok) {
    const error = new Error(st("notice.ollama.distillFailed", { model, error: `HTTP ${res.status} ${(await res.text()).slice(0, 300)}` }));
    throw [401, 403, 408, 429, 500, 502, 503, 504].includes(res.status) ? classifyError(error, "external_environment") : error;
  }
  const body = (await res.json()) as { message?: { content?: string }; done_reason?: string };
  // ★ 끝까지 못 쓴 답을 성공으로 돌려주면 호출자가 잘린 결과를 정상으로 받아들인다(Codex 배경 작업과 같은 규율).
  if (body.done_reason && body.done_reason !== "stop") throw new Error(st("notice.ollama.distillIncomplete", { reason: body.done_reason }));
  return (body.message?.content ?? "").trim();
}
