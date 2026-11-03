/**
 * Claude 재인증 순수 함수 단위 (Claude 0) — URL 추출·로그인 결과 분류·인증오류 판별.
 * (PTY 전체 흐름은 스파이크로 검증됨 — 여기선 파싱/분류만.)
 */
import { extractAuthUrl, classifyLoginOutput, isAuthError } from "../auth/loginParse";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`); c ? pass++ : fail++; };

// ── extractAuthUrl ──
const realPty =
  "\x1b[2G\x1b[?25lOpening browser to sign in…\r\n" +
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=ABC123&code_challenge_method=S256&state=XYZ789\r\n" +
  "Paste code here if prompted > ";
const url = extractAuthUrl(realPty);
check(url === "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=ABC123&code_challenge_method=S256&state=XYZ789",
  "T1 authorize URL 정확 추출(ANSI 제거 + 줄 끝에서 절단)", `got=${url}`);
check(!/Paste/.test(url ?? ""), "T1b 뒤 'Paste' 흡수 안 함");
check(extractAuthUrl("아무 URL 없음") === null, "T2 URL 없으면 null");

// ── classifyLoginOutput ──
check(classifyLoginOutput("...\r\nLogin successful.\r\n") === "success", "T3 'Login successful' → success");
check(classifyLoginOutput("Invalid code. Please make sure the full code was copied.") === "invalid_code", "T4 'Invalid code' → invalid_code");
check(classifyLoginOutput("Paste code here if prompted > ") === null, "T5 코드 대기 중(마커 없음) → null");

// ── isAuthError (positive) ──
for (const [t, why] of [
  ["Failed to authenticate. API Error: 401 The socket connection was closed unexpectedly.", "실제 18시 에러"],
  ["API Error: 401", "401만"],
  ["OAuth token has expired. Please obtain a new token or refresh your existing token.", "토큰 만료 문구"],
  ["{\"error\":{\"type\":\"invalid_grant\"}}", "invalid_grant(refresh 실패)"],
  ["Request failed: Unauthorized", "unauthorized"],
] as const) {
  check(isAuthError(t) === true, `T6 인증오류 감지: ${why}`);
}

// ── isAuthError (negative — 오탐 방지) ──
for (const [t, why] of [
  ["Tool execution failed: file not found", "일반 도구 실패"],
  ["rate_limit_event rejected (429)", "레이트리밋(429)"],
  ["서버 과부하 529 overloaded", "과부하"],
  ["", "빈 문자열"],
  [undefined, "undefined"],
] as const) {
  check(isAuthError(t) === false, `T7 비인증오류 무시: ${why}`);
}

console.log("─".repeat(50));
console.log(`claude_login_unit: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
