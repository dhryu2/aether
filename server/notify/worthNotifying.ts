/**
 * 알릴지 말지 — 채널을 모르는 순수 함수.
 *
 * provider 원본은 codec이 이미 AgentEvent로 흡수했다. 여기서는 Aether 공통 제어 사건과 정규화 사건만
 * 보므로, 실제 발송 설정·구독 유무와 무관하게 제목·본문을 결정적으로 검사할 수 있다.
 * 브라우저 payload 필드(tag)는 붙이지 않는다. 웹 푸시 어댑터가 전송 때 만든다.
 */
import { isAuthError } from "../auth/loginParse";
import { st } from "../i18n";
import { isControlEvent, type AetherEvent, type PermissionRequest, type PlanRequest, type QuestionRequest } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";
import type { SessionAttentionKind } from "../../shared/http";

/** 채널 모르는 알림 의도. 어댑터가 브라우저 payload로 옮긴다. */
export type NotifyIntent = {
  title: string;
  body: string;
  sessionId: string;
  /** 같은 묶음끼리 알림을 덮어쓸지. 없으면 session. */
  topic?: "session" | "context";
  /** 손길 칩·주의 칸이 알림과 같은 사건을 쓰게. 문맥 경고에는 없다. */
  kind?: SessionAttentionKind;
  /** 한도 막힘이 풀리는 시각(ms). provider가 해제 시각을 알릴 때만 있다. */
  until?: number;
};

export type NotifySessionInfo = {
  id: string;
  /** 호출부가 cwd/id 폴백까지 끝낸 표시 이름. */
  name: string;
  providerName: string;
  /** 이번 턴에서 마지막으로 관측한 완성 답변 텍스트(Codex 완료 payload 보완용). */
  lastText?: string;
  /** 승인 카드 표시본에서 미리 뽑은 대상(도구 원본 스키마는 세션에만 남긴다). */
  permissionTarget?: string;
};

