import { reportError } from "../../observability/report";
/**
 * Codex 인증 — 기기 코드 로그인 중계 (Phase 8f · D9).
 *
 * Claude 쪽 흐름과 방향이 반대다. Claude는 서버가 주소를 주면 사용자가 그 화면에서 받은 코드를 되돌려
 * 보내지만, Codex는 **서버가 주소와 코드를 함께 주고** 사용자는 폰에서 그 화면을 끝내면 된다. 끝났다는
 * 사실은 우리가 물어보지 않아도 알림(`account/login/completed`)으로 온다. 그래서 완료를 화면에 알리는
 * 통로가 `poll`이다(계약 근거는 `providers/types.ts`의 `LoginStart`·`LoginProgress` 주석).
 *
 * 상대는 대화 스레드를 만들지 않는 인증 전용 프로세스다(`codex/control.ts`) — 세션이 하나도 없을 때도
 * 설정 화면이 상태를 물어보기 때문이다.
 *
 * ⚠️ userCode는 로그인 자격이다. 로그로 남기지 않는다.
 */
import { st } from "../../i18n";
import { controlRequest, disposeControl, holdControl, onControlExit, onControlNotification } from "../../codex/control";
import type { AuthStatus, LoginProgress, LoginStart, ProviderAuth } from "../types";
import type { Account } from "../../codex/protocol/v2/Account";
import type { AccountLoginCompletedNotification } from "../../codex/protocol/v2/AccountLoginCompletedNotification";
import type { GetAccountResponse } from "../../codex/protocol/v2/GetAccountResponse";
import type { LoginAccountResponse } from "../../codex/protocol/v2/LoginAccountResponse";

/**
 * 로그인 하나가 살아 있을 수 있는 최대 시간.
 *
 * 기기 코드는 발급 뒤 십수 분이면 만료된다. 그보다 오래 붙들고 있어 봐야 이미 못 쓰는 코드를 기다리는
 * 것이고, 그동안 인증 전용 프로세스가 안 내려간다(로그인 중에는 놀아도 안 내려가는 규칙 때문). 그래서
 * 상한을 둔다. 상한에 걸리면 조용히 사라지지 않고 "시간이 지났다"고 화면에 답한다.
 */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** 상태 조회를 다시 물어보기까지 기다리는 시간. 조회 한 번이 프로세스를 띄우므로 짧게 반복하지 않는다. */
const STATUS_CACHE_MS = 60_000;

type Pending = {
  id: string;
  /** 인증 전용 프로세스를 붙잡고 있는 손 — 끝나면 놓는다. */
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
};

let pending: Pending | null = null;
/** 마지막으로 끝난 로그인의 결말 — 화면이 완료 알림을 놓쳤어도 `poll`이 답할 수 있게 남긴다. */
let lastOutcome: { id: string; status: "success" | "error"; message: string } | null = null;
let statusCache: { at: number; data: AuthStatus } | null = null;
let wired = false;
/**
 * 로그인 시작을 한 줄로 세우는 자리.
 *
 * 없으면 `/start` 두 요청이 겹칠 때 둘 다 "진행 중인 로그인 없음"을 보고 각자 프로세스를 붙잡는다.
 * 나중 응답이 앞 것을 덮어써서 **앞의 손을 놓을 방법이 영영 사라지고**, 인증 전용 프로세스가 다시는
 * 안 내려간다(2026-08-18 외부 검토 지적).
 */
let startChain: Promise<unknown> = Promise.resolve();

/**
 * **지금 기다리고 있는 로그인**을 끝낸다(성공이든 실패든). 붙잡은 손을 놓고 결말을 남긴다.
 *
 * 우리가 더 이상 기다리지 않는 로그인의 뒤늦은 소식은 여기서 걸러 낸다. 안 걸러 내면 취소된 로그인의
 * 늦은 성공 통보가 이미 적힌 결말을 뒤집고, 최악의 경우 **다음 로그인**을 남의 결과로 마감한다.
 */
function settle(id: string, status: "success" | "error", message: string): boolean {
  if (pending?.id !== id) return false;
  clearTimeout(pending.timer);
  pending.release();
  pending = null;
  lastOutcome = { id, status, message };
  if (status === "success") statusCache = null; // 방금 바뀐 상태를 옛 값으로 답하지 않게
  return true;
}

/** 상대에게도 로그인을 접겠다고 알린다. 실패해도 우리 쪽 정리는 그대로 진행한다. */
function tellRemoteCancel(loginId: string) {
  void controlRequest("account/login/cancel", { loginId }).catch(() => { /* 취소한 로그인이 이미 끝났거나 없어도 로컬 취소는 완료한다. */ });
}

/**
 * 알림·종료 수신을 딱 한 번 붙인다.
 *
 * 붙이는 시점을 로그인 시작으로 미루는 이유: 이 파일은 서버가 뜰 때 등록표를 통해 무조건 import되는데,
 * Codex를 한 번도 안 쓰는 실행에서까지 수신자를 달아 둘 이유가 없다. 한 번 붙인 뒤에는 떼지 않는다 —
 * 수신자는 프로세스가 아니라 모듈에 붙으므로 프로세스가 죽고 다시 떠도 그대로 유효하다.
 */
