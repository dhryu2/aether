import { FailureTracker } from "../providers/failureTracking";
/**
 * jose HS256 세션 토큰 발급/검증. 시크릿은 process.env.AETHER_JWT_SECRET에서만(config.ts 금지).
 * 미설정 시 throw(fail-fast) — fallback 기본값 절대 금지(평문 누출 방지).
 */
import { createHmac, randomUUID } from "node:crypto";
import { currentPasswordHash, isTokenRevoked, revokeTokenId, tokenEpoch } from "./passwordHash";

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
  // 서명 키 = 시크릿 + 현재 비밀번호 해시 + 세대 값. 비밀번호가 바뀌거나(저장·.env 교체) 세대 값이 돌면 이전 토큰이 모두 무효가 된다.
  // shortcut: .env 해시를 옛 값으로 되돌리면 그 해시 시절의 옛 토큰이 살아난다, 막으려면 해시 변화 감지가 더 필요하다.
  return createHmac("sha256", s).update(`${currentPasswordHash() ?? ""}\0${tokenEpoch()}`).digest();
}

/** expiration: jose 형식 문자열("30d") 또는 절대 만료(unix초). 테스트는 과거값으로 만료 토큰 생성. */
export async function signSession(expiration: string | number = "30d"): Promise<string> {
  const { SignJWT } = await import("jose"); // 비밀번호 모드에서만 불러온다
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(expiration)
    .sign(secret());
}

async function verifyClaims(token: string) {
  const { jwtVerify } = await import("jose"); // 비밀번호 모드에서만 불러온다
  const key = secret();
  failures.clear("auth.token.config");
  return (await jwtVerify(token, key, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE })).payload;
}

export async function verifySession(token: string): Promise<boolean> {
  const { errors } = await import("jose");
  try {
    const payload = await verifyClaims(token);
    return !(payload.jti && isTokenRevoked(payload.jti)); // 로그아웃한 토큰은 거부
  } catch (error) {
    // 토큰 만료·변조는 정상 거절이다. 검증기 설정 실패까지 같은 거절로 숨기지는 않는다.
    if (!(error instanceof errors.JOSEError)) failures.report(error, { component: "auth", operation: "auth.token.config" });
    return false; // 만료/변조/알고리즘 불일치/시크릿 불일치 → 거부
  }
}

/** 이 토큰만 폐기한다(이 기기 로그아웃). 서명·클레임 검증을 통과한 토큰만 적는다 — 공개 경로에서 임의 값으로 파일이 커지지 않게. */
export async function revokeSession(token: string): Promise<void> {
  const { errors } = await import("jose");
  let payload;
  try {
    payload = await verifyClaims(token);
  } catch (error) {
    if (error instanceof errors.JOSEError) return;
    throw error;
  }
  if (payload.jti && typeof payload.exp === "number") revokeTokenId(payload.jti, payload.exp);
}

/** 푸시 구독에 찍는 자격 지문. 서명 키에서 나온 값이라 비밀번호나 세대 값이 바뀌면 달라지고, 키는 드러나지 않는다. */
export function credentialStamp(): string {
  // 해시를 읽지 못하면(파일 깨짐·권한) 빈 해시로 지문을 만들지 않고 throw — 호출자가 "보내지 않음"으로만 처리하게.
  if (!currentPasswordHash()) throw new Error("비밀번호 해시를 읽지 못해 자격 지문을 만들 수 없다");
  return createHmac("sha256", secret()).update("push-subscription").digest("hex");
}
