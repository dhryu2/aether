/**
 * 로그인 시도 제한(password 모드). 사용자가 한 명이고 요청이 모두 serve(loopback)로 들어와
 * IP별 구분이 의미 없으므로 서버 전체에 하나만 둔다.
 * - 연속 실패 maxFailures번 → lockMs 동안 모든 로그인 거부(맞는 비번도). 성공하면 실패 수를 0으로.
 * - 동시에 하나만 검사(busy) → 병렬 요청으로 bcrypt 대조를 여러 번 돌려 제한을 앞지르지 못한다.
 * 메모리에만 둔다 — 잠긴 채 급하면 서버 재시작으로 풀린다.
 */
export function createLoginLimiter(opts: { maxFailures?: number; lockMs?: number; now?: () => number } = {}) {
  const maxFailures = opts.maxFailures ?? 5;
  const lockMs = opts.lockMs ?? 15 * 60 * 1000;
  const now = opts.now ?? Date.now;
  let failures = 0;
  let lockedUntil = 0;
  let busy = false;
  return {
    /** 검사를 시작해도 되면 0. 안 되면 다시 시도까지 남은 초(1 이상). 0을 받았으면 반드시 release. */
    acquire(): number {
      const left = lockedUntil - now();
      if (left > 0) return Math.ceil(left / 1000);
      if (busy) return 1;
      busy = true;
      return 0;
    },
    release(ok: boolean): void {
      busy = false;
      if (ok) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures >= maxFailures) {
        failures = 0;
        lockedUntil = now() + lockMs;
      }
    },
  };
}
