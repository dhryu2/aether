/**
 * Grok 인증 계약 테스트 (Phase 10d) — 모델 호출 0, 사용량 0.
 *
 * 가짜 `grok login --device-auth`로 기기코드 상태머신을 반증한다. 실 기기 화면은 열지 않는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokauth-"));
process.env.AETHER_GROK_CONTROL_IDLE_MS = "1000";
process.env.AETHER_GROK_SHUTDOWN_GRACE_MS = "500";

const SOURCE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokhome-src-"));
fs.writeFileSync(path.join(SOURCE_HOME, "auth.json"), JSON.stringify({ email: "fake-grok@example.invalid" }), { mode: 0o600 });
process.env.GROK_HOME = SOURCE_HOME;

const { makeFakeGrokBin } = await import("./support/fakeGrokStdio");
const fake = makeFakeGrokBin();
process.env.AETHER_GROK_BIN = fake.bin;

const { grokAuth, __resetGrokAuthForTest, parseDeviceAuthOutput } = await import("../providers/grok/auth");
const { controlAlive, disposeControl } = await import("../providers/grok/control");
const { resetGrokBinCache } = await import("../providers/grok/transport");
resetGrokBinCache();

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await sleep(20);
  }
  return false;
}

const SIGNAL = path.join(process.env.AETHER_DATA_DIR, "login-signal");
process.env.FAKE_GROK_LOGIN_SIGNAL = SIGNAL;
function signal(cmd: string) {
  fs.writeFileSync(SIGNAL, cmd);
}
function clearSignal() {
  fs.rmSync(SIGNAL, { force: true });
}

const parsed = parseDeviceAuthOutput("Visit https://accounts.x.ai/device\nConfirm this code: ABCD-1234\n");
check(parsed?.url === "https://accounts.x.ai/device" && parsed.userCode === "ABCD-1234", "출력에서 주소와 기기 코드를 꺼낸다");
check(parseDeviceAuthOutput("no url") === null, "주소가 없으면 파싱 실패");

check(!controlAlive(), "① 물어보기 전에는 로그인 프로세스가 떠 있지 않다");
const st1 = await grokAuth.status();
check(st1.loggedIn === true && st1.email === "fake-grok@example.invalid", "① 세션이 없어도 인증 파일을 읽어 상태를 답한다", st1);
check(!controlAlive(), "① 상태 조회는 로그인 프로세스를 띄우지 않는다");

clearSignal();
const started = await grokAuth.start();
check(started.mode === "deviceCode", "② 시작 응답이 기기 코드 방식이다", started);
check(started.mode === "deviceCode" && started.userCode === "FAKE-CODE" && !!started.url, "② 주소와 코드를 함께 준다", { url: started.mode === "deviceCode" ? started.url : "" });
check(grokAuth.submitCode === undefined, "② 되돌려 받을 코드가 없으므로 코드 제출 함수를 갖지 않는다");
check((await grokAuth.poll(started.loginId)).status === "pending", "② 완료 전에는 진행 중으로 답한다");
check(controlAlive(), "③ 로그인이 진행 중이면 프로세스가 떠 있다");
await sleep(1600);
check(controlAlive(), "③ 로그인이 진행 중이면 놀고 있어도 프로세스가 안 내려간다");

signal("complete");
check(await until(async () => (await grokAuth.poll(started.loginId)).status === "success"), "② 프로세스가 성공으로 끝나면 poll이 성공을 답한다");
const lateOther = await grokAuth.poll("다른-로그인");
check(lateOther.status === "error", "늦은 poll이 다른 식별자를 성공으로 뒤집지 않는다", lateOther);

__resetGrokAuthForTest();
clearSignal();
const dying = await grokAuth.start();
check((await grokAuth.poll(dying.loginId)).status === "pending", "④ (준비) 새 로그인이 진행 중이다");
signal("crash");
check(await until(async () => (await grokAuth.poll(dying.loginId)).status === "error"), "④ 프로세스가 죽으면 진행 중이던 로그인이 오류로 마감된다");

__resetGrokAuthForTest();
clearSignal();
const first = await grokAuth.start();
const second = await grokAuth.start();
check((await grokAuth.poll(first.loginId)).status === "error", "새 로그인을 시작하면 이전 로그인은 접힌다");
check((await grokAuth.poll(second.loginId)).status === "pending", "새로 시작한 로그인만 진행 중이다");
grokAuth.cancel(second.loginId);
check((await grokAuth.poll(second.loginId)).status === "error", "취소하면 오류로 마감된다");
check((await grokAuth.poll("없는-로그인")).status === "error", "모르는 로그인 식별자는 오류로 답한다");

__resetGrokAuthForTest();
clearSignal();
const [a, b] = await Promise.all([grokAuth.start(), grokAuth.start()]);
check(a.loginId !== b.loginId, "⑤ 두 로그인이 각각 시작됐다");
const aStatus = await grokAuth.poll(a.loginId);
const bStatus = await grokAuth.poll(b.loginId);
const pendingCount = [aStatus, bStatus].filter((s) => s.status === "pending").length;
check(pendingCount === 1, "⑤ 동시에 시작해도 하나만 진행 중이다", { aStatus, bStatus });
const liveId = aStatus.status === "pending" ? a.loginId : b.loginId;
grokAuth.cancel(liveId);
check(await until(() => !controlAlive(), 5000), "⑤ 끝나면 프로세스가 내려간다");

__resetGrokAuthForTest();
clearSignal();
const kept = await grokAuth.start();
grokAuth.cancel("아닌-식별자");
check((await grokAuth.poll(kept.loginId)).status === "pending", "다른 식별자로 취소해도 지금 로그인을 뒤집지 않는다");
grokAuth.cancel(kept.loginId);

__resetGrokAuthForTest();
grokAuth.disposeAll();
await until(() => !controlAlive());
disposeControl();
fs.rmSync(fake.dir, { recursive: true, force: true });
fs.rmSync(SOURCE_HOME, { recursive: true, force: true });
fs.rmSync(process.env.AETHER_DATA_DIR, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} grok_auth: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
