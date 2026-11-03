/**
 * 세션 rename(표시 이름) 단위 테스트 (Claude 0). 디스크 세션에 setName → 메타 영속·list 반영·리셋·드리프트 방지 검증.
 * (live 세션 resume 드리프트 방지는 claude spawn이 필요해 여기선 디스크 경로만 — getOrResume의 name 전파는 코드 리뷰로 보장.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-rename-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-rename-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`); c ? pass++ : fail++; };

async function mkSession(id: string, meta: any, events: any[]) {
  fs.mkdirSync(path.join(DATA, id), { recursive: true });
  if (meta !== null) fs.writeFileSync(path.join(DATA, id, "meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
  const store = await import("../sessions/persistence");
  for (const e of events) store.appendEvent(id, e as never);
}

async function main() {
  await (await import("./support/tempDb")).useTempDiary("rename"); // 임시 SQLite 일기
  await mkSession("s1", { id: "s1", cwd: ROOT, model: "haiku", resumeKey: "sid-1", createdAt: 1000 }, [
    { seq: 1, ts: 1, kind: "status", status: "completed" },
  ]);

  const { sessionManager } = await import("../sessions/SessionManager");
  const store = await import("../sessions/persistence");

  sessionManager.restoreFromDisk();
  const dn = (id: string) => sessionManager.list().find((x: any) => x.id === id)?.displayName;
  const named = (id: string) => sessionManager.list().find((x: any) => x.id === id)?.named;

  check(dn("s1") === "", "T0 초기 displayName = 빈 값(폴더 이름을 쓰지 않는다)", `dn=${dn("s1")}`);
  check(named("s1") === false, "T0 이름 없으면 named=false");

  // ── rename ──
  check(sessionManager.setName("s1", "내 작업") === true, "T1 setName(디스크 세션) → true");
  check(store.loadMeta("s1")?.name === "내 작업", "T2 meta.json에 name 영속", `name=${store.loadMeta("s1")?.name}`);
  check(dn("s1") === "내 작업", "T3 list() displayName = 지정 이름 우선", `dn=${dn("s1")}`);
  check(named("s1") === true, "T3 지정 이름은 named=true");

  // ── 드리프트 방지: 다른 메타 갱신(model)이 name을 지우지 않음 ──
  sessionManager.updateDiskMeta("s1", { model: "sonnet" });
  check(store.loadMeta("s1")?.name === "내 작업" && store.loadMeta("s1")?.model === "sonnet", "T4 model 변경 후에도 name 보존(드리프트 방지)");

  // ── 공백/빈값 → 자동 제목(없으면 빈 값). 폴더 이름으로 돌아가지 않는다 ──
  check(sessionManager.setName("s1", "   ") === true, "T5 빈값(공백) setName → true");
  check(store.loadMeta("s1")?.name === undefined, "T5 name 제거(undefined)", `name=${JSON.stringify(store.loadMeta("s1")?.name)}`);
  check(dn("s1") === "", "T5 displayName = 빈 값(폴더 이름 폴백 없음)", `dn=${dn("s1")}`);
  check(named("s1") === false, "T5 이름을 비우면 named=false");

  await mkSession("s2", { id: "s2", cwd: ROOT, model: "haiku", resumeKey: "sid-2", createdAt: 2000 }, [
    { seq: 1, ts: 1, kind: "user_msg", text: "Please fix the login timeout bug" },
    { seq: 2, ts: 2, kind: "status", status: "completed" },
  ]);
  sessionManager.restoreFromDisk();
  check(dn("s2") === "Fix the login timeout bug", "T7 첫 말에서 자동 제목을 뽑는다", `dn=${dn("s2")}`);
  check(named("s2") === false, "T7 자동 제목은 named=false");
  check(store.loadMeta("s2")?.generatedName === "Fix the login timeout bug", "T7 generatedName 영속");
  check(sessionManager.setName("s2", "로그인 수정") === true, "T8 자동 제목 위에 사람 이름");
  check(dn("s2") === "로그인 수정" && named("s2") === true, "T8 사람 이름이 앞선다");
  check(sessionManager.setName("s2", "  ") === true, "T9 사람 이름을 비우면 자동 제목으로 복귀");
  check(dn("s2") === "Fix the login timeout bug" && named("s2") === false, "T9 자동 제목 유지", `dn=${dn("s2")}`);

  // ── 미존재 세션 → false(라우트 404) ──
  check(sessionManager.setName("nope", "x") === false, "T6 미존재 세션 setName → false");

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log("─".repeat(50));
  console.log(`rename: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("오류:", e); process.exit(1); });
