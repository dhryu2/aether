import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ErrorEvent, ErrorCollectionStatus } from '../../shared/errors';
import type { ErrorSink, ErrorWriteResult } from './database';
import { makeErrorEvent, type ErrorDetails, isExpectedError } from './event';
const DAY = 86_400_000;
const liveLeases = new Set<string>();
const LEASE_MS = 60_000;
class LockUnavailableError extends Error {}
const liveFiles = new Set<string>();
const emptyLoss = () => ({ count: 0, from: null as string | null, to: null as string | null, reason: null as string | null });
interface Cursor { offset: number; failed: number[]; closed: number | null; pid: number; }
interface State { version: 1; files: Record<string, Cursor>; lost: ReturnType<typeof emptyLoss>; undeliverable: number; lease?: { pid: number; token: string; acquiredAt?: number; files: string[] }; deleting?: string[]; lastSuccess?: string | null; }
interface Row { file: string; start: number; end: number; event: ErrorEvent | null; fresh: boolean }
export interface JournalOptions {
  directory: string; sink?: ErrorSink; now?: () => number; fileBytes?: number; maxBytes?: number;
  /** commit 직후 종료를 재현하는 시험 주입점. */
  afterCommit?: () => void;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dateKorea = (n: number) => new Date(n + 9 * 3600_000).toISOString().slice(0, 10);
const filePattern = /^events-\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/;
/** SQLite는 프로세스 간 파일 잠금만 담당한다. 오류 정본은 fsync한 JSONL이다. */
export class ErrorJournal {
  readonly instance = randomUUID();
  private lock?: DatabaseSync;
  private active?: string;
  private now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private maintenance?: ReturnType<typeof setInterval>;
  private stopped = false;
  private running?: Promise<boolean>;
  private attempts = 0;
  private outage = false;
  private lastSuccess: string | null = null;
  private fileFailures = 0;
  private directLost = emptyLoss();
  private initializing?: Promise<void>;
  // 디스크에서 읽은 직후의 상태 직렬화. 바뀐 게 없으면 저장과 디렉터리 sync를 건너뛴다(null=파일 없음·손상).
  private loaded: string | null = null;
  private records = new Set<Promise<unknown>>();
  constructor(private options: JournalOptions) { this.now = options.now ?? Date.now; }
  private async init(): Promise<void> {
    this.initializing ??= (async () => {
      await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      this.lock = new DatabaseSync(path.join(this.options.directory, 'coordination.sqlite'));
      this.lock.exec('PRAGMA busy_timeout=0');
    })().catch(e => { this.initializing = undefined; throw e; });
    await this.initializing;
  }
  private async syncDirectory() {
    if (process.platform === 'win32') return; // 윈도우는 폴더 핸들의 fsync를 EPERM으로 거절한다. 파일 이름 변경의 내구성은 NTFS 로그가 맡는다.
    const fd = await fs.open(this.options.directory, 'r');
    try { await fd.sync(); } finally { await fd.close(); }
  }
  private async state(): Promise<State> {
    let state: State;
    try {
      const { checksum, ...payload } = JSON.parse(await fs.readFile(path.join(this.options.directory, 'delivery-state.json'), 'utf8'));
      if (checksum !== createHash('sha256').update(JSON.stringify(payload)).digest('hex')) throw new Error('state checksum mismatch');
      state = payload as State;
      this.loaded = JSON.stringify(payload);
      if (state.version !== 1 || !state.files || !state.lost || !Number.isSafeInteger(state.lost.count)) throw new Error('invalid state');
      state.undeliverable ??= 0;
      if (!Number.isSafeInteger(state.undeliverable) || state.undeliverable < 0) throw new Error('invalid undeliverable count');
      for (const [name, c] of Object.entries(state.files)) {
        if (!filePattern.test(name) || !Number.isSafeInteger(c.offset) || c.offset < 0 || !Array.isArray(c.failed) ||
            c.failed.some(n => !Number.isSafeInteger(n) || n < 0) || !Number.isInteger(c.pid)) throw new Error('invalid cursor');
      }
    } catch (e) {
      this.loaded = null;
      state = { version: 1, files: {}, lost: emptyLoss(), undeliverable: 0 };
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write('[aether errors] 전달 위치 손상: 처음부터 재전송합니다.\n');
    }
    if (state.lease && (!alive(state.lease.pid) ||
        (state.lease.pid === process.pid && !liveLeases.has(state.lease.token)) ||
        this.now() - (state.lease.acquiredAt ?? 0) >= LEASE_MS)) {
      // 종료된 프로세스의 재전송은 정상 복구다. 살아 있는 소유자의 정지만 장애로 알린다.
      if (alive(state.lease.pid)) { this.outage = true; this.attempts++; }
      delete state.lease;
    }
    for (const file of state.deleting ?? []) {
      if (!filePattern.test(file)) continue;
      await fs.unlink(path.join(this.options.directory, file)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      delete state.files[file];
    }
    state.deleting = [];
    const names = (await fs.readdir(this.options.directory)).filter(n => filePattern.test(n));
    for (const name of names) {
      const stat = await fs.stat(path.join(this.options.directory, name));
      const owner = Number(name.split('-')[4]) || 0;
      const ownsFile = (pid: number) => pid === process.pid ? liveFiles.has(path.join(this.options.directory, name)) : pid > 0 && alive(pid);
      const c = state.files[name] ??= { offset: 0, failed: [], closed: ownsFile(owner) ? null : this.now(), pid: owner };
      // 비정상 종료의 정확한 닫힘 시각은 모른다. 복구 시각부터 보존해 조기 삭제를 피한다.
      if (c.closed === null && !ownsFile(c.pid)) c.closed = this.now();
      if (c.offset > stat.size) { c.offset = 0; c.failed = []; }
    }
    for (const name of Object.keys(state.files)) if (!names.includes(name)) delete state.files[name];
    return state;
  }
  private async save(s: State) {
    const temp = path.join(this.options.directory, 'delivery-state.tmp');
    const fd = await fs.open(temp, 'w', 0o600);
    try { await fd.writeFile(JSON.stringify({ ...s, checksum: createHash('sha256').update(JSON.stringify(s)).digest('hex') })); await fd.sync(); } finally { await fd.close(); }
    await fs.rename(temp, path.join(this.options.directory, 'delivery-state.json'));
    await this.syncDirectory();
  }
  private async exclusive<T>(fn: (s: State) => Promise<T>): Promise<T> {
    await this.init();
    const until = Date.now() + 5000;
    while (true) {
      try { this.lock!.exec('BEGIN IMMEDIATE'); break; }
      catch (e) { if (Date.now() > until) throw new LockUnavailableError('오류 파일 잠금 대기 시간 초과', { cause: e }); await new Promise(r => setTimeout(r, 10)); }
    }
    try { const s = await this.state(); const result = await fn(s); if (this.loaded === null || JSON.stringify(s) !== this.loaded) await this.save(s); return result; }
    finally { this.lock!.exec('ROLLBACK'); }
  }
  record(error: unknown, details: ErrorDetails): Promise<{ id: string; durable: boolean; recorded?: boolean }> {
    if (isExpectedError(error)) return Promise.resolve({ id: '', durable: false });
    let work: Promise<{ id: string; durable: boolean; recorded?: boolean }>;
    try { work = this.append(makeErrorEvent(error, details, this.instance)); }
    catch {
      this.fileFailures++;
      process.stderr.write('[aether errors] 오류 직렬화 실패\n');
      return Promise.resolve({ id: '', durable: false });
    }
    this.records.add(work);
    void work.finally(() => this.records.delete(work));
    return work;
  }
  private loss(s: State, count: number, from: string | null, to: string | null, reason: string) {
    if (!count) return;
    s.lost.count += count;
    s.lost.from = s.lost.from && from ? (s.lost.from < from ? s.lost.from : from) : s.lost.from ?? from;
    s.lost.to = s.lost.to && to ? (s.lost.to > to ? s.lost.to : to) : s.lost.to ?? to;
    s.lost.reason = reason;
    process.stderr.write(`[aether errors] 미전송 오류 ${count}건 유실 (${reason}, ${from} ~ ${to})\n`);
  }
  private rows(file: string, data: Buffer): Row[] {
    const rows: Row[] = [];
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline + 1;
      let event: ErrorEvent | null = null;
      try {
        if (newline < 0) throw new Error('incomplete line');
        const value = JSON.parse(data.subarray(start, newline).toString('utf8'));
        if (typeof value.id !== 'string' || typeof value.message !== 'string' || typeof value.component !== 'string' || !value.component || typeof value.operation !== 'string' || !value.operation) throw new Error('invalid event');
        event = value;
      } catch { /* 손상 행은 전달 시 별도로 집계하고 재시도하지 않는다. */ }
      rows.push({ file, start, end, event, fresh: true }); start = end;
    }
    return rows;
  }
  private async read(file: string) { return this.rows(file, await fs.readFile(path.join(this.options.directory, file))); }
  private async append(event: ErrorEvent): Promise<{ id: string; durable: boolean; recorded?: boolean }> {
    let failedFile: string | undefined;
    try {
      const line = Buffer.from(JSON.stringify(event) + '\n');
      if (line.length > 1024 * 1024) throw new Error('error event exceeds 1 MiB');
      await this.exclusive(async s => {
        if (this.stopped) throw new Error('error journal closed');
        const day = dateKorea(this.now());
        if (this.active) {
          failedFile = this.active;
          const size = (await fs.stat(path.join(this.options.directory, this.active))).size;
          failedFile = undefined;
          if (!this.active.startsWith(`events-${day}-`) || size + line.length > (this.options.fileBytes ?? 20 * 1024 * 1024)) {
            s.files[this.active].closed = this.now(); liveFiles.delete(path.join(this.options.directory, this.active)); this.active = undefined;
          }
        }
        await this.cleanLocked(s, line.length);
        if (!this.active) {
          const file = `events-${day}-${process.pid}-${randomUUID()}.jsonl`;
          const fd = await fs.open(path.join(this.options.directory, file), 'wx', 0o600);
          await fd.close(); await this.syncDirectory();
          liveFiles.add(path.join(this.options.directory, file));
          s.files[file] = { offset: 0, failed: [], closed: null, pid: process.pid };
          this.active = file;
        }
        failedFile = this.active;
        const fd = await fs.open(path.join(this.options.directory, this.active), 'a');
        try { await fd.writeFile(line); await fd.sync(); } finally { await fd.close(); }
        failedFile = undefined;
      });
      return { id: event.id, durable: true, recorded: true };
    } catch (e) {
      if (!(e instanceof LockUnavailableError)) this.fileFailures++;
      // 부분 쓰기 뒤 같은 파일에 붙이면 다음 정상 행까지 손상된다. 이후에는 새 파일만 연다.
      const file = failedFile;
      if (file && this.active === file) this.active = undefined;
      if (file) liveFiles.delete(path.join(this.options.directory, file));
      if (file) await this.exclusive(async s => { if (s.files[file]) s.files[file].closed = this.now(); }).catch(() => {});
      process.stderr.write(`[aether errors] 파일 기록 실패: ${String(e)}\n`);
      let recorded = false;
      try {
        if (!this.options.sink || !(await this.options.sink.write([event])).has(event.id)) throw new Error('direct delivery rejected');
        recorded = true;
      }
      catch (dbError) { this.directLost.count++; this.directLost.from ??= event.occurred_at; this.directLost.to = event.occurred_at; this.directLost.reason = "file-and-database"; process.stderr.write(`[aether errors] DB 직접 기록도 실패: ${String(dbError)}\n`); }
      return { id: event.id, durable: false, recorded };
    }
  }
  private async cleanLocked(s: State, reserve = 0) {
    let total = 0;
    for (const name of await fs.readdir(this.options.directory)) total += (await fs.stat(path.join(this.options.directory, name))).size;
    const max = this.options.maxBytes ?? 1024 ** 3;
    // 상태 파일의 원자 교체 중 생기는 임시 사본과 다음 커서 증가분도 용량 안에 둔다.
    const overhead = Buffer.byteLength(JSON.stringify(s)) + 2048;
    total += overhead;
    const candidates: {name: string; size: number; pending: number; from: string | null; to: string | null; closed: number}[] = [];
    for (const [name, c] of Object.entries(s.files)) {
      if (c.closed === null || s.lease?.files.includes(name)) continue;
      if (this.now() - c.closed < 14 * DAY && total + reserve <= max) continue;
      const pending = (await this.read(name)).filter(r => r.start >= c.offset || c.failed.includes(r.start));
      const dates = pending.map(r => r.event?.occurred_at ?? new Date(c.closed!).toISOString()).sort();
      candidates.push({ name, size: (await fs.stat(path.join(this.options.directory, name))).size, pending: pending.length, from: dates[0] ?? null, to: dates.at(-1) ?? null, closed: c.closed });
    }
    candidates.sort((a, b) => Number(a.pending > 0) - Number(b.pending > 0) || a.closed - b.closed);
    for (const f of candidates) {
      const expired = this.now() - f.closed >= (f.pending ? 30 : 14) * DAY;
      if (!expired && total + reserve <= max) continue;
      this.loss(s, f.pending, f.from, f.to, expired ? 'retention' : 'capacity');
      // 유실 집계를 먼저 영속한다. 삭제 직전 종료 시 과대 계수 가능성은 상태 문서에 명시한다.
      s.deleting = [...(s.deleting ?? []), f.name];
      await this.save(s);
      await fs.unlink(path.join(this.options.directory, f.name));
      delete s.files[f.name]; s.deleting = s.deleting.filter(n => n !== f.name); total -= f.size;
    }
    if (total + reserve > max) throw new Error('error storage capacity exhausted (active/in-flight files protected)');
  }
  async cleanup() { await this.exclusive(s => this.cleanLocked(s)); await this.options.sink?.prune(); }
  async deliver(): Promise<boolean> {
    if (!this.options.sink || this.stopped) return false;
    if (this.running) return this.running;
    const token = randomUUID();
    liveLeases.add(token);
    this.running = this.deliverOnce(token).catch(e => { this.outage = true; this.attempts++; throw e; }).finally(() => { liveLeases.delete(token); this.running = undefined; });
    return this.running;
  }
  private async deliverOnce(token: string): Promise<boolean> {
    const rows = await this.exclusive(async s => {
      if (s.lease) return [];
      const fresh: Row[] = [], failed: Row[] = [];
      for (const [file, c] of Object.entries(s.files).sort()) {
        const size = (await fs.stat(path.join(this.options.directory, file))).size;
        if (c.offset >= size && !c.failed.length) continue;
        const failures = new Set(c.failed);
        for (const row of await this.read(file)) {
          if (row.start >= c.offset && fresh.length < 100) fresh.push(row);
          else if (failures.has(row.start) && failed.length < 100) failed.push({ ...row, fresh: false });
        }
        if (fresh.length >= 100 && failed.length >= 20) break;
      }
      const selected = [...fresh.slice(0, failed.length ? 80 : 100), ...failed.slice(0, fresh.length ? 20 : 100)].slice(0, 100);
      if (selected.length) s.lease = { pid: process.pid, token, acquiredAt: this.now(), files: [...new Set(selected.map(r => r.file))] };
      return selected;
    });
    if (!rows.length) return false;
    try {
      const events = rows.flatMap(r => r.event ? [r.event] : []);
      let saved: ErrorWriteResult = new Set<string>();
      let writeFailed = false, failure: unknown;
      if (events.length) {
        try { saved = await this.options.sink!.write(events); }
        catch (e) { writeFailed = true; failure = e; }
        if (!writeFailed) this.options.afterCommit?.();
      }
      await this.exclusive(async s => {
        if (s.lease?.token !== token) throw new Error('delivery lease changed');
        for (const row of rows) {
          const c = s.files[row.file];
          if (!c) continue;
          if (row.fresh) c.offset = Math.max(c.offset, row.end);
          c.failed = c.failed.filter(n => n !== row.start);
          // DB 장애가 함께 나도 손상 행은 확정한다. 정상 미전송 행의 위치는 반드시 남긴다.
          if (!row.event || saved.rejected?.has(row.event.id)) s.undeliverable++;
          else if (!saved.has(row.event.id)) c.failed.push(row.start);
        }
        delete s.lease;
        if (events.length && !writeFailed) s.lastSuccess = new Date(this.now()).toISOString();
      });
      if (writeFailed) throw failure;
      if (!events.length) return rows.some(r => r.fresh);
      this.lastSuccess = new Date(this.now()).toISOString();
      const recovered = this.outage;
      if (this.outage) {
        this.outage = false;
        await this.record(new Error('오류 DB 전달 복구'), { component: 'observability', operation: 'delivery.recovered', severity: 'warning', context: { retries: this.attempts } });
      }
      this.attempts = 0;
      return recovered || rows.some(r => r.fresh);
    } catch (e) {
      this.attempts++;
      if (!this.outage) { this.outage = true; await this.record(e, { component: 'observability', operation: 'delivery.failed' }); }
      return false;
    } finally {
      try { await this.exclusive(async s => { if (s.lease?.token === token) delete s.lease; }); }
      catch (e) {
        this.outage = true; this.attempts++;
        process.stderr.write(`[aether errors] 전달 소유권 해제 실패: ${String(e)}\n`);
      }
    }
  }
  async status(): Promise<ErrorCollectionStatus> {
    return this.exclusive(async s => {
      let pending = 0;
      for (const [file, c] of Object.entries(s.files)) pending += (await this.read(file)).filter(r => r.start >= c.offset || c.failed.includes(r.start)).length;
      return { delivery: !this.options.sink ? 'disabled' : this.outage ? 'retrying' : this.lastSuccess ? 'ok' : 'idle', pending, undeliverable: s.undeliverable,
        lastSuccess: this.lastSuccess ?? s.lastSuccess ?? null, retryCount: this.attempts, fileFailures: this.fileFailures, lost: { ...s.lost, count: s.lost.count + this.directLost.count, from: s.lost.from ?? this.directLost.from, to: this.directLost.to ?? s.lost.to, reason: this.directLost.reason ?? s.lost.reason } };
    });
  }
  async start() {
    await this.init();
    await this.cleanup().catch(e => process.stderr.write(`[aether errors] 정리 실패: ${String(e)}\n`));
    const tick = async () => {
      let more = false;
      try { more = await this.deliver(); } catch (e) { process.stderr.write(`[aether errors] 전달 작업 실패: ${String(e)}\n`); }
      if (!this.stopped) { this.timer = setTimeout(tick, more ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(this.attempts, 6))); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, 1000); this.timer.unref();
    this.maintenance = setInterval(() => { void this.cleanup().catch(e => process.stderr.write(`[aether errors] 정리 실패: ${String(e)}\n`)); }, 3600_000);
    this.maintenance.unref();
  }
  async close(timeoutMs = 2000) {
    clearTimeout(this.timer); clearInterval(this.maintenance);
    const finish = async () => {
      await Promise.allSettled([...this.records]); await this.running;
      await this.exclusive(async s => { if (this.active && s.files[this.active]) s.files[this.active].closed = this.now(); });
      this.stopped = true;
      if (this.active) liveFiles.delete(path.join(this.options.directory, this.active));
      await this.options.sink?.close?.(); this.lock?.close();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([finish(), new Promise<void>(r => { timer = setTimeout(r, timeoutMs); })]); }
    finally { clearTimeout(timer); this.stopped = true; }
  }
}
