/**
 * 세션 없는 계정 한도 조회 — 반복해서 열어도 프로세스가 쌓이지 않는지, 한 서비스의 실패가 번지지 않는지. 모델 호출 0.
 */
import assert from "node:assert/strict";
import { __resetAccountUsageForTest, accountUsage } from "../providers/accountUsage";
import { __registerProviderForTest, listProviders } from "../providers/registry";
import { usageFromCodexRateLimits } from "../providers/codex/usage";
import type { ProviderServices, ProviderUsage } from "../providers/types";

// 제한 시간 타이머는 unref라 시험이 먼저 끝나지 않게 붙잡는다.
const keepAlive = setInterval(() => {}, 1000);
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const ok: ProviderUsage = {
  costUsd: 1,
  context: { used: 1, size: 2 },
  windowsAvailable: true,
  windows: [{ key: "five_hour", utilization: 40, resetsAt: null }],
};
const calls = { claude: 0, codex: 0, grok: 0 };
let claudeUsage: () => Promise<ProviderUsage> = async () => ok;

function fake(id: string, extra: Partial<ProviderServices>): void {
  const real = listProviders().find((entry) => entry.id === id)!;
  __registerProviderForTest({
    ...real,
    services: { ...real.services, availability: async () => ({ available: true }), usage: undefined, ...extra },
  });
}
fake("claude", { usage: async () => { calls.claude++; return claudeUsage(); } });
fake("codex", { usage: async () => { calls.codex++; throw new Error("읽기 실패"); } });
fake("grok", { availability: async () => ({ available: false, reason: "logged_out" }), usage: async () => { calls.grok++; return ok; } });
fake("ollama", {});

__resetAccountUsageForTest();

// 동시 요청은 한 번만 읽고, 쓸 수 없는 서비스와 한도가 없는 서비스는 묻지 않는다.
const [first, second] = await Promise.all([accountUsage(false), accountUsage(false)]);
assert.deepEqual(calls, { claude: 1, codex: 1, grok: 0 }, "겹친 요청은 프로세스를 하나만 띄운다");
assert.deepEqual(first, second);
assert.deepEqual(first.providers.map((p) => p.provider), ["claude", "codex"], "못 쓰는 서비스와 Ollama는 목록에 없다");

// 세션 값은 흘리지 않고, 한 서비스의 실패는 다른 서비스 값을 막지 않는다.
assert.deepEqual(first.providers[0]!.usage, { windowsAvailable: true, windows: ok.windows });
assert.equal(first.providers[1]!.usage, null, "실패는 숫자를 지어내지 않는다");

// 탭을 다시 열어도 1분 안에는 띄우지 않는다. 실패도 저장한다.
clock += 59_000;
await accountUsage(false);
assert.deepEqual(calls, { claude: 1, codex: 1, grok: 0 }, "1분 안에는 다시 읽지 않는다");
clock += 2_000;
await accountUsage(false);
assert.deepEqual(calls, { claude: 2, codex: 2, grok: 0 }, "1분이 지나면 다시 읽는다");

// 새로고침을 연타해도 10초에 한 번이다.
clock += 5_000;
await accountUsage(true);
assert.deepEqual(calls, { claude: 2, codex: 2, grok: 0 }, "새로고침도 10초 안에는 저장값이다");
clock += 6_000;
await accountUsage(true);
assert.deepEqual(calls, { claude: 3, codex: 3, grok: 0 }, "10초가 지난 새로고침은 새로 읽는다");

// 어댑터가 응답하지 않아도 화면이 영원히 기다리지 않고, 다음 조회도 막히지 않는다.
Date.now = realNow;
clock = realNow();
__resetAccountUsageForTest(10);
claudeUsage = () => new Promise(() => {});
const hung = await accountUsage(false);
assert.equal(hung.providers[0]!.usage, null, "응답 없는 서비스는 확인 못 함으로 끝난다");
__resetAccountUsageForTest(10);
claudeUsage = async () => ok;
assert.ok((await accountUsage(false)).providers[0]!.usage, "다음 조회는 다시 읽는다");
__resetAccountUsageForTest();

// 느린 서비스가 빠른 서비스의 값을 붙잡지 않고, 끝난 값은 다음 조회에 나온다.
__resetAccountUsageForTest(1000, 20);
let release = () => {};
claudeUsage = () => new Promise((resolve) => { release = () => resolve(ok); });
const slow = await accountUsage(false);
assert.equal(slow.providers[0]!.usage, null, "마감까지 못 읽은 서비스는 확인 못 함으로 먼저 응답한다");
assert.ok(slow.providers[1], "다른 서비스는 함께 나온다");
const before = calls.claude;
await accountUsage(false);
assert.equal(calls.claude, before, "아직 도는 조회가 있으면 새로 띄우지 않는다");
release();
await new Promise((resolve) => setTimeout(resolve, 5));
assert.ok((await accountUsage(false)).providers[0]!.usage, "늦게 끝난 값은 저장돼 다음 조회에 나온다");

// 못 쓰던 서비스에 로그인하면 저장값을 기다리지 않고 바로 나온다.
__resetAccountUsageForTest();
let loggedIn = false;
fake("grok", { availability: async () => (loggedIn ? { available: true } : { available: false, reason: "logged_out" }), usage: async () => ok });
assert.ok(!(await accountUsage(false)).providers.some((p) => p.provider === "grok"));
loggedIn = true;
assert.ok((await accountUsage(false)).providers.some((p) => p.provider === "grok"), "로그인 직후 바로 보인다");

// 가용성 확인이 실패한 서비스는 사라지지 않고 확인 못 함으로 보인다.
__resetAccountUsageForTest();
fake("grok", { availability: async () => ({ available: false, reason: "check_failed" }), usage: async () => ok });
assert.equal((await accountUsage(false)).providers.find((p) => p.provider === "grok")?.usage, null);
__resetAccountUsageForTest();

// Codex 응답 변환은 세션과 세션 밖이 같은 함수를 쓴다.
const codex = usageFromCodexRateLimits({
  rateLimits: { limitId: "codex", primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1787617478 } },
} as never);
assert.equal(codex.windows[0]!.utilization, 7);
assert.equal(codex.windows[0]!.windowMinutes, 300);

clearInterval(keepAlive);
console.log("✓ account_usage");
process.exit(0);
