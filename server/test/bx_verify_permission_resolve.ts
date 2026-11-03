/**
 * bx_verify_permission_resolve — LiveSession.resolvePermission "인자 수정(updatedInput) 통로 폐쇄"(H1) 검증 (Claude 0).
 *
 * H1 수정(bx-verify): updatedInput 통로 폐쇄 — resolvePermission은 수정본 인자를 받지 않고,
 *   allow는 updatedInput 없이 반환해 SDK가 Claude 원본 toolInput을 그대로 실행한다.
 *   → "승인한 카드 = 실제 실행 input" 보장. 경로없는 툴 undefined===undefined fail-open +
 *      시크릿 redact echo-back이 원천 차단된다.
 *
 * 관점:
 *   [Spec Tester / 블랙박스]  POST /permission {permissionId,decision}: allow→{behavior:"allow"}(원본 실행),
 *      deny→{behavior:"deny"}, 미존재/중복→false(라우트 404·멱등)
 *   [Code Tester / 화이트박스]  resolvePermission(permissionId, decision)은 updatedInput 파라미터가 없고
 *      allow 결과에 updatedInput 필드가 없다(SDK가 원본 사용). 시크릿 경로 카드 input은 redact 표시본.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// LiveSession 생성자가 store.ensureSessionDir/saveMeta로 디스크를 건드리므로 임시 데이터 디렉터리로 격리.
process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxperm-data-"));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxperm-cwd-"));
  const { LiveSession } = await import("../sessions/LiveSession");
  await (await import("./support/tempDb")).useTempDiary("bx_verify_permission_resolve"); // 임시 SQLite 일기
  const { eventLogFor } = await import("../sessions/eventLog");
  const permId = randomUUID();
  const s = new LiveSession({ id: permId, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(permId) }) as any;
  const ctx = (tid: string, signal: AbortSignal) => ({ signal, toolUseID: tid });
  const { ClaudeRuntime } = await import("../sessions/runtimes/claude");
  // 8d 이후 권한 왕복은 runtime → 세션 콜백으로 흐른다. 실제 배선 그대로 조립해 합성 경로를 검증한다
  // (SDK 형식의 결과 behavior/updatedInput은 runtime이 만든다 — 모델 호출은 없음).
  const rt = new ClaudeRuntime({
    sessionId: "test-session",
    cwd,
    model: "haiku",
    permissionMode: "manual",
    onPermission: (ask: any) => s.requestPermission(ask),
    onQuestion: (ask: any) => s.requestQuestion(ask),
    onResumeKey: () => {},
  }) as any;

  // 무한대기 방지(권한 promise는 resolve 안 되면 영영 안 끝남).
  const guard = setTimeout(() => { console.error("타임아웃"); process.exit(1); }, 15000);

  // ── allow → updatedInput 없음(통로 폐쇄, SDK가 Claude 원본 실행) ──
  {
    const ac = new AbortController();
    const p = rt.requestPermission("Write", { file_path: "note.txt", content: "원본" }, ctx("ok1", ac.signal));
    const id = s.pendingPermissions().find((r: any) => r.toolUseID === "ok1").id;
    const ok = s.resolvePermission(id, "allow");
    const r = await p;
    check(ok === true, "[normal] allow resolve → true");
    check(r.behavior === "allow", "[normal] behavior=allow");
    check(r.updatedInput?.content === "원본" && r.updatedInput?.file_path === "note.txt",
      "[H1] allow 실행 input은 원본 rawInput(클라 수정 불가, 통로 폐쇄)", `content=${r.updatedInput?.content}`);
  }

  // ── 경로 없는 툴(Bash): 통로 폐쇄라 클라 수정 주입 경로 자체가 없음(과거 undefined===undefined fail-open 제거) ──
  {
    const ac = new AbortController();
    const p = rt.requestPermission("Bash", { command: "ls" }, ctx("bash1", ac.signal));
    const id = s.pendingPermissions().find((r: any) => r.toolUseID === "bash1").id;
    const ok = s.resolvePermission(id, "allow"); // 3번째 인자(updatedInput) 자체가 시그니처에 없음
    const r = await p;
    check(ok === true && r.behavior === "allow" && r.updatedInput?.command === "ls",
      "[H1] 경로없는 툴(Bash)도 원본 command 실행(undefined===undefined fail-open 제거)");
  }

  // ── 시크릿 경로 변이: 카드는 redact 표시본, 실행은 SDK 원본(echo-back 무력) ──
  {
    const ac = new AbortController();
    const p = rt.requestPermission("Edit", { file_path: ".env", old_string: "A", new_string: "B" }, ctx("sec1", ac.signal));
    const req = s.pendingPermissions().find((r: any) => r.toolUseID === "sec1");
    check(req.input.old_string === "[비밀 정보]",
      "[H1] 시크릿 경로 카드 input은 redact 표시본");
    const r2 = await Promise.resolve(s.resolvePermission(req.id, "allow"));
    const r = await p;
    check(r2 === true && r.behavior === "allow" && r.updatedInput?.old_string === "A",
      "[H1] 시크릿 변이 실행 input은 원본 old_string='A'(redact 표시본이 실행에 못 샘)");
  }

  // ── deny → behavior deny, updatedInput 없음 ──
  {
    const ac = new AbortController();
    const p = rt.requestPermission("Write", { file_path: "deny.txt", content: "원본" }, ctx("deny1", ac.signal));
    const id = s.pendingPermissions().find((r: any) => r.toolUseID === "deny1").id;
    const ok = s.resolvePermission(id, "deny");
    const r = await p;
    check(ok === true && r.behavior === "deny" && r.updatedInput === undefined,
      "[edge] deny → behavior=deny, updatedInput 없음");
  }

  // ── 멱등: 같은 permissionId 두 번째 resolve → false ──
  {
    const ac = new AbortController();
    const p = rt.requestPermission("Write", { file_path: "idem.txt", content: "c" }, ctx("idem1", ac.signal));
    const id = s.pendingPermissions().find((r: any) => r.toolUseID === "idem1").id;
    const first = s.resolvePermission(id, "allow");
    const second = s.resolvePermission(id, "allow");
    await p;
    check(first === true && second === false, "[edge] 멱등 — 두 번째 resolve는 false(이미 처리/만료)");
  }

  // ── 미존재 permissionId → false(라우트는 이걸 404로 변환) ──
  {
    const bogus = s.resolvePermission("존재안함-id", "allow");
    check(bogus === false, "[edge] 미존재 permissionId → false(→ 라우트 404)");
  }

  clearTimeout(guard);
  void rt.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  console.log("─".repeat(56));
  console.log(`bx_verify_permission_resolve: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
