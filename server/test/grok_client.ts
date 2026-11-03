/**
 * grok ACP 통신선 계약 테스트 (Phase 10c) — 모델 호출 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokclient-"));
process.env.AETHER_GROK_MAX_LINE_BYTES = String(64 * 1024);
process.env.AETHER_GROK_SHUTDOWN_GRACE_MS = "500";

const { makeFakeGrokBin } = await import("./support/fakeGrokStdio");
const fake = makeFakeGrokBin();
process.env.AETHER_GROK_BIN = fake.bin;

const { GrokStdio, GrokRpcError } = await import("../providers/grok/transport");
const { grokAgentArgs } = await import("../providers/grok/args");
type GrokStdioT = InstanceType<typeof GrokStdio>;
type Notification = { method: string; params: unknown };
type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

type Harness = {
  server: GrokStdioT;
  notes: Notification[];
  exits: ExitInfo[];
  asks: { method: string; params: unknown }[];
  answer: (r: { method: string; params: unknown }) => Promise<unknown>;
};
const open = new Set<GrokStdioT>();

function start(): Harness {
  const h: Partial<Harness> & { notes: Notification[]; exits: ExitInfo[]; asks: { method: string; params: unknown }[] } = {
    notes: [],
    exits: [],
    asks: [],
    answer: async () => ({ ok: true }),
  };
  const server = new GrokStdio({
    args: grokAgentArgs({ permissionMode: "manual", model: "grok-4.6" }),
    env: { ...process.env },
    onNotification: (n) => h.notes.push(n),
    onServerRequest: async (r) => {
      h.asks.push({ method: r.method, params: r.params });
      return h.answer!(r);
    },
    onExit: (info) => h.exits.push(info),
  });
  open.add(server);
  h.server = server;
  return h as Harness;
}

async function main() {
  {
    const h = start();
    const init = await h.server.request<{ protocolVersion: number }>("initialize", { protocolVersion: 1 });
    check(init.protocolVersion === 1, "① initialize가 protocolVersion 1을 돌려준다", init);
    const sess = await h.server.request<{ sessionId: string }>("session/new", { cwd: "/tmp", mcpServers: [] });
    check(typeof sess.sessionId === "string" && sess.sessionId.length > 8, "① session/new가 sessionId를 준다", sess);
    await h.server.close();
  }

  {
    const h = start();
    h.answer = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await h.server.request("initialize", { protocolVersion: 1 });
    const sess = await h.server.request<{ sessionId: string }>("session/new", { cwd: "/tmp", mcpServers: [] });
    const prompt = h.server.request("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "@@ask@@ hello" }] }, 0);
    check(await until(() => h.asks.some((a) => a.method === "session/request_permission")), "② 승인 요청이 클라이언트로 온다");
    const result = await prompt as { stopReason?: string };
    check(result.stopReason === "end_turn", "② 승인 뒤 prompt가 끝난다", result);
    check(h.asks.length === 1, "② 서버 요청에 정확히 한 번 답한다", h.asks);
    await h.server.close();
  }

  {
    const h = start();
    await h.server.request("initialize", { protocolVersion: 1 });
    let err = "";
    try {
      await h.server.request("no/such/method", {});
    } catch (e) {
      err = String((e as Error).message);
    }
    check(/Method not found/.test(err), "③ 모르는 요청은 오류로 답하고 통신선은 산다", err);
    const echo = await h.server.request<{ calls: unknown[] }>("test/calls", {});
    check(Array.isArray(echo.calls), "③ 오류 뒤에도 다음 요청이 산다", echo);
    await h.server.close();
  }

  {
    const h = start();
    const pending = h.server.request("initialize", { protocolVersion: 1 }, 30_000);
    await h.server.close();
    let err = "";
    try {
      await pending;
    } catch (e) {
      err = String((e as Error).message);
    }
    check(/종료/.test(err), "④ 프로세스 종료 시 대기 요청을 실패로 정리한다", err);
    check(h.exits.length >= 1, "④ 종료 콜백이 온다");
    await h.server.close();
    await h.server.close();
    check(true, "④ close는 멱등이다");
  }

  {
    const h = start();
    await h.server.request("initialize", { protocolVersion: 1 });
    try {
      await h.server.request("session/load", { sessionId: "x" });
      check(false, "⑤ session/load는 실패해야 한다");
    } catch (e) {
      check(e instanceof GrokRpcError, "⑤ session/load는 RPC 오류다", e);
    }
    await h.server.close();
  }
}

try {
  await main();
} catch (e) {
  check(false, "예상 못 한 오류", String(e));
}
for (const s of open) await s.close().catch(() => {});
fs.rmSync(fake.dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} grok_client: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
