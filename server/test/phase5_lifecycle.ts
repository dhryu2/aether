/**
 * Phase 5 권한 lifecycle 단위 (Claude 모델 호출 0 — 세션/runtime 생성 시 claude CLI는 뜨나 메시지 미전송).
 * 다중 pending · 멱등 resolve · abort→deny · drainPending · 권한 결과(H1 통로 폐쇄).
 * requestPermission(private)을 캐스팅해 직접 호출(권한 왕복 경유 없이 pending API 검증).
 *
 * 8d 이후 H1("승인한 카드 = 실제 실행 인자")은 두 곳에서 지켜진다:
 *   ① LiveSession — 사용자 결정을 allow/deny로만 돌려준다(인자를 실어 보낼 통로 자체가 없음).
 *   ② ClaudeRuntime — allow면 SDK가 준 *원본* toolInput을 실행 인자로 되돌린다.
 * 그래서 T17까지는 세션 쪽을, T18은 runtime 쪽을 검증한다.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-life-data-"));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  // realpath로 푼다 — macOS의 임시 폴더는 `/var/...`가 `/private/var/...`의 별칭이라, 안 풀면 경로 비교가
  //   "작업 폴더 밖"으로 오판한다. 실제 세션의 cwd도 이미 풀린 경로다(SessionManager가 검증하며 푼다).
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-life-cwd-")));
  const { LiveSession } = await import("../sessions/LiveSession");
  await (await import("./support/tempDb")).useTempDiary("phase5_lifecycle"); // 임시 SQLite 일기
  const store = await import("../sessions/persistence");
  const { eventLogFor } = await import("../sessions/eventLog");
  const lifeId = randomUUID();
  const s = new LiveSession({ id: lifeId, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(lifeId) }) as any;
  /** runtime → 세션으로 오는 권한 요청 형태(PermissionAsk). */
  const ask = (toolName: string, input: Record<string, unknown>, tid: string, signal: AbortSignal) => ({ toolName, input, toolUseID: tid, signal });

  const guard = setTimeout(() => { console.error("타임아웃"); process.exit(1); }, 15000);

  // T13 다중 동시 pending
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const p1 = s.requestPermission(ask("Bash", { command: "echo 1" }, "t1", ac1.signal));
  const p2 = s.requestPermission(ask("Bash", { command: "echo 2" }, "t2", ac2.signal));
  let pend = s.pendingPermissions();
  check(pend.length === 2 && pend[0].id !== pend[1].id, "T13 다중 동시 pending(2, 서로 다른 id)");
  const id1 = pend[0].id;
  const id2 = pend[1].id;

  // T14 멱등 resolve
  check(s.resolvePermission(id1, "allow") === true, "T14 resolve 1번째 true");
  check(s.resolvePermission(id1, "allow") === false, "T14 resolve 2번째 false(멱등)");
  check((await p1).allow === true, "T14 allow promise 해소");

  // T15 abort → deny
  ac2.abort();
  const r2 = await p2;
  check(r2.allow === false, "T15 abort → deny 해소");
  check(s.resolvePermission(id2, "allow") === false, "T15 abort 후 resolve false(이미 정리)");

  // T15b: signal이 이미 abort된 상태로 runtime 콜백이 들어와도 listener 재발화를 기다리지 않고 즉시 정리.
  // 이 경합을 놓치면 interrupt와 카드 생성이 맞물린 한 턴이 영구 pending이 된다.
  const acAlready = new AbortController();
  acAlready.abort();
  const beforeAlready = s.replaySince(0).length;
  const already = await s.requestPermission(ask("Bash", { command: "already-aborted" }, "t-already", acAlready.signal));
  check(already.allow === false && s.pendingPermissions().length === 0 && s.replaySince(0).length === beforeAlready, "T15b 이미 abort된 signal은 카드 없이 즉시 deny + pending 없음");

  // T16 drainPending
  const ac3 = new AbortController();
  const ac4 = new AbortController();
  const p3 = s.requestPermission(ask("Bash", { command: "3" }, "t3", ac3.signal));
  const p4 = s.requestPermission(ask("Bash", { command: "4" }, "t4", ac4.signal));
  check(s.pendingPermissions().length === 2, "T16 drain 전 pending 2");
  s.drainPending("종료");
  check((await p3).allow === false && (await p4).allow === false && s.pendingPermissions().length === 0, "T16 drainPending 전체 deny + 비움");

  const qAlready = new AbortController();
  qAlready.abort();
  const beforeQuestionAlready = s.replaySince(0).length;
  const qResult = await s.requestQuestion({ toolUseID: "q-already", questions: [], signal: qAlready.signal });
  check(qResult.answered === false && s.pendingQuestionList().length === 0 && s.replaySince(0).length === beforeQuestionAlready, "T16b 이미 abort된 질문은 카드 없이 즉시 deny + pending 없음");

  // T16c: 시크릿 파일 Read와 tool_result 사이에 서버가 재시작해도, 새 LiveSession이 영속 축소기 상태를
  // 복원해 평문 결과를 다시 저장하지 않아야 한다.
  const restartId = "11111111-1111-4111-8111-111111111111";
  store.ensureSessionDir(restartId);
  store.appendEvent(restartId, {
    seq: 1,
    ts: 1,
    kind: "sdk",
    msg: { type: "assistant", message: { content: [{ type: "tool_use", id: "secret-read", name: "Read", input: { file_path: path.join(cwd, ".env") } }] } },
  } as any);
  const afterRestart = new LiveSession({ id: restartId, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(restartId) }) as any;
  afterRestart.ingest({
    kind: "sdk",
    msg: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "secret-read", content: "OPENAI_API_KEY=sk-restart-secret" }] } },
  });
  const savedAfterRestart = store.readEventsSince(restartId, 0);
  check(!JSON.stringify(savedAfterRestart.at(-1)).includes("sk-restart-secret"), "T16c 재시작 뒤 영속 축소기 상태 복원 → 시크릿 결과도 redact");
  afterRestart.dispose();

  // T17 세션은 결정만 돌려준다 — 승인 응답에 실행 인자를 실어 보낼 필드가 없다(H1 통로 폐쇄).
  const ac5 = new AbortController();
  const p5 = s.requestPermission(ask("Write", { file_path: "x.txt", content: "orig" }, "t5", ac5.signal));
  const id5 = s.pendingPermissions().find((r: any) => r.toolName === "Write").id;
  check(s.resolvePermission(id5, "allow") === true, "T17 allow resolve true");
  const r5 = await p5;
  check(r5.allow === true && !("input" in r5) && !("updatedInput" in r5), "T17 allow 결과는 결정만(인자 전달 필드 없음)");

  // R8(리뷰 #1) 시크릿 Edit → 카드에 실리는 표시본에서 old/new_string이 가려진다.
  //   8e 이동: 이 판정은 이제 runtime이 한다(인자 이름을 아는 것이 provider의 지식이라). 그래서 세션에
  //   직접 넣지 않고, 세션이 실제로 받는 모양 그대로(runtime이 이미 가린 input) 넣어 카드까지 이어지는지 본다.
  const ac8 = new AbortController();
  const redactedShown = { file_path: ".env", old_string: "[비밀 정보]", new_string: "[비밀 정보]" };
  const p8 = s.requestPermission(ask("Edit", redactedShown, "t8", ac8.signal));
  const reqShown = s.pendingPermissions().find((r: any) => r.toolUseID === "t8");
  check(reqShown.input.old_string === "[비밀 정보]" && reqShown.input.new_string === "[비밀 정보]", "R8 시크릿 Edit req.input redact(SSE 노출본)");
  s.resolvePermission(reqShown.id, "allow");
  check((await p8).allow === true, "R8 시크릿 Edit 승인 해소");

  // T18 runtime 쪽 H1 — allow면 SDK 원본 toolInput이 그대로 실행 인자로 되돌아간다(표시본·수정본이 아님).
  const { ClaudeRuntime } = await import("../sessions/runtimes/claude");
  let decision: any = { allow: true };
  let questionOutcome: any = { answered: true, answers: [{ chosen: ["빨강"] }] };
  /** runtime이 세션에 넘긴 카드 내용 — 표시용 인자와 변경 미리보기를 runtime이 채우는지 본다(8e). */
  let lastAsk: any = null;
  const rt = new ClaudeRuntime({
    sessionId: "test-session",
    cwd,
    model: "haiku",
    permissionMode: "manual",
    onPermission: async (a: any) => { lastAsk = a; return decision; },
    onQuestion: async () => questionOutcome,
    onResumeKey: () => {},
  }) as any;
  const rtCtx = (tid: string) => ({ signal: new AbortController().signal, toolUseID: tid });
  const origInput = { file_path: ".env", old_string: "S_OLD", new_string: "S_NEW" };
  const g1 = await rt.requestPermission("Edit", origInput, rtCtx("r1"));
  check(g1.behavior === "allow" && g1.updatedInput === origInput, "T18 allow → SDK에 원본 input 그대로 반환(H1)");
  // 8e: 카드에 실릴 인자와 변경 미리보기를 만드는 일은 runtime 몫이다. 세션에는 이미 가려진 표시본만 간다.
  check(
    lastAsk?.input?.old_string === "[비밀 정보]" && lastAsk?.input?.new_string === "[비밀 정보]",
    "T18b runtime이 시크릿 경로의 인자를 가려서 넘긴다",
    JSON.stringify(lastAsk?.input),
  );
  check(lastAsk?.input !== origInput && origInput.old_string === "S_OLD", "T18b 실행 인자 원본은 그대로 남는다(H1)");
  check(lastAsk?.mutation?.redacted === true && lastAsk?.mutation?.path === ".env", "T18b runtime이 변경 미리보기를 만든다", JSON.stringify(lastAsk?.mutation));
  decision = { allow: false, message: "사용자가 거부" };
  const g2 = await rt.requestPermission("Bash", { command: "rm -rf /" }, rtCtx("r2"));
  check(g2.behavior === "deny" && g2.message === "사용자가 거부", "T18 deny → 사유 메시지 전달");
  // 질문은 권한 카드가 아니라 질문 카드로 분기하고, 답은 deny+메시지 우회로 모델에 전달된다(Claude 고유 수법).
  const g3 = await rt.requestPermission("AskUserQuestion", { questions: [{ question: "색?", options: [] }] }, rtCtx("r3"));
  check(g3.behavior === "deny" && g3.message.includes("빨강"), "T18 질문 답변은 deny+답변 메시지로 전달");
  void rt.dispose();

  clearTimeout(guard);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  console.log("─".repeat(50));
  console.log(`Phase 5 lifecycle: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
