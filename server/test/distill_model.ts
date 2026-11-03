/**
 * 배경 작업 모델 자동 선택 — 결정 순서와 안전장치. 서버·모델을 띄우지 않는 순수 로직 테스트.
 *
 * 검사하는 것:
 *   ① 운영자가 환경변수(AETHER_REFLECT_MODEL)로 못 박으면 그 값이 이긴다
 *   ② 못 박은 값이 없으면 저장해 둔 값(캐시 파일)을 쓴다
 *   ③ 모델이 목록에 없는 이름을 답하면 버린다(손으로 적어 두던 때와 같은 어긋남 방지)
 *   ④ 저장되는 값은 언제나 **별칭**이지 정식 id가 아니다 — 정식 id는 그 버전이 은퇴하면 못 쓰는 이름이 된다
 *   ⑤ 모델이 군말을 붙여 답해도 마지막 줄에서 이름을 찾아낸다
 *   ⑥ 이름 모양이 이상하면(제어문자·과길이·'-' 시작) 애초에 안 받는다
 *
 * 실행: AETHER_DATA_DIR="$(mktemp -d)" tsx test/distill_model.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// config가 읽히기 전에 데이터 폴더를 격리한다(캐시 파일이 실제 데이터 폴더를 건드리지 않게).
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-distill-model-"));
process.env.AETHER_DATA_DIR = DATA_DIR;
delete process.env.AETHER_REFLECT_MODEL;

await import("../providers/registry"); // 등록표가 claude의 옛 저장 파일 이름(distill-model.json)을 연결한다
const { PICK_RULE, bindDistillPinLookup, buildPriceOrderPrompt, cachedModel, currentDistillModel, forgetModel, mergePriceOrders, parsePriceOrder, pickCheapest, pickGeneration, pinnedModel, resetDistillModelMemory, resolveAndApply, selectableModels, UnknownModelNameError } = await import("../providers/distillModel");

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq<T>(label: string, actual: T, expected: T) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`);
}

/** 2026-07-30에 실제로 받은 목록 그대로. */
const MODELS = [
  { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5[1m]" },
  { value: "opus[1m]", displayName: "Opus (1M context)", resolvedModel: "claude-opus-5[1m]" },
  { value: "claude-fable-5[1m]", displayName: "Fable", resolvedModel: "claude-fable-5" },
  { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" },
  { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" },
];

const CACHE = path.join(DATA_DIR, "distill-model.json");
const writeCache = (model: unknown, rule: unknown = PICK_RULE) => fs.writeFileSync(CACHE, JSON.stringify({ model, rule }));

/** 가격 순서 답 — first가 가장 싼 줄이고, 나머지는 후보 순서대로 한 줄에 하나씩(가격대마다 한 모델). */
const order = (first: string, rows: readonly { value: string }[] = selectableModels(MODELS)) =>
  [first, ...rows.map((r) => r.value).filter((v) => v !== first)].join("\n");

async function main() {
  console.log("──────── 가격 순서 답 검증(parsePriceOrder) ────────");
  const CAND = selectableModels(MODELS);
  eq("가격대 줄과 쉼표 묶음을 읽는다", parsePriceOrder("haiku, sonnet\nclaude-fable-5[1m]\nopus[1m]", CAND), [["haiku", "sonnet"], ["claude-fable-5[1m]"], ["opus[1m]"]]);
  eq("대소문자는 무시한다", parsePriceOrder("HAIKU\nsonnet\nopus[1m]\nclaude-fable-5[1m]", CAND)?.[0], ["haiku"]);
  eq("정식 id로 답해도 그 줄의 value로 받는다", parsePriceOrder("claude-haiku-4-5-20251001\nsonnet\nopus[1m]\nclaude-fable-5[1m]", CAND)?.[0], ["haiku"]);
  eq("목록 밖 이름이 섞이면 누락으로 거부한다", parsePriceOrder("haiku\nclaude-instant-1.2\nsonnet\nopus[1m]", CAND), null);
  eq("중복이면 거부한다", parsePriceOrder("haiku\nhaiku\nsonnet\nopus[1m]\nclaude-fable-5[1m]", CAND), null);
  eq("빠진 이름이 있으면 거부한다", parsePriceOrder("haiku\nsonnet", CAND), null);
  eq("번호·표시명·설명을 옮겨 적어도 이름만 읽는다", parsePriceOrder("1. haiku (Haiku) — 싸다\n2. sonnet\n3. opus[1m]\n4. claude-fable-5[1m]", CAND)?.map((t) => t[0]), ["haiku", "sonnet", "opus[1m]", "claude-fable-5[1m]"]);
  eq("빈 답은 거부한다", parsePriceOrder("  \n ", CAND), null);

  console.log("\n──────── 합치기(mergePriceOrders) ────────");
  const A = parsePriceOrder("haiku, sonnet\nopus[1m]\nclaude-fable-5[1m]", CAND)!;
  eq("★ 같은 단가 묶음에서는 맨 앞(가장 최근)만 남는다", mergePriceOrders([A], CAND), ["haiku", "opus[1m]", "claude-fable-5[1m]"]);
  const B = parsePriceOrder("sonnet, haiku\nopus[1m]\nclaude-fable-5[1m]", CAND)!;
  eq("여러 답이면 절반 넘게 맨 앞이 아니라는 줄만 뺀다(다수결)", mergePriceOrders([A, A, B], CAND), ["haiku", "opus[1m]", "claude-fable-5[1m]"]);
  eq("정확히 절반만 빠진 줄은 남고 평균 순위로 놓인다", mergePriceOrders([A, parsePriceOrder("haiku\nsonnet\nopus[1m]\nclaude-fable-5[1m]", CAND)!], CAND), ["haiku", "sonnet", "opus[1m]", "claude-fable-5[1m]"]);

  console.log("\n──────── 고르기 프롬프트(buildPriceOrderPrompt) ────────");
  const prompt = buildPriceOrderPrompt(CAND);
  check(CAND.every((m) => prompt.includes(m.value)), "목록의 모든 이름이 프롬프트에 들어간다");
  check(/쉼표|commas/.test(prompt) && /최근|recent/i.test(prompt), "같은 단가 묶음과 최신 순서를 요구한다");

  console.log("\n──────── 결정 순서 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  delete process.env.AETHER_REFLECT_MODEL;
  eq("못 박은 값도 저장해 둔 값도 없으면 모른다", currentDistillModel("claude"), undefined);

  writeCache("sonnet");
  eq("② 저장해 둔 값을 쓴다", currentDistillModel("claude"), "sonnet");

  // ① 환경변수 우선 — config는 모듈이 처음 로드될 때 한 번만 환경변수를 읽으므로, 이 규칙만은
  //    별도 프로세스에서 확인한다. 저장해 둔 값을 일부러 다르게(sonnet) 심어 두고, 못 박은 값(haiku)이
  //    이기는지 본다.
  const pinDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-distill-model-pin-"));
  fs.writeFileSync(path.join(pinDir, "distill-model.json"), JSON.stringify({ model: "sonnet" }));
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "-e", 'import("./providers/registry.ts").then(() => import("./providers/distillModel.ts")).then((m) => console.log(String(m.currentDistillModel("claude"))))'],
    { cwd: SERVER_DIR, env: { ...process.env, AETHER_DATA_DIR: pinDir, AETHER_REFLECT_MODEL: "haiku" }, encoding: "utf8" },
  ).trim();
  eq("① 못 박은 값이 저장해 둔 값을 이긴다", out, "haiku");

  console.log("\n──────── 캐시 파일의 방어 ────────");
  writeCache("");
  eq("빈 이름은 저장돼 있어도 안 쓴다", cachedModel("claude"), undefined);
  writeCache("-dangerous");
  eq("'-'로 시작하는 이름은 안 쓴다(명령줄 인자 오염 방지)", cachedModel("claude"), undefined);
  writeCache("x".repeat(65));
  eq("65자 이름은 안 쓴다", cachedModel("claude"), undefined);
  writeCache("hai\u0001ku"); // 실제 제어문자(0x01)
  eq("제어문자가 든 이름은 안 쓴다", cachedModel("claude"), undefined);
  writeCache(123);
  eq("문자열이 아니면 안 쓴다", cachedModel("claude"), undefined);
  fs.writeFileSync(CACHE, "{ 깨진 JSON");
  eq("파일이 깨졌으면 없는 것으로 본다", cachedModel("claude"), undefined);
  writeCache("default");
  eq('★ 저장된 값이 "default"(계정 기본 = 가장 비쌈)면 무시한다 — 예전 판이 남긴 파일 대비', cachedModel("claude"), undefined);
  writeCache("DEFAULT");
  eq("대소문자가 달라도 마찬가지", cachedModel("claude"), undefined);
  forgetModel("claude");
  eq("지우면 없다", cachedModel("claude"), undefined);

  console.log("\n──────── 새로 고르기(pickCheapest) ────────");
  forgetModel("claude");
  let asked = 0;
  const picked = await pickCheapest("claude", MODELS, async (p) => { asked++; check(p.includes("haiku"), "질문에 실제 목록이 실려 나간다"); return order("haiku"); });
  eq("③ 목록에 있는 답이면 채택한다", picked, "haiku");
  eq("질문은 한 번만 나간다", asked, 1);
  eq("★ 고르기 단계에서는 아직 저장하지 않는다(통하는지 확인 전이다)", cachedModel("claude"), undefined);

  forgetModel("claude");
  resetDistillModelMemory("claude");
  const bogus = await pickCheapest("claude", MODELS, async () => "claude-instant-1.2");
  eq("목록에 없는 답이면 채택하지 않는다", bogus, undefined);
  eq("채택 안 했으면 저장도 안 한다", cachedModel("claude"), undefined);

  forgetModel("claude");
  resetDistillModelMemory("claude");
  const thrown = await pickCheapest("claude", MODELS, async () => { throw new Error("모델 호출 실패"); });
  eq("질문 자체가 실패하면 undefined(예외를 밖으로 안 던진다)", thrown, undefined);
  eq("실패했으면 저장도 안 한다", cachedModel("claude"), undefined);

  resetDistillModelMemory("claude");
  const empty = await pickCheapest("claude", [], async () => { throw new Error("불려선 안 된다"); });
  eq("목록이 비었으면 묻지도 않는다", empty, undefined);

  console.log("\n──────── ★ 'default' 줄은 후보에서 뺀다 ────────");
  // 실측 목록의 첫 줄은 default = claude-opus-5[1m], 곧 가장 비싼 모델이다. 이걸 고르면 이 작업의
  //   목적(싼 모델로 배경 작업 돌리기)이 정반대로 뒤집히고, 파일에 저장돼 영구히 굳는다.
  eq("후보 목록에 default가 없다", selectableModels(MODELS).map((m) => m.value), ["opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku"]);
  check(!buildPriceOrderPrompt(selectableModels(MODELS)).includes("Default (recommended)"), "질문에도 default가 안 실린다");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  const defaulted = await pickCheapest("claude", MODELS, async () => "default");
  eq("★ 모델이 default라고 답해도 채택하지 않는다", defaulted, undefined);
  resetDistillModelMemory("claude");
  const opusById = await pickCheapest("claude", MODELS, async () => "claude-opus-5[1m]\nclaude-fable-5[1m]\nsonnet\nhaiku");
  eq("정식 id로 답해도 default 줄로는 안 걸린다(opus[1m] 줄로 걸린다)", opusById, "opus[1m]");

  console.log("\n──────── 결정 + 적용 + 재시도(resolveAndApply) ────────");
  // 저장해 둔 이름이 아직 통할 때는 아무것도 다시 하지 않는다.
  forgetModel("claude");
  resetDistillModelMemory("claude");
  writeCache("haiku");
  let sets: string[] = [];
  let asks = 0;
  const notFound = (m: string) => new UnknownModelNameError(m);
  let used = await resolveAndApply("claude", MODELS, async (m) => { sets.push(m); }, async () => { asks++; return order("sonnet"); });
  eq("통하는 이름이면 그대로 쓴다", used, "haiku");
  eq("그때는 다시 고르지 않는다(질문 0회)", asks, 0);
  eq("맞추기는 한 번만", sets, ["haiku"]);
  eq("고른 적이 없으니 알림 세대도 그대로", pickGeneration("claude"), 0);

  // 저장해 둔 이름이 거부되면 → 캐시를 버리고 딱 한 번 다시 고른다.
  forgetModel("claude");
  resetDistillModelMemory("claude");
  writeCache("sonnet");
  sets = []; asks = 0;
  used = await resolveAndApply("claude", MODELS, async (m) => { sets.push(m); if (m === "sonnet") throw notFound(m); }, async () => { asks++; return order("haiku"); });
  eq("거부되면 새로 고른 이름을 쓴다", used, "haiku");
  eq("다시 고르기는 정확히 한 번", asks, 1);
  eq("맞추기는 실패 1 + 성공 1", sets, ["sonnet", "haiku"]);
  eq("★ 통한다는 걸 확인한 뒤에야 저장된다", cachedModel("claude"), "haiku");
  eq("새로 골랐으니 알림 세대가 늘었다", pickGeneration("claude"), 1);
  eq("실제로 쓴 모델이 기록된다", currentDistillModel("claude"), "haiku");

  // ★ H1 — 환경변수에 못 쓰는 이름이 박혀 있어도, 저장해 둔 값을 먼저 써 보고 질문은 아낀다.
  console.log("\n──────── ★ 못 박은 이름이 고장 났을 때 ────────");
  {
    const pin2 = fs.mkdtempSync(path.join(os.tmpdir(), "aether-distill-model-broken-"));
    fs.writeFileSync(path.join(pin2, "distill-model.json"), JSON.stringify({ model: "haiku", rule: PICK_RULE }));
    const script = 'import("./providers/registry.ts").then(() => import("./providers/distillModel.ts")).then(async (m) => {'
      + ' let asks = 0; const sets = [];'
      + ' const used = await m.resolveAndApply("claude", '
      + '   [{value:"sonnet"},{value:"haiku"}],'
      + '   async (x) => { sets.push(x); if (x === "broken-name") throw new (await import("./providers/distillModel.ts")).UnknownModelNameError(x); },'
      + '   async () => { asks++; return "sonnet\\nhaiku"; });'
      + ' console.log(JSON.stringify({ used, asks, sets })); })';
    const r = execFileSync(process.execPath, ["--import", "tsx", "-e", script],
      { cwd: SERVER_DIR, env: { ...process.env, AETHER_DATA_DIR: pin2, AETHER_REFLECT_MODEL: "broken-name" }, encoding: "utf8" }).trim();
    const got = JSON.parse(r);
    eq("★ 저장해 둔 멀쩡한 이름으로 넘어간다", got.used, "haiku");
    eq("★ 비싼 질문은 아예 안 나간다", got.asks, 0);
    eq("못 박은 값 → 저장값 순서로 시도한다", got.sets, ["broken-name", "haiku"]);
    eq("고장 난 못 박은 값은 지우지 않는다(운영자가 고칠 설정이다)", JSON.parse(fs.readFileSync(path.join(pin2, "distill-model.json"), "utf8")).model, "haiku");
    fs.rmSync(pin2, { recursive: true, force: true });
  }

  // ★ M3 — 이름 문제가 아닌 실패는 저장값을 파괴하지 않는다.
  console.log("\n──────── ★ 일시적 장애와 '없는 이름'을 구분한다 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  writeCache("haiku");
  sets = []; asks = 0;
  used = await resolveAndApply("claude", MODELS, async (m) => { sets.push(m); throw new Error("Connection closed"); }, async () => { asks++; return order("sonnet"); });
  eq("일시적 장애면 이번 실행만 포기한다", used, undefined);
  eq("★ 멀쩡한 저장값을 지우지 않는다", cachedModel("claude"), "haiku");
  eq("★ 비싼 질문도 안 던진다", asks, 0);

  // 새로 고른 이름마저 거부되면 → 더 반복하지 않고 계정 기본 모델로 넘어간다.
  forgetModel("claude");
  resetDistillModelMemory("claude");
  writeCache("sonnet");
  sets = []; asks = 0;
  used = await resolveAndApply("claude", MODELS, async (m) => { sets.push(m); throw notFound(m); }, async () => { asks++; return order("haiku"); });
  eq("⑥ 끝내 못 정하면 undefined(계정 기본 모델로 진행)", used, undefined);
  eq("⑥ 다시 고르기는 그래도 한 번뿐이다(무한 반복 없음)", asks, 1);
  eq("⑥ 맞추기 시도도 두 번을 넘지 않는다", sets.length, 2);
  eq("못 쓰는 이름은 저장에 남지 않는다", cachedModel("claude"), undefined);
  eq("채택 못 했으면 알림 세대도 안 는다", pickGeneration("claude"), 0);

  // ★ M1 — 고르기가 실패하면 한동안 다시 묻지 않는다(비싼 질문 반복 방지).
  console.log("\n──────── ★ 고르기 실패 후에는 한동안 안 묻는다 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  asks = 0;
  await resolveAndApply("claude", MODELS, async () => {}, async () => { asks++; return "없는이름"; });
  eq("첫 시도에서 묻는다(답이 목록과 안 맞아 한 번 더 묻는다)", asks, 2);
  await resolveAndApply("claude", MODELS, async () => {}, async () => { asks++; return "없는이름"; });
  await resolveAndApply("claude", MODELS, async () => {}, async () => { asks++; return "없는이름"; });
  eq("★ 곧바로 다시 묻지 않는다(비싼 턴 반복 차단)", asks, 2);

  // ★ M2 — 세션 여러 개가 동시에 쉬어도 질문은 하나로 합친다.
  console.log("\n──────── ★ 동시에 여러 세션이 쉬어도 질문은 한 번 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  asks = 0;
  const slowAsk = async () => { asks++; await new Promise((r) => setTimeout(r, 30)); return order("haiku"); };
  const three = await Promise.all([
    resolveAndApply("claude", MODELS, async () => {}, slowAsk),
    resolveAndApply("claude", MODELS, async () => {}, slowAsk),
    resolveAndApply("claude", MODELS, async () => {}, slowAsk),
  ]);
  eq("셋 다 같은 답을 받는다", three, ["haiku", "haiku", "haiku"]);
  eq("★ 그런데 질문은 한 번만 나갔다", asks, 1);

  // ★ 새로 고른 이름마저 안 통하면, 그것도 대기시간에 기록해 질문 반복을 막는다.
  console.log("\n──────── ★ 새로 고른 이름이 실패해도 곧바로 다시 묻지 않는다 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  asks = 0;
  await resolveAndApply("claude", MODELS, async (m) => { throw notFound(m); }, async () => { asks++; return order("haiku"); });
  eq("첫 시도에서 한 번 묻는다", asks, 1);
  await resolveAndApply("claude", MODELS, async (m) => { throw notFound(m); }, async () => { asks++; return order("haiku"); });
  eq("★ 곧바로 또 묻지 않는다", asks, 1);

  // 아는 이름이 아예 없으면 곧바로 고른다.
  forgetModel("claude");
  resetDistillModelMemory("claude");
  sets = []; asks = 0;
  used = await resolveAndApply("claude", MODELS, async (m) => { sets.push(m); }, async () => { asks++; return order("haiku"); });
  eq("아는 이름이 없으면 바로 고른다", used, "haiku");
  eq("그때도 질문은 한 번", asks, 1);
  eq("맞추기는 고른 것 하나뿐", sets, ["haiku"]);

  // ★ 8f — provider가 둘이 되면서 저장 파일과 프로세스 안 기억을 나눴다. 안 나누면 한쪽이 고른 이름을
  //   다른 쪽이 덮어쓰고, 그 이름은 상대의 모델 어휘가 아니라 배경 작업이 매번 거부당한다.
  console.log("\n──────── ★ provider끼리 저장값·기억이 섞이지 않는다 ────────");
  forgetModel("claude");
  forgetModel("codex");
  resetDistillModelMemory("claude");
  resetDistillModelMemory("codex");
  const CODEX_MODELS = [{ value: "gpt-5.6-terra" }, { value: "gpt-5.4-mini" }];
  await resolveAndApply("claude", MODELS, async () => {}, async () => order("haiku"));
  await resolveAndApply("codex", CODEX_MODELS, async () => {}, async () => "gpt-5.4-mini\ngpt-5.6-terra");
  eq("Claude가 고른 이름은 Claude 쪽에만 남는다", cachedModel("claude"), "haiku");
  eq("Codex가 고른 이름은 Codex 쪽에만 남는다", cachedModel("codex"), "gpt-5.4-mini");
  eq("실제로 쓴 모델도 따로 기억한다(claude)", currentDistillModel("claude"), "haiku");
  eq("실제로 쓴 모델도 따로 기억한다(codex)", currentDistillModel("codex"), "gpt-5.4-mini");
  check(fs.existsSync(path.join(DATA_DIR, "distill-model.json")), "Claude는 옛 파일 이름을 그대로 쓴다(저장해 둔 선택을 안 버린다)");
  check(fs.existsSync(path.join(DATA_DIR, "distill-model-codex.json")), "다른 provider는 자기 파일에 쓴다");
  forgetModel("codex");
  eq("한쪽을 지워도 다른 쪽은 남는다", cachedModel("claude"), "haiku");

  // 목록과 대조해 판정하는 provider는 Claude CLI의 문장을 흉내 낼 필요가 없다 — 이 오류를 던지면 된다.
  forgetModel("codex");
  resetDistillModelMemory("codex");
  fs.writeFileSync(path.join(DATA_DIR, "distill-model-codex.json"), JSON.stringify({ model: "gpt-5.6-terra", rule: PICK_RULE }));
  const codexSets: string[] = [];
  const codexUsed = await resolveAndApply(
    "codex",
    CODEX_MODELS,
    async (m) => {
      codexSets.push(m);
      if (m === "gpt-5.6-terra") throw new UnknownModelNameError(m);
    },
    async () => "gpt-5.4-mini\ngpt-5.6-terra",
  );
  eq("★ UnknownModelNameError도 '없는 이름'으로 알아본다", codexUsed, "gpt-5.4-mini");
  eq("없는 이름은 버리고 새로 고른 것으로 넘어간다", codexSets, ["gpt-5.6-terra", "gpt-5.4-mini"]);

  console.log("\n──────── ★ 별칭이 가리키지 않는 옛 버전은 후보에서 빠진다 ────────");
  // 같은 단가 묶음의 맨 앞(가장 최근)이 채택된다 — 별칭 같은 provider 고유 표시 없이 이름 목록만으로 동작한다.
  eq("별칭이 없는 목록도 후보가 그대로다", selectableModels(CODEX_MODELS).map((m) => m.value), ["gpt-5.6-terra", "gpt-5.4-mini"]);
  forgetModel("codex");
  resetDistillModelMemory("codex");
  const tierUsed = await resolveAndApply("codex", CODEX_MODELS, async () => {}, async () => "gpt-5.4-mini, gpt-5.6-terra");
  eq("같은 단가 묶음에서 맨 앞(가장 최근)을 쓴다", tierUsed, "gpt-5.4-mini");
  eq("저장 파일에 규칙 판이 함께 남는다", JSON.parse(fs.readFileSync(path.join(DATA_DIR, "distill-model-codex.json"), "utf8")).rule, PICK_RULE);

  forgetModel("claude");
  resetDistillModelMemory("claude");
  fs.writeFileSync(CACHE, JSON.stringify({ model: "claude-haiku-4-5-20251001" })); // 판 없는 옛 저장값
  eq("판이 없는 저장값은 읽히지 않는다", cachedModel("claude"), undefined);
  check(!fs.existsSync(CACHE), "읽다가 버린 저장 파일은 지워진다");
  writeCache("claude-haiku-4-5-20251001", "old-rule");
  const staleSets: string[] = [];
  const staleUsed = await resolveAndApply("claude", MODELS, async (m) => { staleSets.push(m); }, async () => order("haiku"));
  eq("다른 판의 저장값은 써 보지도 않고 다시 고른다", staleSets, ["haiku"]);
  eq("다시 고른 이름을 쓴다", staleUsed, "haiku");
  eq("저장값이 새 판으로 바뀐다", cachedModel("claude"), "haiku");

  console.log("\n──────── ★ 기본 모델이 오류면 후보 줄에 따로 묻고 합친다 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  const askedAs: string[] = [];
  const fbUsed = await resolveAndApply(
    "claude",
    MODELS,
    async () => {},
    async () => { throw new Error("크레딧 부족"); },
    async (model) => { askedAs.push(model); return model === "sonnet" ? "haiku, sonnet\nopus[1m]\nclaude-fable-5[1m]" : order("haiku"); },
  );
  eq("실패한 기본 모델과 같은 실제 모델 줄(opus[1m])과 default 줄을 빼고 앞쪽 세 줄에 물었다", askedAs, ["claude-fable-5[1m]", "sonnet", "haiku"]);
  eq("합친 순위의 맨 앞을 쓴다", fbUsed, "haiku");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  const fbOne = await resolveAndApply("claude", MODELS, async () => {}, async () => { throw new Error("크레딧 부족"); },
    async (model) => { if (model !== "sonnet") throw new Error("거부"); return order("haiku"); });
  eq("쓸 답이 둘 미만이면 포기한다", fbOne, undefined);

  console.log("\n──────── ★ 목록이 비면 저장값을 지우지 않는다 ────────");
  forgetModel("claude");
  resetDistillModelMemory("claude");
  writeCache("haiku");
  const emptySets: string[] = [];
  const emptyUsed = await resolveAndApply("claude", [], async (m) => { emptySets.push(m); throw new UnknownModelNameError(m); }, async () => { throw new Error("불려선 안 된다"); });
  eq("목록이 비면 아무것도 시도하지 않고 undefined", emptyUsed, undefined);
  eq("맞추기도 시도하지 않는다", emptySets, []);
  eq("저장값이 그대로 남는다", cachedModel("claude"), "haiku");

  console.log("\n──────── 한계 고정: 최신 선택은 질문 지시에만 기대다 ────────");
  // 모델이 옛 버전을 같은 가격대 맨 앞에 두면 코드는 그것을 채택한다(코드는 출시 시점을 모른다).
  forgetModel("codex");
  resetDistillModelMemory("codex");
  const oldFirst = await resolveAndApply("codex", CODEX_MODELS, async () => {}, async () => "gpt-5.4-mini, gpt-5.6-terra");
  eq("답의 같은 가격대 맨 앞이 채택된다", oldFirst, "gpt-5.4-mini");

  console.log("\n──────── ★ 핀은 등록표에서 읽고 이름으로 가르지 않는다 ────────");
  bindDistillPinLookup((id) => {
    if (id === "mock3") return { model: "cheap-3", source: "AETHER_MOCK3_DISTILL_MODEL" };
    if (id === "codex") return { model: "codex-pin", source: "AETHER_CODEX_DISTILL_MODEL" };
    if (id === "claude") return { model: "haiku", source: "AETHER_REFLECT_MODEL" };
    return undefined;
  });
  eq("세 번째 id 핀은 등록표 값이다", pinnedModel("mock3"), "cheap-3");
  eq("Codex 핀은 이름 분기가 아니라 등록 값이다", pinnedModel("codex"), "codex-pin");
  eq("없는 id는 Claude 핀으로 떨어지지 않는다", pinnedModel("nope"), undefined);

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(pinDir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "✅" : "❌"} distill_model: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
