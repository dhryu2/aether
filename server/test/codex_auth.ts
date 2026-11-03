/**
 * Codex 인증 계약 테스트 (Phase 8f 단위 2) — 모델 호출 0, 사용량 0.
 *
 * 가짜 app-server를 진짜 codex 실행 파일인 척 띄워 네 가지를 반증한다.
 *
 *   ① **세션이 하나도 없어도 상태를 물어볼 수 있다.** 이게 인증 전용 프로세스를 따로 두는 이유다 —
 *      Codex는 세션마다 프로세스를 띄우는 구조라, 세션이 없으면 물어볼 상대가 없다.
 *   ② **완료가 알림으로 오는 로그인이 실제로 끝난다.** 시작 → 진행 중 → 완료 통보 → 성공으로 바뀐다.
 *   ③ **로그인 중에는 프로세스가 안 내려간다.** 놀고 있다고 내려가면 진행 중인 로그인이 통째로 끊어진다.
 *   ④ **프로세스가 죽으면 진행 중이던 로그인이 정직하게 실패로 마감된다.** 조용히 매달려 있으면 화면이
 *      영원히 기다린다(§0.1-4 — 조용한 fallback·조용한 무응답 금지).
 *
 * 여기에 놀고 있을 때 실제로 내려가는지, 그리고 상태 조회를 매번 새로 하지 않는지(프로세스 남발 방지)를 본다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config를 import하기 전에 환경을 고정한다(설정은 import 시점에 한 번 읽힌다).
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexauth-"));
// 놀 때 내려가는 시간을 최소값으로 낮춘다 — 안 낮추면 이 검사 하나에 60초가 든다.
process.env.AETHER_CODEX_CONTROL_IDLE_MS = "1000";
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

const { codexAuth, __resetCodexAuthForTest } = await import("../providers/codex/auth");
const { controlAlive, controlRequest, disposeControl, onControlExit } = await import("../codex/control");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 조건이 참이 될 때까지 짧게 폴링(프로세스 간 통신이라 고정 대기보다 안정적). */
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await sleep(10);
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// ① 세션 0개 상태의 상태 조회 + 기억해 두기
// ────────────────────────────────────────────────────────────────────────────

check(!controlAlive(), "① 물어보기 전에는 인증 프로세스가 떠 있지 않다(미리 띄우지 않는다)");

const st1 = await codexAuth.status();
check(st1.loggedIn === true && st1.email === "fake@example.invalid" && st1.subscriptionType === "plus", "① 세션이 하나도 없어도 계정 상태를 읽는다", st1);
check(controlAlive(), "① 물어본 뒤에는 인증 프로세스가 떠 있다");

const before = ((await controlRequest<{ calls: { method: string }[] }>("test/calls")).calls ?? []).filter((c) => c.method === "account/read").length;
await codexAuth.status();
const after = ((await controlRequest<{ calls: { method: string }[] }>("test/calls")).calls ?? []).filter((c) => c.method === "account/read").length;
check(after === before, "① 곧바로 다시 물으면 기억해 둔 답을 준다(조회 한 번이 프로세스를 띄우므로)", { before, after });

// ────────────────────────────────────────────────────────────────────────────
// ② 기기 코드 로그인 왕복 — 완료는 알림으로 온다
// ────────────────────────────────────────────────────────────────────────────

const started = await codexAuth.start();
check(started.mode === "deviceCode", "② 시작 응답이 기기 코드 방식임을 밝힌다", started);
check(started.mode === "deviceCode" && started.userCode === "FAKE-CODE" && !!started.url, "② 주소와 코드를 함께 준다(사용자가 폰에서 끝낸다)", { url: started.url });
check(codexAuth.submitCode === undefined, "② 되돌려 받을 코드가 없으므로 코드 제출 함수를 갖지 않는다");

const mid = await codexAuth.poll(started.loginId);
check(mid.status === "pending", "② 완료 통보 전에는 진행 중으로 답한다", mid);

// ③ 로그인 중에는 놀아도 안 내려간다 — 놀기 상한(1초)보다 넉넉히 기다려 본다.
await sleep(1600);
check(controlAlive(), "③ 로그인이 진행 중이면 놀고 있어도 프로세스가 안 내려간다");

await controlRequest("test/completeLogin", { loginId: started.loginId, success: true });
const done = await until(async () => (await codexAuth.poll(started.loginId)).status === "success");
check(done, "② 완료 통보가 오면 성공으로 바뀐다");

const statusAfterLogin = await codexAuth.status();
check(statusAfterLogin.loggedIn === true, "② 로그인이 끝나면 기억해 둔 상태를 버리고 다시 읽는다", statusAfterLogin);

// 놀기 상한이 지나면 실제로 내려간다(로그인이 끝났으므로 붙잡은 손이 없다).
const wentDown = await until(() => !controlAlive(), 4000);
check(wentDown, "놀기 상한이 지나면 인증 프로세스가 스스로 내려간다");

// ────────────────────────────────────────────────────────────────────────────
// ④ 프로세스가 죽으면 진행 중이던 로그인이 실패로 마감된다
// ────────────────────────────────────────────────────────────────────────────

__resetCodexAuthForTest();
const dying = await codexAuth.start();
check((await codexAuth.poll(dying.loginId)).status === "pending", "④ (준비) 새 로그인이 진행 중이다");
void controlRequest("test/crash", { code: 9 }).catch(() => {});
const failed = await until(async () => (await codexAuth.poll(dying.loginId)).status === "error");
check(failed, "④ 프로세스가 죽으면 진행 중이던 로그인이 오류로 마감된다(조용한 매달림 금지)");
check(!controlAlive(), "④ 죽은 뒤에는 떠 있지 않다고 답한다");

