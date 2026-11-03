/** 클라이언트 JWT 메모리 칸. 디스크·localStorage에 쓰지 않는다. */

let clientToken: string | undefined

export function getClientToken(): string | undefined {
  return clientToken
}

export function setClientToken(token: string | undefined): void {
  clientToken = token || undefined
}

/** 토큰이 있을 때만 Authorization Bearer. 질의 문자열에 token을 넣지 않는다. */
export function authHeaders(): Record<string, string> {
  if (!clientToken) return {}
  return { Authorization: `Bearer ${clientToken}` }
}
