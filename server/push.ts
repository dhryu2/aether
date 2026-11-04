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
import { credentialStamp } from "./auth/jwt";
import type { NotifyIntent } from "./notify/worthNotifying";

type Sub = webpush.PushSubscription & { stamp?: string }; // stamp: 등록 때의 로그인 자격 지문(password 모드만)

function vapidPublic(): string | undefined {
  const v = process.env.AETHER_VAPID_PUBLIC;
  return v && v.trim() ? v : undefined;
}

function vapidPrivate(): string | undefined {
  const v = process.env.AETHER_VAPID_PRIVATE;
  return v && v.trim() ? v : undefined;
}

function vapidSubject(): string {
  return process.env.AETHER_VAPID_SUBJECT ?? "https://github.com/dhryu2/aether";
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

/** password 모드에서 지금 자격의 지문. 다른 모드는 자격 폐기가 없어 지문을 쓰지 않는다. */
const currentStamp = () => (config.authMode === "password" ? credentialStamp() : undefined);

export function addSubscription(sub: Sub) {
  if (!sub?.endpoint) return;
  const stamp = currentStamp();
  const list = load();
  const hit = list.find((s) => s.endpoint === sub.endpoint); // dedup
  if (hit) {
    // 같은 endpoint의 재등록: 자격이 바뀐 뒤라면 새 지문으로 갱신해야 다시 전송 대상이 된다.
    if (hit.stamp !== stamp) { hit.stamp = stamp; save(); }
    return;
  }
  list.push({ ...sub, stamp });
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
  tag?: string;
};

export type PushSendResult = { attempted: number; reason?: "no-vapid" | "no-subscribers" };

/** 판정부 의도 → 브라우저 payload. 알림에는 승인·거부 버튼이 없다 — 앱에서 카드의 전체 내용을 보고 결정한다. */
export function toBrowserPayload(intent: NotifyIntent): BrowserPushPayload {
  return {
    title: intent.title,
    body: intent.body,
    sessionId: intent.sessionId,
    tag: intent.topic === "context" ? `ctx-${intent.sessionId}` : intent.sessionId,
  };
}

/**
 * 지금 자격으로 등록된 구독만. 비밀번호가 바뀐 뒤 옛 로그인이 등록한 구독은 보낼 때 걸러 저장 파일에서도 뺀다.
 * 재설정 도구처럼 다른 프로세스가 비밀번호를 바꿔도 지문이 달라지므로 같은 방식으로 걸러진다.
 */
function liveSubs(): Sub[] {
  const list = load();
  if (config.authMode !== "password") return list;
  let stamp: string;
  try {
    stamp = credentialStamp();
  } catch (e) {
    void reportError(e, { component: "push", operation: "push.subscriptions.stamp" }); // 지문을 못 구하면 보내지 않는다
    return [];
  }
  const keep = list.filter((s) => s.stamp === stamp);
  if (keep.length !== list.length) {
    subs = keep;
    save();
  }
  return keep;
}

/** 모든 구독에 푸시 전송(fire-and-forget). 만료(404/410) 구독은 자동 제거. 키 미설정이면 no-op. */
export function notifyPush(payload: BrowserPushPayload): PushSendResult {
  if (!pushEnabled()) return { attempted: 0, reason: "no-vapid" };
  const list = liveSubs();
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
