/**
 * 로그인 시도 제한(password 모드). 사용자는 한 명이지만 tailnet의 여러 기기가 같은 서버로 들어오므로
 * 피어(요청한 기기의 주소)별로 센다 — 다른 기기의 실패로 소유자가 잠기지 않게 한다.
 * - 피어별 연속 실패 maxFailures번 → lockMs 동안 그 피어의 로그인 거부(맞는 비번도). 성공하면 실패 수를 0으로.
 * - 피어를 속여 칸을 바꾸는 시도를 막으려고 전체 실패도 lockMs 창 안에서 센다: globalMaxFailures번이면 모든 피어를 lockMs 동안 거부.
 * - 동시에 하나만 검사(busy) → 병렬 요청으로 bcrypt 대조를 여러 번 돌려 제한을 앞지르지 못한다.
 * 메모리에만 둔다 — 잠긴 채 급하면 서버 재시작으로 풀린다.
 */
const MAX_PEERS = 1000; // 넘으면 비운다(전체 상한이 남아 있어 추측 허용량은 여전히 묶인다)

export function createLoginLimiter(opts: { maxFailures?: number; lockMs?: number; globalMaxFailures?: number; now?: () => number } = {}) {
  const maxFailures = opts.maxFailures ?? 5;
  const lockMs = opts.lockMs ?? 15 * 60 * 1000;
  const globalMaxFailures = opts.globalMaxFailures ?? 30;
  const now = opts.now ?? Date.now;
  const peers = new Map<string, { failures: number; lockedUntil: number }>();
  let globalFailures = 0;
  let globalSince = 0; // 전체 실패 창의 시작(첫 실패 시각)
  let globalLockedUntil = 0;
  let busy = false;
  let held = "";
  return {
    /** 검사를 시작해도 되면 0. 안 되면 다시 시도까지 남은 초(1 이상). 0을 받았으면 반드시 release. */
    acquire(peer = ""): number {
      const left = Math.max(globalLockedUntil, peers.get(peer)?.lockedUntil ?? 0) - now();
      if (left > 0) return Math.ceil(left / 1000);
      if (busy) return 1;
      busy = true;
      held = peer;
      return 0;
    },
    release(ok: boolean): void {
      busy = false;
      if (ok) {
        peers.delete(held);
        globalFailures = 0;
        return;
      }
      if (peers.size >= MAX_PEERS && !peers.has(held)) peers.clear();
      const p = peers.get(held) ?? { failures: 0, lockedUntil: 0 };
      p.failures += 1;
      if (p.failures >= maxFailures) {
        p.failures = 0;
        p.lockedUntil = now() + lockMs;
      }
      peers.set(held, p);
      if (globalFailures > 0 && now() - globalSince >= lockMs) globalFailures = 0; // 창(lockMs)이 지나면 새로 센다
      if (globalFailures === 0) globalSince = now();
      globalFailures += 1;
      if (globalFailures >= globalMaxFailures) {
        globalFailures = 0;
        globalLockedUntil = now() + lockMs;
      }
    },
  };
}
