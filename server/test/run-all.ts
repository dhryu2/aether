/**
 * 결정적 테스트 일괄 실행기 (Phase 8d-2) — 모델 호출 0.
 *
 * 8d-2 이전엔 스위트를 하나씩 손으로 돌렸다. 개수가 30개를 넘으면서 "무엇이 빠졌는지"를 사람이 기억해야
 * 했고, 실제로 몇몇은 오래 실패한 채 방치됐다. 여기서 한 번에 돌리고 느린 스위트를 눈에 보이게 한다.
 *
 * 실모델을 쓰는 스위트는 목록에 이름과 이유를 적어 **의도적으로** 뺀다(구독 사용량 소모).
 * 빼는 것을 눈에 보이게 하려고 실행 끝에 제외 목록을 그대로 출력한다 — 조용히 줄어드는 커버리지 방지.
 *
 * 사용: `npm test` (server/에서). 특정 스위트만: `npm test -- search fts` 처럼 이름 조각을 넘긴다.
 * 제외 목록의 실모델 스위트는 인자가 이름과 정확히 같을 때만 돈다(`run-all.ts wire_live`). 조각 일치로는 여전히 빠진다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pathname을 직접 쓰면 경로에 공백·비ASCII가 있을 때 percent-encoding으로 깨진다.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 실모델(구독 사용량 소모)이라 일괄 실행에서 뺀다 — 이름 → 이유. */
const REAL_MODEL: Record<string, string> = {
  e2e_phase1: "haiku 실세션 E2E",
  phase2_smoke: "haiku 실세션 스모크",
  phase5_e2e: "haiku 권한 왕복 E2E",
  wire_live: "haiku 실 SSE 봉투 확인(test:wire:live)",
  claude_login_smoke: "실제 claude CLI PTY 로그인",
};

/** 일괄 실행에서 빼는 스위트 — 이름 → 이유. */
const BATCH_EXCLUDE: Record<string, string> = {
  ...REAL_MODEL,
};

/** 스위트가 아닌 파일(헬퍼·픽스처). */
const NOT_A_SUITE = new Set(["run-all"]);

/** test/ 밖에 있어 파일 목록에 안 잡히는 스위트(경로 그대로 실행). */
const EXTRA_SUITES: { name: string; file: string }[] = [
  { name: "web:errorQueue", file: path.join(TEST_DIR, "..", "..", "web", "test", "errorQueue.test.ts") },
  { name: "web:errorLog", file: path.join(TEST_DIR, "..", "..", "web", "test", "errorLog.test.ts") },
  { name: "web:authGate", file: path.join(TEST_DIR, "..", "..", "web", "test", "authGate.test.ts") },
  { name: "web:setupForm", file: path.join(TEST_DIR, "..", "..", "web", "test", "setupForm.test.ts") },
  { name: "web:passwordForm", file: path.join(TEST_DIR, "..", "..", "web", "test", "passwordForm.test.ts") },
  { name: "web:deriveTurn", file: path.join(TEST_DIR, "..", "..", "web", "test", "deriveTurn.test.ts") },
  { name: "web:modelLabel", file: path.join(TEST_DIR, "..", "..", "web", "test", "modelLabel.test.ts") },
  { name: "web:paneView", file: path.join(TEST_DIR, "..", "..", "web", "test", "paneView.test.ts") },
  { name: "web:contractVersion", file: path.join(TEST_DIR, "..", "..", "web", "test", "contractVersion.test.ts") },
  { name: "web:brief", file: path.join(TEST_DIR, "..", "..", "web", "test", "brief.test.ts") },
  { name: "web:streamSegments", file: path.join(TEST_DIR, "..", "..", "web", "test", "streamSegments.test.ts") },
  { name: "web:olderHistory", file: path.join(TEST_DIR, "..", "..", "web", "test", "olderHistorySearch.test.ts") },
  { name: "web:questionDisplay", file: path.join(TEST_DIR, "..", "..", "web", "test", "questionDisplay.test.ts") },
  { name: "web:transcriptView", file: path.join(TEST_DIR, "..", "..", "web", "test", "transcriptView.test.ts") },
  { name: "web:boundary", file: path.join(TEST_DIR, "..", "..", "web", "test", "web_boundary.test.ts") },
  { name: "web:providerSel", file: path.join(TEST_DIR, "..", "..", "web", "test", "providerSelectors.test.ts") },
  { name: "web:usageLabels", file: path.join(TEST_DIR, "..", "..", "web", "test", "usageLabels.test.ts") },
  { name: "web:effortLabels", file: path.join(TEST_DIR, "..", "..", "web", "test", "effortLabels.test.ts") },
  { name: "web:appViewport", file: path.join(TEST_DIR, "..", "..", "web", "test", "appViewport.test.ts") },
  { name: "web:tokens", file: path.join(TEST_DIR, "..", "..", "web", "test", "tokens.test.ts") },
  { name: "web:interruptArm", file: path.join(TEST_DIR, "..", "..", "web", "test", "interruptArm.test.ts") },
  { name: "web:updateNotice", file: path.join(TEST_DIR, "..", "..", "web", "test", "updateNotice.test.ts") },
  { name: "web:updateFlow", file: path.join(TEST_DIR, "..", "..", "web", "test", "updateFlow.test.ts") },
  { name: "web:slashCommands", file: path.join(TEST_DIR, "..", "..", "web", "test", "slashCommands.test.ts") },
  { name: "web:wakeOnOpen", file: path.join(TEST_DIR, "..", "..", "web", "test", "wakeOnOpen.test.ts") },
  { name: "web:localeBoot", file: path.join(TEST_DIR, "..", "..", "web", "test", "localeBoot.test.ts") },
  { name: "web:sessionGroups", file: path.join(TEST_DIR, "..", "..", "web", "test", "sessionGroups.test.ts") },
  { name: "web:splitArchived", file: path.join(TEST_DIR, "..", "..", "web", "test", "splitArchived.test.ts") },
  { name: "web:requestTimeout", file: path.join(TEST_DIR, "..", "..", "web", "test", "requestTimeout.test.ts") },
  { name: "web:teamTask", file: path.join(TEST_DIR, "..", "..", "web", "test", "teamTask.test.ts") },
  { name: "web:workTitle", file: path.join(TEST_DIR, "..", "..", "web", "test", "workTitle.test.ts") },
  { name: "web:backgroundTasks", file: path.join(TEST_DIR, "..", "..", "web", "test", "backgroundTasks.test.ts") },
  { name: "web:attention", file: path.join(TEST_DIR, "..", "..", "web", "test", "attention.test.ts") },
  { name: "web:fanoutStart", file: path.join(TEST_DIR, "..", "..", "web", "test", "fanoutStart.test.ts") },
  { name: "web:splitPane", file: path.join(TEST_DIR, "..", "..", "web", "test", "splitPane.test.ts") },
  { name: "web:clientMessageId", file: path.join(TEST_DIR, "..", "..", "web", "test", "clientMessageId.test.ts") },
  { name: "web:markdownHighlight", file: path.join(TEST_DIR, "..", "..", "web", "test", "markdownHighlight.test.ts") },
  { name: "web:composerBlocks", file: path.join(TEST_DIR, "..", "..", "web", "test", "composerBlocks.test.ts") },
  { name: "web:chatBasics", file: path.join(TEST_DIR, "..", "..", "web", "test", "chatBasics.test.ts") },
  { name: "web:staleGuard", file: path.join(TEST_DIR, "..", "..", "web", "test", "staleGuard.test.ts") },
  { name: "web:questionnaire", file: path.join(TEST_DIR, "..", "..", "web", "test", "questionnaire.test.ts") },
  { name: "web:folderExplorer", file: path.join(TEST_DIR, "..", "..", "web", "test", "folderExplorer.test.ts") },
  { name: "web:newSessionProviders", file: path.join(TEST_DIR, "..", "..", "web", "test", "newSessionProviders.test.ts") },
  { name: "web:todoList", file: path.join(TEST_DIR, "..", "..", "web", "test", "todoList.test.ts") },
  { name: "web:autoResume", file: path.join(TEST_DIR, "..", "..", "web", "test", "autoResume.test.ts") },
  { name: "web:handoff", file: path.join(TEST_DIR, "..", "..", "web", "test", "handoff.test.ts") },
];

