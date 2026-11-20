/**
 * 인증 라우트(password 모드용). 게이트 *앞에* 공개 mount(로그인해서 쿠키 받을 길 보장).
 *   POST /api/auth/login  { password } → bcrypt 검증 → httpOnly 쿠키에 JWT 발급
 *   POST /api/auth/logout → 동일 옵션으로 쿠키 clear + 그 토큰을 서버에서 폐기(이 기기만)
 *   POST /api/auth/password { current, next } → 비밀번호 변경(게이트 통과 + password 모드만)
 *   GET /api/auth/devices · DELETE /api/auth/devices/:id · POST /api/auth/devices/sign-out-others → 로그인한 기기 목록과 원격 로그아웃(password 모드만)
 * 로그인은 시도 제한(auth/loginLimiter.ts)을 거친다. 잠기면 429 + Retry-After(초).
 * ⚠️ 비번/해시를 로깅하지 않는다(시크릿 평문 금지).
 */
import { Router, type RequestHandler } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config";
import { revokeSession, signSession } from "../auth/jwt";
import { currentPasswordHash, isValidNewPassword, listSessions, revokeAllTokens, revokeTokenId, savePasswordHash } from "../auth/passwordHash";
import { removeSubscriptionsByToken } from "../push";
import { bearerToken, createAuthMiddleware, selectStrategy } from "../middleware/auth";
import { reportError } from "../observability/report";
import type { AuthDevicesResponse, ChangePasswordResponse } from "../../shared/http";
import { createLoginLimiter } from "../auth/loginLimiter";
import { st } from "../i18n";

export const authRouter = Router();

const COOKIE = "aether_session";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d
// 타이밍 보정용 더미 해시(비번 미설정/요청 시에도 항상 1회 compare → 타이밍 일정).
// 부팅을 막지 않도록 첫 필요 때 비동기로 만든다.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hash("aether-dummy", config.bcryptCost));

function cookieOpts(secure: boolean) {
  // secure는 req.secure 파생(하드코딩 금지) — serve(HTTPS)면 true, dev(HTTP)면 false. set/clear 동일 옵션.
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: MAX_AGE_MS };
}

const limiter = createLoginLimiter();
const passwordLimiter = createLoginLimiter(); // 비밀번호 변경 경로는 따로 센다 — 로그인 잠금이 이미 로그인한 소유자의 변경을 막지 않게

authRouter.post("/login", async (req, res) => {
  // 비밀번호가 문자열이 아닌 요청은 실패 횟수에 넣지 않고 돌려보낸다(자격 없이 소유자의 로그인을 잠그지 못하게).
  if (typeof req.body?.password !== "string") {
    res.status(400).json({ error: st("routes.auth.failed") });
    return;
  }
  const wait = limiter.acquire(req.ip ?? "");
  if (wait) {
    res.set("Retry-After", String(wait));
    res.status(429).json({ error: st("routes.auth.tooMany") });
    return;
  }
  let ok = false;
  try {
    const password: string = req.body.password;
    const stored = currentPasswordHash();
    const match = await bcrypt.compare(password, stored || await getDummyHash()); // 미설정 시 더미와 비교(항상 실패, 타이밍 일정)
    ok = match && !!stored;
  } finally {
    limiter.release(ok);
  }
  if (!ok) {
    res.status(401).json({ error: st("routes.auth.failed") });
    return;
  }
  const token = await signSession();
  res.cookie(COOKIE, token, cookieOpts(req.secure));
  res.json({ ok: true, token });
});

authRouter.post("/logout", async (req, res) => {
  const { maxAge: _omit, ...clearOpts } = cookieOpts(req.secure);
  res.clearCookie(COOKIE, clearOpts);
  // 이 기기의 토큰만 서버에서도 무효로 만든다(쿠키와 Bearer 각각). 모드 조건: off 모드의 묵은 쿠키로 시크릿 검사가 throw하지 않게.
  if (config.authMode === "password") {
    for (const token of [req.cookies?.[COOKIE], bearerToken(req)]) if (typeof token === "string" && token) await revokeSession(token);
  }
  res.json({ ok: true });
});