/** 권한 알림 본문용 — tool input(이미 redact된 표시본)에서 대상(명령/경로/패턴/URL)만 추출. */
const TARGET_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"];
export function pickToolTarget(input: Record<string, unknown>): string {
  for (const k of TARGET_KEYS) {
    const v = input?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 답변 본문을 알림 미리보기로 — 마크다운 줄바꿈/공백을 한 줄로 접고 길이 제한 + 말줄임. */
function previewText(s: string, limit = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > limit ? t.slice(0, limit - 1).trimEnd() + "…" : t;
}

export function permissionPreview(req: PermissionRequest): string {
  const tool = req.displayName || req.toolName;
  const target = pickToolTarget(req.input);
  return target ? previewText(`${tool} · ${target}`, 160) : st("notify.permission.waiting", { tool });
}

export function questionPreview(req: QuestionRequest): string {
  const q0 = req.questions[0];
  const more = req.questions.length > 1 ? st("notify.question.more", { n: req.questions.length - 1 }) : "";
  return q0?.question ? previewText(`${q0.header ? `[${q0.header}] ` : ""}${q0.question}${more}`) : st("notify.question.waiting");
}

export function planPreview(req: PlanRequest): string {
  return req.text.trim() ? previewText(req.text) : st("notify.plan.waiting");
}

/** 살아 있는 세션의 대기 카드. 알림 본문과 같은 말을 쓴다. since는 대기 중인 카드 중 가장 이른 생성 시각이다. */
export function waitingFromPending(pending: {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  plans: PlanRequest[];
}): { kind: "permission" | "question" | "plan"; preview: string; since: number } | undefined {
  const since = Math.min(...[...pending.permissions, ...pending.questions, ...pending.plans].map((r) => r.createdAt));
  const perm = pending.permissions[0];
  if (perm) return { kind: "permission", preview: permissionPreview(perm), since };
  const question = pending.questions[0];
  if (question) return { kind: "question", preview: questionPreview(question), since };
  const plan = pending.plans[0];
  if (plan) return { kind: "plan", preview: planPreview(plan), since };
  return undefined;
}

/** 한도 막힘 알림인가. 알림 판정과 자동 재개·넘기기가 같은 기준을 쓴다. */
export function isBlockedRateLimit(a: AgentEvent): a is Extract<AgentEvent, { type: "provider_notice" }> {
  return a.type === "provider_notice" && a.kind === "rate_limit" && a.severity === "blocked";
}

/** resetsAt은 초 또는 ms로 온다(1e12 미만이면 초). 항상 ms로 맞춘다. */
export function resetsAtMs(resetsAt: number): number {
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/** 자동 재개가 멈췄을 때(3번 모두 막힘, 보내지 못함) 사람을 부르는 알림. */
export function autoResumeStoppedIntent(
  session: { id: string; name: string },
  reason: "gave_up" | "send_failed",
  detail?: string,
): NotifyIntent {
  return {
    title: st(reason === "gave_up" ? "notify.autoResume.gaveUp.title" : "notify.autoResume.sendFailed.title", { name: session.name }),
    body: reason === "gave_up" ? st("notify.autoResume.gaveUp.body") : st("notify.autoResume.sendFailed.body", { detail: detail ? previewText(detail, 120) : "" }),
    sessionId: session.id,
    kind: "rate_limit",
  };
}

/** 이벤트와 세션 표시 정보에서 보낼 알림을 만들거나, 알릴 일이 없으면 undefined를 돌린다. */
export function worthNotifying(
  ev: AetherEvent,
  agentEvents: AgentEvent[],
  session: NotifySessionInfo,
): NotifyIntent | undefined {
  const base = { sessionId: session.id };
  if (isControlEvent(ev, "permission_request")) {
    return {
      ...base,
      title: st("notify.permission.title", { name: session.name }),
      body: permissionPreview(ev.req),
      kind: "permission",
    };
  }
  if (isControlEvent(ev, "plan_request")) {
    return {
      ...base,
      title: st("notify.plan.title", { name: session.name }),
      body: planPreview(ev.req),
      kind: "plan",
    };
  }
  if (isControlEvent(ev, "question_request")) {
    return {
      ...base,
      title: st("notify.question.title", { name: session.name }),
      body: questionPreview(ev.req),
      kind: "question",
    };
  }
  if (isControlEvent(ev, "status") && ev.status === "crashed") {
    if (isAuthError(ev.error)) return undefined; // auth_expired notice가 한 번만 보낸다.
    return {
      ...base,
      title: st("notify.crashed.title", { name: session.name }),
      body: ev.error?.trim() ? previewText(ev.error) : st("notify.crashed.generic"),
      kind: "crashed",
    };
  }
  if (isControlEvent(ev, "notice") && ev.notice === "auth_expired") {
    return {
      ...base,
      title: st("notify.auth.title", { name: session.name, provider: session.providerName }),
      body: st("notify.auth.body", { provider: session.providerName }),
      kind: "auth",
    };
  }

  // 같은 사건에 실패와 한도 막힘이 함께 오면 한도를 먼저 본다(막힘 표시와 자동 재개가 걸리게).
  const rateLimit = agentEvents.find(isBlockedRateLimit);
  if (rateLimit) {
    return {
      ...base,
      title: st("notify.ratelimit.title", { name: session.name }),
      body: st("notify.ratelimit.body", { type: rateLimit.limitType ?? st("notify.ratelimit.fallbackType") }),
      kind: "rate_limit",
      ...(rateLimit.resetsAt ? { until: resetsAtMs(rateLimit.resetsAt) } : {}),
    };
  }

  const completed = agentEvents.find((a): a is Extract<AgentEvent, { type: "turn_completed" }> => a.type === "turn_completed");
  if (completed) {
    if (completed.status === "failed") {
      const errors = completed.errors?.join(" · ") ?? "";
      if (isAuthError(`${errors} ${completed.error ?? ""}`)) return undefined; // auth_expired notice와 중복 금지.
      return {
        ...base,
        title: st("notify.failed.title", { name: session.name }),
        body: /529|overload/i.test(errors) ? st("notify.failed.overload") : errors ? previewText(errors) : st("notify.failed.generic"),
        kind: "failed",
      };
    }
    // Claude의 interrupted는 기존부터 result 성공 경로로 '완료'를 알렸다. Codex도 같은 계약 상태를 완료로
    // 취급해, 사용자가 Stop을 눌렀는지 provider에 따라 폰 알림이 달라지지 않게 한다.
    if (completed.status === "ok" || completed.status === "interrupted") {
      // `/clear` 같은 모델 미실행 성공은 Claude만 이 값을 제공한다. 값이 없다는 이유로 Codex를 막지 않는다.
      if (completed.modelTurnCount === 0) return undefined;
      const response = completed.responsePreview ?? session.lastText;
      return {
        ...base,
        title: st("notify.done.title", { name: session.name }),
        body: response?.trim() ? previewText(response) : st("notify.done.generic"),
        kind: "done",
      };
    }
  }

  return undefined;
}
