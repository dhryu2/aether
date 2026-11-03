import { reportError } from "../observability/report";
/**
 * 세션 하나의 사건 순번을 맡는다.
 * 순번을 매기고, 먼저 저장하고, 그다음 순번 순서대로 공개한다.
 * 저장은 동기다. 구독자 안에서 다시 쓰면 공개가 뒤집히지 않게 공개만 줄을 세운다.
 * 일기 전환용 막기 문은 직렬화에 쓰지 않는다.
 */
import type { AetherEvent, AetherEventBody } from "../types";
import * as store from "./persistence";

export type Published = {
  event: AetherEvent;
  persisted: AetherEvent | null;
};

type LiveListener = (published: Published) => void;

type PendingWrite = {
  seq: number;
  event: AetherEvent;
  persisted: AetherEvent | null;
  durable: boolean;
  /** 저장에 실패했다. 이어 쓴 순번은 빈 번호로 남는다. */
  error?: unknown;
  resolve?: (ev: AetherEvent) => void;
  reject?: (err: unknown) => void;
};

const logs = new Map<string, SessionEventLog>();
const closedIds = new Set<string>();

export function eventLogFor(id: string): SessionEventLog {
  const found = logs.get(id);
  if (found) return found;
  if (closedIds.has(id)) throw new Error("세션 사건 기록기를 닫았다");
  if (!store.diaryAcceptsInput(id)) throw new Error("일기 전환 중이거나 데이터베이스를 쓸 수 없다");
  const created = new SessionEventLog(id);
  logs.set(id, created);
  return created;
}

/** 세션을 지울 때 기록기를 닫는다. 늦은 저장이 기록기를 다시 만들지 않는다. */
export function closeEventLog(id: string): void {
  closedIds.add(id);
  const found = logs.get(id);
  logs.delete(id);
  found?.close();
  store.retireSessionRecord(id);
}

/** 같은 id로 세션을 다시 만들 때. 늦은 저장은 이미 닫힌 기록기만 본다. */
export function adoptEventLog(id: string): SessionEventLog {
  const wasClosed = closedIds.delete(id);
  try {
    return eventLogFor(id);
  } catch (err) {
    if (wasClosed) closedIds.add(id);
    throw err;
  }
}

export function __resetEventLogsForTest(): void {
  for (const log of logs.values()) log.abandon();
  logs.clear();
  closedIds.clear();
}

/** 프로세스를 다시 띄운 것처럼 맵에서만 뺀다. 일기를 닫지 않는다. */
export function __dropEventLogForTest(id: string): void {
  const found = logs.get(id);
  logs.delete(id);
  found?.abandon();
}

