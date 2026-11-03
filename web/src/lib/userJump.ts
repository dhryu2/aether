import { agentEventsOf } from "./agentEvents";
import type { AgentEvent } from "./types";

/** 사용자 말 순번만 모아, 위·아래로 이웃을 고른다. 범위 밖이면 null. */
export function stepUserSeq(seqs: readonly number[], cursor: number | null, dir: -1 | 1): number | null {
  if (seqs.length === 0) return null;
  if (cursor == null) return dir < 0 ? seqs[seqs.length - 1] : seqs[0];
  const index = seqs.indexOf(cursor);
  if (index < 0) {
    if (dir < 0) {
      for (let i = seqs.length - 1; i >= 0; i--) if (seqs[i] < cursor) return seqs[i];
      return null;
    }
    return seqs.find((seq) => seq > cursor) ?? null;
  }
  const next = index + dir;
  if (next < 0 || next >= seqs.length) return null;
  return seqs[next];
}

export function userSeqsOf(items: readonly { seq: number; kind: string; events?: readonly { type?: string }[] }[]): number[] {
  const seqs: number[] = [];
  for (const item of items) {
    if (item.seq < 0) continue;
    if (item.kind === "user_msg") seqs.push(item.seq);
    else if (agentEventsOf(item as { events?: AgentEvent[] })?.some((event) => event.type === "user_text")) seqs.push(item.seq);
  }
  return seqs;
}
