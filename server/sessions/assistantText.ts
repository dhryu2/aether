import { failuresFor } from "../providers/failureTracking";
/**
 * 버퍼에서 이번 턴 assistant 본문만 고른다. HTTP·events()·provider 이름 없음.
 */
import { isControlEvent, type AetherEvent } from "../types";
import type { ProviderEventCodec } from "./codec/types";

export function assistantTextFromBuffer(
  events: readonly AetherEvent[],
  codec: ProviderEventCodec,
  afterUserText?: string,
  sessionId?: string,
): string | null {
  const failureKey = `assistant:${sessionId ?? "unknown"}`;
  let boundarySeq: number | null = null;
  if (afterUserText !== undefined) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && isControlEvent(ev, "user_msg") && ev.text === afterUserText) {
        boundarySeq = ev.seq;
        break;
      }
    }
    if (boundarySeq === null) return null;
  } else {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.kind === "user_msg") {
        boundarySeq = ev.seq;
        break;
      }
    }
    if (boundarySeq === null) return null;
  }

  let failed = false;
  let last: string | null = null;
  for (const ev of events) {
    if (ev.seq <= boundarySeq) continue;
    let parts;
    try {
      parts = codec.normalize(ev);
    } catch (error) {
      failed = true;
      failuresFor(codec).report(error, { component: "session", operation: "session.assistant.normalize", severity: "warning", session_id: sessionId }, failureKey);
      continue;
    }
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        last = part.text;
      }
    }
  }
  if (!failed) failuresFor(codec).clear(failureKey);
  return last;
}
