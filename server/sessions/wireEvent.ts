/**
 * SSE·GET /events 송출 직전 클라이언트 봉투 (Phase 9b · D4).
 *
 * 디스크에 적힌 원본(`msg`)은 codec 안에서만 정규화한다. 사람이 붙는 공통 문(REST·SSE)으로는
 * 정규화 `events`와 Aether 제어 사건만 나간다. 한 raw seq의 파생 N개는 하나의 봉투(id=seq)에 담긴다.
 *
 * 모델이 만든 사건의 kind는 클라이언트에서 `"agent"`다. 디스크의 `"sdk"`/`"codex"` 태그는 밖으로 나가지 않는다.
 */
import type { AetherEvent } from "../types";
import type { ProviderEventCodec } from "./codec/types";
import type { AetherEvent as ClientEvent } from "../../shared/http";

/** Aether가 소유하는 제어 사건 — 필드를 그대로 보내고, 정규화 파생이 있으면 events만 덧붙인다. */
const CONTROL_KINDS = new Set<string>([
  "user_msg",
  "permission_request",
  "permission_resolved",
  "question_request",
  "question_resolved",
  "plan_request",
  "plan_resolved",
  "status",
  "command_operation",
  "notice",
  "ctx",
  "questionnaire",
]);

/** 공통 문으로 나가는 봉투. 모양은 shared/http.ts의 클라이언트 봉투와 같다. provider 원본 `msg`는 없다. */
export type WireEvent = ClientEvent;

/**
 * 영속 원본 → 클라이언트 봉투.
 * 제어 사건은 필드를 유지한다. 그 밖의 원본 사건은 seq/ts/`kind:"agent"`와 정규화 events만 남긴다.
 * 파생이 없으면 빈 배열을 싣지 않는다.
 */
export function toWireEvent(ev: AetherEvent, codec: ProviderEventCodec): WireEvent {
  const events = codec.normalize(ev);
  const rest = { ...(ev as AetherEvent & { msg?: unknown }) } as Record<string, unknown>;
  delete rest.msg;
  const body = CONTROL_KINDS.has(ev.kind) ? rest : { seq: ev.seq, ts: ev.ts, kind: "agent" };
  return (events.length ? { ...body, events } : body) as WireEvent;
}
