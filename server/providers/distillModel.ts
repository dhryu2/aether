import { FailureTracker } from "./failureTracking";
import { reportError } from "../observability/report";
/**
 * 배경 작업이 쓸 모델 이름을 정한다 — provider 중립(D6).
 *
 * 배경 작업(검색 요약)은 짧은 글을 정해진 형식으로 뽑는 단순한 일이라
 * 가장 싼 모델이면 충분하다. 그런데 **어느 것이 싼지는 코드로 알 수 없다** — provider가 주는 모델 목록
 * (`ModelInfo`)에 가격 항목이 없기 때문이다. 그래서 이름을 손으로 적어 두는 방식을 오래 써 왔는데,
 * 그 이름이 사라지면 기능이 조용히 죽는다.
 *
 * 여기서 하는 일은 셋이다.
 *   ① 쓸 이름을 정한다      — 운영자가 못 박은 값 → 저장해 둔 값(규칙 판이 같을 때만) → 없으면 새로 고르기
 *   ② 새로 고른다          — 계정 기본 모델에게 목록을 주고 "호출 단가가 싼 순서, 같은 단가는 한 줄에 쉼표로 묶고
 *                            그 줄 안에서는 가장 최근 모델부터"를 묻는다. 답을 목록과 대조해 검증하고,
 *                            가장 싼 가격대의 맨 앞(= 같은 단가 중 가장 최근 모델)을 채택한다.
 *                            기본 모델 호출이 오류면 후보 앞쪽 줄들에게 따로 물어 평균 순위·다수결로 합친다.
 *   ③ 정해진 값을 남긴다    — 다음부터 다시 안 묻도록 규칙 판(`PICK_RULE`)과 함께 파일에 저장
 *
 * 이 파일은 provider 이름도, 목록 줄의 고유 표시(별칭 여부 등)도 보지 않는다. 판단 재료는 이름·표시명·설명뿐이다.
 *
 * ★ 환경변수를 되쓰지 않는 이유: 실행 중에 `process.env`를 바꿔도 그 프로세스 안에서만 살아 있다.
 *   launchd가 재시작할 때 plist의 값으로 다시 띄우므로 그대로 사라진다. 그래서 파일에 남긴다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { pick } from "../i18n";
import type { ProviderId } from "./types";

/** 고르는 규칙의 판. 저장 파일에 함께 적고, 다르면 저장값을 버려 새 규칙으로 다시 고른다. 규칙을 바꿀 때 올린다. */
export const PICK_RULE = "price-tier-latest-v1";

const cacheFailures = new FailureTracker();
const failures = new FailureTracker();

/** 모델 목록 한 줄 — provider가 주는 것 중 고르기에 필요한 만큼만. */
export type DistillModelChoice = {
  /** 고를 때 쓰는 이름. 대개 버전 없는 별칭이다(`haiku`). 저장하는 값은 언제나 이것. */
  value: string;
  /** 그 별칭이 지금 가리키는 정식 id(`claude-haiku-4-5-20251001`). 모델이 이쪽으로 답해도 같은 줄로 받으려고 둔다. */
  resolvedModel?: string;
  displayName?: string;
  description?: string;
};

/**
 * 저장 파일은 **provider마다 따로**다(8f). 한 파일을 나눠 쓰면 Codex가 고른 이름을 Claude가 덮어쓰고,
 * 그러면 서로의 모델 어휘가 아닌 이름을 물려받아 배경 작업이 매번 거부당한다.
 * 옛 이름을 그대로 써야 하는 provider는 등록표가 `cacheFile`로 알려 준다 — 이미 저장해 둔 선택을 버리지 않기 위해서다(이름을 바꾸면 다시 묻게 된다).
 */
const CACHE_FILE = (provider: ProviderId) =>
  path.join(config.dataDir, pinLookup(provider)?.cacheFile ?? `distill-model-${provider}.json`);

/**
 * 운영자가 못 박은 이름. 값은 등록표(`ProviderEntry.distillModel`)에서 온다.
 *
 * 공통 계층이 provider 이름으로 환경변수를 가르면, 세 번째 실행기는 Claude 설정을 조용히 물려받는다.
 * 등록표가 기동 시 `bindDistillPinLookup`으로 연결한다. 테스트 등록도 같은 조회를 탄다.
 */
