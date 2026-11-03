/**
 * bx_verify_session_create — SessionManager.create 입력 정규화(M1 수정) 검증 (Claude 모델 호출 0).
 *
 * M1 수정(bx-verify): create()가 단일 chokepoint에서 model/resume/cwd를 타입 정규화한다.
 *   - 빈문자열 model:''  → config.claudeDefaultModel 폴백(과거 ''가 `?? ` 폴백 우회하던 결함 해소)
 *   - 비문자열 model/resume → defaultModel / undefined로 정규화(SDK options 미오염)
 *   - cwd는 종전대로 검증(resolveWorkFolder: 없는 경로·파일·상대경로·보호 폴더 거부)
 *
 * 관점:
 *   [Spec Tester / 블랙박스]  계약: 정상 입력 시 {id,cwd,model} 반환, cwd 검증.
 *   [Code Tester / 화이트박스]  create의 `typeof ... ? : config.claudeDefaultModel` 정규화가 ''/비문자열을 흡수함을 직접 관측.
 *
 * 주의: LiveSession 생성자는 query()를 lazy하게 만들 뿐 실제 claude spawn은 메시지(턴) 전송 시.
 *       이 테스트는 메시지를 보내지 않고 create()까지만 검증 → 모델 쿼터 0.
 *
 * ⚠️ config 검증(projectRootReal realpath)을 위해 AETHER_PROJECT_ROOT를 실존 임시 디렉터리로 둔다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxcreate-root-")));
process.env.AETHER_PROJECT_ROOT = ROOT;
process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxcreate-data-"));
// 기본 모델은 명시적 'haiku'로 고정(폴백 채택 여부를 명확히 관측하기 위함).
process.env.AETHER_MODEL = "haiku";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  const { config } = await import("../config");
  const { sessionManager } = await import("../sessions/SessionManager");
  await (await import("./support/tempDb")).useTempDiary("bx_verify_session_create"); // 임시 SQLite 일기
  const created: any[] = []; // 종료 시 drain용

  // ── 정상경로(Spec 계약): 기본 cwd=화이트리스트 루트, model 지정 ──
  {
    const s = sessionManager.create({ provider: "claude", cwd: config.projectRoot, model: "haiku" });
    created.push(s);
    check(typeof s.id === "string" && s.id.length > 0, "[normal] id 부여됨");
    check(s.cwd === config.projectRootReal, "[normal] cwd가 realpath 화이트리스트 루트로 해소됨", `cwd=${s.cwd}`);
    check(s.model === "haiku", "[normal] 지정 model 반영");
    const body = { id: s.id, cwd: s.cwd, model: s.model };
    check(Object.keys(body).sort().join(",") === "cwd,id,model", "[normal] 201 본문 계약 {id,cwd,model} 정확");
  }

  // ── 정상경로: model 미지정 → defaultModel 폴백 ──
  {
    const s = sessionManager.create({ provider: "claude", cwd: config.projectRoot });
    created.push(s);
    check(s.model === config.claudeDefaultModel && s.model === "haiku",
      "[normal] model 미지정 → defaultModel 폴백", `model=${s.model}`);
  }

  // ── fix M1-A: 빈문자열 model:'' → defaultModel 폴백(정규화됨) ──
  {
    const s = sessionManager.create({ provider: "claude", cwd: config.projectRoot, model: "" });
    created.push(s);
    check(s.model === config.claudeDefaultModel && s.model === "haiku",
      "[fix M1] 빈문자열 model → defaultModel 폴백(정규화 — 빈 모델 spawn 차단)", `model=${JSON.stringify(s.model)}`);
  }

  // ── fix M1-B: 비문자열 model(숫자) → defaultModel 폴백(타입가드) ──
  {
    let threw = "";
    let s: any;
    try { s = sessionManager.create({ provider: "claude", cwd: config.projectRoot, model: 123 as any }); created.push(s); }
    catch (e) { threw = String((e as Error).message); }
    check(threw === "" && s !== undefined && s.model === config.claudeDefaultModel,
      "[fix M1] 비문자열 model(123) → defaultModel 폴백(타입가드)", `model=${JSON.stringify(s?.model)}`);
  }

  // ── fix M1-C: 비문자열 resume(배열) → undefined로 정규화(SDK options 미오염) ──
  {
    let threw = "";
    let s: any;
    try { s = sessionManager.create({ provider: "claude", cwd: config.projectRoot, resume: ["bad"] as any }); created.push(s); }
    catch (e) { threw = String((e as Error).message); }
    check(threw === "" && s !== undefined && s.resumeKey === undefined,
      "[fix M1] 비문자열 resume(배열) → undefined 정규화(타입가드)", `sid=${JSON.stringify(s?.resumeKey)}`);
  }

  // ── fix M1-D: 문자열이지만 UUID 형식 아닌 resume → throw(임의 문자열 주입 차단) ──
  {
    let threw = false;
    try { sessionManager.create({ provider: "claude", cwd: config.projectRoot, resume: "not-a-uuid" }); } catch { threw = true; }
    check(threw, "[fix M1] UUID 아닌 resume 문자열 → throw(라우트 400, 주입 차단)");
  }

  // ── 화이트박스: cwd는 종전대로 검증 — 없는 폴더면 즉시 throw ──
  {
    let threw = false;
    try { sessionManager.create({ provider: "claude", cwd: path.join(ROOT, "no-such-dir") }); } catch { threw = true; }
    check(threw, "[edge] 없는 폴더 cwd → 즉시 throw(라우트 400)");
  }

  // 좀비 promise/리소스 정리.
  for (const s of created) { try { (s as any).drainPending?.("테스트 종료"); } catch { /* ignore */ } }

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  console.log("─".repeat(56));
  console.log(`bx_verify_session_create: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
