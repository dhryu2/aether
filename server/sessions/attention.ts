/**
 * 한 세션의 주의 상태. 알림 판정과 같은 사건을 쓰며, 수명 `status`와 섞지 않는다.
 *
 * 우선순위: 대기(질문·권한·계획) > 진행 중 턴 > 막힘(hold: 한도·끊긴 요청) > 백그라운드 작업 중 > 아직 안 본 완료/실패 > 쉼.
 * 뒤 작업이 남아 있는 동안은 남은 완료 표시가 가려진다(완료는 뒤 작업이 모두 끝난 뒤 한 번만).
 * 잠든 세션은 대기·진행을 넘기지 않는다(프로세스가 없다).
 */
import type { SessionAttention, SessionAttentionKind } from "../../shared/http";

export type AttentionSticky = {
  kind: SessionAttentionKind;
  preview: string;
  at: number;
};

/** 사람이 풀어야 막힌 것. 다음 턴이 열리면 세션이 지운다. until이 지났으면 무시한다. */
export type AttentionHold = {
  kind: "rate_limit" | "interrupted_request";
  preview: string;
  since: number;
  until?: number;
};

export type AttentionInput = {
  waitingKind?: "permission" | "question" | "plan";
  waitingPreview?: string;
  /** 대기 카드가 처음 뜬 시각(ms). */
  waitingSince?: number;
  turnOpen: boolean;
  hold?: AttentionHold;
  /** hold.until 비교용 현재 시각. 시험에서 고정한다. */
  now?: number;
  /** 메인 턴이 끝난 뒤에도 백그라운드 작업 수. 살아 있는 세션만 채운다. */
  backgroundCount?: number;
  lastViewedAt?: number;
  sticky?: AttentionSticky;
};

export type AttentionState = {
  attention: SessionAttention;
  attentionKind?: SessionAttentionKind;
  attentionPreview?: string;
  /** 기다리기 시작한 시각. `waiting`일 때만. */
  attentionSince?: number;
};

export function isStickyAttentionKind(kind: SessionAttentionKind): boolean {
  return kind === "done" || kind === "failed" || kind === "crashed" || kind === "auth";
}

export function computeAttention(input: AttentionInput): AttentionState {
  if (input.waitingKind) {
    return {
      attention: "waiting",
      attentionKind: input.waitingKind,
      attentionPreview: input.waitingPreview,
      attentionSince: input.waitingSince,
    };
  }
  if (input.turnOpen) return { attention: "running" };
  const hold = input.hold;
  if (hold && (hold.until == null || hold.until > (input.now ?? Date.now()))) {
    return { attention: "waiting", attentionKind: hold.kind, attentionPreview: hold.preview, attentionSince: hold.since };
  }
  if ((input.backgroundCount ?? 0) > 0) return { attention: "background" };
  const sticky = input.sticky;
  if (
    sticky &&
    isStickyAttentionKind(sticky.kind) &&
    (input.lastViewedAt == null || sticky.at > input.lastViewedAt)
  ) {
    if (sticky.kind === "done") {
      return { attention: "done", attentionKind: "done", attentionPreview: sticky.preview };
    }
    return { attention: "failed", attentionKind: sticky.kind, attentionPreview: sticky.preview };
  }
  return { attention: "idle" };
}
