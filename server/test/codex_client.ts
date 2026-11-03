/**
 * codex app-server 통신선 계약 테스트 (Phase 8e 단위 1) — 모델 호출 0, 사용량 0.
 *
 * 가짜 app-server(`test/support/fakeAppServer.ts`)를 진짜 codex 실행 파일인 척 띄워, 통신선이 지켜야 하는
 * 여섯 가지를 반증한다: 요청은 반드시 끝난다 · 서버가 보낸 요청에는 정확히 한 번 답한다 · 깨진 줄이
 * 통신선을 죽이지 않는다 · 거대한 줄은 버리되 조용히 넘어가지 않는다 · 프로세스가 죽으면 대기 요청을
 * 전부 정리한다 · 종료는 멱등이다.
 *
 * 이 계약이 서 있어야 그 위에 얹을 승인 왕복(단위 4)과 턴 진행(단위 3)을 믿을 수 있다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config를 import하기 전에 환경을 고정한다(설정은 import 시점에 한 번 읽힌다).
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexclient-"));
// 줄 길이 상한을 최소값으로 낮춘다 — 낮춰야 "상한을 넘긴 줄" 시나리오를 짧은 시간에 재현할 수 있다.
process.env.AETHER_CODEX_MAX_LINE_BYTES = String(64 * 1024);
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

const { CodexAppServer, CodexRpcError } = await import("../codex/appServer");
type CodexAppServerT = InstanceType<typeof CodexAppServer>;
type ModelListResponse = import("../codex/protocol/v2/ModelListResponse").ModelListResponse;
type Notification = { method: string; params: unknown };
type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 조건이 참이 될 때까지 짧게 폴링(프로세스 간 통신이라 고정 대기보다 안정적). */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

type Harness = {
  server: CodexAppServerT;
  notes: Notification[];
  exits: ExitInfo[];
  /** 서버가 거꾸로 보낸 요청들(승인 왕복의 자리). */
  asks: { method: string; params: unknown }[];
  /** 다음 서버 요청에 어떻게 답할지 — 값을 돌려주거나, throw로 실패시킨다. */
  answer: (r: { method: string; params: unknown }) => Promise<unknown>;
};

const open = new Set<CodexAppServerT>();