type DistillPin = { model?: string; source?: string; cacheFile?: string };
let pinLookup: (provider: ProviderId) => DistillPin | undefined = () => undefined;

export function bindDistillPinLookup(lookup: (provider: ProviderId) => DistillPin | undefined): void {
  pinLookup = lookup;
}

function pinnedRaw(provider: ProviderId): string | undefined {
  return pinLookup(provider)?.model;
}

function pinSourceName(provider: ProviderId): string {
  return pinLookup(provider)?.source ?? "distillModel";
}

/** provider 하나가 프로세스 안에 들고 있는 기억. 섞이면 한쪽의 실패가 다른 쪽의 대기시간이 된다. */
type Memory = {
  /** 실제로 마지막에 쓴 모델 이름. 아직 한 번도 안 정했으면 undefined. */
  lastUsed?: string;
  /** 모델을 새로 고른 횟수 — 알림 판정용(값 비교보다 정확하다). */
  pickCount: number;
  /** 고르기가 실패한 시각 — 한동안 다시 묻지 않기 위해. */
  pickFailedAt: number;
  /** 진행 중인 질문 — 여러 세션이 동시에 쉬어도 질문은 하나로 합친다. */
  inFlightPick: Promise<string | undefined> | null;
};
const memories = new Map<ProviderId, Memory>();
function mem(provider: ProviderId): Memory {
  let m = memories.get(provider);
  if (!m) memories.set(provider, (m = { pickCount: 0, pickFailedAt: 0, inFlightPick: null }));
  return m;
}

/**
 * "그런 이름은 없다"를 provider가 알리는 방법 — Claude 말고도 쓸 수 있게 타입으로 둔다.
 *
 * 어댑터가 서비스 거절을 확인한 경우 중립 원인을 붙인다. 표시가 없으면 내부 결함 가능성을 보존한다.
 */
export class UnknownModelNameError extends Error {
  constructor(model: string) {
    super(`알 수 없는 모델 이름: ${model}`);
    this.name = "UnknownModelNameError";
  }
}

/**
 * 이름이 너무 길거나 제어문자를 품고 있으면 모델이 엉뚱한 걸 답한 것이다.
 *
 * 이 이름은 명령줄 인자가 되지 않는다(setModel은 이미 떠 있는 프로세스에 보내는 메시지다). 그래도 검사가
 * 필요한 이유는 따로 있다 — 이 이름이 사용자에게 보이는 알림 문구로 들어가고 디스크에 기록되기 때문이다.
 * 제어문자와 과도한 길이를 여기서 막는다.
 *
 * 판정 기준은 세션 생성 경로(`server/routes/sessions.ts:45`)와 같다. 두 경로가 같은 값을 다르게 판정하면
 * 사람이 손으로 넣을 땐 거절당한 이름이 자동 선택 경로로는 통과한다.
 */
export function isWellFormedName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (name.startsWith("-")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false; // 제어 문자
  }
  return true;
}

/** 운영자가 환경변수로 못 박은 이름. 비어 있으면 undefined(자동 선택). */
export function pinnedModel(provider: ProviderId): string | undefined {
  const v = pinnedRaw(provider)?.trim();
  return v && isWellFormedName(v) ? v : undefined;
}

/**
 * 저장해 둔 이름. 파일이 없거나 깨졌으면 undefined.
 *
 * `default`는 여기서 거부한다. 자동 선택은 애초에 그 줄을 후보에서 빼므로 정상 경로로는 저장될 수 없지만,
 * 예전 판이 저장해 둔 파일이 남아 있거나 누가 손으로 고쳐 넣으면 그대로 읽힌다. 그러면 배경 작업 네 가지가
 * 전부 계정 기본 모델(가장 비싼 것)로 돌면서, 그게 "저장된 선택"이라 다시 검토되지도 않는다.
 * 환경변수로 못 박은 `default`는 반대로 존중한다 — 그건 사람이 일부러 고른 것이다(`pinnedModel`).
 */
