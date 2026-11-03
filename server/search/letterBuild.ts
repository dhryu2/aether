/**
 * 사건 줄에서 검색 글자(LetterDoc)를 만드는 순수 부분. 부팅 재생성(rebuildLetter)과 삭제 때의 글자 확인,
 * 일회용 정리 도구가 같이 쓴다. DB는 읽기만 하고 쓰지 않는다.
 * provider 이름은 모른다. 세션 정보가 없으면 등록된 provider 어댑터(codec)가 직접 사건을 해석해 보고 고른다.
 */
import type { DatabaseSync } from "node:sqlite";
import { listProviders } from "../providers/registry";
import type { ProviderEventCodec } from "../sessions/codec/types";
import type { AetherEvent } from "../types";
import { fillMissingLetterRows, sanitizeDocs, type LetterDoc, type LetterSessionMeta } from "../db/sessionLetter";
import { extractIndexable, type IndexItem } from "./extract";
import { createLetterRefiner, type RefineRules } from "./refineLetter";

const MAX_INDEX_CHARS = 100_000;

export type LetterRow = { seq: number; ts: number; line: string };
/** 줄을 파일 순서로 하나씩 넘기는 원천. 읽기 전용 연결이든 운영 연결이든 호출자가 정한다. */
export type RowSource = (visit: (row: LetterRow) => void) => void;
export type LetterBuild = { docs: LetterDoc[]; turnSeqs: number[]; seen: number; parseFailed: boolean; extractFailed: boolean };

export function buildLetterDocs(
  source: RowSource,
  codec: ProviderEventCodec,
  rules?: Partial<RefineRules>,
  onError?: (kind: "parse" | "extract", error: unknown) => void,
): LetterBuild {
  const docs: LetterDoc[] = [];
  const turnSeqs: number[] = [];
  // 실시간 반영과 같은 정제 규칙을 세션마다 처음부터 적용한다.
  const refiner = createLetterRefiner(rules);
  let parseFailed = false, extractFailed = false, seen = 0;
  source((row) => {
    if (row.seq > seen) seen = row.seq;
    let ev: AetherEvent;
    try {
      const parsed = JSON.parse(row.line) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      ev = parsed as AetherEvent;
    } catch (error) {
      parseFailed = true;
      onError?.("parse", error);
      return;
    }
    let plan: ReturnType<typeof extractIndexable>;
    let items: IndexItem[];
    try {
      plan = extractIndexable(ev, codec);
      items = refiner.refine(row.seq, plan.items);
    } catch (error) {
      extractFailed = true;
      onError?.("extract", error);
      return;
    }
    for (const item of items) {
      const content = item.content.length > MAX_INDEX_CHARS ? item.content.slice(0, MAX_INDEX_CHARS) : item.content;
      if (!content) continue;
      docs.push({ seq: row.seq, part: item.part, role: item.role, ts: row.ts, content });
    }
    if (plan.turnEnded) turnSeqs.push(row.seq);
  });
  return { docs, turnSeqs, seen, parseFailed, extractFailed };
}

/**
 * 세션 정보(폴더)가 없는 세션의 해석기를 고른다. 등록된 어댑터마다 사건 전체를 해석해 보고
 * 검색 글자가 가장 많이 나오는 쪽을 쓴다. 같으면 먼저 등록된 쪽이다.
 * 표본을 두지 않는다. 앞부분이 제어 사건뿐인 세션도 바르게 고르려는 것이다. 한 번만 읽어 어댑터마다 점수를 더한다.
 */
export function detectCodec(source: RowSource): ProviderEventCodec {
  const entries = listProviders();
  const scores = entries.map(() => 0);
  source((row) => {
    let ev: AetherEvent;
    try {
      const parsed = JSON.parse(row.line) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      ev = parsed as AetherEvent;
    } catch {
      return; // 깨진 줄은 판정에서 뺀다
    }
    entries.forEach((entry, i) => {
      try {
        scores[i] += extractIndexable(ev, entry.codec).items.length;
      } catch {
        /* 이 어댑터가 못 읽는 사건 */
      }
    });
  });
  let best = 0;
  for (let i = 1; i < entries.length; i++) if (scores[i] > scores[best]) best = i;
  return entries[best].codec;
}

/** 사용자 말 / 어시스턴트 말(중간·최종 합) / 도구 줄 수. */
export type RoleCounts = { user: number; assistant: number; tool: number };

const bucket = (role: string): keyof RoleCounts => (role === "user" ? "user" : role === "tool" ? "tool" : "assistant");

