/**
 * 세션 없이 읽는 계정 한도. 설정 화면이 열릴 때마다 provider 프로그램이 뜰 수 있으므로 횟수를 여기서 막는다.
 *
 *   - provider마다 동시에 하나만 읽는다. 겹친 요청은 진행 중인 결과를 같이 받는다.
 *   - 결과는 실패까지 1분 저장한다. 새로고침도 10초 안에는 저장값을 준다.
 *   - 쓸 수 없는 provider는 묻지 않고 목록에서 뺀다. 방금 로그인한 서비스가 바로 보이도록 이 결과는 저장하지 않는다.
 *   - 느린 provider가 다른 provider의 값을 붙잡지 않는다. 응답은 먼저 보내고, 끝난 값은 저장해 다음 조회에 준다.
 */
import type { AccountUsageEntry, AccountUsageResponse } from "../../shared/http";
import { FailureTracker } from "./failureTracking";
import { listProviders, providerAvailability, type ProviderEntry } from "./registry";

const MAX_AGE_MS = 60_000;
const MIN_REFRESH_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RESPONSE_DEADLINE_MS = 10_000;
// 어댑터가 자기 제한 시간을 지키지 못해도 진행 중 표시가 영원히 남아 조회가 막히지 않게 한다.
const GUARD_EXTRA_MS = 5_000;

type Saved = { at: number; entry: AccountUsageEntry };

const saved = new Map<string, Saved>();
const running = new Map<string, Promise<AccountUsageEntry | null>>();
const failures = new FailureTracker();
let timeoutMs = DEFAULT_TIMEOUT_MS;
let responseDeadlineMs = DEFAULT_RESPONSE_DEADLINE_MS;

async function ask(entry: ProviderEntry): Promise<AccountUsageEntry["usage"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("계정 한도 조회가 제한 시간을 넘겼다")), timeoutMs + GUARD_EXTRA_MS);
    timer.unref?.();
  });
  try {
    const { windowsAvailable, windows } = await Promise.race([entry.services.usage!(timeoutMs), guard]);
    return { windowsAvailable, windows };
  } finally {
    clearTimeout(timer);
  }
}

async function readNow(entry: ProviderEntry): Promise<AccountUsageEntry | null> {
  const availability = await providerAvailability(entry);
  const named = { provider: entry.id, displayName: entry.services.displayName };
  // 확인 자체가 실패한 서비스는 로그인되어 있을 수 있으므로 조용히 빼지 않는다.
  if (!availability.available) return availability.reason === "check_failed" ? { ...named, usage: null } : null;
  const operation = `provider.account_usage.${entry.id}`;
  let usage: AccountUsageEntry["usage"] = null;
  try {
    usage = await ask(entry);
    failures.clear(operation);
  } catch (error) {
    failures.report(error, { component: "providers", operation, severity: "warning" });
  }
  return { ...named, usage };
}

function read(entry: ProviderEntry, fresh: boolean): Promise<AccountUsageEntry | null> {
  const last = saved.get(entry.id);
  if (last && Date.now() - last.at < (fresh ? MIN_REFRESH_MS : MAX_AGE_MS)) return Promise.resolve(last.entry);
  const current = running.get(entry.id);
  if (current) return current;
  const run = readNow(entry)
    .then((result) => {
      if (result) saved.set(entry.id, { at: Date.now(), entry: result });
      else saved.delete(entry.id);
      return result;
    })
    .finally(() => running.delete(entry.id));
  running.set(entry.id, run);
  return run;
}

async function readWithinDeadline(entry: ProviderEntry, fresh: boolean): Promise<AccountUsageEntry | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<AccountUsageEntry>((resolve) => {
    timer = setTimeout(() => resolve({ provider: entry.id, displayName: entry.services.displayName, usage: null }), responseDeadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read(entry, fresh), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function accountUsage(fresh: boolean): Promise<AccountUsageResponse> {
  const entries = listProviders().filter((entry) => entry.services.usage);
  const results = await Promise.all(entries.map((entry) => readWithinDeadline(entry, fresh)));
  return { providers: results.filter((r): r is AccountUsageEntry => r !== null) };
}

/** 시험 전용 — 저장값을 비우고 제한 시간을 바꾼다. */
export function __resetAccountUsageForTest(nextTimeoutMs = DEFAULT_TIMEOUT_MS, nextDeadlineMs = DEFAULT_RESPONSE_DEADLINE_MS): void {
  saved.clear();
  running.clear();
  timeoutMs = nextTimeoutMs;
  responseDeadlineMs = nextDeadlineMs;
}