export function cachedModel(provider: ProviderId): string | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CACHE_FILE(provider), "utf8"));
    const model = raw && typeof raw === "object" ? (raw as { model?: unknown }).model : undefined;
    const v = typeof model === "string" ? model.trim() : "";
    if (!v || !isWellFormedName(v)) throw new Error("저장된 배경 작업 모델 형식 손상");
    cacheFailures.recoveredFile(CACHE_FILE(provider));
    // 다른 규칙(또는 규칙 판이 없던 때)으로 고른 값은 믿지 않고 새 규칙으로 다시 고른다.
    if ((raw as { rule?: unknown }).rule !== PICK_RULE) {
      forgetModel(provider);
      return undefined;
    }
    if (v.toLowerCase() === "default") {
      console.error('[aether] 저장된 배경 작업 모델이 "default"(계정 기본 = 가장 비쌈)라 무시하고 다시 고른다');
      return undefined;
    }
    return v;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      cacheFailures.file(error, { component: "providers", operation: "background_model.cache.read", provider }, CACHE_FILE(provider));
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") cacheFailures.recoveredFile(CACHE_FILE(provider));
    return undefined;
  }
}

/** 고른 이름을 남긴다. 실패해도 조용히 넘어간다 — 저장은 다음번을 아끼는 것일 뿐 이번 작업의 조건이 아니다. */
function saveModel(provider: ProviderId, model: string) {
  try {
    const file = CACHE_FILE(provider);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 임시 이름을 매번 다르게 짓고 "이미 있으면 실패"(flag: wx)로 연다. 이름이 고정이면 그 자리에 미리
    //   심볼릭 링크를 걸어 두는 것으로 엉뚱한 파일을 덮어쓰게 만들 수 있다.
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ model, rule: PICK_RULE, pickedAt: Date.now() }), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch (e) {
    void reportError(e, { component: "providers", operation: "background_model.selection.save" }); console.error("[aether] 배경 작업 모델 저장 실패(다음 실행에서 다시 고른다):", e);
  }
}

/** 저장해 둔 이름을 버린다 — 그 이름이 거부됐을 때. */
export function forgetModel(provider: ProviderId) {
  try {
    fs.rmSync(CACHE_FILE(provider), { force: true });
  } catch (error) {
    failures.file(error, { component: "providers", operation: "background_model.cache.delete" }, CACHE_FILE(provider));
    /* 없으면 그만 */
  }
}

/**
 * 실제로 마지막에 쓴 모델 이름. 아직 한 번도 안 정했으면 undefined.
 *
 * 설정값(`pinnedModel`/`cachedModel`)이 아니라 **실제로 쓴 것**을 기억한다. 설정값을 알림 기준으로 삼으면,
 * 환경변수에 못 박힌 이름이 고장 나서 다른 모델로 돌고 있어도 설정값은 안 바뀌므로 화면이 계속 침묵한다.
 */
export function currentDistillModel(provider: ProviderId): string | undefined {
  return mem(provider).lastUsed ?? pinnedModel(provider) ?? cachedModel(provider);
}
/** 지금까지 모델을 새로 고른 횟수 — 알림 판정용(값 비교보다 정확하다). */
export function pickGeneration(provider: ProviderId): number {
  return mem(provider).pickCount;
}
/** 테스트 전용 — 프로세스 안에 남는 기억(마지막 사용·고른 횟수·실패 대기·진행 중 질문)을 지운다. */
export function resetDistillModelMemory(provider: ProviderId) {
  memories.delete(provider);
}

/**
 * 고를 수 있는 후보만 남긴다 — `default` 줄을 뺀다.
 *
 * 실측 목록의 첫 줄은 `{ value: "default", displayName: "Default (recommended)",
 * resolvedModel: "claude-opus-5[1m]" }`이다. 이건 가격 선택지가 아니라 "계정 기본 모델을 쓰겠다"는 뜻이고,
 * 이 작업이 피하려는 바로 그 비싼 모델이다. 한 번 골라 저장되면 사람이 파일을 지우기 전까지
 * 배경 작업이 전부 가장 비싼 모델로 돈다.
 *
 * `default`가 가리키는 정식 id와 같은 줄(예: `opus[1m]`)까지 빼지는 않는다. 그건 사용자가 이름으로 고를 수
 * 있는 실재하는 선택지이고, 가격 순서에서 알아서 비싼 쪽으로 밀린다.
 */
export function selectableModels(models: readonly DistillModelChoice[]): DistillModelChoice[] {
  return models.filter((m) => m.value.trim().toLowerCase() !== "default");
}

