/**
 * Claude `/compact` 진행 카드가 읽는 SDK 신호 판정. 원본 메시지 모양은 Claude adapter 안에서만 읽는다(D2.6).
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** 넣은 입력 하나의 처리가 끝났다는 신호(모델 턴·로컬 명령 공통). */
export function endsClaudeTurn(msg: SDKMessage): boolean {
  return msg.type === "result";
}

/**
 * 직접 시킨 `/compact`가 끝났는지 SDK 메시지에서 읽는다. 끝이 아니면 null.
 *
 * 실측(2026-09-30, haiku): 정상 압축은 `status:"compacting"` 상태가 오다가 `compact_result`를 실은 상태
 * 신호로 끝나고, 뒤이어 명령 턴의 `result`가 온다. 대화가 비어 있으면 상태 신호 없이
 * "No messages to compact" 문장과 `result`(is_error=false)만 온다. 그래서 결과 신호보다 `result`가 먼저
 * 오면 압축이 일어나지 않은 것으로 본다.
 */
export function compactOutcome(msg: SDKMessage): "completed" | "failed" | null {
  if (msg.type === "system" && msg.subtype === "status" && msg.compact_result) {
    return msg.compact_result === "success" ? "completed" : "failed";
  }
  if (endsClaudeTurn(msg)) return "failed";
  return null;
}
