/**
 * 목록 카드 모델 — 스트림에서 본 실제 모델과 사람이 읽는 이름 (모델 호출 0).
 *
 * 계정 기본 모델은 준비 신호가 적은 값이라 실제 응답과 다를 수 있다.
 * 카드는 스트림의 model_info를 우선하고, 표시 이름은 그 세션의 모델 목록에서만 찾는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelDisplayName } from "../sessions/modelLabel";
import type { ModelInfo } from "../../shared/http";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-model-label-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-model-label-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;
process.env.AETHER_SEARCH = "0";
delete process.env.AETHER_DATABASE_URL;

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e: unknown = "") => {
  const detail = c || e === "" ? "" : ` — ${typeof e === "string" ? e : JSON.stringify(e)}`;
  console.log(`  ${c ? "✅" : "❌"} ${n}${detail}`);
  c ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 저장 시각. 타입 정의에 없는 나노초 필드가 런타임에 있으면 그걸 쓴다. */
function savedAt(file: string): bigint {
  const stat = fs.statSync(file) as fs.Stats & { mtimeNs?: bigint };
  return stat.mtimeNs ?? BigInt(Math.round(stat.mtimeMs * 1_000_000));
}
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const variantRows: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5[1m]", isDefault: true },
  { value: "opus[1m]", displayName: "Opus 5 (1M)", resolvedModel: "claude-opus-5[1m]" },
];
const aliasRows: ModelInfo[] = [
  { value: "default", displayName: "Default", resolvedModel: "mock-large-2026", isDefault: true },
  { value: "large", displayName: "Large", resolvedModel: "mock-large-2026" },
];

check(resolveModelDisplayName("LARGE", aliasRows) === "Large", "별칭 value는 대소문자를 무시하고 맞춘다");
check(resolveModelDisplayName("mock-large-2026", aliasRows) === "Large", "정식 id는 기본 줄보다 구체적인 줄 이름을 고른다");
check(
  resolveModelDisplayName("mock-large-2026", [
    { value: "mock-large-2026", displayName: "Default row", isDefault: true },
    { value: "large", displayName: "Specific", resolvedModel: "mock-large-2026" },
  ]) === "Default row",
  "value가 정확히 맞으면 그 줄을 먼저 쓴다",
);
check(resolveModelDisplayName("claude-opus-5", variantRows) === "Opus 5 (1M)", "끝의 [1m]만 다른 정식 id도 구체적인 줄로 맞춘다");
check(resolveModelDisplayName("claude-opus-5[1m]", variantRows) === "Opus 5 (1M)", "변종 표시가 붙은 정식 id도 기본 줄보다 구체적인 줄이다");
check(
  resolveModelDisplayName("claude-opus-5[1m]", [{ value: "claude-opus-5", displayName: "Opus 5" }]) === "Opus 5",
  "원문에만 변종 표시가 있으면 뗀 이름으로 다시 맞춘다",
);
check(resolveModelDisplayName("nope", variantRows) === "", "목록에 없으면 빈 이름이다");
check(resolveModelDisplayName("  ", variantRows) === "" && resolveModelDisplayName("opus", []) === "", "빈 원문·빈 목록은 빈 이름이다");

async function mkSession(id: string, meta: Record<string, unknown>) {
  fs.mkdirSync(path.join(DATA, id), { recursive: true });
  fs.writeFileSync(path.join(DATA, id, "meta.json"), JSON.stringify(meta));
  (await import("../sessions/persistence")).appendEvent(id, { seq: 1, ts: 1, kind: "status", status: "completed" });
}

