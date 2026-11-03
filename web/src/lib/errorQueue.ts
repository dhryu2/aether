import type { ClientErrorInput } from '@shared/errors'
export interface QueuedError { event: ClientErrorInput; storedAt: number }
export interface QueueState { rows: QueuedError[]; lost: number; rejected?: number }
export const ERROR_MAX_BYTES = 10 * 1024 * 1024
export const ERROR_MAX_COUNT = 1000
export const ERROR_MAX_AGE = 7 * 86_400_000
const bytes = (r: QueuedError) => new TextEncoder().encode(JSON.stringify(r)).length
export function boundErrors(state: QueueState, now: number): QueueState {
  const sorted = [...state.rows].sort((a, b) => a.storedAt - b.storedAt)
  let lost = state.lost
  const rows = sorted.filter(r => {
    if (now - Math.min(r.storedAt, Date.parse(r.event.occurred_at)) >= ERROR_MAX_AGE) { lost++; return false }
    return true
  })
  let size = rows.reduce((n, r) => n + bytes(r), 0)
  while (rows.length > ERROR_MAX_COUNT || size > ERROR_MAX_BYTES) { size -= bytes(rows.shift()!); lost++ }
  return { rows, lost, rejected: state.rejected ?? 0 }
}
export interface ErrorQueueStore { change(fn: (state: QueueState) => QueueState): Promise<QueueState> }
/** 한 readwrite 트랜잭션에서 읽기/제한/삭제한다. 여러 탭이 서로의 추가분을 덮어쓰지 않는다. */
export class IndexedErrorStore implements ErrorQueueStore {
  private db?: Promise<IDBDatabase>
  private open() {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('aether-errors', 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('queue') }
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result) }
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('error queue database blocked'))
    }).catch(e => { this.db = undefined; throw e })
    return this.db
  }
  async change(fn: (state: QueueState) => QueueState): Promise<QueueState> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite'), store = tx.objectStore('queue')
      let next: QueueState
      const read = store.get('state')
      read.onsuccess = () => {
        try { next = fn(read.result ?? { rows: [], lost: 0 }); store.put(next, 'state') }
        catch (e) { tx.abort(); reject(e) }
      }
      tx.oncomplete = () => resolve(next)
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('error queue transaction failed'))
    })
  }
}
export class ErrorQueue {
  private fallback: QueueState = { rows: [], lost: 0 }
  private pending = 0
  storageFailed = false
  lost = 0
  rejected = 0
  private serial = Promise.resolve()
  private store: ErrorQueueStore
  private send: (event: ClientErrorInput) => Promise<boolean | 'rejected'>
  private now: () => number
  constructor(store: ErrorQueueStore, send: (event: ClientErrorInput) => Promise<boolean | 'rejected'>, now = Date.now) { this.store = store; this.send = send; this.now = now }
  private async change(fn: (s: QueueState) => QueueState) {
    let result!: QueueState
    const work = this.serial.then(async () => {
      try {
        result = await this.store.change(s => {
          const rows = new Map([...s.rows, ...this.fallback.rows].map(r => [r.event.id, r]))
          return boundErrors(fn({ rows: [...rows.values()], lost: s.lost + this.fallback.lost,
            rejected: (s.rejected ?? 0) + (this.fallback.rejected ?? 0) }), this.now())
        })
        this.fallback = { rows: [], lost: 0 }; this.storageFailed = false
      } catch {
        this.storageFailed = true
        this.fallback = boundErrors(fn(this.fallback), this.now()); result = this.fallback
      }
      this.pending = result.rows.length; this.lost = result.lost; this.rejected = result.rejected ?? 0
    })
    this.serial = work.catch(() => {})
    await work
    return result
  }
  async add(event: ClientErrorInput) {
    await this.change(s => ({ ...s, rows: [...s.rows.filter(r => r.event.id !== event.id), { event, storedAt: this.now() }] }))
  }
  async flush() {
    const state = await this.change(s => s)
    for (const row of state.rows.slice(0, 50)) {
      let result: boolean | 'rejected' = false
      try { result = await this.send(row.event) } catch { /* 수집 요청 실패는 다시 수집하지 않는다. */ }
      if (result !== true && result !== 'rejected') break
      await this.change(s => ({ ...s, rows: s.rows.filter(r => r.event.id !== row.event.id),
        // 같은 행을 보낸 다른 탭이 먼저 지웠다면 중복 집계하지 않는다.
        rejected: (s.rejected ?? 0) + (result === 'rejected' && s.rows.some(r => r.event.id === row.event.id) ? 1 : 0) }))
    }
  }
  status() { return { pending: this.pending, lost: this.lost, rejected: this.rejected, storageFailed: this.storageFailed } }
}