function wireOnce() {
  if (wired) return;
  wired = true;
  onControlNotification((n) => {
    if (n.method === "account/login/completed") {
      const p = (n.params ?? {}) as AccountLoginCompletedNotification;
      // loginId가 없는 통보는 "지금 기다리는 그것"으로 읽는다(동시 로그인은 하나뿐이다). 기다리는 것이
      //   없으면 누구 소식인지 알 길이 없으므로 버린다 — 억지로 갖다 붙이면 남의 결과가 된다.
      const id = p.loginId ?? pending?.id;
      if (!id) return;
      // 지금 기다리는 로그인이 아니면 `settle`이 false를 돌려주고 아무것도 안 바꾼다.
      const done = p.success
        ? settle(id, "success", st("routes.providerAuth.completed"))
        : settle(id, "error", p.error ?? st("routes.providerAuth.loginFailed"));
      if (!done) console.error("[aether] 기다리지 않는 로그인의 완료 통보를 버린다(뒤늦게 도착).");
      return;
    }
    // 계정이 바뀌었다는 통보 — 기억해 둔 상태는 더 이상 답이 아니다.
    if (n.method === "account/updated") statusCache = null;
  });
  onControlExit(() => {
    statusCache = null;
    if (pending) settle(pending.id, "error", st("routes.providerAuth.interrupted"));
  });
}

/** app-server가 준 계정 정보를 화면이 아는 모양으로 옮긴다. */
function toAuthStatus(account: Account | null): AuthStatus {
  if (!account) return { loggedIn: false };
  if (account.type === "chatgpt") return { loggedIn: true, email: account.email ?? undefined, subscriptionType: account.planType ?? undefined };
  // API 키·Bedrock 자격증명도 로그인은 로그인이다 — 구독 종류 자리에 방식 이름을 넣어 화면이 구분할 수 있게 한다.
  return { loggedIn: true, subscriptionType: account.type };
}

/** 로그인 시작 본체 — 반드시 `startChain`을 통해서만 불린다(겹쳐 돌면 안 된다). */
async function doStart(): Promise<LoginStart> {
  wireOnce();
  // 이전 로그인이 남아 있으면 먼저 접는다 — 손을 놓지 않으면 인증 프로세스가 영영 안 내려간다.
  //   상대에게도 알린다(안 알리면 저쪽에 버려진 기기 코드가 만료될 때까지 남는다).
  if (pending) {
    const old = pending.id;
    settle(old, "error", st("routes.providerAuth.replaced"));
    tellRemoteCancel(old);
  }
  const release = holdControl();
  let res: LoginAccountResponse;
  try {
    res = await controlRequest<LoginAccountResponse>("account/login/start", { type: "chatgptDeviceCode" });
  } catch (e) {
    release();
    // 계정에서 기기 코드 로그인이 꺼져 있으면 여기서 거부된다(8a 실측) — 무엇을 켜야 하는지 알려준다.
    throw new Error(st("notice.codex.deviceCodeUnavailable", { error: String((e as Error)?.message ?? e) }));
  }
  if (res.type !== "chatgptDeviceCode") {
    release();
    throw new Error(st("notice.codex.deviceCodeUnexpected", { type: res.type }));
  }
  const timer = setTimeout(() => settle(res.loginId, "error", st("routes.providerAuth.expired")), LOGIN_TIMEOUT_MS);
  timer.unref?.();
  pending = { id: res.loginId, release, timer };
  lastOutcome = null; // 새 로그인이 시작됐으므로 이전 결말은 더 이상 답이 아니다
  return { mode: "deviceCode", loginId: res.loginId, url: res.verificationUrl, userCode: res.userCode };
}

export const codexAuth: ProviderAuth = {
  async status(): Promise<AuthStatus> {
    if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.data;
    let data: AuthStatus = { loggedIn: false };
    try {
      const res = await controlRequest<GetAccountResponse>("account/read", { refreshToken: false });
      data = toAuthStatus(res.account ?? null);
    } catch (e) {
      // 판정 불가는 미로그인으로 답한다(Claude와 같은 규율) — 화면이 재인증을 권하는 쪽이 안전하다.
      void reportError(e, { component: "providers", operation: "provider.codex.auth_status" }); console.error("[aether] codex 인증 상태 조회 실패:", String((e as Error)?.message ?? e));
    }
    statusCache = { at: Date.now(), data };
    return data;
  },

  /**
   * 로그인 시작. **한 번에 하나씩만 실행한다** — 겹쳐 돌면 각자 프로세스를 붙잡은 뒤 뒤엣것이 앞엣것을
   * 덮어써서, 앞의 손을 놓을 방법이 사라진다(그러면 인증 프로세스가 다시는 안 내려간다).
   */
  start(): Promise<LoginStart> {
    const run = startChain.then(doStart, doStart);
    startChain = run.then(
      () => {},
      () => {},
    );
    return run;
  },

  // submitCode 없음 — 기기 코드 방식엔 되돌려 보낼 코드가 없다. 라우트가 이 부재를 501로 답한다.

  async poll(loginId: string): Promise<LoginProgress> {
    if (pending?.id === loginId) return { status: "pending" };
    if (lastOutcome?.id === loginId) return { status: lastOutcome.status, message: lastOutcome.message };
    return { status: "error", message: st("routes.providerAuth.unknownLogin") };
  },

  cancel(loginId?: string): void {
    const p = pending;
    if (!p || (loginId && p.id !== loginId)) return;
    // 상대에게도 알린다 — 실패해도 우리 쪽 정리는 그대로 진행한다(붙잡은 손을 놓는 것이 더 중요하다).
    tellRemoteCancel(p.id);
    settle(p.id, "error", st("routes.providerAuth.cancelled"));
  },

  disposeAll(): void {
    if (pending) settle(pending.id, "error", st("routes.providerAuth.interrupted"));
    disposeControl();
  },
};

/** 테스트 전용 — 모듈에 남는 기억(진행 중 로그인·마지막 결말·상태 캐시)을 지운다. */
export function __resetCodexAuthForTest(): void {
  if (pending) {
    clearTimeout(pending.timer);
    pending.release();
    pending = null;
  }
  lastOutcome = null;
  statusCache = null;
}
