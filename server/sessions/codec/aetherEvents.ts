/**
 * Aether가 직접 소유하는 사건 중 화면 계약(AgentEvent)으로도 보여야 하는 것을 모든 codec에 한 번에 입힌다.
 *
 * 지금은 `todo_list`(할 일 도구가 남긴 목록)를 `plan_update`로 바꾼다. Codex·Grok 원본 계획 알림이
 * 이미 같은 `plan_update`로 오므로, 어느 길로 와도 화면이 받는 모양이 같다.
 * provider마다 변환을 따로 짜지 않는다 — 가짜 provider와 앞으로 생길 provider도 저절로 같은 동작을 얻는다.
 */
import { buildAgentEvents } from "../../../shared/agentEvent";
import type { AetherEvent } from "../../types";
import { isControlEvent } from "../../types";
import type { ProviderEventCodec } from "./types";

export function withAetherEvents(codec: ProviderEventCodec): ProviderEventCodec {
  return {
    ...codec,
    normalize: (ev: AetherEvent) =>
      isControlEvent(ev, "todo_list")
        ? buildAgentEvents(ev, codec.provider, [{ type: "plan_update", items: ev.items }])
        : codec.normalize(ev),
  };
}
