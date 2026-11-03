import { reportError } from "../observability/report";
/**
 * 모델 칩 목록 기억 — provider가 짧은 목록과 긴 목록을 번갈아 줘도 화면에는 늘 긴 목록을 보인다
 * (배경 작업 모델 측정 계획 7절, D9).
 *
 * provider마다 세 가지를 기억한다(메모리와 `data/model-catalog-<provider>.json`).
 *   - 골격: 지금까지 받은 목록 중 줄 수가 가장 많은 목록의 value 순서. 받은 목록이 골격 이상이면 바꾼다.
 *   - 줄별 최신 관측: value마다 마지막으로 본 줄과 시각. 짧은 목록을 받아도 거기 있는 줄은 갱신한다.
 *   - 버전이 확인된 표시 이름: value마다 (resolvedModel, displayName, description). 골격을 바꿀 때 받은 목록에서만
 *     갱신한다 — 짧은 목록의 이름("Haiku")이 긴 목록의 이름("Haiku 5.5")을 덮지 않게.
 * 30일 동안 어떤 목록에서도 안 보인 줄은 버린다. 골격이 30일 넘게 갱신되지 않으면 골격도 버린다.
 *
 * 합친 목록은 모델 목록 응답과 표시 이름 계산에만 쓴다. 계정 기본 모델 계산과 배경 작업 측정은 받은 원본을 쓴다.
 * 고를 때는 지금처럼 provider가 이름을 판정한다(기억에만 있는 줄도 고를 수 있고, 거부되면 지금의 오류가 뜬다).
 * 이 파일은 provider 이름도 모델 이름의 생김새도 보지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { ProviderId, RuntimeModel } from "./types";

export const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type VersionedName = { resolvedModel: string; displayName: string; description?: string };
type CatalogMemory = {
  version: 1;
  skeleton: { values: string[]; updatedAt: number } | null;
  rows: Record<string, { row: RuntimeModel; seenAt: number }>;
  names: Record<string, VersionedName>;
};

const memory = new Map<ProviderId, CatalogMemory>();
const empty = (): CatalogMemory => ({ version: 1, skeleton: null, rows: {}, names: {} });
const file = (provider: ProviderId) => path.join(config.dataDir, `model-catalog-${provider}.json`);

const optStr = (v: unknown) => v === undefined || typeof v === "string";
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";
/** 설명 묶음: 키마다 `{ text?: 문자열, byLocale?: { 로케일: 문자열 } }`. 화면이 그대로 그리므로 문자열만 허용한다. */
function isDescriptions(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((d) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const { text, byLocale } = d as { text?: unknown; byLocale?: unknown };
    if (!optStr(text)) return false;
    if (byLocale === undefined) return true;
    return !!byLocale && typeof byLocale === "object" && !Array.isArray(byLocale) && Object.values(byLocale).every((x) => typeof x === "string");
  });
}

/** 기억한 줄 하나가 화면과 표시 이름 계산에 그대로 써도 되는 모양인가. */
function isRow(r: RuntimeModel): boolean {
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.value === "string" &&
    r.value.length > 0 &&
    typeof r.displayName === "string" &&
    optStr(r.description) &&
    optStr(r.resolvedModel) &&
    optBool(r.isDefault) &&
    optBool(r.supportsEffort) &&
    optBool(r.followsAccountDefault) &&
    optBool(r.movingAlias) &&
    (r.supportedEffortLevels === undefined || (Array.isArray(r.supportedEffortLevels) && r.supportedEffortLevels.every((e) => typeof e === "string"))) &&
    isDescriptions(r.supportedEffortDescriptions)
  );
}

function isValid(v: unknown): v is CatalogMemory {
  const m = v as CatalogMemory;
  return (
    !!m &&
    typeof m === "object" &&
    m.version === 1 &&
    (m.skeleton === null || (Array.isArray(m.skeleton?.values) && m.skeleton.values.every((x) => typeof x === "string") && Number.isFinite(m.skeleton.updatedAt))) &&
    !!m.rows &&
    typeof m.rows === "object" &&
    Object.entries(m.rows).every(([k, r]) => !!r && isRow(r.row) && r.row.value === k && Number.isFinite(r.seenAt)) &&
    !!m.names &&
    typeof m.names === "object" &&
    Object.values(m.names).every((n) => !!n && typeof n.resolvedModel === "string" && typeof n.displayName === "string" && optStr(n.description))
  );
}