/** 계정 기본 모델에게 던질 질문 — 가격대별로 묶어 싼 순서로 줄 세우기(D16). */
export function buildPriceOrderPrompt(rows: readonly DistillModelChoice[]): string {
  const list = rows
    .map((m) => `- ${m.value}${m.displayName ? ` (${m.displayName})` : ""}${m.description ? ` — ${m.description}` : ""}`)
    .join("\n");
  return pick({
    ko: [
      "아래는 지금 이 계정에서 쓸 수 있는 모델 목록이다.",
      "이 모델들을 **호출 비용이 싼 것부터 비싼 것 순서로** 줄 세워라. 성능·품질은 고려하지 마라 — 오직 가격만 본다.",
      "",
      list,
      "",
      "출력은 한 줄에 가격대 하나씩, 가장 싼 가격대부터다.",
      "호출 단가가 같은 모델들은 같은 줄에 쉼표로 이어 적고, 그 줄 안에서는 **가장 최근에 나온 모델부터** 적어라.",
      "위 목록의 이름을 모두 정확히 한 번씩 그대로 옮겨 적어라.",
      "번호·설명·따옴표·머리말을 붙이지 마라.",
      "도구를 쓰거나 자료를 찾아보지 마라. 네가 이미 아는 것만으로 답하라.",
      "정확한 단가를 몰라도 된다. 대략적인 순서면 충분하다. 이름·세대·설명을 보고 추정해서 반드시 위 형식으로만 답하라. 답할 수 없다는 말은 하지 마라.",
      "각 줄에는 모델 이름만 적는다. 괄호 속 표시 이름과 설명은 옮기지 마라.",
    ].join("\n"),
    en: [
      "Below is the list of models available to this account.",
      "Order these models **from cheapest to most expensive to call**. Ignore capability and quality — price only.",
      "",
      list,
      "",
      "Output one price tier per line, cheapest tier first.",
      "Put models with the same per-call price on the same line separated by commas, **most recently released first** within the line.",
      "Copy every name from the list above exactly once, verbatim.",
      "No numbering, explanation, quotes, or preamble.",
      "Do not use tools or look anything up. Answer from what you already know.",
      "Exact prices are not needed; a rough order is enough. Estimate from the names, generations, and descriptions and answer only in the format above. Never say you cannot answer.",
      "Write only the model names. Do not copy the display names in parentheses or the descriptions.",
    ].join("\n"),
  });
}

/**
 * 가격 순서 답을 검증한다(D16). 줄 하나가 가격대 하나이고, 줄 안은 쉼표로 나눈 최근 것부터의 이름이다.
 * 목록의 value가 정확히 한 번씩 모두 나와야 한다. 모르는 이름은 버린다. 정식 id로 답해도 그 줄의 value로 받는다.
 * 싼 가격대부터 가격대 배열을 돌려준다. 빠짐·중복·빈 답이면 null.
 *
 * 모델은 자기가 학습한 시점의 가격표를 말한다. 목록에 없는 이름은 받지 않는다 — 실제 목록이 유일한 정본이다.
 */