authRouter.post("/password", createAuthMiddleware(selectStrategy()), async (req, res) => {
  if (config.authMode !== "password") {
    res.status(404).json({ error: st("routes.common.apiNotFound") });
    return;
  }
  // 입력 검사는 시도 제한보다 먼저 한다 — limiter에 "실패 아님"으로 끝내는 길이 없어 400이 실패 횟수에 들어가기 때문.
  const { current, next } = req.body ?? {};
  if (typeof current !== "string" || !isValidNewPassword(next)) {
    res.status(400).json({ error: st("routes.auth.passwordInvalid") });
    return;
  }
  const wait = passwordLimiter.acquire(req.ip ?? ""); // 로그인과 따로 센다
  if (wait) {
    res.set("Retry-After", String(wait));
    res.status(429).json({ error: st("routes.auth.tooMany") });
    return;
  }
  let ok = false; // 해시 계산·저장·토큰 발급까지 끝나야 true. release는 finally에서 한 번만 부른다.
  try {
    const stored = currentPasswordHash();
    if (!(await bcrypt.compare(current, stored ?? await getDummyHash())) || !stored) {
      res.status(403).json({ error: st("routes.auth.currentWrong") });
      return;
    }
    try {
      savePasswordHash(await bcrypt.hash(next, config.bcryptCost));
    } catch (error) {
      void reportError(error, { component: "auth", operation: "auth.password.save" });
      res.status(500).json({ error: st("routes.auth.saveFailed") });
      return;
    }
    const token = await signSession(); // 새 해시로 바뀐 키로 서명
    res.cookie(COOKIE, token, cookieOpts(req.secure));
    const body: ChangePasswordResponse = { ok: true, token };
    res.json(body);
    ok = true;
  } finally {
    passwordLimiter.release(ok);
  }
});

// 로그인한 기기 목록과 원격 로그아웃. password 모드가 아니면 404.
const gate = createAuthMiddleware(selectStrategy());
const passwordOnly: RequestHandler = (_req, res, next) => {
  if (config.authMode === "password") return next();
  res.status(404).json({ error: st("routes.common.apiNotFound") });
};

authRouter.get("/devices", gate, passwordOnly, (req, res) => {
  const devices = listSessions()
    .sort((a, b) => b.seen - a.seen)
    .map((r) => ({ id: r.id, issuedAt: r.iat * 1000, lastSeenAt: r.seen * 1000, ...(r.ua ? { userAgent: r.ua } : {}), current: r.id === req.auth?.tokenId }));
  const body: AuthDevicesResponse = { devices };
  res.json(body);
});

authRouter.delete("/devices/:id", gate, passwordOnly, (req, res) => {
  const id = String(req.params.id);
  if (id === req.auth?.tokenId) {
    res.status(400).json({ error: st("routes.auth.deviceCurrent") }); // 이 기기는 기존 로그아웃을 쓴다
    return;
  }
  const target = listSessions().find((r) => r.id === id);
  if (!target) {
    res.status(404).json({ error: st("routes.auth.deviceNotFound") });
    return;
  }
  revokeTokenId(id, target.exp);
  removeSubscriptionsByToken(id);
  res.json({ ok: true });
});

authRouter.post("/devices/sign-out-others", gate, passwordOnly, async (req, res) => {
  revokeAllTokens(); // 세대 값이 바뀌어 이 기기 토큰도 무효가 되므로 새 토큰을 준다. 옛 구독은 자격 지문이 달라져 보낼 때 걸러진다.
  const token = await signSession();
  res.cookie(COOKIE, token, cookieOpts(req.secure));
  const body: ChangePasswordResponse = { ok: true, token };
  res.json(body);
});