function load(provider: ProviderId): CatalogMemory {
  const hit = memory.get(provider);
  if (hit) return hit;
  let m = empty();
  try {
    const parsed = JSON.parse(fs.readFileSync(file(provider), "utf8"));
    if (isValid(parsed)) m = parsed;
    else {
      void reportError(new Error("모델 목록 기억 형식 손상"), { component: "providers", operation: "model_catalog.corruption", provider });
      console.error(`[aether] 모델 목록 기억(${provider})의 모양이 맞지 않아 비우고 시작한다`);
    }
  } catch (e) {
    // 아직 세션을 띄운 적 없는 provider는 파일이 없는 것이 정상이다.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      void reportError(e, { component: "providers", operation: "model_catalog.memory.load" });
      console.error(`[aether] 모델 목록 기억(${provider})을 읽지 못해 비우고 시작한다:`, e);
    }
  }
  memory.set(provider, m);
  return m;
}

/** 파일 쓰기는 실패해도 넘어간다 — 기억은 화면 편의이지 동작 조건이 아니다. 메모리 쪽은 그대로 쓴다. */
function save(provider: ProviderId, m: CatalogMemory) {
  try {
    const f = file(provider);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, f);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch (e) {
    void reportError(e, { component: "providers", operation: "model_catalog.memory.save" }); console.error(`[aether] 모델 목록 기억(${provider})을 저장하지 못했다:`, e);
  }
}

/** 오래된 줄과 골격을 버린다. */
function expire(m: CatalogMemory, now: number) {
  for (const [value, r] of Object.entries(m.rows)) {
    if (now - r.seenAt >= CATALOG_MAX_AGE_MS) {
      delete m.rows[value];
      delete m.names[value];
    }
  }
  if (m.skeleton && now - m.skeleton.updatedAt >= CATALOG_MAX_AGE_MS) m.skeleton = null;
}

/** provider가 준 목록을 기억한다. 준비 신호를 받을 때마다 부른다. */
export function rememberModelList(provider: ProviderId, rows: readonly RuntimeModel[], now = Date.now()): void {
  if (!rows.length) return;
  const m = load(provider);
  expire(m, now);
  for (const row of rows) m.rows[row.value] = { row: { ...row }, seenAt: now };
  if (!m.skeleton || rows.length >= m.skeleton.values.length) {
    m.skeleton = { values: rows.map((r) => r.value), updatedAt: now };
    for (const r of rows) {
      if (r.resolvedModel) m.names[r.value] = { resolvedModel: r.resolvedModel, displayName: r.displayName, ...(r.description ? { description: r.description } : {}) };
    }
  }
  save(provider, m);
}

/**
 * 버전이 확인된 표시 이름을 쓸 수 있으면 쓴다. 두 쪽 모두 resolvedModel이 있고 같을 때만이다.
 * 그 줄이 만료됐으면(30일 동안 안 보였으면) 이름도 쓰지 않는다.
 */
function withName(row: RuntimeModel, names: Record<string, VersionedName>, live: (value: string) => boolean): RuntimeModel {
  const n = live(row.value) ? names[row.value] : undefined;
  if (!n || !row.resolvedModel || n.resolvedModel !== row.resolvedModel) return row;
  return { ...row, displayName: n.displayName, ...(n.description !== undefined ? { description: n.description } : {}) };
}

/**
 * 화면에 줄 목록(7.2절). 순서는 골격을 따르고, 골격에 없는 줄은 뒤에 붙인다.
 * 지금 목록에 있는 줄은 지금 값을 쓰고, 기억에만 있는 줄은 `remembered: true`를 붙인다.
 * 기억에만 있는 기본값 선택지는 붙이지 않는다(기본값 선택지는 지금 목록 것만 믿는다).
 */
export function mergeModelList(provider: ProviderId, current: readonly RuntimeModel[], now = Date.now()): RuntimeModel[] {
  const m = load(provider);
  const byValue = new Map(current.map((r) => [r.value, r]));
  const fresh = (value: string) => {
    const r = m.rows[value];
    return r && now - r.seenAt < CATALOG_MAX_AGE_MS ? r.row : undefined;
  };
  const live = (value: string) => !!fresh(value);
  const rememberedRow = (value: string): RuntimeModel | undefined => {
    const r = fresh(value);
    if (!r || r.followsAccountDefault) return undefined;
    const { isDefault: _drop, ...rest } = r;
    return { ...withName(rest, m.names, live), remembered: true };
  };
  const out: RuntimeModel[] = [];
  const seen = new Set<string>();
  const push = (row: RuntimeModel | undefined) => {
    if (!row || seen.has(row.value)) return;
    seen.add(row.value);
    out.push(row);
  };
  const skeleton = m.skeleton && now - m.skeleton.updatedAt < CATALOG_MAX_AGE_MS ? m.skeleton.values : [];
  for (const value of skeleton) {
    const cur = byValue.get(value);
    push(cur ? withName(cur, m.names, live) : rememberedRow(value));
  }
  for (const cur of current) push(withName(cur, m.names, live));
  for (const value of Object.keys(m.rows)) if (!byValue.has(value)) push(rememberedRow(value));
  return out;
}

/** 시험 전용 — 메모리 사본을 지운다(재시작 흉내). */
export function resetModelCatalogMemory(): void {
  memory.clear();
}