function start(opts: { overrides?: string[]; env?: NodeJS.ProcessEnv } = {}): Harness {
  const h: Partial<Harness> & { notes: Notification[]; exits: ExitInfo[]; asks: { method: string; params: unknown }[] } = {
    notes: [],
    exits: [],
    asks: [],
    answer: async () => ({ ok: true }),
  };
  const server = new CodexAppServer({
    configOverrides: opts.overrides,
    env: { ...process.env, ...opts.env },
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
  // ── ① 실행 인자 조립: `-c` 오버라이드가 그대로 전달되는가 ──
  {
    const h = start({ overrides: ["mcp_servers.aether.url=http://x", "features.shell_tool=false"] });
    const res = (await h.server.request("test/configOverrides")) as { overrides: string[] };
    check(
      res.overrides.length === 2 && res.overrides[0] === "mcp_servers.aether.url=http://x" && res.overrides[1] === "features.shell_tool=false",
      "① 실행별 설정 오버라이드가 `-c`로 그대로 전달된다",
      res.overrides,
    );
    await h.server.close();
  }

  // ── ② 프로토콜 악수: initialize 응답 + initialized 알림까지 한 세트 ──
  {
    const h = start();
    const init = (await h.server.initialize({ name: "aether-test", version: "0.0.0" })) as { codexHome?: string };
    check(!!init.codexHome, "② initialize 응답을 받는다", init);
    const echo = (await h.server.request("test/echo", { a: 1 })) as { echo: { a: number }; initialized: boolean };
    check(echo.initialized === true, "② initialized 알림이 상대에게 도달했다");
    check(echo.echo.a === 1, "② 요청 파라미터가 그대로 전달된다");
    await h.server.close();
  }

  // ── ③ 요청과 응답의 짝짓기: 동시에 여러 건을 보내도 각자 자기 답을 받는다 ──
  {
    const h = start();
    const results = (await Promise.all([
      h.server.request("test/echo", { n: 1 }),
      h.server.request("test/echo", { n: 2 }),
      h.server.request("test/echo", { n: 3 }),
    ])) as { echo: { n: number } }[];
    check(
      results.map((r) => r.echo.n).join(",") === "1,2,3",
      "③ 동시 요청 3건이 각각 자기 응답과 짝지어진다",
      results.map((r) => r.echo.n),
    );
    await h.server.close();
  }

  // ── ④ 알림 순서 보존 ──
  {
    const h = start();
    await h.server.request("test/notify", { count: 5 });
    await until(() => h.notes.filter((n) => n.method === "test/tick").length === 5);
    const order = h.notes.filter((n) => n.method === "test/tick").map((n) => (n.params as { i: number }).i);
    check(order.join(",") === "0,1,2,3,4", "④ 알림이 보낸 순서 그대로 도착한다", order);
    await h.server.close();
  }

  // ── ⑤ 깨진 줄 하나가 통신선을 죽이지 않는다 ──
  {
    const h = start();
    const res = (await h.server.request("test/malformed")) as { recovered: boolean };
    check(res.recovered === true, "⑤ 깨진 줄 다음의 정상 응답을 받는다");
    check(h.server.diagnostics.malformedLines === 1, "⑤ 해석 못 한 줄을 1건으로 센다", h.server.diagnostics);
    await h.server.close();
  }

  // ── ⑥ 상한을 넘긴 줄은 버리되 조용히 넘어가지 않는다 ──
  {
    const h = start();
    const res = (await h.server.request("test/hugeLine", { bytes: 1_000_000 })) as { hugeSent: number };
    check(res.hugeSent === 1_000_000, "⑥ 거대한 줄 뒤의 정상 응답을 받는다");
    check(h.server.diagnostics.droppedLines >= 1, "⑥ 버린 줄을 센다(조용한 유실 금지)", h.server.diagnostics);
    check(!h.notes.some((n) => n.method === "test/huge"), "⑥ 버려진 줄은 알림으로 올라오지 않는다");
    await h.server.close();
  }

  // ── ⑦ 응답이 안 오면 시간 초과로 끝난다 ──
  {
    const h = start();
    const t0 = Date.now();
    let message = "";
    try {
      await h.server.request("test/silent", {}, 300);
      message = "(거부되지 않음)";
    } catch (e) {
      message = String((e as Error).message);
    }
    check(message.includes("시간 초과"), "⑦ 답 없는 요청이 시간 초과로 거부된다", message);
    check(Date.now() - t0 < 3000, "⑦ 지정한 상한 안에서 끝난다");
    // 시간 초과 뒤에도 통신선은 살아 있어야 한다.
    const echo = (await h.server.request("test/echo", { after: "timeout" })) as { echo: { after: string } };
    check(echo.echo.after === "timeout", "⑦ 시간 초과 뒤에도 다음 요청은 정상 동작한다");
    await h.server.close();
  }

  // ── ⑧ 상대가 오류로 답하면 오류 코드가 보존된다 ──
  {
    const h = start();
    let err: unknown;
    try {
      await h.server.request("존재하지않는/메서드");
    } catch (e) {
      err = e;
    }
    check(err instanceof CodexRpcError, "⑧ 상대의 오류 응답이 전용 오류로 온다", String(err));
    check((err as InstanceType<typeof CodexRpcError>)?.code === -32601, "⑧ 오류 코드가 보존된다", (err as InstanceType<typeof CodexRpcError>)?.code);
    await h.server.close();
  }

  // ── ⑨ 서버가 거꾸로 보낸 요청에 정확히 한 번 답한다(승인 왕복의 자리) ──
  {
    const h = start();
    h.answer = async (r) => ({ decision: "accept", saw: (r.params as { q?: string }).q });
    const res = (await h.server.request("test/serverRequest", { method: "item/commandExecution/requestApproval", payload: { q: "rm -rf" } })) as {
      answer: { decision: string; saw: string };
    };
    check(res.answer.decision === "accept", "⑨ 우리가 돌려준 답이 상대의 결과로 반영된다", res.answer);
    check(h.asks.length === 1 && h.asks[0].method === "item/commandExecution/requestApproval", "⑨ 서버 요청이 한 번만 전달된다", h.asks);
    await h.server.close();
  }

  // ── ⑩ 답을 만들다 실패해도 반드시 응답이 나간다(모델이 멈추지 않게) ──
  {
    const h = start();
    h.answer = async () => {
      throw new Error("판단 실패");
    };
    const res = (await h.server.request("test/serverRequest", { method: "item/fileChange/requestApproval" })) as {
      answer: { error?: { message?: string } };
    };
    check(!!res.answer?.error, "⑩ 핸들러가 실패해도 상대는 오류 응답을 받는다", res.answer);
    check(String(res.answer?.error?.message).includes("판단 실패"), "⑩ 실패 사유가 응답에 실린다", res.answer?.error);
    await h.server.close();
  }

  // ── ⑪ 프로세스가 죽으면 대기 중인 요청이 전부 정리된다 ──
  {
    const h = start();
    const silent = h.server.request("test/silent", {}, 0).then(
      () => "(성공?)",
      (e) => String((e as Error).message),
    );
    await h.server.request("test/crash", { code: 7, stderr: "치명적 오류: 데모" }).catch(() => {});
    const msg = await silent;
    check(msg.includes("종료로 요청이 실패"), "⑪ 프로세스 사망 시 대기 요청이 실패로 정리된다", msg);
    check(msg.includes("치명적 오류: 데모"), "⑪ 실패 메시지에 상대의 표준오류가 실린다", msg);
    check(await until(() => h.exits.length === 1), "⑪ 종료 통지가 정확히 한 번 온다", h.exits.length);
    check(h.exits[0]?.code === 7, "⑪ 종료 코드가 전달된다", h.exits[0]);
    check(!h.server.alive, "⑪ 죽은 뒤에는 살아있지 않다고 답한다");
    let after = "";
    try {
      await h.server.request("test/echo");
    } catch (e) {
      after = String((e as Error).message);
    }
    check(after.includes("이미 종료"), "⑪ 죽은 뒤의 요청은 즉시 거부된다", after);
    // 이미 죽은 뒤의 종료 호출도 안전해야 한다.
    const info = await h.server.close();
    check(info.code === 7, "⑪ 죽은 뒤 종료를 불러도 안전하다(같은 사유 반환)", info.code);
  }

  // ── ⑬ 시험대가 진짜 codex와 같은 모양으로 답한다 ──
  //   실제 codex 0.145.0으로 확인한 사실: 모델 목록의 키는 `models`가 아니라 `data`이고, 추론 강도는
  //   문자열이 아니라 `{reasoningEffort, description}` 객체다. 시험대가 이걸 흉내 내지 않으면 그 위에
  //   올리는 코드가 처음부터 틀린 모양을 상대로 만들어진다.
  {
    const h = start();
    const list = (await h.server.request("model/list", {})) as ModelListResponse;
    check(Array.isArray(list.data) && list.data.length > 0, "⑬ 모델 목록이 `data` 배열로 온다", Object.keys(list));
    check(
      typeof list.data[0]?.supportedReasoningEfforts?.[0]?.reasoningEffort === "string",
      "⑬ 추론 강도가 객체 배열이다(문자열 배열 아님)",
      list.data[0]?.supportedReasoningEfforts?.[0],
    );
    await h.server.close();
  }

  // ── ⑫ 종료는 멱등이다 ──
  {
    const h = start();
    await h.server.request("test/echo", { hello: 1 });
    const [a, b, c] = await Promise.all([h.server.close(), h.server.close(), h.server.close()]);
    check(!!a && a === b && b === c, "⑫ 종료를 여러 번 불러도 같은 결과 하나로 끝난다");
    check(h.exits.length === 1, "⑫ 종료 통지는 한 번만 온다", h.exits.length);
    check(!h.server.alive, "⑫ 종료 후 살아있지 않다고 답한다");
  }
}

try {
  await main();
} catch (e) {
  check(false, "예상 못 한 오류로 중단", String(e));
} finally {
  for (const s of open) await s.close().catch(() => {});
  try {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  } catch {
    /* 임시 폴더 정리 실패는 무해 */
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} codex_client: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
