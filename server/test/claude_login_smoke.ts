/**
 * Claude 재인증 LoginManager 통합 스모크 — start()로 PTY 구동·URL 캡처 후 cancel()(코드 미제출=인증 무변경).
 * spawn-helper chmod 가드 + claude 절대경로 해석 + 상태머신 검증. (실제 로그인 완료는 스파이크로 검증됨.)
 * ⚠️ claude auth login을 잠깐 띄움 → 맥에 Safari 탭이 열릴 수 있음(무해, 코드 미제출로 즉시 폐기).
 */
import { claudeLogin } from "../auth/claudeLogin";

async function main() {
  console.log("LoginManager.start() — PTY 구동 + URL 캡처 대기…");
  const r = await claudeLogin.start();
  const ok =
    /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/.test(r.url) &&
    r.url.includes("code_challenge") &&
    r.url.includes("state=") &&
    !/Paste/.test(r.url);
  console.log(`  ${ok ? "✅" : "❌"} URL 캡처: ${r.url.slice(0, 80)}…`);
  console.log(`  loginId: ${r.loginId.slice(0, 8)}`);

  claudeLogin.cancel(r.loginId);
  console.log("  ✅ cancel() — 코드 미제출(creds 무변경)");

  const st = await claudeLogin.status();
  console.log(`  auth status: loggedIn=${st.loggedIn} sub=${st.subscriptionType ?? "?"}`);

  console.log("─".repeat(50));
  console.log(ok && st.loggedIn ? "smoke: PASS" : "smoke: FAIL");
  process.exit(ok && st.loggedIn ? 0 : 1);
}
main().catch((e) => { console.error("smoke 오류:", e); process.exit(1); });
