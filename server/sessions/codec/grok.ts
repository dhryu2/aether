/**
 * Grok codec (Phase 10c · D2.6) — 수명주기 판정.
 *
 * 청크는 라이브 전용. 턴 종료는 runtime이 만든 `session/prompt_result`(ACP 요청의 stopReason).
 */
import { isAuthError } from "../../auth/loginParse";
import { GrokPersistFilter } from "../../providers/grok/persistFilter";
import { normalizeGrok } from "../normalize/grok";
import type { EventShape, ProviderEventCodec } from "./types";

type GrokRaw = { kind: "grok"; msg: { method?: unknown; params?: unknown } };

function isGrokRaw(ev: EventShape): ev is GrokRaw {
  return ev.kind === "grok";
}

function methodOf(ev: EventShape): string | undefined {
  if (!isGrokRaw(ev)) return undefined;
  return typeof ev.msg?.method === "string" ? ev.msg.method : undefined;
}

function sessionUpdateOf(ev: EventShape): string | undefined {
  if (!isGrokRaw(ev) || ev.msg?.method !== "session/update") return undefined;
  const params = ev.msg.params as { update?: { sessionUpdate?: unknown } } | undefined;
  return typeof params?.update?.sessionUpdate === "string" ? params.update.sessionUpdate : undefined;
}

const LIVE_ONLY_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

function failureText(ev: EventShape): string {
  if (!isGrokRaw(ev)) return "";
  const params = ev.msg.params as Record<string, unknown> | undefined;
  if (methodOf(ev) === "error") {
    return [params?.message, params?.error].filter((v) => typeof v === "string").join(" ");
  }
  if (methodOf(ev) === "session/prompt_result") {
    const stop = params?.stopReason;
    if (stop === "cancelled" || stop === "end_turn") return typeof params?.error === "string" ? params.error : "";
    if (typeof params?.error === "string") return params.error;
    if (typeof stop === "string") return stop;
  }
  return "";
}

export const grokCodec: ProviderEventCodec = {
  provider: "grok",
  normalize: normalizeGrok,
  isLiveOnly: (ev) => {
    const u = sessionUpdateOf(ev);
    return u !== undefined && LIVE_ONLY_UPDATES.has(u);
  },
  endsTurn: (ev) => methodOf(ev) === "session/prompt_result",
  isAuthExpired: (ev) => isAuthError(failureText(ev)),
  persistFilter: () => new GrokPersistFilter(),
};
