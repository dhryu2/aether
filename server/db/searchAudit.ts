/**
 * 검색 감사 표. HTTP 없음.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database } from "./sqlite";

/** 시험용 — recordSearchAudit throw 주입. */
let injectFail: (() => boolean) | null = null;

export function __setSearchAuditFailure(fn: (() => boolean) | null): void {
  injectFail = fn;
}

export type SearchAuditFilters = {
  fromTs?: number;
  toTs?: number;
  sessionId?: string;
  chatOnly?: boolean;
  sort?: string;
  role?: string;
};

export type SearchAuditHitKey = {
  sessionId: string;
  seq: number;
  part: number;
};

export async function recordSearchAudit(input: {
  actorId: string;
  query: string;
  filters?: SearchAuditFilters;
  hits: SearchAuditHitKey[];
}): Promise<void> {
  if (injectFail?.()) throw new Error("searchAudit injectFail");
  const hitKeys = input.hits
    .slice(0, 20)
    .map((h) => `${h.sessionId}:${h.seq}:${h.part}`)
    .join(",");
  const filters = JSON.stringify(input.filters ?? {});
  database()
    .prepare(
      `INSERT INTO search_audit (id, at, actor_id, query, filters, hit_count, hit_keys)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), Date.now(), input.actorId, input.query, filters, input.hits.length, hitKeys);
}

/** 지운 세션이 감사 표 hit_keys에 남지 않게 그 세션의 항목을 뺀다. 호출자가 연 트랜잭션 안에서 돈다. */
export function removeSessionFromAudit(db: DatabaseSync, sessionId: string): void {
  const rows = db.prepare("SELECT id, hit_keys FROM search_audit WHERE instr(hit_keys, ?) > 0").all(`${sessionId}:`) as { id: string; hit_keys: string }[];
  const update = db.prepare("UPDATE search_audit SET hit_keys = ? WHERE id = ?");
  for (const row of rows) {
    const kept = row.hit_keys.split(",").filter((key) => !key.startsWith(`${sessionId}:`));
    update.run(kept.join(","), row.id);
  }
}
