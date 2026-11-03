/**
 * Grok 모델 목록 읽기 — ACP `initialize` 응답의 `_meta.modelState`에서 중립 목록을 만든다.
 *
 * 대화 런타임의 준비 신호와 배경 작업의 목록 조회가 같은 함수를 쓴다(지문이 두 경로에서 같게 나와야 한다).
 * Grok에는 별칭도 기본값 선택지도 없어서 중립 필드(`followsAccountDefault`, `movingAlias`)는 채우지 않는다.
 * 실측(2026-10-15, CLI 1.0.50): 표시 이름은 `name`으로 온다. 옛 모양(`displayName`)도 받는다.
 */
import type { RuntimeModel } from "../types";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function readGrokModels(init: Record<string, unknown>): RuntimeModel[] {
  const meta = asRecord(init._meta);
  const state = asRecord(meta?.modelState);
  const current = typeof state?.currentModelId === "string" ? state.currentModelId : undefined;
  const list = Array.isArray(state?.availableModels) ? state.availableModels : [];
  const models: RuntimeModel[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    const value = String(rec?.modelId ?? rec?.id ?? "").trim();
    if (!value) continue;
    const extra = asRecord(rec?._meta);
    const effortsRaw = Array.isArray(extra?.reasoningEfforts) ? extra.reasoningEfforts : Array.isArray(rec?.reasoningEfforts) ? rec.reasoningEfforts : [];
    const levels = effortsRaw
      .map((e) => {
        if (typeof e === "string") return e;
        const r = asRecord(e);
        return typeof r?.value === "string" ? r.value : typeof r?.id === "string" ? r.id : "";
      })
      .filter(Boolean);
    const descriptions = Object.fromEntries(
      effortsRaw
        .map((e) => {
          const r = asRecord(e);
          const key = typeof r?.value === "string" ? r.value : typeof r?.id === "string" ? r.id : "";
          const text = typeof r?.label === "string" ? r.label : typeof r?.description === "string" ? r.description : "";
          return key && text ? [key, { text }] : null;
        })
        .filter((x): x is [string, { text: string }] => !!x),
    );
    models.push({
      value,
      displayName: typeof rec?.displayName === "string" ? rec.displayName : typeof rec?.name === "string" ? rec.name : value,
      isDefault: value === current || rec?.isDefault === true,
      supportsEffort: levels.length > 0,
      supportedEffortLevels: levels,
      ...(typeof extra?.reasoningEffort === "string" ? { defaultEffort: extra.reasoningEffort } : {}),
      ...(Object.keys(descriptions).length ? { supportedEffortDescriptions: descriptions } : {}),
    });
  }
  if (models.length && !models.some((m) => m.isDefault)) models[0].isDefault = true;
  return models;
}
