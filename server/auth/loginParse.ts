/**
 * Claude 로그인 PTY 출력 파싱 + 인증오류 분류 — 순수 함수(node-pty 비의존).
 * claudeLogin(매니저)·LiveSession(401 감지)·단위테스트가 공용으로 import.
 */

/** PTY 출력에서 OAuth authorize URL 추출. ANSI만 제거(줄바꿈 보존) → \S+ 가 URL 줄에서 깔끔히 끝남(뒤 "Paste" 흡수 방지). */
export function extractAuthUrl(text: string): string | null {
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const m = clean.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/);
  return m ? m[0] : null;
}

/** 코드 주입 후 PTY 출력으로 결과 분류. 마커는 코드 시도 후에만 등장. */
export function classifyLoginOutput(text: string): "success" | "invalid_code" | null {
  const t = text.toLowerCase();
  if (/login successful/.test(t)) return "success";
  if (/invalid code|make sure the full code|incorrect code|code is invalid/.test(t)) return "invalid_code";
  return null;
}

/**
 * 턴 에러 문자열이 "구독 OAuth 인증 만료/실패"인지 분류 — *에러 필드에만* 적용(일반 출력 아님 → 오탐 최소).
 * 18시 케이스("API Error: 401 ...")처럼 auth 단어 없이 401만 오는 경우도 잡되, 호출부가 에러 문맥으로 한정.
 */
export function isAuthError(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /failed to authenticate/.test(t) ||
    /invalid_grant/.test(t) ||
    /oauth token (has )?expired/.test(t) ||
    /\bunauthorized\b/.test(t) ||
    /please (obtain|run|sign|re-?authenticate).{0,40}(token|login|authenticat)/.test(t) ||
    /\b401\b/.test(t)
  );
}
