/**
 * Grok 문맥 점유량 — 실측 2026-08-22.
 *
 * ACP `usage_update.used/size`와 `session_info_update.used/size`는 라이브에서 안 온다.
 * `session_info_update`는 제목만 싣는다. 점유량은 `session/update` params `_meta.totalTokens`다.
 * 창 크기는 스트림에 없고, grok-4.6 공식 창은 500,000토큰이다. 스트림이 크기를 주면 그걸 쓴다.
 */
import type { ContextUsage } from "../types";

/** grok-4.6 공식 문맥 창. 스트림이 크기를 안 줄 때만 쓴다. */
export const GROK_CONTEXT_WINDOW = 500_000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return null;
}

function usageFromRecord(rec: Record<string, unknown> | null): { used: number | null; size: number | null } {
  if (!rec) return { used: null, size: null };
  const nested = asRecord(rec.usage) ?? asRecord(rec.tokenUsage) ?? asRecord(rec.context);
  const used =
    num(rec.totalTokens) ??
    num(rec.used) ??
    num(rec.usedTokens) ??
    num(rec.tokens) ??
    num(nested?.totalTokens) ??
    num(nested?.used);
  const size =
    num(rec.maxTokens) ??
    num(rec.size) ??
    num(rec.contextWindow) ??
    num(nested?.maxTokens) ??
    num(nested?.size);
  return { used, size };
}

/**
 * session/update 알림의 params(또는 동등한 객체)에서 문맥 점유량을 읽는다.
 * 점유량이 없으면 null. 크기만 없으면 공식 창을 쓴다.
 */
export function contextUsageFromGrokNotice(params: unknown, fallbackWindow = GROK_CONTEXT_WINDOW): ContextUsage | null {
  const rec = asRecord(params);
  const meta = usageFromRecord(asRecord(rec?._meta));
  const update = usageFromRecord(asRecord(rec?.update) ?? rec);
  const used = meta.used ?? update.used;
  const size = meta.size ?? update.size ?? (used != null ? fallbackWindow : null);
  if (used == null || size == null || size <= 0) return null;
  return { totalTokens: used, maxTokens: size };
}
