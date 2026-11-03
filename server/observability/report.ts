import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ErrorJournal } from './journal';
import { SqliteErrorSink } from './database';
import { databasePath } from '../db/sqlite';
import { isExpectedError, type ErrorDetails } from './event';
export type Receipt = { id: string; durable: boolean; recorded?: boolean };
export const errorContext = new AsyncLocalStorage<{ requestId: string; ended?: boolean; receipt?: Promise<Receipt> }>();
let journal: ErrorJournal | undefined;
const seen = new WeakMap<object, Promise<Receipt>>();
export function setErrorJournal(value: ErrorJournal | undefined) { journal = value; }
export function getErrorJournal() { return journal; }
/** 폴더는 호출자가 config.errorDir로 정해 넘긴다 — 이 모듈이 config를 import하면 시험이 환경변수를 바꾸기 전에 config가 굳는다. */
export function startErrorCollection(directory: string) {
  // 시험은 opt-in 설정 전까지 수집기가 없다. 시험이 운영 폴더(옛 기본 로그 폴더, 지금 기본 데이터 폴더의 errors)에 쓰지 못하게 막는다.
  const real = path.resolve(directory);
  if (process.env.NODE_ENV === 'test' && (real === path.join(os.homedir(), 'Library/Logs/aether/errors') || real === path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/errors'))) throw new Error('시험은 운영 오류 폴더에 쓸 수 없습니다.');
  journal = new ErrorJournal({ directory, sink: databasePath() ? new SqliteErrorSink() : undefined });
  void journal.start().catch(e => process.stderr.write(`[aether errors] 시작 실패: ${String(e)}\n`));
}
/** import만 한 시험에서는 파일/DB 부작용이 없다. 잡아서 다시 던진 같은 Error는 한 번만 기록한다. */
export function reportError(error: unknown, details: ErrorDetails): Promise<Receipt> {
  if (isExpectedError(error)) return Promise.resolve({ id: '', durable: false });
  if (!journal) return Promise.resolve({ id: '', durable: false });
  const object = error !== null && (typeof error === 'object' || typeof error === 'function') ? error as object : null;
  const scope = errorContext.getStore();
  const context = scope?.ended ? undefined : scope;
  const previous = object ? seen.get(object) : undefined;
  if (previous) {
    if (context) context.receipt = previous;
    return previous;
  }
  const receipt = journal.record(error, { request_id: context?.requestId ?? null, ...details });
  if (object) seen.set(object, receipt);
  if (context) context.receipt = receipt;
  return receipt;
}
