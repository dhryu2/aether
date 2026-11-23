/**
 * 맡겨 두는 작업 대기열 — 서버 전체에 줄 하나, 한 번에 한 작업.
 *
 * 작업 하나는 "미리 만든 작업 복사본 세션 + 그 세션에 나중에 보낼 첫 글"이다. 차례가 오면 기존 push로 보낸다.
 * 다음 작업으로 넘어가는 기준은 중립 신호(주의 상태, 자동 재개 예약)뿐이다. 서버가 명령을 돌려 완료를 판정하지 않는다.
 * provider 이름·원본 모양은 모른다. (세션 안 메시지 대기열은 브라우저에만 있는 별개 기능이다.)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { reportError } from "../observability/report";
import type { PresenceSession, TaskQueueItem, TaskQueueResponse, TaskQueueRun, TaskQueueStopReason } from "../../shared/http";
import { AUTO_RESUME_TEXT_MAX } from "./autoResume";
import * as store from "./persistence";
import type { sessionManager } from "./SessionManager";

export const TASK_QUEUE_LIMIT_CHOICES = [1, 2, 4, 8, 12];
export const TASK_QUEUE_DEFAULT_LIMIT_HOURS = 4;
export const TASK_QUEUE_MAX_ITEMS = 10;
export const TASK_QUEUE_MAX_FAILS = 2;
export const TASK_QUEUE_START_WITHIN_MS = 48 * 3_600_000;

// ── 순수 부분 ──

export type Observation = "gone" | "limit_gave_up" | "limit_wait" | "busy" | "human_wait" | "failed" | "finished";

/** 세션 상태 한 칸을 중립 관찰값으로 줄인다. 위에서부터 처음 맞는 줄을 쓴다. */
export function observe(p: PresenceSession | undefined): Observation {
  if (!p || p.archivedAt) return "gone";
  const ar = p.autoResume;
  // 재시작으로 끊김 표시는 한도 포기가 아니다. 사람이 [이어 가기]를 눌러야 한다.
  if (ar?.restartCutAt) return "human_wait";
  if (ar?.gaveUp) return "limit_gave_up";
  if (ar?.at !== undefined) return "limit_wait";
  if (p.attention === "running" || p.attention === "background") return "busy";
  if (p.attention === "waiting") return p.attentionKind === "rate_limit" ? "limit_wait" : "human_wait";
  if (p.attention === "failed") return "failed";
  return "finished";
}

export type TaskQueueState = {
  run: TaskQueueRun;
  startAt?: number;
  deadlineAt?: number;
  limitHours: number;
  stopReason?: TaskQueueStopReason;
  items: TaskQueueItem[];
  /** 연속 실패 수. 응답에는 싣지 않는다. */
  failStreak: number;
};

export type Action =
  | { type: "none" }
  | { type: "deadline" }
  | { type: "begin" }
  | { type: "start" }
  | { type: "stop"; reason: TaskQueueStopReason }
  | { type: "end"; state: "done" | "failed"; reason?: TaskQueueItem["reason"]; stop?: TaskQueueStopReason };

/**
 * 상태와 관찰을 보고 다음 행동 하나를 정한다. seen은 도는 작업이 바쁨·기다림을 한 번이라도 보였는지다.
 * 멈춘 줄은 새 일을 시작하지 않고, 이미 돌던 작업의 끝만 정리한다.
 */
export function decide(q: TaskQueueState, obs: Observation, seen: boolean, now: number): Action {
  const cur = q.items.find((i) => i.state === "running");
  const ending = (): Action => {
    if (!cur) return { type: "none" };
    if (obs === "finished") return seen ? { type: "end", state: "done" } : { type: "none" };
    if (obs === "failed") return { type: "end", state: "failed" };
    if (obs === "gone") return { type: "end", state: "failed", reason: "gone" };
    if (obs === "limit_gave_up") return { type: "end", state: "failed", reason: "limit", stop: "limit" };
    return { type: "none" }; // busy·limit_wait·human_wait: 줄 전체가 기다린다
  };
  if (q.run === "stopped") return ending();
  if (q.deadlineAt !== undefined && now >= q.deadlineAt) return { type: "deadline" };
  if (q.run === "scheduled") return q.startAt !== undefined && now >= q.startAt ? { type: "begin" } : { type: "none" };
  if (cur) return ending();
  return q.items.some((i) => i.state === "waiting") ? { type: "start" } : { type: "stop", reason: "all_done" };
}

