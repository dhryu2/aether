/**
 * 프로세스 죽은 뒤에 남은 미해결 카드.
 * 권한·질문·계획 카드는 실행기가 살아 있을 때만 답을 받을 수 있다.
 * 재시작·크래시 뒤에는 그 약속이 없으므로 화면에서 대기 중으로 두면 안 된다.
 */
import { waitingFromPending } from "../notify/worthNotifying";
import { isControlEvent, type AetherEvent, type AetherEventBody, type PermissionRequest, type PlanRequest, type QuestionRequest } from "../types";

/** 미해결 카드 판정에 필요한 사건 종류. 저장소에서 이 종류만 읽으면 된다. */
export const HOLD_EVENT_KINDS = ["permission_request", "permission_resolved", "question_request", "question_resolved", "plan_request", "plan_resolved"] as const;

export function orphanHoldResolves(events: readonly { kind: string; id?: string; req?: { id?: string } }[]): AetherEventBody[] {
  const resolvedP = new Set<string>();
  const resolvedQ = new Set<string>();
  const resolvedPlan = new Set<string>();
  for (const e of events) {
    if (e.kind === "permission_resolved" && typeof e.id === "string") resolvedP.add(e.id);
    else if (e.kind === "question_resolved" && typeof e.id === "string") resolvedQ.add(e.id);
    else if (e.kind === "plan_resolved" && typeof e.id === "string") resolvedPlan.add(e.id);
  }
  const out: AetherEventBody[] = [];
  for (const e of events) {
    const id = e.req?.id;
    if (!id) continue;
    if (e.kind === "permission_request" && !resolvedP.has(id)) {
      resolvedP.add(id);
      out.push({ kind: "permission_resolved", id, decision: "deny" });
    } else if (e.kind === "question_request" && !resolvedQ.has(id)) {
      resolvedQ.add(id);
      out.push({ kind: "question_resolved", id, answered: false });
    } else if (e.kind === "plan_request" && !resolvedPlan.has(id)) {
      resolvedPlan.add(id);
      out.push({ kind: "plan_resolved", id, decision: "cancel" });
    }
  }
  return out;
}

/** 닫히지 않고 끊긴 카드 중 대기 표시용 한 건(종류·미리보기·가장 이른 생성 시각). 없으면 undefined. */
export function orphanHoldWaiting(events: readonly AetherEvent[]) {
  const resolved = new Set<string>();
  for (const e of events) {
    if (isControlEvent(e, "permission_resolved") || isControlEvent(e, "question_resolved") || isControlEvent(e, "plan_resolved")) resolved.add(e.id);
  }
  const permissions: PermissionRequest[] = [];
  const questions: QuestionRequest[] = [];
  const plans: PlanRequest[] = [];
  for (const e of events) {
    if (isControlEvent(e, "permission_request") && !resolved.has(e.req.id)) permissions.push(e.req);
    else if (isControlEvent(e, "question_request") && !resolved.has(e.req.id)) questions.push(e.req);
    else if (isControlEvent(e, "plan_request") && !resolved.has(e.req.id)) plans.push(e.req);
  }
  return waitingFromPending({ permissions, questions, plans });
}
