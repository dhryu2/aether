import { FailureTracker } from "../providers/failureTracking";
/**
 * jose HS256 세션 토큰 발급/검증. 시크릿은 process.env.AETHER_JWT_SECRET에서만(config.ts 금지).
 * 미설정 시 throw(fail-fast) — fallback 기본값 절대 금지(평문 누출 방지).
 */
import { createHmac } from "node:crypto";
import { currentPasswordHash, hasStoredPasswordHash } from "./passwordHash";

const failures = new FailureTracker();

const ISSUER = "aether";
const AUDIENCE = "aether-web";

/** HS256은 시크릿이 곧 서명 키 — 짧으면 오프라인 brute-force로 토큰 위조 가능. 32바이트(256비트) 이상 강제. */
export const MIN_JWT_SECRET_BYTES = 32;

function secret(): Uint8Array {
  const s = process.env.AETHER_JWT_SECRET;
  if (!s) throw new Error("AETHER_JWT_SECRET 미설정 — password 모드에는 .env에 JWT 시크릿이 필요합니다.");
  if (Buffer.byteLength(s, "utf8") < MIN_JWT_SECRET_BYTES) {
    throw new Error(`AETHER_JWT_SECRET가 너무 짧습니다 — HS256은 ${MIN_JWT_SECRET_BYTES}바이트(256비트) 이상 권장 (예: openssl rand -base64 48).`);
  }
  // 비밀번호를 바꿔 저장 파일이 생기면 서명 키가 달라져 이전 토큰이 모두 무효가 된다. 파일이 없으면 기존 키 그대로.
  if (hasStoredPasswordHash()) return createHmac("sha256", s).update(currentPasswordHash() ?? "").digest();
  return new TextEncoder().encode(s);
}

/** expiration: jose 형식 문자열("30d") 또는 절대 만료(unix초). 테스트는 과거값으로 만료 토큰 생성. */
export async function signSession(expiration: string | number = "30d"): Promise<string> {
  const { SignJWT } = await import("jose"); // 비밀번호 모드에서만 불러온다
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(secret());
}

export async function verifySession(token: string): Promise<boolean> {
  const { jwtVerify, errors } = await import("jose"); // 비밀번호 모드에서만 불러온다
  try {
    const key = secret();
    failures.clear("auth.token.config");
    await jwtVerify(token, key, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
    return true;
  } catch (error) {
    // 토큰 만료·변조는 정상 거절이다. 검증기 설정 실패까지 같은 거절로 숨기지는 않는다.
    if (!(error instanceof errors.JOSEError)) failures.report(error, { component: "auth", operation: "auth.token.config" });
    return false; // 만료/변조/알고리즘 불일치/시크릿 불일치 → 거부
  }
}