export class SessionEventLog {
  readonly sessionId: string;
  private assigned: number;
  private nextPublish: number;
  private readonly generation: store.RecordGeneration;
  private readonly queue: PendingWrite[] = [];
  private pumping = false;
  // 같은 세션의 연속 저장 실패는 첫 건만 남기고 저장 성공 때 다시 연다.
  private appendFailed = false;
  private closed = false;
  private listener: LiveListener | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.generation = store.openRecordGeneration(sessionId);
    const last = store.lastSeqFromDisk(sessionId);
    this.assigned = last;
    this.nextPublish = last + 1;
  }

  /** 배정한 마지막 순번. 아직 공개되지 않은 번호와 빈 번호도 포함한다. */
  lastAssigned(): number {
    return this.assigned;
  }

  /** 공개가 끝난 마지막 순번. 구독자 안에서 쓴 아직 공개 전 번호는 포함하지 않는다. 빈 번호가 확정되면 그 번호까지 포함한다. */
  lastPublished(): number {
    return this.nextPublish - 1;
  }

  /** 살아 있는 세션 하나. 새 세션이 붙으면 이전 구독을 대체한다. */
  bindLive(fn: LiveListener): () => void {
    this.listener = fn;
    return () => {
      if (this.listener === fn) this.listener = null;
    };
  }

  /**
   * 순번을 매기고 먼저 저장한 뒤 공개한다.
   * 저장이 실패하면 수집하고 그 사건은 라이브로만 공개한다(저장본 없음). 순번은 빈 번호로 남는다.
   */
  write(body: AetherEventBody, prepare: (ev: AetherEvent) => AetherEvent | null): AetherEvent | null {
    if (this.closed) return null;
    this.assertOpen();
    const seq = this.assigned + 1;
    const event = stamp(body, seq);
    let persisted = prepare(event);
    this.assigned = seq;
    if (persisted) {
      try {
        store.insertEventRow(this.sessionId, persisted, this.generation);
        this.appendFailed = false;
      } catch (err) {
        persisted = null;
        store.noteHighSeq(this.sessionId, seq, this.generation);
        this.reportAppendFailure(err, seq);
        const msg = err instanceof Error ? err.message : "unknown";
        console.error("[aether] appendEvent 실패(이벤트 영속 건너뜀):", msg.includes("://") || msg.includes("@") ? "연결 실패" : msg);
      }
    }
    this.queue.push({ seq, event, persisted, durable: false });
    this.drain();
    return event;
  }

  /**
   * 저장이 끝나고 공개된 뒤에 끝난다.
   * 저장이 실패하면 거절하고 그 순번은 빈 번호로 남는다.
   */
  writeDurable(body: AetherEventBody, prepare: (ev: AetherEvent) => AetherEvent): Promise<AetherEvent> {
    if (this.closed) return Promise.reject(new Error("세션 사건 기록기를 닫았다"));
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    const seq = this.assigned + 1;
    const event = stamp(body, seq);
    let persisted: AetherEvent;
    try {
      persisted = prepare(event);
      if (!persisted) throw new Error("user_msg persist filtered");
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.assigned = seq;
      const item: PendingWrite = { seq, event, persisted, durable: true, resolve, reject };
      try {
        store.insertEventRow(this.sessionId, persisted, this.generation);
        this.appendFailed = false;
      } catch (err) {
        item.error = err;
      }
      this.queue.push(item);
      this.drain();
    });
  }

  /** 배정한 마지막 순번을 상한으로 남긴 뒤 세대를 닫는다. 아직 공개되지 않은 번호도 포함한다. */
  close(): void {
    const high = this.assigned;
    this.abandon();
    store.noteHighSeq(this.sessionId, high, this.generation);
    store.closeRecordGeneration(this.sessionId, this.generation);
  }

  /** 맵에서 뺄 때. 일기 읽기 목록은 건드리지 않는다. */
  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    this.listener = null;
    this.failQueued();
  }

  private assertOpen(): void {
    if (!store.diaryAcceptsInput(this.sessionId)) throw new Error("일기 전환 중이거나 데이터베이스를 쓸 수 없다");
  }

  private advance(seq: number): void {
    if (this.nextPublish < seq + 1) this.nextPublish = seq + 1;
  }

  /** 저장이 끝난 순번을 들어온 순서대로 공개한다. 구독자 안에서 다시 쓰면 줄 끝에 붙는다. */
  private drain(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        this.advance(item.seq);
        if (item.error !== undefined) {
          if (!this.closed) store.noteHighSeq(this.sessionId, item.seq, this.generation);
          this.settleReject(item, item.error);
          continue;
        }
        this.emit(item.event, item.persisted);
        this.settleResolve(item);
      }
    } finally {
      this.pumping = false;
      if (this.closed) this.failQueued();
    }
  }

  private reportAppendFailure(error: unknown, seq: number): void {
    if (this.appendFailed) return;
    this.appendFailed = true;
    void reportError(error, { component: "session", operation: "session.event_log.append", session_id: this.sessionId, session_seq: seq });
  }

  private emit(event: AetherEvent, persisted: AetherEvent | null): void {
    if (this.closed) return;
    const listener = this.listener;
    if (!listener) return;
    try {
      listener({ event, persisted });
    } catch (err) {
      void reportError(err, { component: "session", operation: "session.event_log.notify", session_id: this.sessionId, session_seq: event.seq }); console.error("[aether] 세션 사건 기록 구독 실패:", err);
    }
  }

  private settleResolve(item: PendingWrite): void {
    const resolve = item.resolve;
    item.resolve = undefined;
    item.reject = undefined;
    resolve?.(item.event);
  }

  private settleReject(item: PendingWrite, err: unknown): void {
    const reject = item.reject;
    item.resolve = undefined;
    item.reject = undefined;
    reject?.(err instanceof Error ? err : new Error("세션 사건 기록 실패"));
  }

  private failQueued(): void {
    const pending = this.queue.splice(0);
    for (const item of pending) this.settleReject(item, new Error("세션 사건 기록기를 닫았다"));
  }
}

function stamp(body: AetherEventBody, seq: number): AetherEvent {
  return { seq, ts: Date.now(), ...body } as AetherEvent;
}
