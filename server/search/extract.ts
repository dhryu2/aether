/**
 * 검색 인덱싱용 텍스트 추출 — AetherEvent → codec.normalize(AgentEvent[]) → IndexItem[].
 *
 * Phase 8b: 중앙 normalize 모듈(sessions/normalize/claude.ts)을 경유하도록 전환했다.
 *   과거 이 파일이 직접 하던 블록 분해·역할 분리는 이제 normalize가 AgentEvent로 수행하고,
 *   여기서는 색인 대상 AgentEvent(user_text/text/tool_call/tool_result)만 IndexItem(역할·내용·part)으로 사상한다.
 *   비색인 AgentEvent(reasoning·text_delta·plan_update·turn_completed·usage_update·provider_notice)는 걸러진다.
 *   → 검색 결과 동등성 유지(무회귀), part은 AgentEvent (seq,part) 식별자를 그대로 사용(SSOT).
 *
 * 입력은 *toPersist*(영속 직전 redact/clamp본)여야 한다 — 비밀 파일 경로의 tool_result는 이미 마커로 치환,
 * 16KB clamp 적용본. 명령줄 값 가림은 2026-10-21 사용자 결정으로 없앴다. 그래서 색인은 events.jsonl과 같은 내용이다.
 *
 * 매핑:
 *   user_text    → [{user, 내용}]                 (1행)
 *   text         → [{assistant_interim, 내용}]    (자세한 이유는 아래 "작업 도중의 말" 절)
 *   tool_call    → [{tool, "⚙ 도구(인자)"}]        (action)
 *   tool_result  → [{tool, "▸ 결과"}] (내용 있을 때만)
 *   도구 항목에는 tool(id, 호출이면 kind)을 붙인다 — 검색용 표 정제기(refineLetter.ts)가 결과의 종별을 찾을 때 쓴다.
 *
 * 작업 도중의 말:
 *   모델은 한 턴 안에서 여러 번 말한다 — "이제 모달 껍데기를 고치겠습니다" 같은 진행 보고가 대부분이고,
 *   진짜 답은 맨 마지막 한 마디다. 앞의 것들이 검색에 걸리면 사람이 찾으려던 게 아닌 결과만 잔뜩 나오고,
 *   화면에도 안 남는 말이라 결과를 눌러도 갈 곳이 없다. 그래서 모든 모델 텍스트를 일단
 *   `assistant_interim`(작업 도중의 말)으로 넣고, 턴이 끝날 때 그 턴의 마지막 하나만 `assistant`로 올린다
 *   (SearchIndex.promoteFinalAssistant). 승격은 색인 쪽 일이라 이 파일은 역할만 붙이고 끝낸다.
 *   events.jsonl 원본은 하나도 안 지운다 — 나중에 마음이 바뀌면 질의의 역할 목록만 되돌리면 된다.
 */
import type { AetherEvent } from "../types";
import type { ProviderEventCodec } from "../sessions/codec/types";
import type { AgentEvent, ToolKind } from "../../shared/agentEvent";

/** 색인 행의 역할. `assistant_interim` = 턴이 끝나기 전에 한 말(사람 검색에서 제외되는 것). */
export type IndexRole = "user" | "assistant" | "assistant_interim" | "tool";

export type IndexItem = { role: IndexRole; content: string; part: number; tool?: { id: string; kind?: ToolKind } };

/** 한 이벤트의 색인 결과 + 이 이벤트로 턴이 끝났는가(끝났으면 마지막 말을 최종 답변으로 승격해야 한다). */
export type IndexPlan = { items: IndexItem[]; turnEnded: boolean };

/** 색인 대상 AgentEvent 1개 → IndexItem(또는 비색인이면 null). part은 AgentEvent 식별자를 그대로 사용. */
function toIndexItem(ev: AgentEvent): IndexItem | null {
  switch (ev.type) {
    case "user_text": {
      const c = ev.text.trim();
      return c ? { role: "user", content: c, part: ev.part } : null;
    }
    case "text": {
      const c = ev.text.trim();
      return c ? { role: "assistant_interim", content: c, part: ev.part } : null;
    }
    case "tool_call": {
      const content = ev.target ? `⚙ ${ev.name}(${ev.target})` : `⚙ ${ev.name}`;
      return { role: "tool", content, part: ev.part, tool: { id: ev.toolId, kind: ev.toolKind } };
    }
    case "tool_result": {
      const c = ev.output.trim();
      return c ? { role: "tool", content: `▸ ${c}`, part: ev.part, tool: { id: ev.toolId } } : null;
    }
    default:
      return null; // reasoning·text_delta·plan_update·turn_completed·usage_update·provider_notice·turn_started → 비색인
  }
}

/** codec = 이 이벤트를 낳은 세션의 provider codec(D2.6). 세션이 없는 경로는 meta.json의 provider로 고른다. */
export function extractIndexable(ev: AetherEvent, codec: ProviderEventCodec): IndexPlan {
  const items: IndexItem[] = [];
  let turnEnded = false;
  for (const ae of codec.normalize(ev)) {
    if (ae.type === "turn_completed") turnEnded = true;
    const it = toIndexItem(ae);
    if (it) items.push(it);
  }
  return { items, turnEnded };
}
