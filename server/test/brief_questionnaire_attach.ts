/**
 * 브리프 질문지 카드 답에 첨부가 섞이면 거절하는지 본다.
 * 카드 답은 이미지나 문서를 싣지 않는다. images 또는 documents가 같이 오면 400이다.
 * 첨부가 없는 정상 카드 답은 이 검사에 걸리지 않고 받아들여진다.
 * 가짜 provider를 쓴다. 실제 모델은 부르지 않는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const LIVE_DATA = path.join(SERVER_DIR, "data");

if (!process.env.AETHER_DATA_DIR || path.resolve(process.env.AETHER_DATA_DIR) === path.resolve(LIVE_DATA)) {
  process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-attach-"));
}
process.env.AETHER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-attach-skills-"));
delete process.env.AETHER_READ_CANON;
delete process.env.AETHER_DATABASE_URL;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  const shown = cond || extra === undefined ? "" : ` — ${JSON.stringify(extra).slice(0, 400)}`;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${shown}`);
  cond ? pass++ : fail++;
}

async function waitFor(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`기다리다 시간 초과: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function main(): Promise<void> {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-attach-proj-")));
  process.env.AETHER_PROJECT_ROOT = projectDir;
  const { config } = await import("../config");
  if (path.resolve(config.dataDir) === path.resolve(LIVE_DATA)) throw new Error("데이터 폴더가 운영 data다");
  const store = await import("../sessions/persistence");
  await (await import("./support/tempDb")).useTempDiary("brief_questionnaire_attach"); // 임시 SQLite 일기
  const { sessionManager } = await import("../sessions/SessionManager");
  const { sessionsRouter } = await import("../routes/sessions");
  const { streamRouter } = await import("../routes/stream");
  const { __registerProviderForTest } = await import("../providers/registry");
  const { mockEntry, MOCK_PROVIDER } = await import("./support/mockProvider");
  type MockRaw = import("./support/mockProvider").MockRaw;
  type MockRuntime = import("./support/mockProvider").MockRuntime;
  const express = (await import("express")).default;
  const { setLocale } = await import("../i18n");
  setLocale("ko");

  // 가짜 runtime이 입력을 기록만 하고 아무 사건도 만들지 않게 한다.
  const runtimes = new Map<string, MockRuntime>();
  const unregister = __registerProviderForTest({
    ...mockEntry,
    createRuntime(opts) {
      const rt = mockEntry.createRuntime(opts) as MockRuntime;
      rt.push = () => undefined;
      runtimes.set(opts.sessionId, rt);
      return rt;
    },
  });

  const app = express();
  app.use(express.json());
  app.use("/api/sessions", streamRouter);
  app.use("/api/sessions", sessionsRouter);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  async function post(sessionId: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  const QJ = {
    questions: [
      { id: "q1", text: "재시도할 오류", kind: "single", options: [{ label: "A" }, { label: "B" }], recommended: "A" },
    ],
  };
  const ANS = { q1: { chosen: ["A"] } };
  const IMAGE = { media_type: "image/png", data: "iVBORw0KGgo=" };
  const DOC = { name: "a.pdf", media_type: "application/pdf", data: "JVBERi0=" };

  // 브리프 세션을 만들고 질문지를 하나 받아 둔다.
  const s = sessionManager.create({ cwd: projectDir, provider: MOCK_PROVIDER, permissionMode: "full" });
  const rt = runtimes.get(s.id)!;
  const emitRaw = (msg: MockRaw) => (rt as unknown as { emit(m: MockRaw): void }).emit(msg);
  await s.push("첨부 시험 요청", undefined, undefined, "attach-req", { brief: true });
  const box = `정리를 마쳤다.\n\`\`\`aether-questions\n${JSON.stringify(QJ)}\n\`\`\``;
  emitRaw({ t: "say", text: box });
  emitRaw({ t: "done" });
  rt.emitModel("attach-sync");
  await waitFor(() => store.readEventsSince(s.id, 0).some((e) => e.kind === "questionnaire"), "질문지 사건");
  const q = store.readEventsSince(s.id, 0).find((e) => e.kind === "questionnaire") as unknown as { id: string };

  const withImage = await post(s.id, { clientMessageId: "att-img", questionnaire: { id: q.id, answers: ANS }, images: [IMAGE] });
  check(withImage.status === 400, "images가 함께 오면 400이다", withImage);

  const withDoc = await post(s.id, { clientMessageId: "att-doc", questionnaire: { id: q.id, answers: ANS }, documents: [DOC] });
  check(withDoc.status === 400, "documents가 함께 오면 400이다", withDoc);

  const plain = await post(s.id, { clientMessageId: "att-none", questionnaire: { id: q.id, answers: ANS } });
  check(plain.status === 200 && plain.json.ok === true, "첨부가 없는 카드 답은 받아들여진다", plain);

  server.close();
  unregister();
  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "✅" : "❌"} brief_questionnaire_attach: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