async function main() {
  const { config } = await import("../config");
  const { __registerProviderForTest } = await import("../providers/registry");
  const { sessionManager } = await import("../sessions/SessionManager");
  await (await import("./support/tempDb")).useTempDiary("model_label"); // 임시 SQLite 일기
  const store = await import("../sessions/persistence");
  const mock = await import("./support/mockProvider");
  const unregister = __registerProviderForTest(mock.mockEntry);
  const metaOf = (id: string) => store.loadMeta(id);
  const rowOf = (id: string) => sessionManager.list().find((row) => row.id === id);
  const linesOf = (id: string) => store.readEventsSince(id, 0).length;

  try {
    const live = sessionManager.create({ cwd: ROOT, provider: mock.MOCK_PROVIDER });
    const runtime = mock.lastMockRuntime;
    if (!runtime) throw new Error("가짜 실행기가 없다");
    await live.waitHandshake(5000);
    check(metaOf(live.id)?.accountDefaultModel === "mock-small-2026", "준비 신호가 계정 기본 모델의 정식 id를 적는다", metaOf(live.id));
    check(!metaOf(live.id)?.model, "계정 기본 모델은 고른 모델 칸에 들어가지 않는다");
    check(metaOf(live.id)?.modelLabel === "Mock Small", "목록이 있으면 계정 기본 모델의 표시 이름을 적는다", metaOf(live.id)?.modelLabel);

    runtime.emitModel("mock-large-2026");
    check(await waitFor(() => metaOf(live.id)?.observedModel === "mock-large-2026"), "model_info가 관측 모델을 meta에 적는다", metaOf(live.id));
    const seen = metaOf(live.id);
    check(seen?.modelLabel === "Mock Large", "관측 모델의 표시 이름은 정식 id로 찾는다", seen?.modelLabel);
    check(seen?.model === undefined && seen?.accountDefaultModel === "mock-small-2026", "관측 모델은 고른 모델·계정 기본을 덮어쓰지 않는다", seen);
    check(rowOf(live.id)?.observedModel === "mock-large-2026" && rowOf(live.id)?.modelLabel === "Mock Large", "세션 목록이 관측 모델과 표시 이름을 싣는다", rowOf(live.id));

    const metaPath = path.join(config.dataDir, live.id, "meta.json");
    const beforeLines = linesOf(live.id);
    const beforeMeta = fs.readFileSync(metaPath);
    const beforeMtime = savedAt(metaPath);
    runtime.emitModel("mock-large-2026");
    const duplicated = await waitFor(() => linesOf(live.id) > beforeLines);
    await sleep(40);
    check(
      duplicated && savedAt(metaPath) === beforeMtime && fs.readFileSync(metaPath).equals(beforeMeta),
      "같은 관측 모델은 meta를 다시 쓰지 않는다",
    );

    runtime.emitEffort("medium");
    check(metaOf(live.id)?.observedEffort === "medium" && rowOf(live.id)?.observedEffort === "medium", "실행기가 알린 실제 강도를 meta와 세션 목록에 적는다", metaOf(live.id)?.observedEffort);
    await live.setEffort("brisk");
    check(metaOf(live.id)?.observedEffort === undefined, "강도를 바꾸면 지난 턴의 실제 강도를 지운다", metaOf(live.id)?.observedEffort);
    runtime.emitEffort("medium");
    await live.setModel("mock-small");
    const chosen = metaOf(live.id);
    check(metaOf(live.id)?.observedEffort === undefined, "모델을 바꾸면 지난 턴의 실제 강도를 지운다", metaOf(live.id)?.observedEffort);
    check(chosen?.model === "mock-small" && chosen.observedModel === undefined, "모델을 고르면 다음 응답 전까지 관측 모델을 지운다", chosen);
    check(chosen?.modelLabel === "Mock Small", "고른 별칭의 표시 이름으로 다시 계산한다", chosen?.modelLabel);
    check(rowOf(live.id)?.observedModel === undefined && rowOf(live.id)?.modelLabel === "Mock Small", "목록도 지운 관측 모델과 새 표시 이름을 보여 준다", rowOf(live.id));

    runtime.emitModel(mock.MOCK_ALT_MODEL);
    check(await waitFor(() => metaOf(live.id)?.observedModel === mock.MOCK_ALT_MODEL), "다음 응답의 model_info가 관측 모델을 다시 적는다");
    check(metaOf(live.id)?.model === "mock-small" && metaOf(live.id)?.modelLabel === "Mock Large", "응답이 알려 준 모델이 고른 값보다 카드에서 앞선다", metaOf(live.id));

    let rejected = false;
    try {
      await live.setModel("totally-made-up");
    } catch {
      rejected = true;
    }
    const rolled = metaOf(live.id);
    check(rejected, "없는 모델 이름은 거부된다");
    check(
      rolled?.model === "mock-small" && rolled.observedModel === mock.MOCK_ALT_MODEL && rolled.modelLabel === "Mock Large",
      "거절되면 관측 모델과 표시 이름을 되돌린다",
      rolled,
    );

    const odd = sessionManager.create({ cwd: ROOT, provider: mock.MOCK_PROVIDER, model: "not-in-catalog" });
    await odd.waitHandshake(5000);
    const oddMeta = metaOf(odd.id);
    check(oddMeta?.model === "not-in-catalog" && !oddMeta.modelLabel, "목록에 없는 모델은 표시 이름을 비운다", oddMeta);
    check(oddMeta?.accountDefaultModel === "mock-small-2026", "맞추지 못해도 계정 기본 모델 기록은 남긴다", oddMeta?.accountDefaultModel);

    await mkSession("s_disk", {
      id: "s_disk",
      cwd: ROOT,
      provider: mock.MOCK_PROVIDER,
      model: "mock-small",
      observedModel: "mock-large-2026",
      modelLabel: "Mock Large",
      resumeKey: "mock-resume-disk",
      createdAt: 1000,
    });
    await mkSession("s_wake", {
      id: "s_wake",
      cwd: ROOT,
      provider: mock.MOCK_PROVIDER,
      accountDefaultModel: "mock-small-2026",
      observedModel: "mock-large-2026",
      modelLabel: "Mock Large",
      resumeKey: "mock-resume-wake",
      createdAt: 1000,
    });
    sessionManager.restoreFromDisk();
    const diskRow = rowOf("s_disk");
    check(diskRow?.observedModel === "mock-large-2026" && diskRow.modelLabel === "Mock Large", "잠든 세션 목록도 관측 모델과 표시 이름을 싣는다", diskRow);

    check(sessionManager.updateDiskMeta("s_disk", { model: "mock-small" }) === true, "같은 모델로 다시 적기");
    check(metaOf("s_disk")?.observedModel === "mock-large-2026" && metaOf("s_disk")?.modelLabel === "Mock Large", "모델이 안 바뀌면 관측값과 표시 이름을 유지한다", metaOf("s_disk"));
    check(sessionManager.updateDiskMeta("s_disk", { effort: "deep" }) === true, "강도만 바꾸기");
    check(metaOf("s_disk")?.observedModel === "mock-large-2026" && metaOf("s_disk")?.effort === "deep", "강도를 바꿔도 관측 모델은 남는다", metaOf("s_disk"));
    check(sessionManager.updateDiskMeta("s_disk", { model: "mock-large-2026" }) === true, "잠든 세션의 모델 변경");
    const cleared = metaOf("s_disk");
    check(cleared?.model === "mock-large-2026" && cleared.observedModel === undefined && cleared.modelLabel === undefined, "잠든 세션의 모델을 바꾸면 관측값과 표시 이름을 지운다", cleared);
    check(rowOf("s_disk")?.observedModel === undefined && rowOf("s_disk")?.modelLabel === undefined, "지운 값이 잠든 세션 목록에도 반영된다", rowOf("s_disk"));

    const woke = sessionManager.getOrResume("s_wake");
    const wokeMeta = metaOf("s_wake");
    check(woke.observedModel === "mock-large-2026" && woke.modelLabel === "Mock Large", "재개하면 관측 모델과 표시 이름을 되돌린다", wokeMeta);
    check(rowOf("s_wake")?.modelLabel === "Mock Large", "재개 직후 목록은 저장돼 있던 표시 이름을 유지한다", rowOf("s_wake"));
    await woke.setModel("mock-small");
    const wokeAfter = metaOf("s_wake");
    check(
      wokeAfter?.model === "mock-small" && wokeAfter.observedModel === undefined && wokeAfter.modelLabel === undefined,
      "목록을 모르면 모델을 바꿀 때 옛 표시 이름을 비운다",
      wokeAfter,
    );
  } finally {
    unregister();
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log("─".repeat(50));
  console.log(`model_label: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("오류:", e);
  process.exit(1);
});
