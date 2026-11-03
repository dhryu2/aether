/**
 * node-pty를 동적으로 불러온 뒤 실제로 spawn까지 도달하는지 — 모델 호출 0.
 * 동적 import는 CJS 모듈의 spawn을 최상위에 두기도 하고 default 아래에 두기도 한다.
 * 한쪽만 읽으면 Claude 로그인 시작이 항상 실패하는데, 모듈을 막아 두는 시험(claude_modules_absent)은 이를 못 잡는다.
 * 프로그램 대신 /bin/echo를 쓴다. URL이 안 나오므로 "URL을 못 얻음"으로 끝나는 것이 정상이다.
 */
export {}; // 최상위 await를 쓰므로 모듈로 표시한다

process.env.AETHER_CLAUDE_BIN = "/bin/echo";

const { claudeLogin } = await import("../auth/claudeLogin");

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, detail?: unknown) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}`);
  if (!c && detail !== undefined) console.log("     detail:", detail instanceof Error ? detail.message : JSON.stringify(detail));
  c ? pass++ : fail++;
};

let msg = "";
try {
  await claudeLogin.start();
} catch (e) {
  msg = e instanceof Error ? e.message : String(e);
}
check(msg !== "", "로그인 시작이 가짜 프로그램에서는 URL을 못 얻어 거부된다", msg);
check(!/reading 'spawn'/.test(msg), "node-pty의 spawn을 읽지 못해 터지지 않는다(default/최상위 모두 처리)", msg);
check(!/node-pty/i.test(msg), "node-pty 불러오기 실패 문구가 아니다", msg);

console.log(`\n${fail ? "❌" : "✅"} claude_login_pty_load: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