const filters = process.argv.slice(2);
const suites = fs
  .readdirSync(TEST_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) => e.name.replace(/\.ts$/, ""))
  .filter((n) => !NOT_A_SUITE.has(n) && (!(n in BATCH_EXCLUDE) || filters.includes(n)))
  .filter((n) => filters.length === 0 || filters.some((f) => n.includes(f)))
  .sort();

/** 돌릴 것 전부 — test/ 파일 + test/ 밖 스위트(프론트). */
const runs: { name: string; file: string; env: Record<string, string> }[] = [];
for (const name of suites) runs.push({ name, file: path.join(TEST_DIR, `${name}.ts`), env: {} });
for (const e of EXTRA_SUITES) {
  if (filters.length && !filters.some((f) => e.name.includes(f))) continue;
  if (!fs.existsSync(e.file)) {
    console.log(`❌ ${e.name.padEnd(26)} 파일 없음: ${e.file}`);
    process.exit(1);
  }
  runs.push({ name: e.name, file: e.file, env: {} });
}

const results: { name: string; ok: boolean; ms: number; out: string }[] = [];
for (const run of runs) {
  // 스위트마다 새 임시 데이터 디렉터리 — 서로의 세션·검색 인덱스를 보지 않게(교차 오염 방지).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aether-test-`));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--import", "tsx", run.file], {
    encoding: "utf8",
    env: { ...process.env, AETHER_DATA_DIR: dataDir, ...run.env },
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;
  results.push({ name: run.name, ok, ms, out });
  console.log(`${ok ? "✅" : "❌"} ${run.name.padEnd(26)} ${String(ms).padStart(6)}ms`);
  // 일반 ⚠️는 실모델 스위트 등 다른 의미도 가질 수 있어, 대기 시간 여유 경고만 전용 표식으로 골라 낸다.
  for (const line of out.split("\n").filter((line) => line.includes("[대기-여유부족]"))) console.log(`      ${line.trim()}`);
  if (!ok) {
    for (const line of out.split("\n").filter((l) => l.includes("❌"))) console.log(`      ${line.trim()}`);
    // 처리 안 된 예외는 ❌ 표시 없이 죽으므로, stdout·stderr를 합친 끝을 남겨 호출 스택을 보존한다.
    const tail = out.split("\n").map((line) => line.trim()).filter(Boolean).slice(-20);
    if (tail.length) {
      console.log("      출력 꼬리:");
      for (const line of tail) console.log(`      ${line}`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3);

console.log("─".repeat(52));
console.log(`가장 느린 스위트: ${slow.map((s) => `${s.name}(${(s.ms / 1000).toFixed(1)}s)`).join(" · ")}`);
console.log(`일괄 실행에서 제외(실모델·Docker): ${Object.entries(BATCH_EXCLUDE).map(([n, why]) => `${n} — ${why}`).join(" · ")}`);
console.log(
  `${failed.length === 0 ? "✅" : "❌"} 결정적 스위트 ${results.length - failed.length}/${results.length} 통과` +
    (failed.length ? ` — 실패: ${failed.map((f) => f.name).join(", ")}` : ""),
);
process.exit(failed.length === 0 ? 0 : 1);
