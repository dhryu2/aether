/** AuthGate phase 판정. HTTP·React 없음. */

export type AuthPhase = 'login' | 'ready' | 'need-tailnet' | 'blocked' | 'setup'

export type AuthGateInput = {
  sessionsStatus: number | null
  healthAuth: 'off' | 'tailscale' | 'password' | undefined
  /** health.setup — 첫 설정 서버가 응답 중이면 true. 이때는 보호 REST를 부르지 않는다. */
  healthSetup?: boolean
  originHost: string
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost'
}

function isTsNet(host: string): boolean {
  return host.toLowerCase().endsWith('.ts.net')
}

/**
 * health.auth · 호스트 · 보호 REST 상태로 phase를 정한다.
 * 비번 칸은 health.auth==="password" 이고 401일 때만.
 */
export function nextAuthPhase(input: AuthGateInput): AuthPhase {
  if (input.healthSetup === true) return 'setup'
  const auth = input.healthAuth ?? 'off'
  const host = input.originHost
  const status = input.sessionsStatus

  if (auth === 'tailscale') {
    if (isLoopback(host)) return 'need-tailnet'
    if (isTsNet(host)) {
      if (status === null) return 'need-tailnet'
      if (status >= 200 && status < 300) return 'ready'
      if (status === 401) return 'need-tailnet'
      return 'blocked'
    }
    return 'need-tailnet'
  }

  if (auth === 'password') {
    if (status !== null && status >= 200 && status < 300) return 'ready'
    if (status === 401) return 'login'
    if (status === null) return 'login'
    return 'blocked'
  }

  // off 또는 칸 없음 — 호스트 무관
  if (status !== null && status >= 200 && status < 300) return 'ready'
  if (status === 401) return 'blocked'
  return 'blocked'
}