// ── 저장: 데이터 폴더의 파일 하나. 지시문을 잃지 않도록 임시 파일에 쓰고 이름을 바꾼다. ──

const queueFile = () => path.join(config.dataDir, "task-queue.json");

const emptyState = (): TaskQueueState => ({ run: "stopped", limitHours: TASK_QUEUE_DEFAULT_LIMIT_HOURS, items: [], failStreak: 0 });

/** 파일이 없거나 깨졌으면 빈 줄. 깨진 파일은 지우지 않고 옆에 보존한다(다음 저장이 덮어쓰기 때문). */
export function readTaskQueue(): TaskQueueState {
  let text: string;
  try {
    text = fs.readFileSync(queueFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "session", operation: "task_queue.load" });
    return emptyState();
  }
  try {
    const raw = JSON.parse(text) as Partial<TaskQueueState>;
    if (!raw || !Array.isArray(raw.items) || !["stopped", "scheduled", "running"].includes(raw.run as string)) throw new Error("task-queue.json 형식이 맞지 않다");
    return { ...emptyState(), ...raw, items: raw.items, failStreak: raw.failStreak ?? 0 } as TaskQueueState;
  } catch (e) {
    void reportError(e, { component: "session", operation: "task_queue.parse" });
    try { fs.copyFileSync(queueFile(), `${queueFile()}.broken`); } catch { /* 보존 실패는 넘어간다 */ }
    return emptyState();
  }
}

