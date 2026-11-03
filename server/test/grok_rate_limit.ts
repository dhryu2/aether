/**
 * Grok 한도 오류 판별(A1) — 정규화 단위 시험과 가짜 Grok 실행. 모델 호출 0.
 * 판별은 실제 오류 표본 없이 만든 임시 판별이다(errorOrigin.ts의 shortcut 주석 참조).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokrl-"));
process.env.AETHER_GROK_SHUTDOWN_GRACE_MS = "500";
const GROK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokrl-home-"));
fs.writeFileSync(path.join(GROK_HOME, "auth.json"), JSON.stringify({ email: "fake-grok@example.invalid" }), { mode: 0o600 });
process.env.GROK_HOME = GROK_HOME;
const FUTURE_END = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
process.env.FAKE_GROK_BILLING_END = FUTURE_END;

const { makeFakeGrokBin } = await import("./support/fakeGrokStdio");
process.env.AETHER_GROK_BIN = makeFakeGrokBin().bin;

const { GrokRuntime } = await import("../sessions/runtimes/grok");
const { normalizeGrok } = await import("../sessions/normalize/grok");
const { grokRateLimitKind } = await import("../providers/grok/errorOrigin");
type RawProviderEventBody = import("../types").RawProviderEventBody;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const result = (error: string | undefined, extra: Record<string, unknown> = {}) =>
  ({ kind: "grok", seq: 1, ts: 1, msg: { method: "session/prompt_result", params: { stopReason: "failed", ...(error ? { error } : {}), ...extra } } }) as never;
const types = (ev: never) => normalizeGrok(ev).map((a) => `${a.type}${a.type === "turn_completed" ? `:${a.status}` : ""}`);

console.log("\n=== 정규화 ===");
for (const msg of ["You hit your weekly limit.", "You hit your free usage limit.", "You've hit the rate limit for your plan."]) {
  check(JSON.stringify(types(result(msg))) === JSON.stringify(["provider_notice", "turn_completed:failed"]), `문구: ${msg} -> 막힘이 실패보다 먼저`, types(result(msg)));
}
for (const status of [429, 402]) {
  check(JSON.stringify(types(result("Some failure", { errorStatus: status }))) === JSON.stringify(["provider_notice", "turn_completed:failed"]), `상태 ${status} -> 막힘이 먼저`);
}
check(JSON.stringify(types(result("Some other failure"))) === JSON.stringify(["turn_completed:failed"]), "다른 문장은 막힘 알림이 없다");
check(JSON.stringify(types(result("line 429 failed"))) === JSON.stringify(["turn_completed:failed"]), "문장 속 숫자 429는 한도가 아니다");
check(grokRateLimitKind("you hit your weekly limit.", undefined) === undefined, "대소문자가 다르면 판별하지 않는다");
{
  const notice = normalizeGrok(result("You hit your weekly limit.", { resetsAt: 1_800_000_000_000 })).find((a) => a.type === "provider_notice");
  check(notice?.type === "provider_notice" && notice.resetsAt === 1_800_000_000_000 && notice.severity === "blocked" && notice.kind === "rate_limit", "resetsAt이 그대로 옮겨진다", notice);
}

console.log("\n=== 가짜 Grok 실행 ===");
async function runTurn(text: string) {
  const events: RawProviderEventBody[] = [];
  const rt = new GrokRuntime({
    sessionId: `rl-${Math.random().toString(36).slice(2)}`,
    cwd: process.env.AETHER_DATA_DIR!,
    permissionMode: "manual",
    onPermission: async () => ({ allow: true }),
    onQuestion: async () => ({ answered: false, reason: "aborted" }),
    onPlan: async () => ({ decision: "cancel" as const }),
    onResumeKey: () => {},
  });
  void (async () => {
    try {
      for await (const ev of rt.events()) events.push(ev);
    } catch {
      /* 종료 */
    }
  })();
  rt.push({ text });
  const t0 = Date.now();
  const doneEv = () => events.find((e) => (e.msg as { method?: string })?.method === "session/prompt_result");
  while (!doneEv() && Date.now() - t0 < 8000) await sleep(20);
  const calls = (await (rt as unknown as { stdio: { request: (m: string) => Promise<{ calls: { method: string }[] }> } }).stdio.request("test/calls")).calls;
  const params = ((doneEv()?.msg as { params?: Record<string, unknown> })?.params ?? {}) as Record<string, unknown>;
  await rt.dispose();
  return { params, billed: calls.some((c) => c.method === "_x.ai/billing") };
}
{
  const r = await runTurn("@@weekly@@");
  check(r.params.resetsAt === Date.parse(FUTURE_END), "weekly: 요금 기간 끝이 resetsAt으로 실린다", r.params);
}
{
  const r = await runTurn("@@free@@");
  check(r.params.resetsAt === Date.parse(FUTURE_END), "free: 요금 기간 끝을 쓴다", r.params);
}
{
  const r = await runTurn("@@http402@@");
  check(r.params.errorStatus === 402 && r.params.resetsAt === Date.parse(FUTURE_END), "402: 상태 숫자와 기간 끝이 실린다", r.params);
}
{
  const r = await runTurn("@@ratelimit@@");
  check(r.params.resetsAt === undefined && !r.billed, "rate limit for your plan: 요금 조회도 시각도 없다", { ...r });
}
{
  const r = await runTurn("@@http429@@");
  check(r.params.errorStatus === 429 && r.params.resetsAt === undefined && !r.billed, "429: 요금 조회도 시각도 없다", { ...r });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} grok_rate_limit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
