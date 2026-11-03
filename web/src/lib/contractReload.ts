/**
 * 화면 계약 번호가 서버와 다를 때 열린 탭을 자동으로 한 번만 새로고침하는 판단.
 * 표시(sessionStorage)에는 새로고침을 시도한 서버 계약 번호를 남긴다. 같은 번호로 또 어긋나면 새로고침해도 소용없으니 안내만 보인다.
 */
export const CONTRACT_RELOAD_KEY = 'aether.contractReload'

export type ContractAction = 'none' | 'clear' | 'reload' | 'notice'

/** serverVersion이 없으면 구버전 서버라 판단 보류. 일치하면 표시를 지운다. */
export function decideContractReload(serverVersion: unknown, ourVersion: number, mark: string | null, busy = false): ContractAction {
  if (serverVersion === undefined) return 'none'
  if (serverVersion === ourVersion) return mark === null ? 'none' : 'clear'
  // 첨부가 남았거나 전송 중이면 새로고침으로 날리지 않고 안내만 보인다.
  return busy || mark === String(serverVersion) ? 'notice' : 'reload'
}

/** 새로고침하면 잃는 것이 있는가. 작성기가 첨부 유무를 여기에 알리고, 스토어가 전송·대기열 상태를 더해 넘긴다. */
export const reloadGuard = { attachments: 0 }

/** 어긋남이면 true(안내 상태를 켜야 함). 첫 어긋남은 새로고침을 걸고 true를 돌려준다. */
export function applyContractReload(serverVersion: unknown, ourVersion: number, busy = false, reload: () => void = () => location.reload()): boolean {
  let mark: string | null = null
  try { mark = sessionStorage.getItem(CONTRACT_RELOAD_KEY) } catch { /* 저장소를 못 쓰면 새로고침을 한 번도 안 한 것으로 본다 */ }
  const action = decideContractReload(serverVersion, ourVersion, mark, busy || reloadGuard.attachments > 0)
  try {
    if (action === 'clear') sessionStorage.removeItem(CONTRACT_RELOAD_KEY)
    if (action === 'reload') sessionStorage.setItem(CONTRACT_RELOAD_KEY, String(serverVersion))
  } catch {
    return serverVersion !== ourVersion // 표시를 못 남기면 새로고침이 반복될 수 있어 안내만 보인다
  }
  if (action === 'reload') reload()
  return action === 'reload' || action === 'notice'
}

export const STALE_RELOAD_KEY = 'aether.staleBuildReload'

/** 멈춘 화면이 옛 빌드인가. 서버의 최신 빌드 해시가 실행 중인 해시와 다르고 그 해시로 아직 새로고침한 적이 없을 때만 true. */
export function shouldReloadStaleBuild(serverHash: unknown, runningHash: string | null, mark: string | null): boolean {
  return typeof serverHash === 'string' && !!runningHash && serverHash !== runningHash && mark !== serverHash
}
