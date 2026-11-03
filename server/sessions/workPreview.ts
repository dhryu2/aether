import { failuresFor } from "../providers/failureTracking";
/**
 * 작업 목록 카드에 올릴 마지막 말. 꼬리만 보고, 사용자 말 또는 모델의 본문 텍스트를 고른다.
 */
import { clampWorkPreview } from "../../shared/workTitle";
import type { AgentEvent } from "../../shared/agentEvent";
import type { AetherEvent } from "../types";
import type { ProviderEventCodec } from "./codec/types";

export function lastWorkPreview(events: readonly AetherEvent[], codec: ProviderEventCodec, sessionId?: string): string {
  const failureKey = `preview:${sessionId ?? "unknown"}`;
  let failed = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === "user_msg" && "text" in ev) {
      const text = typeof ev.text === "string" ? ev.text : "";
      const preview = clampWorkPreview(text);
      if (preview) { if (!failed) failuresFor(codec).clear(failureKey); return preview; }
    }
    let parts: AgentEvent[] = [];
    try {
      parts = codec.normalize(ev);
    } catch (error) {
      failed = true;
      failuresFor(codec).report(error, { component: "session", operation: "session.preview.normalize", severity: "warning", session_id: sessionId }, failureKey);
      continue;
    }
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if ((part.type === "text" || part.type === "user_text") && part.text?.trim()) {
        const preview = clampWorkPreview(part.text);
        if (preview) { if (!failed) failuresFor(codec).clear(failureKey); return preview; }
      }
    }
  }
  if (!failed) failuresFor(codec).clear(failureKey);
  return "";
}
