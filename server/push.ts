import { FailureTracker } from "./providers/failureTracking";
import { reportError } from "./observability/report";
/**
 * Web Push(PWA 알림) — VAPID 전송 + 구독 영속. 선택 부가.
 * 구독은 data/push-subs.json에 보관(단일 사용자·소수 기기). 키 미설정 시 전체 no-op(graceful degrade).
 * ⚠️ 전송은 fire-and-forget(세션 흐름에 영향 0). 만료(404/410) 구독은 자동 정리.
 * 키는 공통 설정이 아니라 이 어댑터가 환경 변수에서 읽는다. 유무는 전송 순간에 본다.
 */
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { config } from "./config";
import type { NotifyIntent } from "./notify/worthNotifying";

type Sub = webpush.PushSubscription;

function vapidPublic(): string | undefined {
  const v = process.env.AETHER_VAPID_PUBLIC;
  return v && v.trim() ? v : undefined;
}

function vapidPrivate(): string | undefined {
  const v = process.env.AETHER_VAPID_PRIVATE;
  return v && v.trim() ? v : undefined;
}

function vapidSubject(): string {
  return process.env.AETHER_VAPID_SUBJECT ?? "mailto:admin@localhost";
}

export function pushEnabled(): boolean {
  return !!(vapidPublic() && vapidPrivate());
}

/** 구독에 쓸 공개키. 비밀키가 없으면 비활성으로 본다. */
export function vapidPublicIfEnabled(): string | undefined {
  return pushEnabled() ? vapidPublic() : undefined;
}

let vapidConfigured = false;
function ensureVapid(): boolean {
  const pub = vapidPublic();
  const priv = vapidPrivate();
  if (!pub || !priv) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(vapidSubject(), pub, priv);
    vapidConfigured = true;
  }
  return true;
}

const SUBS_FILE = path.join(config.dataDir, "push-subs.json");
let subs: Sub[] | null = null;
let saveFailed = false;

function load(): Sub[] {
  if (subs) return subs;
  try {
    const parsed = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
    subs = Array.isArray(parsed) ? (parsed as Sub[]) : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "push", operation: "push.subscriptions.load" });
    subs = []; // 파일 없음/손상 → 빈 목록
  }
  return subs;
}

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = SUBS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, SUBS_FILE); // 원자 교체
    saveFailed = false;
  } catch (e) {
    if (!saveFailed) void reportError(e, { component: "push", operation: "push.subscriptions.save" });
    saveFailed = true;
    console.error("[aether] push-subs 저장 실패:", e);
  }
}

const MAX_SUBS = 50; // 구독 무제한 증식 방지(인증 off에서도 디스크/메모리 폭주 차단). 초과 시 오래된 것부터 제거.

export function addSubscription(sub: Sub) {
  if (!sub?.endpoint) return;
  const list = load();
  if (list.some((s) => s.endpoint === sub.endpoint)) return; // dedup
  list.push(sub);
  if (list.length > MAX_SUBS) list.splice(0, list.length - MAX_SUBS);
  save();
}

export function removeSubscription(endpoint: string) {
  if (!endpoint) return;
  const list = load();
  const next = list.filter((s) => s.endpoint !== endpoint);
  if (next.length !== list.length) {
    subs = next;
    save();
  }
}

export type BrowserPushPayload = {
  title: string;
  body: string;
  sessionId?: string;
  /** 승인 REST용 실행 id. 없으면 sessionId. */
  executionId?: string;
  tag?: string;
  permissionId?: string;
};

export type PushSendResult = { attempted: number; reason?: "no-vapid" | "no-subscribers" };

/** 판정부 의도 → 브라우저 payload. 서비스워커 승인 버튼은 permissionId를 쓴다. */
export function toBrowserPayload(intent: NotifyIntent): BrowserPushPayload {
  return {
    title: intent.title,
    body: intent.body,
    sessionId: intent.sessionId,
    executionId: intent.sessionId,
    tag: intent.topic === "context" ? `ctx-${intent.sessionId}` : intent.sessionId,
    permissionId: intent.action?.type === "await_permission" ? intent.action.requestId : undefined,
  };
}

/** 모든 구독에 푸시 전송(fire-and-forget). 만료(404/410) 구독은 자동 제거. 키 미설정이면 no-op. */
export function notifyPush(payload: BrowserPushPayload): PushSendResult {
  if (!pushEnabled()) return { attempted: 0, reason: "no-vapid" };
  const list = load();
  if (!list.length) return { attempted: 0, reason: "no-subscribers" };
  if (!ensureVapid()) return { attempted: 0, reason: "no-vapid" };
  const data = JSON.stringify(payload);
  for (const sub of [...list]) {
    webpush.sendNotification(sub, data).then(() => {
      deliveryFailures.clear(sub.endpoint);
    }).catch((err: { statusCode?: number; code?: string }) => {
      // 영구 실패(만료·삭제·거부·잘못된 요청)면 정리. 일시 5xx/네트워크는 보존.
      const sc = err?.statusCode;
      // 푸시 서비스의 만료·인증 거절·장애와 알려진 연결 실패는 외부 환경이다.
      const external = sc === 401 || sc === 403 || sc === 404 || sc === 410 || sc === 429 || (sc !== undefined && sc >= 500 && sc <= 599) ||
        ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(err?.code ?? "");
      if (!external) deliveryFailures.report(err, { component: "push", operation: "push.notification.send", session_id: payload.sessionId }, sub.endpoint);
      if (sc === 400 || sc === 403 || sc === 404 || sc === 410) removeSubscription(sub.endpoint);
    });
  }
  return { attempted: list.length };
}

/** 조립부가 판정부에 넘기는 전송 함수. */
export function deliverWebPush(intent: NotifyIntent): PushSendResult {
  return notifyPush(toBrowserPayload(intent));
}

const deliveryFailures = new FailureTracker();
