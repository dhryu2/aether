/**
 * 1a importer 시험용 codec. 등록표에 넣지 않는다.
 * id는 claude/codex/grok가 아니다.
 */
import type { ProviderEventCodec } from "../../sessions/codec/types";
import type { AetherEvent } from "../../types";
import type { AgentEvent } from "../../../shared/agentEvent";

export const IMPORT_FAKE_PROVIDER = "mock-workspace" as const;

export const importFakeCodec: ProviderEventCodec = {
  provider: IMPORT_FAKE_PROVIDER,
  normalize(ev: AetherEvent): AgentEvent[] {
    const anyEv = ev as AetherEvent & { kind?: string; text?: unknown; seq?: number; ts?: number };
    if (anyEv.kind === "fixture_text" && typeof anyEv.text === "string") {
      return [
        {
          provider: IMPORT_FAKE_PROVIDER,
          seq: typeof anyEv.seq === "number" ? anyEv.seq : 0,
          part: 0,
          ts: typeof anyEv.ts === "number" ? anyEv.ts : 0,
          type: "text",
          text: anyEv.text,
        },
      ];
    }
    return [];
  },
  fileEdits: () => [],
  isLiveOnly: () => false,
  endsTurn(ev) {
    return ev.kind === "status";
  },
  isAuthExpired: () => false,
  persistFilter: () => ({
    restore: () => {},
    apply: (e) => e,
  }),
};