export function writeTaskQueue(q: TaskQueueState): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const f = queueFile();
  const tmp = `${f}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(q), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, f);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ── 실행기 ──

/** 실행기가 세션 쪽에 묻고 시키는 것의 전부. 시험은 가짜를 넣는다. */
export type TaskQueuePort = {
  /** 세션 상태 한 칸. 없는 세션이면 undefined. */
  snapshot(id: string): PresenceSession | undefined;
  isBusy(id: string): boolean;
  /** 입력이 아직 한 번도 없는가. */
  hasNoInput(id: string): boolean;
  isIsolated(id: string): boolean;
  isExternal(id: string): boolean;
  push(id: string, text: string): Promise<void>;
  /** 기존 [중지]와 같다. */
  interrupt(id: string): Promise<void>;
  cancelAutoResume(id: string): void;
  subscribe(fn: (p: PresenceSession) => void): () => void;
};

export type TaskQueueNotice = { type: "finished" } | { type: "stopped"; reason: Exclude<TaskQueueStopReason, "all_done" | "manual"> };

export type AddResult = { ok: true; item: TaskQueueItem } | { ok: false; code: "notFound" | "archived" | "external" | "notIsolated" | "hasInput" | "duplicate" | "full" | "textInvalid" };

export class TaskQueueRunner {
  private q: TaskQueueState;
  /** 도는 작업이 바쁨·기다림을 한 번이라도 봤는가. 지금 스냅숏은 짧은 턴을 놓칠 수 있어 구독에서 동기로 표시한다. */
  private seen = false;
  private chain: Promise<void> = Promise.resolve();
  private unsub: (() => void) | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly port: TaskQueuePort,
    private readonly notify: (n: TaskQueueNotice, sessionId: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.q = readTaskQueue();
  }

  /** restoreFromDisk 뒤에 부른다. 부팅 규칙을 적용하고 구독·타이머를 켠다. */
  boot(): void {
    const now = this.now();
    const cur = this.q.items.find((i) => i.state === "running");
    if (cur) {
      const plan = this.port.snapshot(cur.sessionId)?.autoResume;
      // 시각 있는 한도 예약이 남았으면 그대로 둔다. 한도가 풀리면 기존 자동 재개가 이어 간다.
      // seen은 false로 둔다. 예약이 지워진 뒤의 idle을 끝남으로 읽지 않고, 재개 턴의 바쁨을 다시 본 뒤에야 끝으로 인정한다.
      if (plan?.at !== undefined && !plan.restartCutAt) this.seen = false;
      else {
        this.endItem(cur, "cut", "restart"); // 글을 저절로 다시 보내지 않는다. 사람이 [이어 가기]를 누른다
        // 이어 갈 작업이 없으면 "모두 마쳤어요" 알림 없이 멈춘다. 끊긴 작업은 목록에 남는다.
        if (!this.q.items.some((i) => i.state === "waiting")) {
          this.q.run = "stopped";
          this.q.startAt = this.q.deadlineAt = undefined;
        }
      }
    }
    if (this.q.run === "scheduled" && this.q.deadlineAt !== undefined && now >= this.q.deadlineAt) {
      this.q.run = "stopped";
      this.q.stopReason = "missed";
      this.q.startAt = this.q.deadlineAt = undefined;
      this.notify({ type: "stopped", reason: "missed" }, this.q.items.at(-1)?.sessionId ?? "");
    }
    this.save();
    this.unsub = this.port.subscribe((p) => {
      if (this.disposed) return;
      const run = this.q.items.find((i) => i.state === "running");
      if (run?.sessionId === p.id) {
        const o = observe(p);
        // 한도 대기 중에는 seen을 끈다. 자동 재개 예약이 지워져 idle이 돼도 끝남이 아니고, 재개 턴의 바쁨을 다시 봐야 한다.
        // 자동 재개를 끈 경우 한도에 막힌 작업은 사람이 이어 가거나 시간 상한에 닿을 때까지 줄이 기다린다(이어지지 않은 작업을 끝남으로 기록하지 않는다).
        if (o === "limit_wait") this.seen = false;
        else if (o === "busy" || o === "human_wait") this.seen = true;
      }
      if (this.q.run !== "stopped" || run) void this.kick();
    });
    void this.kick();
  }

  /** 서버가 꺼질 때, 세션을 멈추기 전에 부른다. 이 뒤의 사건과 타이머는 무시한다. */
  dispose(): void {
    this.disposed = true;
    this.unsub?.();
    this.unsub = undefined;
    clearTimeout(this.startTimer);
    clearTimeout(this.deadlineTimer);
  }

  getState(): TaskQueueResponse {
    const { run, startAt, deadlineAt, limitHours, stopReason, items } = this.q;
    return { run, ...(startAt !== undefined ? { startAt } : {}), ...(deadlineAt !== undefined ? { deadlineAt } : {}), limitHours, limitChoices: TASK_QUEUE_LIMIT_CHOICES, ...(stopReason ? { stopReason } : {}), items, maxItems: TASK_QUEUE_MAX_ITEMS };
  }

  add(sessionId: string, rawText: string): AddResult {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text || text.length > AUTO_RESUME_TEXT_MAX) return { ok: false, code: "textInvalid" };
    const p = this.port.snapshot(sessionId);
    if (!p) return { ok: false, code: "notFound" };
    if (p.archivedAt) return { ok: false, code: "archived" };
    if (this.port.isExternal(sessionId)) return { ok: false, code: "external" };
    if (!this.port.isIsolated(sessionId)) return { ok: false, code: "notIsolated" };
    if (!this.port.hasNoInput(sessionId)) return { ok: false, code: "hasInput" };
    if (this.q.items.some((i) => i.sessionId === sessionId)) return { ok: false, code: "duplicate" };
    if (this.q.items.filter((i) => i.state === "waiting" || i.state === "running").length >= TASK_QUEUE_MAX_ITEMS) return { ok: false, code: "full" };
    const item: TaskQueueItem = { id: crypto.randomUUID(), sessionId, text, state: "waiting", addedAt: this.now() };
    this.q.items.push(item);
    this.save();
    return { ok: true, item };
  }

  remove(itemId: string): "ok" | "notFound" | "running" {
    const i = this.q.items.findIndex((x) => x.id === itemId);
    if (i < 0) return "notFound";
    if (this.q.items[i].state === "running") return "running";
    this.q.items.splice(i, 1);
    this.save();
    return "ok";
  }

  /** 시작 요청. 값 검증은 호출하는 쪽이 한다. */
  startRun(opts: { startAt?: number; limitHours: number }): "ok" | "already" | "empty" {
    if (this.q.run !== "stopped") return "already";
    if (!this.q.items.some((i) => i.state === "waiting")) return "empty";
    this.q.limitHours = opts.limitHours;
    this.q.failStreak = 0;
    this.q.stopReason = undefined;
    const base = opts.startAt ?? this.now();
    this.q.run = opts.startAt !== undefined ? "scheduled" : "running";
    this.q.startAt = opts.startAt;
    this.q.deadlineAt = base + opts.limitHours * 3_600_000;
    this.save();
    void this.kick();
    return "ok";
  }

  /** 멈추기 요청. 도는 작업은 끝까지 둔다(interrupt하지 않는다). */
  stop(): void {
    if (this.q.run === "stopped") return;
    this.q.run = "stopped";
    this.q.stopReason = "manual";
    this.q.startAt = this.q.deadlineAt = undefined;
    this.save();
    this.rearm();
  }

  /** 한 번에 하나씩만 돈다(약속 사슬). */
  kick(): Promise<void> {
    this.chain = this.chain.then(() => this.step()).catch((e) => void reportError(e, { component: "session", operation: "task_queue.step" }));
    return this.chain;
  }

  private save(): boolean {
    try {
      writeTaskQueue(this.q);
      return true;
    } catch (e) {
      void reportError(e, { component: "session", operation: "task_queue.save" });
      return false;
    }
  }

  private rearm() {
    clearTimeout(this.startTimer);
    clearTimeout(this.deadlineTimer);
    const arm = (at: number) => {
      const t = setTimeout(() => void this.kick(), Math.min(Math.max(at - this.now(), 0), 2 ** 31 - 1));
      t.unref();
      return t;
    };
    if (this.disposed) return;
    if (this.q.run === "scheduled" && this.q.startAt !== undefined) this.startTimer = arm(this.q.startAt);
    if (this.q.run !== "stopped" && this.q.deadlineAt !== undefined) this.deadlineTimer = arm(this.q.deadlineAt);
  }

  private lastSessionId = () => this.q.items.at(-1)?.sessionId ?? "";

  private endItem(item: TaskQueueItem, state: "done" | "failed" | "cut", reason?: TaskQueueItem["reason"]) {
    item.state = state;
    item.endedAt = this.now();
    if (reason) item.reason = reason;
    if (state === "done") this.q.failStreak = 0;
    else if (state === "failed") this.q.failStreak += 1;
  }

  private stopRun(reason: TaskQueueStopReason) {
    this.q.run = "stopped";
    this.q.stopReason = reason;
    this.q.startAt = this.q.deadlineAt = undefined;
  }

  private async step(): Promise<void> {
    for (let guard = 0; guard < 50 && !this.disposed; guard++) {
      const cur = this.q.items.find((i) => i.state === "running");
      const obs = cur ? observe(this.port.snapshot(cur.sessionId)) : "finished";
      if (obs === "limit_wait") this.seen = false;
      const a = decide(this.q, obs, this.seen, this.now());
      if (a.type === "none") break;
      const wasRunning = this.q.run !== "stopped";
      if (a.type === "begin") {
        this.q.run = "running";
        this.save();
      } else if (a.type === "stop") {
        this.stopRun(a.reason);
        this.save();
        this.notify({ type: "finished" }, this.lastSessionId());
      } else if (a.type === "end" && cur) {
        this.endItem(cur, a.state, a.reason);
        // 줄이 멈춘 뒤에 끝난 작업(멈추기 요청 뒤)은 기록만 한다.
        const stopReason = !wasRunning ? undefined : a.stop ?? (this.q.failStreak >= TASK_QUEUE_MAX_FAILS ? "failures" : undefined);
        if (stopReason) this.stopRun(stopReason);
        this.save();
        if (stopReason === "limit" || stopReason === "failures") this.notify({ type: "stopped", reason: stopReason }, cur.sessionId);
      } else if (a.type === "deadline") {
        // 먼저 저장한다. interrupt로 끝난 턴을 보고 다음 작업을 시작하지 않게.
        if (cur) this.endItem(cur, "cut", "deadline");
        this.stopRun("deadline");
        this.save();
        if (cur) {
          try {
            await this.port.interrupt(cur.sessionId);
          } catch (e) {
            void reportError(e, { component: "session", operation: "task_queue.interrupt", session_id: cur.sessionId });
          }
          this.port.cancelAutoResume(cur.sessionId);
        }
        this.notify({ type: "stopped", reason: "deadline" }, cur?.sessionId ?? this.lastSessionId());
      } else if (a.type === "start") {
        const next = this.q.items.find((i) => i.state === "waiting");
        if (!next) break;
        const p = this.port.snapshot(next.sessionId);
        if (!p || p.archivedAt) {
          this.endItem(next, "failed", "gone");
        } else if (this.port.isBusy(next.sessionId)) {
          break; // 바쁘지 않을 때 보낸다. 세션 상태가 바뀌면 다시 깨어난다
        } else if (!this.port.hasNoInput(next.sessionId)) {
          // 넣은 뒤 다른 기기나 API로 사람이 먼저 글을 보냈다. 대기열 글이 둘째 메시지로 나가지 않게 한다.
          this.endItem(next, "failed", "send_failed");
        } else {
          next.state = "running";
          next.startedAt = this.now();
          this.seen = false;
          // 보내다 죽어도 두 번 가지 않게 먼저 저장한다. 저장하지 못하면 보내지 않고 줄을 멈춘다.
          if (!this.save()) {
            next.state = "waiting";
            delete next.startedAt;
            this.stopRun("failures");
            this.notify({ type: "stopped", reason: "failures" }, next.sessionId);
            break;
          }
          try {
            await this.port.push(next.sessionId, next.text);
          } catch (e) {
            void reportError(e, { component: "session", operation: "task_queue.push", session_id: next.sessionId });
            this.endItem(next, "failed", "send_failed");
          }
        }
        if (next.state === "failed" && this.q.failStreak >= TASK_QUEUE_MAX_FAILS) {
          this.stopRun("failures");
          this.notify({ type: "stopped", reason: "failures" }, next.sessionId);
        }
        this.save();
      }
    }
    this.rearm();
  }
}

/**
 * 실제 세션 창구. SessionManager에 붙이는 얇은 어댑터다.
 * shortcut: 그 세션 화면의 실시간 연결(SSE)이 열려 있기만 해도 실패 표시를 세우는 자리에서 "봤음"이 함께 찍혀 그 턴이 곧바로 idle이 되고, 실행기는 그 실패를 done으로 읽는다. 근본 해결은 턴 종료 사건의 실패 여부를 중립 필드로 받는 것이다. 실패한 작업이 done으로 기록되는 일이 실제로 보이면 고친다.
 */
export function sessionManagerPort(sm: typeof sessionManager): TaskQueuePort {
  return {
    snapshot: (id) => sm.presenceOf(id),
    isBusy: (id) => sm.isBusy(id),
    hasNoInput: (id) => {
      try {
        return store.lastUserInputTs(id) === undefined;
      } catch {
        return false; // 읽지 못하면 넣지 않는다
      }
    },
    isIsolated: (id) => !!sm.workspaceTarget(id),
    isExternal: (id) => sm.isExternal(id),
    // 자동 재개의 fireAutoResume과 같은 길. 사람이 쓴 글이므로 sentBy는 붙이지 않는다.
    push: async (id, text) => {
      await sm.settledSleep(id);
      await sm.getOrResume(id).push(text);
    },
    interrupt: async (id) => {
      await sm.get(id)?.interrupt();
    },
    cancelAutoResume: (id) => sm.cancelAutoResume(id),
    subscribe: (fn) => sm.subscribePresence(fn),
  };
}