const revived = await codexAuth.status();
check(revived.loggedIn === true, "④ 죽은 뒤 다음 요청에서 다시 뜬다", revived);

// ────────────────────────────────────────────────────────────────────────────
// 취소 · 대체 · 모르는 식별자
// ────────────────────────────────────────────────────────────────────────────

__resetCodexAuthForTest();
const first = await codexAuth.start();
const second = await codexAuth.start();
check((await codexAuth.poll(first.loginId)).status === "error", "새 로그인을 시작하면 이전 로그인은 접힌다(붙잡은 손을 놓는다)");
check((await codexAuth.poll(second.loginId)).status === "pending", "새로 시작한 로그인만 진행 중이다");

codexAuth.cancel(second.loginId);
const cancelled = await codexAuth.poll(second.loginId);
check(cancelled.status === "error", "취소하면 오류로 마감된다", cancelled);
const sawCancel = await until(async () => {
  const calls = (await controlRequest<{ calls: { method: string }[] }>("test/calls")).calls ?? [];
  return calls.some((c) => c.method === "account/login/cancel");
});
check(sawCancel, "취소가 app-server까지 전달된다");

check((await codexAuth.poll("없는-로그인")).status === "error", "모르는 로그인 식별자는 오류로 답한다");

// ────────────────────────────────────────────────────────────────────────────
// 겹쳐 도는 경우 (2026-08-18 외부 검토가 지적한 세 가지)
// ────────────────────────────────────────────────────────────────────────────

// ⑤ 로그인 시작이 **동시에** 두 번 들어와도 붙잡은 손이 새지 않는다.
//   새면 인증 프로세스가 다시는 안 내려간다 — 아무도 안 쓰는 프로세스가 영원히 떠 있게 된다.
__resetCodexAuthForTest();
const [a, b] = await Promise.all([codexAuth.start(), codexAuth.start()]);
check(a.loginId !== b.loginId, "⑤ (준비) 두 로그인이 실제로 각각 시작됐다", { a: a.loginId, b: b.loginId });
check((await codexAuth.poll(a.loginId)).status === "error", "⑤ 먼저 시작한 로그인은 접힌다");
check((await codexAuth.poll(b.loginId)).status === "pending", "⑤ 나중 것만 진행 중이다");
codexAuth.cancel(b.loginId);
check(await until(() => !controlAlive(), 5000), "⑤ 둘 다 끝나면 프로세스가 내려간다(붙잡은 손이 새지 않았다)");

// ⑥ 한 요청이 끝났다고 해서, 아직 답을 기다리는 다른 요청 밑에서 프로세스를 치우면 안 된다.
//   놀기 상한은 1초인데 느린 요청은 3초 걸린다 — 붙잡은 것(hold)만 세면 그 사이에 프로세스가 사라진다.
__resetCodexAuthForTest();
await codexAuth.status(); // 프로세스를 미리 띄워 둔다(스폰 시간이 판정에 안 섞이게)
// 실패를 **만들어지는 즉시** 붙잡는다. 나중에 붙이면 그 사이에 온 거부가 처리되지 않은 채로 터져
//   테스트 러너가 결과도 못 내고 죽는다(고장을 ❌로 보고하지 못하면 게이트로서 쓸모가 없다).
let slowFailed = "";
const slow = controlRequest("test/slow", { ms: 3000 }, 20_000).catch((e) => {
  slowFailed = String((e as Error)?.message ?? e);
});
await sleep(50);
await controlRequest("test/echo"); // 먼저 끝나는 요청 — 여기서 "이제 논다"고 판단하던 자리
await sleep(1500); // 놀기 상한(1000ms)을 넘긴다
check(controlAlive(), "⑥ 아직 답을 기다리는 요청이 있으면 프로세스가 안 내려간다");
await slow;
check(slowFailed === "", "⑥ 그래서 그 요청도 정상적으로 끝난다", slowFailed.slice(0, 80));

// ⑦ 우리가 **일부러 내린** 프로세스의 종료는 크래시로 방송하면 안 된다.
//   방송하면, 그 사이 새로 뜬 프로세스에서 진행 중이던 로그인이 남의 부고에 마감된다.
__resetCodexAuthForTest();
let exitBroadcasts = 0;
const offExit = onControlExit(() => exitBroadcasts++);
await codexAuth.status(); // 프로세스 하나 띄우고
disposeControl(); // 일부러 내린다
check(await until(() => !controlAlive(), 5000), "⑦ (준비) 일부러 내린 프로세스가 실제로 내려갔다");
await sleep(400); // 종료 소식이 도착할 시간
check(exitBroadcasts === 0, "⑦ 일부러 내린 프로세스의 종료는 크래시로 방송되지 않는다", exitBroadcasts);

// 반대로 **진짜 크래시**는 반드시 방송돼야 한다 — 안 그러면 진행 중 로그인이 영원히 매달린다.
await codexAuth.status();
void controlRequest("test/crash", { code: 9 }).catch(() => {});
check(await until(() => exitBroadcasts === 1, 5000), "⑦ 진짜 크래시는 그대로 방송된다", exitBroadcasts);
offExit();

// ── 정리 ──
codexAuth.disposeAll();
await until(() => !controlAlive());
disposeControl();
fs.rmSync(fake.dir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} codex_auth: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
