/**
 * SSE caught_up 표지의 계약 버전 테스트 — 가짜 provider만 써서 모델 호출 0.
 * 실제 streamRouter를 열어, 화면이 받는 named SSE 프레임에 shared 계약 상수가 실리는지 확인한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-contract-version-"));

const express = (await import("express")).default;
const { AGENT_EVENT_CONTRACT_VERSION } = await import("../../shared/agentEvent");
const { __registerProviderForTest } = await import("../providers/registry");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("contract_version"); // 임시 SQLite 일기
const { streamRouter } = await import("../routes/stream");
const { config } = await import("../config");
const mock = await import("./support/mockProvider");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

async function readCaughtUp(base: string, id: string): Promise<unknown> {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/sessions/${id}/stream?since=0`, { signal: abort.signal });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE 본문이 없다");
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("caught_up 전에 SSE가 닫혔다");
      text += decoder.decode(value, { stream: true });
      const found = text.match(/event: caught_up\ndata: (.+)\n\n/);
      if (found) return JSON.parse(found[1]);
    }
  } finally {
    abort.abort();
  }
}

const unregister = __registerProviderForTest(mock.mockEntry);
const app = express();
app.use("/api/sessions", streamRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));

let sessionId: string | undefined;
try {
  const session = sessionManager.create({ cwd: config.projectRootReal ?? config.projectRoot, provider: mock.MOCK_PROVIDER });
  sessionId = session.id;
  const port = (server.address() as { port: number }).port;
  const data = await readCaughtUp(`http://127.0.0.1:${port}`, session.id) as { contractVersion?: unknown };
  check(data.contractVersion === AGENT_EVENT_CONTRACT_VERSION, "caught_up가 shared 계약 버전을 싣는다", data);
} finally {
  server.close();
  if (sessionId) sessionManager.delete(sessionId);
  unregister();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} contract_version: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
