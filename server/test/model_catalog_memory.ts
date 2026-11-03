/**
 * 모델 칩 목록 기억과 합치기 — 모델 호출 0.
 *
 * 모델 목록 메모리 시험.
 * 실행: tsx test/model_catalog_memory.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-catalog-"));
process.env.AETHER_DATA_DIR = DATA_DIR;

const cm = await import("../providers/modelCatalogMemory");
type Row = import("../providers/types").RuntimeModel;

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
}
const values = (rows: Row[]) => rows.map((r) => r.value);
const DAY = 86400000;
const T = 1_800_000_000_000;

// 짧은 목록(이름에 버전 없음)과 긴 목록(버전 있음). 이름은 데이터일 뿐이다.
const SHORT: Row[] = [
  { value: "dflt", displayName: "Default", resolvedModel: "x-big-5", followsAccountDefault: true, isDefault: true },
  { value: "big", displayName: "Big", resolvedModel: "x-big-5", movingAlias: true },
  { value: "small", displayName: "Small", resolvedModel: "x-small-5", movingAlias: true },
];
const LONG: Row[] = [
  { value: "dflt", displayName: "Default (Big 5)", resolvedModel: "x-big-5", followsAccountDefault: true, isDefault: true },
  { value: "big", displayName: "Big 5", resolvedModel: "x-big-5", movingAlias: true },
  { value: "small", displayName: "Small 5", description: "빠름", resolvedModel: "x-small-5", movingAlias: true },
  { value: "x-small-4", displayName: "Small 4" },
  { value: "x-big-4", displayName: "Big 4", supportedEffortLevels: ["low"] },
];

console.log("── 긴 목록 뒤 짧은 목록 ──");
{
  cm.rememberModelList("claude", LONG, T);
  cm.rememberModelList("claude", SHORT, T + 1);
  const out = cm.mergeModelList("claude", SHORT, T + 2);
  check(JSON.stringify(values(out)) === JSON.stringify(["dflt", "big", "small", "x-small-4", "x-big-4"]), "순서는 골격(가장 긴 목록)을 따른다", values(out));
  check(out.find((r) => r.value === "small")?.displayName === "Small 5" && out.find((r) => r.value === "small")?.description === "빠름", "짧은 목록 뒤에도 버전 표시 이름이 남는다");
  check(out.find((r) => r.value === "dflt")?.isDefault === true && !out.find((r) => r.value === "dflt")?.remembered, "지금 목록의 줄은 지금 값(isDefault 등)을 쓴다");
  const mem = out.find((r) => r.value === "x-big-4");
  check(mem?.remembered === true && JSON.stringify(mem.supportedEffortLevels) === JSON.stringify(["low"]) && !out.find((r) => r.value === "small")?.remembered, "기억에만 있는 줄은 remembered로 붙는다");
}

console.log("── 기억에만 있는 기본값 선택지와 isDefault ──");
{
  const noDefault = SHORT.filter((r) => r.value !== "dflt");
  const out = cm.mergeModelList("claude", noDefault, T + 3);
  check(!out.some((r) => r.value === "dflt"), "기억에만 있는 기본값 선택지는 붙이지 않는다");
  cm.rememberModelList("codex", [{ value: "a", displayName: "A", isDefault: true }, { value: "b", displayName: "B" }], T);
  const c = cm.mergeModelList("codex", [{ value: "b", displayName: "B" }], T + 1);
  check(c.find((r) => r.value === "a")?.remembered === true && c.find((r) => r.value === "a")?.isDefault === undefined, "기억에만 있는 줄은 isDefault를 떼어 낸다");
}

console.log("── 별칭이 새 버전을 가리키면 옛 이름을 쓰지 않는다 ──");
{
  const moved = SHORT.map((r) => (r.value === "small" ? { ...r, resolvedModel: "x-small-6" } : r));
  const out = cm.mergeModelList("claude", moved, T + 4);
  check(out.find((r) => r.value === "small")?.displayName === "Small", "resolvedModel이 다르면 지금 목록의 이름", out.find((r) => r.value === "small"));
  const noResolved = SHORT.map((r) => (r.value === "small" ? { value: "small", displayName: "Small" } : r));
  check(cm.mergeModelList("claude", noResolved, T + 4).find((r) => r.value === "small")?.displayName === "Small", "지금 줄에 resolvedModel이 없으면 기억의 이름을 안 가져온다");
}

console.log("── 짧은 목록에만 나온 줄은 다음 세션에 남는다 ──");
{
  cm.rememberModelList("claude", [...SHORT, { value: "tiny", displayName: "Tiny", resolvedModel: "x-tiny-1", movingAlias: true }], T + 5);
  cm.resetModelCatalogMemory(); // 재시작 흉내 — 파일에서 다시 읽는다
  const out = cm.mergeModelList("claude", SHORT, T + 6);
  check(out.find((r) => r.value === "tiny")?.remembered === true, "짧은 목록에만 나온 줄이 재시작 뒤에도 남는다", values(out));
  check(out.find((r) => r.value === "small")?.displayName === "Small 5", "재시작 뒤에도 버전 표시 이름이 남는다");
  check(values(out).indexOf("tiny") > values(out).indexOf("x-big-4"), "골격에 없는 줄은 뒤에 붙는다", values(out));
}

console.log("── 30일 만료 ──");
{
  const later = T + 31 * DAY;
  const out = cm.mergeModelList("claude", SHORT, later);
  check(JSON.stringify(values(out)) === JSON.stringify(values(SHORT)), "30일 동안 안 보인 줄과 골격은 쓰지 않는다", values(out));
  cm.rememberModelList("claude", SHORT, later);
  cm.resetModelCatalogMemory();
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "model-catalog-claude.json"), "utf8"));
  check(!("x-big-4" in raw.rows) && JSON.stringify(raw.skeleton.values) === JSON.stringify(values(SHORT)), "다음 기억 때 오래된 줄을 버리고 골격을 새로 잡는다", raw.skeleton);
}

console.log("── 늘 전체 목록을 주는 provider ──");
{
  const full: Row[] = [
    { value: "g1", displayName: "G1", isDefault: true, supportedEffortLevels: ["low", "high"] },
    { value: "g2", displayName: "G2", resolvedModel: "g2" },
  ];
  cm.rememberModelList("grok", full, T);
  check(JSON.stringify(cm.mergeModelList("grok", full, T)) === JSON.stringify(full), "전체 목록이면 결과가 받은 목록과 같다");
  const reordered = [full[1], full[0]];
  cm.rememberModelList("grok", reordered, T + 1);
  check(JSON.stringify(cm.mergeModelList("grok", reordered, T + 1)) === JSON.stringify(reordered), "순서가 바뀌어도 기억한 뒤 합치면 받은 목록과 같다");
}

console.log("── 만료된 이름 ──");
{
  cm.rememberModelList("codex", [{ value: "n", displayName: "N 5", resolvedModel: "n-5" }, { value: "z", displayName: "Z" }], T);
  cm.rememberModelList("codex", [{ value: "z", displayName: "Z" }], T + 31 * DAY);
  const out = cm.mergeModelList("codex", [{ value: "n", displayName: "N", resolvedModel: "n-5" }], T + 31 * DAY);
  check(out.find((r) => r.value === "n")?.displayName === "N", "30일 동안 안 보인 줄의 이름은 쓰지 않는다", out);
}

{
  // 중간 기억 없이 31일 뒤 바로 합칠 때도 만료된 이름은 쓰지 않는다.
  cm.resetModelCatalogMemory();
  cm.rememberModelList("ollama", [{ value: "p", displayName: "P 5", resolvedModel: "p-5" }], T);
  const out = cm.mergeModelList("ollama", [{ value: "p", displayName: "P", resolvedModel: "p-5" }], T + 31 * DAY);
  check(out[0]?.displayName === "P", "기억을 갱신하지 않은 채 31일 뒤에 합쳐도 만료된 이름은 쓰지 않는다", out);
  fs.rmSync(path.join(DATA_DIR, "model-catalog-ollama.json"), { force: true });
  cm.resetModelCatalogMemory();
}

console.log("── 깨진 파일 ──");
{
  fs.writeFileSync(path.join(DATA_DIR, "model-catalog-ollama.json"), "{ broken");
  cm.resetModelCatalogMemory();
  const rows: Row[] = [{ value: "o", displayName: "O" }];
  check(JSON.stringify(cm.mergeModelList("ollama", rows, T)) === JSON.stringify(rows), "깨진 기억 파일이면 받은 목록 그대로");
  for (const [label, bad] of [
    ["표시 이름 없는 줄", { value: "q" }],
    ["resolvedModel 타입 오류", { value: "q", displayName: "Q", resolvedModel: 5 }],
    ["effort 목록 타입 오류", { value: "q", displayName: "Q", supportedEffortLevels: "low" }],
    ["effort 설명 글 타입 오류", { value: "q", displayName: "Q", supportedEffortDescriptions: { low: { text: { bad: 1 } } } }],
    ["effort 설명 로케일 타입 오류", { value: "q", displayName: "Q", supportedEffortDescriptions: { low: { byLocale: { ko: 3 } } } }],
  ] as const) {
    fs.writeFileSync(
      path.join(DATA_DIR, "model-catalog-ollama.json"),
      JSON.stringify({ version: 1, skeleton: { values: ["q"], updatedAt: T }, rows: { q: { row: bad, seenAt: T } }, names: {} }),
    );
    cm.resetModelCatalogMemory();
    check(JSON.stringify(cm.mergeModelList("ollama", rows, T)) === JSON.stringify(rows), `${label}이 든 기억 파일은 쓰지 않는다`);
  }

  // 쓰기 실패: 메모리 기억은 그대로 쓰고 호출자는 계속 간다.
  cm.resetModelCatalogMemory();
  fs.chmodSync(DATA_DIR, 0o500);
  try {
    cm.rememberModelList("grok", [{ value: "w", displayName: "W" }, { value: "w2", displayName: "W2" }], T);
  } finally {
    fs.chmodSync(DATA_DIR, 0o700);
  }
  check(!fs.existsSync(path.join(DATA_DIR, "model-catalog-grok.json")) || !JSON.parse(fs.readFileSync(path.join(DATA_DIR, "model-catalog-grok.json"), "utf8")).rows.w2, "(전제) 파일 쓰기가 실제로 실패했다");
  check(cm.mergeModelList("grok", [{ value: "w", displayName: "W" }], T).some((r) => r.value === "w2" && r.remembered), "파일을 못 써도 메모리 기억으로 합친다");
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} model_catalog_memory: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
