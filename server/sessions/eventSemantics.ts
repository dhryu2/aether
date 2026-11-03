import type { AetherEvent } from "../types";
import { isControlEvent } from "../types";

type SemanticEvent = { type: string; severity?: unknown };
type SemanticCodec = { normalize(ev: AetherEvent): SemanticEvent[] };

/** 화면에서 실제 대화의 일부가 되는 중립 사건. 상태·사용량·명령 목록은 포함하지 않는다. */
const CONVERSATION_CONTENT_TYPES = new Set([
  "user_text",
  "text",
  "text_delta",
  "reasoning",
  "tool_call",
  "tool_result",
  "plan_update",
  "plan_text",
  "command_output",
]);

const ACTIVITY_TYPES = new Set([...CONVERSATION_CONTENT_TYPES, "turn_completed"]);

/** provider 원본 모양을 보지 않고, 이 사건이 대화 화면 복원에 필요한지 판정한다. */
export function isConversationContentEvent(ev: AetherEvent, codec: SemanticCodec): boolean {
  return codec.normalize(ev).some((item) => CONVERSATION_CONTENT_TYPES.has(item.type));
}

/** 마지막 대화 한 턴의 구조를 복원할 때 함께 실을 사건(본문 + 턴 종료 푸터). */
export function isConversationSeedEvent(ev: AetherEvent, codec: SemanticCodec): boolean {
  return codec.normalize(ev).some((item) => ACTIVITY_TYPES.has(item.type));
}

/**
 * 사이드바의 "마지막 사용"을 움직일 실제 활동인가.
 *
 * 사용자 입력과 화면에서 사람이 대응해야 하는 Aether 제어 사건은 활동이다. provider 원본은 중립 사건으로
 * 바꾼 뒤 대화·경고만 센다. 명령 목록, 모델/사용량 관측, 턴 시작 표지, 세션 status만으로는 움직이지 않는다.
 */
export function affectsLastActivity(ev: AetherEvent, codec: SemanticCodec): boolean {
  if (isControlEvent(ev, "user_msg")) return true;
  if (
    isControlEvent(ev, "permission_request") ||
    isControlEvent(ev, "permission_resolved") ||
    isControlEvent(ev, "question_request") ||
    isControlEvent(ev, "question_resolved") ||
    isControlEvent(ev, "plan_request") ||
    isControlEvent(ev, "plan_resolved") ||
    isControlEvent(ev, "command_operation")
  ) {
    return true;
  }
  return codec
    .normalize(ev)
    .some((item) => ACTIVITY_TYPES.has(item.type) || (item.type === "provider_notice" && item.severity !== undefined));
}