/** 저장될 때와 같이 (seq, part)가 같은 글은 하나로 센다. */
export function docCounts(docs: LetterDoc[]): RoleCounts {
  const byKey = new Map<string, string>();
  for (const d of docs) byKey.set(`${d.seq}:${d.part}`, d.role);
  const out: RoleCounts = { user: 0, assistant: 0, tool: 0 };
  for (const role of byKey.values()) out[bucket(role)]++;
  return out;
}

export function storedCounts(db: DatabaseSync, sessionId: string): RoleCounts {
  const out: RoleCounts = { user: 0, assistant: 0, tool: 0 };
  const rows = db.prepare("SELECT role, count(*) AS n FROM session_letter WHERE session_id = ? GROUP BY role").all(sessionId) as { role: string; n: number | bigint }[];
  for (const r of rows) out[bucket(r.role)] += Number(r.n);
  return out;
}


/**
 * 원본 사건에서 만든 글자(같은 정제 규칙을 거친 결과)를 저장된 글자와 (seq, part)마다 내용까지 견준다.
 *   match   원본에서 기대되는 글이 모두 같은 내용으로 저장돼 있다.
 *   recover 빠진 글이 있다. 빠진 것만 채우면 된다.
 *   keep    같은 자리에 다른 내용이 저장돼 있거나 읽지 못한 사건 줄이 있다. 원본을 남긴다.
 * 저장 글자에만 있는 글(extra)과, 정제 전이라 더 긴 채 저장된 도구 결과(unrefined)는 정상으로 두고 수만 알린다. 사용자 말과 답변의 역할은 중간·최종을 같게 본다.
 */
export type LetterCheck =
  | { state: "match" | "recover"; want: RoleCounts; have: RoleCounts; missing: number; extra: number; unrefined: number; build: LetterBuild }
  | { state: "keep"; reason: string; want: RoleCounts; have: RoleCounts; missing: number; extra: number; unrefined: number };

type Compared = { missing: number; conflicts: number; conflictRole: string; extra: number; unrefined: number };

function compareLetters(db: DatabaseSync, sessionId: string, expected: LetterDoc[]): Compared {
  const stored = new Map<string, { role: string; content: string }>();
  const rows = db.prepare("SELECT seq, part, role, content FROM session_letter WHERE session_id = ?").all(sessionId) as { seq: number | bigint; part: number | bigint; role: string; content: string }[];
  for (const r of rows) stored.set(`${r.seq}:${r.part}`, { role: r.role, content: r.content });
  const out: Compared = { missing: 0, conflicts: 0, conflictRole: "", extra: 0, unrefined: 0 };
  let found = 0;
  for (const d of expected) {
    const got = stored.get(`${d.seq}:${d.part}`);
    if (!got) {
      out.missing++;
      continue;
    }
    found++;
    if (bucket(got.role) === bucket(d.role) && got.content === d.content) continue;
    // 정제는 긴 도구 결과를 줄이기만 한다. 정제 규칙이 생기기 전에 저장된 글은 더 길 뿐 잃은 것이 없다.
    if (d.role === "tool" && bucket(got.role) === "tool" && got.content.length > d.content.length) {
      out.unrefined++;
      continue;
    }
    out.conflicts++;
    out.conflictRole ||= bucket(d.role);
  }
  out.extra = stored.size - found;
  return out;
}

export function checkLetters(db: DatabaseSync, sessionId: string, source: RowSource, codec: ProviderEventCodec): LetterCheck {
  const build = buildLetterDocs(source, codec);
  const expected = sanitizeDocs(build.docs);
  const want = docCounts(expected);
  const have = storedCounts(db, sessionId);
  const cmp = compareLetters(db, sessionId, expected);
  const base = { want, have, missing: cmp.missing, extra: cmp.extra, unrefined: cmp.unrefined };
  if (build.parseFailed || build.extractFailed) return { state: "keep", reason: "읽지 못한 사건 줄이 있다", ...base };
  if (cmp.conflicts > 0) return { state: "keep", reason: `같은 자리에 다른 ${cmp.conflictRole === "tool" ? "도구 결과" : "말"}이 ${cmp.conflicts}곳 저장돼 있다`, ...base };
  return { state: cmp.missing > 0 ? "recover" : "match", ...base, build };
}

/** 빠진 글만 채우고 다시 견줘, 빠진 것도 다른 것도 없을 때만 true. 이미 있던 글은 지우지 않는다. */
export function applyRecover(db: DatabaseSync, sessionId: string, check: LetterCheck & { state: "match" | "recover" }, meta: LetterSessionMeta): boolean {
  fillMissingLetterRows(db, sessionId, check.build.docs, check.build.turnSeqs, meta);
  const after = compareLetters(db, sessionId, sanitizeDocs(check.build.docs));
  return after.missing === 0 && after.conflicts === 0;
}