export function parsePriceOrder(answer: string, rows: readonly DistillModelChoice[]): string[][] | null {
  const tiers: string[][] = [];
  const seen = new Set<string>();
  for (const raw of answer.split("\n")) {
    const tier: string[] = [];
    for (const part of raw.trim().replace(/^(?:\d+[.)]\s*|[-*•]\s*)/, "").split(",")) {
      // 목록에 적힌 대로 "이름 (표시 이름) — 설명"까지 옮겨 적는 답이 있다. 이름 뒤의 괄호·설명은 버린다.
      const name = part
        .replace(/\s+(?:—|–|-{1,2})\s.*$/, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim()
        .replace(/^[`"']+|[`"'.]+$/g, "")
        .trim()
        .toLowerCase();
      if (!name) continue;
      const hit = rows.find((r) => r.value.toLowerCase() === name || r.resolvedModel?.toLowerCase() === name);
      if (!hit) continue;
      if (seen.has(hit.value)) return null;
      seen.add(hit.value);
      tier.push(hit.value);
    }
    if (tier.length) tiers.push(tier);
  }
  if (!seen.size || seen.size !== rows.length) return null;
  return tiers;
}

/**
 * 가격 순서 답(하나 이상)을 합쳐 가장 싼 모델 순으로 만든다(D15·D16). 각 답은 `parsePriceOrder`를 통과한 가격대 배열이다.
 *   - 가격대의 맨 앞(가장 최근 모델)이 아닌 줄은 뺀다. 답이 여럿이면 절반 넘는 답에서 빠진 줄만 뺀다(다수결).
 *   - 남은 줄은 각 답에서의 가격대 자리(0부터)를 평균 내어 작은 것부터 놓는다. 평균이 같으면 `rows`의 순서를 따른다.
 */
export function mergePriceOrders(answers: readonly (readonly (readonly string[])[])[], rows: readonly DistillModelChoice[]): string[] {
  const tierOf = (tiers: readonly (readonly string[])[], v: string) => tiers.findIndex((t) => t.includes(v));
  const avg = (v: string) => answers.reduce((sum, tiers) => sum + tierOf(tiers, v), 0) / answers.length;
  const dropVotes = (v: string) => answers.filter((tiers) => tiers[tierOf(tiers, v)]?.[0] !== v).length;
  return rows
    .map((r, i) => ({ v: r.value, a: avg(r.value), i, drop: dropVotes(r.value) * 2 > answers.length }))
    .filter((x) => !x.drop)
    .sort((x, y) => x.a - y.a || x.i - y.i)
    .map((x) => x.v);
}

/**
 * 고르기가 실패한 뒤 다시 물어보기까지 기다리는 시간.
 *
 * 실패는 대개 곧바로 낫지 않는다(모델이 엉뚱한 답을 하거나 호출 자체가 안 되는 상황). 그런데 질문은
 * 계정 기본 모델이 받으므로, 실패할 때마다 다시 물으면 배경 작업 1회마다 비싼 턴이 하나씩 더 붙는다.
 * 그래서 실패하면 한동안 묻지 않고 계정 기본 모델로 진행한다.
 */
const PICK_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/** 계정 기본 모델이 답하지 못할 때 대신 물을 후보 줄 수. 별칭 같은 provider 고유 표시에 기대지 않고 목록 앞쪽 줄에 묻는다. */
const FALLBACK_ASKERS = 3;

/**
 * 새로 고른다 — 계정 기본 모델에게 가격 순서를 묻고, 가장 싼 가격대의 맨 앞(가장 최근 모델)을 채택한다.
 *
 * `ask`는 provider가 넘겨주는 "모델 지정 없이 짧은 턴 1회"다. 계정 기본 모델이 답하게 되고,
 * 도구는 provider 쪽에서 전부 차단된 채다. 답이 목록과 안 맞으면 한 번 더 묻는다.
 * 기본 모델 호출이 오류로 끝나면(D15) `askAs`로 후보 앞쪽 줄들에게 따로 묻고 평균 순위·다수결로 합친다.
 * 쓸 답이 둘 미만이면 포기한다. 못 고르면 undefined.
 *
 * ★ 여기서는 **저장하지 않는다.** 저장은 그 이름이 실제로 통한다는 걸 확인한 뒤에 한다(`resolveAndApply`).
 *   확인 전에 저장하면, 검증에 실패해 곧 지울 이름을 그 짧은 사이에 다른 세션이 읽어 간다.
 */
export async function pickCheapest(
  provider: ProviderId,
  models: readonly DistillModelChoice[],
  ask: (prompt: string) => Promise<string>,
  askAs?: (model: string, prompt: string) => Promise<string>,
): Promise<string | undefined> {
  const m = mem(provider);
  const candidates = selectableModels(models);
  if (candidates.length === 0) return undefined;
  if (m.pickFailedAt && Date.now() - m.pickFailedAt < PICK_RETRY_COOLDOWN_MS) return undefined;
  if (m.inFlightPick) return m.inFlightPick;

  m.inFlightPick = (async () => {
    const prompt = buildPriceOrderPrompt(candidates);
    let order: string[] | undefined;
    let defaultFailed: unknown;
    let lastAnswer = "";
    for (let i = 0; i < 2 && !order; i++) {
      try {
        lastAnswer = await ask(prompt);
      } catch (e) {
        defaultFailed = e;
        break;
      }
      const tiers = parsePriceOrder(lastAnswer, candidates);
      if (tiers) order = mergePriceOrders([tiers], candidates);
    }
    if (defaultFailed !== undefined && askAs) {
      // 기본 모델이 거부됐다(크레딧 부족 등). 후보 앞쪽 줄들에게 따로 묻고 합친다. 한 모델의 답만 믿지 않는다.
      // 방금 실패한 기본 모델과 같은 실제 모델인 줄은 뺀다(같은 모델에 또 물으면 같은 오류다).
      const failedId = models.find((x) => x.value.trim().toLowerCase() === "default")?.resolvedModel?.toLowerCase();
      const askers = candidates.filter((r) => !failedId || (r.resolvedModel ?? r.value).toLowerCase() !== failedId && r.value.toLowerCase() !== failedId);
      const orders: string[][][] = [];
      for (const r of askers.slice(0, FALLBACK_ASKERS)) {
        try {
          const tiers = parsePriceOrder(await askAs(r.value, prompt), candidates);
          if (tiers) orders.push(tiers);
        } catch { /* 이 줄은 답하지 못했다 — 다음 줄로 */ }
      }
      if (orders.length >= 2) order = mergePriceOrders(orders, candidates);
    }
    const chosen = order?.[0];
    // 목록에서 나온 값이라 모양이 정상일 것이 거의 확실하지만, 읽을 때와 같은 기준을 저장 쪽에도 건다.
    //   기준이 갈리면 "저장은 되는데 다음번에 읽히지 않는" 이름이 생기고, 그러면 매번 다시 묻게 된다.
    if (!chosen || !isWellFormedName(chosen)) {
      m.pickFailedAt = Date.now();
      if (defaultFailed !== undefined) {
        void reportError(defaultFailed, { component: "providers", operation: "background_model.selection.run" });
        console.error("[aether] 배경 작업 모델 고르기 실패:", defaultFailed);
      } else if (chosen || lastAnswer.trim() !== "NONE") {
        // NONE은 모델이 명시한 정상 포기라 수집하지 않는다. 그 밖의 해석 불명·잘못된 후보는 warning으로 수집한다.
        void reportError(new Error(chosen ? "배경 작업 모델 후보 이름 형식 오류" : "배경 작업 모델 가격 순서 답 해석 불명"), {
          component: "providers", operation: "background_model.answer.match", severity: "warning", provider,
        });
        console.error(`[aether] 배경 작업 모델 고르기 — 채택할 수 없는 답이라 버린다: ${lastAnswer.trim().slice(0, 120)}`);
      }
      return undefined;
    }
    m.pickFailedAt = 0;
    return chosen;
  })();

  try {
    return await m.inFlightPick;
  } finally {
    m.inFlightPick = null;
  }
}

/**
 * `setModel`이 "그런 이름은 없다"고 답한 것인가.
 *
 * 이걸 구분하지 않고 모든 실패를 "없는 이름"으로 처리하면, 프로세스가 죽었거나 인증이 만료된 일시적 장애가
 * 멀쩡한 저장값을 지워 버린다. 일시적 장애 하나가 영구 설정을 파괴하면 안 된다.
 * 서비스 고유 문구를 중립 오류로 바꾸는 일은 해당 어댑터가 맡는다.
 */
export function isUnknownNameError(e: unknown): boolean {
  return e instanceof UnknownModelNameError;
}

/**
 * 이번 실행에 쓸 모델을 정하고 실제로 적용한다 — 결정 순서와 재시도 규칙이 여기 한 곳에 있다.
 *
 * `setModel`은 provider가 넘겨주는 "이 이름으로 맞춰라"다. 없는 이름이면 예외를 던진다는 것이 계약이고,
 * 그게 이름을 검증하는 유일하게 정확한 방법이다(쓰려는 이름으로 프로세스를 띄운 뒤 목록과 대조하는
 * 방식은 안 통한다 — CLI가 그 이름을 자기 목록에 넣어서 돌려주기 때문이다). 이 확인은 턴을 안 쓴다(1~3ms).
 * `ask`는 "모델 지정 없이 짧은 턴 1회"다. 계정 기본 모델이 답하므로 비싸다 — 그래서 최대한 아낀다.
 *
 * 순서:
 *   ① 운영자가 못 박은 이름 → ② 저장해 둔 이름 → ③ 그래도 안 되면 새로 고르기(질문 1회)
 *
 * ②를 ③보다 먼저 시도하는 것이 중요하다. 못 박은 이름에 오타가 있거나 그 이름이 은퇴하면 ①이 매번
 * 실패하는데, 곧바로 ③으로 가면 **배경 작업이 돌 때마다** 비싼 질문이 나간다. 저장해 둔 멀쩡한 이름이
 * 있는데도 그렇다. ②를 거치면 질문은 사실상 한 번으로 끝난다.
 *
 * 끝내 못 정하면 undefined — 그때는 호출자가 모델을 지정하지 않은 채(= 계정 기본 모델) 진행한다.
 * 배경 작업이 통째로 죽는 것보다 낫다.
 */
export async function resolveAndApply(
  provider: ProviderId,
  models: readonly DistillModelChoice[],
  setModel: (model: string) => Promise<void>,
  ask: (prompt: string) => Promise<string>,
  askAs?: (model: string, prompt: string) => Promise<string>,
): Promise<string | undefined> {
  const m = mem(provider);
  // 목록이 비면 이름을 확인할 수 없다. 멀쩡한 저장값이 "없는 이름"으로 지워지지 않게 건드리지 않고 기존 동작으로 간다.
  if (models.length === 0) return undefined;
  const pinned = pinnedModel(provider);
  // 규칙 판이 다른 저장값은 cachedModel이 이미 버렸다.
  const cached = cachedModel(provider);
  // 아는 이름을 순서대로 시도한다. 같은 값이 둘 다면 한 번만 본다.
  const known: Array<{ model: string; pinned: boolean }> = [];
  if (pinned) known.push({ model: pinned, pinned: true });
  if (cached && cached !== pinned) known.push({ model: cached, pinned: false });

  for (const k of known) {
    try {
      await setModel(k.model);
      m.lastUsed = k.model;
      return k.model;
    } catch (e) {
      const where = k.pinned ? pinSourceName(provider) : pick({ ko: "저장해 둔 값", en: "the cached value" });
      if (!isUnknownNameError(e)) {
        // 이름 문제가 아니다(프로세스 사망·인증 만료 등). 저장값을 건드리지 않고 이번 실행만 포기한다.
        void reportError(e, { component: "providers", operation: "background_model.selection.apply" }); console.error(`[aether] 배경 작업 모델 "${k.model}"(${where}) 적용 실패 — 이름 문제는 아니다:`, String((e as Error)?.message ?? e).slice(0, 160));
        return undefined;
      }
      // 직접 지정한 이름은 입력 거절이다. 저장값은 어댑터가 서비스 변화를 확인한 경우에만 제외한다.
      if (!k.pinned) void reportError(e, { component: "providers", operation: "background_model.cache.apply", severity: "warning", provider });
      console.error(`[aether] 배경 작업 모델 "${k.model}"(${where})은 없는 이름이다 — 다음 후보로 넘어간다.`);
      // 못 박은 값은 지우지 않는다(운영자가 고쳐야 할 설정이다). 저장해 둔 값만 버린다.
      if (!k.pinned) forgetModel(provider);
    }
  }

  // 아는 이름이 전부 안 통할 때만 묻는다. 질문은 여기 한 번뿐이다(무한 반복 금지).
  const picked = await pickCheapest(provider, models, ask, askAs);
  if (!picked) return undefined;
  try {
    await setModel(picked);
  } catch (e) {
    // 방금 고른 이름마저 안 통한다 — 목록이 낡았거나 제어 요청이 실패하는 상황이다. 이때도 대기시간을
    //   걸어야 한다. 안 걸면 배경 작업이 돌 때마다 비싼 질문이 다시 나가고, 그 답도 매번 같은 이유로 실패한다.
    m.pickFailedAt = Date.now();
    void reportError(e, { component: "providers", operation: "background_model.selection.fallback", severity: "warning" }); console.error(`[aether] 새로 고른 배경 작업 모델 "${picked}"도 쓸 수 없다 — 계정 기본 모델로 진행한다:`, String((e as Error)?.message ?? e).slice(0, 160));
    return undefined;
  }
  // ★ 통한다는 걸 확인한 뒤에 저장한다.
  saveModel(provider, picked);
  m.lastUsed = picked;
  m.pickCount++;
  console.log(`[aether] 배경 작업 모델을 골랐다: ${picked}`);
  return picked;
}
