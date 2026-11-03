import { FailureTracker } from "../providers/failureTracking";
import { reportError } from "../observability/report";
import { rejectRequest, reportResponseError } from '../observability/http';
/**
 * provider 원격 재인증 라우트 (Phase 8d-1 · D9). 인증 게이트 *안쪽* — 가장 민감한 엔드포인트.
 *
 *   POST /api/provider-auth/:provider/start   로그인 시작 → { mode, loginId, url, userCode? }
 *   POST /api/provider-auth/:provider/code    코드 제출 {loginId, code} → { status, message }
 *   POST /api/provider-auth/:provider/poll    완료 확인 {loginId} → { status: pending|success|error, message? }
 *   POST /api/provider-auth/:provider/cancel  취소 {loginId?}
 *
 * 8f에서 방향이 반대인 로그인을 받아들였다. Claude는 서버가 주소를 주고 사용자가 코드를 되돌려 보내지만,
 * Codex 기기 코드 로그인은 서버가 주소와 코드를 함께 주고 완료는 알림으로 온다. 그래서 시작 응답에 방식
 * (`mode`)이 실리고, 완료를 물어보는 `poll`이 생겼다. 코드 제출을 지원하지 않는 provider의 `/code`는
 * 501로 거부한다 — 빈 구현으로 성공한 척하면 화면이 끝나지도 않은 로그인을 완료로 표시한다.
 *
 * 8d-1 이전엔 이 표면이 `/api/claude-auth/*`로 Claude에 고정돼 있었다. Codex도 UI에서 headless 로그인을
 * 완료할 수 있어야 하므로(D9) 경로에 provider를 넣었다. 구 경로는 프론트 전환과 함께 8d-3에서 지웠다 —
 * 이 저장소는 단일 사용자 self-hosted라 캐시된 구버전 프론트를 대비할 근거가 없고(사용자가 직접
 * 하드리프레시한다), 예비 경로를 남기면 그쪽이 조용히 썩는다.
 *
 * ⚠️ 코드·PTY 출력은 로깅/영속하지 않는다(시크릿 평문 금지).
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { providerAvailability, providerEntry } from "../providers/registry";
import type { ProviderAuth } from "../providers/types";
import { st } from "../i18n";

const failures = new FailureTracker();

/** 이 요청이 다룰 provider의 인증 구현. 미등록 이름이면 404로 거부한다(조용한 fallback 금지 §0.1-4). */
function resolveAuth(req: Request, res: Response): ProviderAuth | null {
  const id = String(req.params.provider ?? "");
  try {
    const auth = providerEntry(id).services.auth;
    if (!auth) {
      rejectRequest(res, 501, { error: st("routes.sessions.notSupportedByProvider") });
      return null;
    }
    return auth;
  } catch (err) {
    // 등록표에 없는 provider 이름을 거절하는 정상 입력 검증이다.
    res.status(404).json({ error: String((err as Error).message ?? id) });
    return null;
  }
}

/** 네 개의 인증 핸들러를 provider 경로 아래에 붙인다. */
function mountAuthRoutes(router: Router, prefix: string) {
  router.post(`${prefix}/start`, async (req: Request, res: Response) => {
    const auth = resolveAuth(req, res);
    if (!auth) return;
    // 원격 재로그인 킬스위치 — 헤드리스 로그인을 아예 막고 싶을 때(운영 정책).
    if (!config.enableProviderRelogin) return res.status(403).json({ error: st("routes.providerAuth.disabled", { envVar: config.reloginDisabledBy ?? "AETHER_ENABLE_PROVIDER_RELOGIN" }) });
    // 실행 프로그램이 없으면 로그인 프로세스를 띄워 봐야 날것의 오류나 20초 대기 뒤 모호한 문구만 나온다. 먼저 걸러 이유를 알려 준다.
    const entry = providerEntry(String(req.params.provider ?? ""));
    const availability = await providerAvailability(entry);
    if (!availability.available && availability.reason === "not_installed") {
      const key = availability.requires ? "requires" : "not_installed";
      return res.status(409).json({ error: st(`routes.providerAuth.unavailable.${key}`, { provider: entry.services.displayName, requires: availability.requires ?? "" }) });
    }
    try {
      res.json(await auth.start());
    } catch (err) {
      void reportResponseError(res, err, { component: "routes", operation: "provider.auth.start" }); console.error("[aether] provider-auth start 실패:", String((err as Error).message ?? err)); // 코드/토큰 미포함
      res.status(500).json({ error: String((err as Error).message ?? st("routes.providerAuth.startFailed")) });
    }
  });

  router.post(`${prefix}/code`, async (req: Request, res: Response) => {
    const auth = resolveAuth(req, res);
    if (!auth) return;
    // 기기 코드 방식엔 되돌려 보낼 코드가 없다 — 받아 놓고 무시하면 화면이 제출에 성공했다고 믿는다.
    if (!auth.submitCode) return rejectRequest(res, 501, { error: st("routes.providerAuth.codeNotSupported") });
    const loginId = req.body?.loginId;
    const code = req.body?.code;
    if (typeof loginId !== "string" || typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ error: st("routes.providerAuth.paramsRequired") });
    }
    try {
      res.json(await auth.submitCode(loginId, code)); // {status: success|invalid_code|error, message}
    } catch (err) {
      void reportError(err, { component: "routes", operation: "provider.auth.submit" });
      res.status(409).json({ error: String((err as Error).message ?? st("routes.providerAuth.codeSubmitFailed")) });
    }
  });

  router.post(`${prefix}/poll`, async (req: Request, res: Response) => {
    const auth = resolveAuth(req, res);
    if (!auth) return;
    const loginId = req.body?.loginId;
    if (typeof loginId !== "string" || !loginId.trim()) {
      return res.status(400).json({ error: st("routes.providerAuth.loginIdRequired") });
    }
    try {
      const state = await auth.poll(loginId);
      failures.clear(`${req.params.provider}:${loginId}`);
      res.json(state); // {status: pending|success|error, message?}
    } catch (err) {
      failures.report(err, { component: "routes", operation: "provider.auth.poll" }, `${req.params.provider}:${loginId}`);
      // 조회 자체가 실패한 것을 "아직 진행 중"으로 답하면 화면이 영원히 돈다 — 오류로 끝낸다.
      res.json({ status: "error", message: String((err as Error).message ?? st("routes.providerAuth.pollFailed")) });
    }
  });

  router.post(`${prefix}/cancel`, (req: Request, res: Response) => {
    const auth = resolveAuth(req, res);
    if (!auth) return;
    auth.cancel(typeof req.body?.loginId === "string" ? req.body.loginId : undefined);
    res.json({ ok: true });
  });
}

/** provider별 경로(정본). */
export const providerAuthRouter = Router();
mountAuthRoutes(providerAuthRouter, "/:provider");
