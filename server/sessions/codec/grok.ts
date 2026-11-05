/**
 * Grok codec (Phase 10c · D2.6) — 수명주기 판정.
 *
 * 청크는 라이브 전용. 턴 종료는 runtime이 만든 `session/prompt_result`(ACP 요청의 stopReason).
 */
import { isAuthError } from "../../auth/loginParse";
import { GrokPersistFilter } from "../../providers/grok/persistFilter";
import { grokFileChangeCall, normalizeGrok } from "../normalize/grok";
import type { EventShape, FileEdit, ProviderEventCodec } from "./types";

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

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * tool_call·tool_call_update의 파일 변경 조각. ACP content[]의 diff 블록({path, oldText, newText})을 먼저 보고,
 * 없으면 rawInput의 경로와 old_string/new_string/content를 본다. 실제 모양을 다 확인하지 못해 못 읽으면 빈 배열이다.
 */
function grokFileEdits(ev: EventShape): FileEdit[] {
  const u = sessionUpdateOf(ev);
  if (u !== "tool_call" && u !== "tool_call_update") return [];
  const update = rec((ev as { msg: { params?: { update?: unknown } } }).msg.params?.update);
  if (!update) return [];
  // tool_call은 normalize가 파일 변경으로 본 것만 낸다(같은 판정 함수). update는 도구 종류를 싣지 않으므로 diff 블록만 본다.
  const call = u === "tool_call" ? grokFileChangeCall(update) : null;
  const toolId = call?.toolId ?? (typeof update.toolCallId === "string" ? update.toolCallId : "");
  if (!toolId || (u === "tool_call" && !call)) return [];
  const out: FileEdit[] = [];
  if (Array.isArray(update.content)) {
    for (const b of update.content) {
      const blk = rec(b);
      if (blk?.type !== "diff" || typeof blk.path !== "string" || !blk.path || typeof blk.newText !== "string") continue;
      if (typeof blk.oldText === "string") out.push({ toolId, path: blk.path, before: blk.oldText, after: blk.newText });
      else if (blk.oldText == null) out.push({ toolId, path: blk.path, after: blk.newText, isCreate: true });
    }
  }
  if (out.length || !call?.input) return out;
  const raw = call.input;
  const p = [raw.file_path, raw.path, raw.target_file].find((v): v is string => typeof v === "string" && !!v);
  if (!p) return [];
  if (typeof raw.old_string === "string" && typeof raw.new_string === "string") {
    return [{ toolId, path: p, before: raw.old_string, after: raw.new_string, ...(raw.replace_all === true ? { replaceAll: true } : {}) }];
  }
  return typeof raw.content === "string" ? [{ toolId, path: p, after: raw.content }] : [];
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
  fileEdits: grokFileEdits,
  isLiveOnly: (ev) => {
    const u = sessionUpdateOf(ev);
    return u !== undefined && LIVE_ONLY_UPDATES.has(u);
  },
  endsTurn: (ev) => methodOf(ev) === "session/prompt_result",
  isAuthExpired: (ev) => isAuthError(failureText(ev)),
  persistFilter: () => new GrokPersistFilter(),
};
