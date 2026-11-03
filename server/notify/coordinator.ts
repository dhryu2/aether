import { reportError } from "../observability/report";
/**
 * 알림 판정부 — 세션 수명주기 사건을 보고 "알릴 가치"와 중립 행동만 정한다.
 *
 * 웹 푸시·VAPID·브라우저 payload를 모른다. 전송은 조립부가 넘긴 send에만 맡긴다.
 * 문맥 85% 히스테리시스(75%로 내려가야 재무장)와 마지막 답변 기억은 여기 세션마다 둔다.
 */
import path from "node:path";
import { st } from "../i18n";
import { providerEntry } from "../providers/registry";
import { isControlEvent, type AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";
import { pickToolTarget, worthNotifying, type NotifyIntent } from "./worthNotifying";
import { sessionManager } from "../sessions/SessionManager";
import { readAutoResumeSettings, trackAutoResume, type AutoResumeTrack } from "../sessions/autoResume";

export type NotifySession = {
  readonly id: string;
  readonly cwd: string;
  name?: string;
  readonly provider: string;
  readonly isDisposed: boolean;
  /** 메인 턴이 끝난 뒤에도 백그라운드 작업. 하나라도 남아 있으면 완료 알림은 아직 이르다. */
  readonly backgroundTasks: readonly unknown[];
  readonly codec: {
    isLiveOnly(ev: AetherEvent): boolean;
    normalize(ev: AetherEvent): AgentEvent[];
  };
  subscribe(fn: (ev: AetherEvent) => void): () => void;
};

export type NotifyState = {
  ctxWarned: boolean;
  lastTurnText?: string;
};

function displayNameOf(session: NotifySession): string {
  return session.name?.trim() || path.basename(session.cwd) || session.id.slice(0, 8);
}

function providerNameOf(session: NotifySession): string {
  return providerEntry(session.provider).services.displayName;
}

/** 한 사건에서 알림 의도를 만들거나, 알릴 일이 없으면 undefined. */
export function considerNotify(session: NotifySession, ev: AetherEvent, state: NotifyState): NotifyIntent | undefined {
  if (session.isDisposed) return undefined;
  if (session.codec.isLiveOnly(ev)) return undefined;
  const agentEvents = session.codec.normalize(ev);
  if (ev.kind === "user_msg" || agentEvents.some((a) => a.type === "turn_started")) state.lastTurnText = undefined;
  for (const a of agentEvents) if (a.type === "text" && a.text.trim()) state.lastTurnText = a.text;

  if (isControlEvent(ev, "ctx")) {
    const pct = ev.maxTokens ? ev.totalTokens / ev.maxTokens : 0;
    if (pct >= 0.85 && !state.ctxWarned) {
      state.ctxWarned = true;
      return {
        title: st("notify.ctx.title"),
        body: st("notify.ctx.body", { name: session.name ?? st("notify.ctx.fallbackName"), pct: Math.round(pct * 100) }),
        sessionId: session.id,
        topic: "context",
      };
    }
    if (pct < 0.75) state.ctxWarned = false;
    return undefined;
  }

  const intent = worthNotifying(ev, agentEvents, {
    id: session.id,
    name: displayNameOf(session),
    providerName: providerNameOf(session),
    lastText: state.lastTurnText,
    permissionTarget: isControlEvent(ev, "permission_request") ? pickToolTarget(ev.req.input) : undefined,
  });
  // 뒤 작업이 남은 채 턴이 끝나면 완료는 그 작업이 모두 끝난 뒤(깨움 턴의 끝)에 한 번만 알린다. 실패는 바로 알린다.
  if (intent?.kind === "done" && session.backgroundTasks.length > 0) return undefined;
  return intent;
}

/**
 * 살아 있는 세션에 판정부를 붙인다. 주의 갱신은 send가 없어도 한다(푸시 키가 없어도 점·칩은 바뀌어야 한다).
 * 반환은 구독 해제.
 */
export function attachNotify(session: NotifySession, send?: (intent: NotifyIntent) => void): () => void {
  const state: NotifyState = { ctxWarned: false };
  const track: AutoResumeTrack = { turnOpen: false };
  return session.subscribe((ev) => {
    try {
      const intent = considerNotify(session, ev, state);
      const agentEvents = session.isDisposed || session.codec.isLiveOnly(ev) ? [] : session.codec.normalize(ev);
      const verdict = trackAutoResume(track, ev, agentEvents);
      // 예약을 먼저 반영하고, 그 결과를 보고 알릴지 정한다.
      const hasReservation = sessionManager.applyAttentionEvent(session.id, ev, intent, verdict);
      if (intent && send && !sessionManager.isArchived(session.id)) { // 보관된 세션은 알림을 내지 않는다
        // 자동 재개가 걸리면 "막혔다"·"실패했다" 알림은 줄인다. 사람이 볼 일은 포기할 때 따로 알린다.
        const covered =
          (intent.kind === "rate_limit" || intent.kind === "failed") &&
          readAutoResumeSettings().enabled &&
          (intent.kind === "failed" ? hasReservation : track.blocked !== undefined || hasReservation);
        if (!covered) send(intent);
      }
    } catch (e) {
      void reportError(e, { component: "notify", operation: "notify.consider", severity: "warning" });
      console.error("[aether] 알림 판정 실패(세션은 계속):", e);
    }
  });
}
