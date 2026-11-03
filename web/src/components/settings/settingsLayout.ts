import { useStore } from '../../lib/store'

export function useNarrow(): boolean {
  return useStore().isNarrow
}

export function rowMin(narrow: boolean): number {
  return narrow ? 52 : 44
}

/** 설정에서 다시 로그인할 수 있는 서비스. 계정 묶음과 「계정과 보안」 칸이 비었는지 판단에 함께 쓴다. */
export function useReloginProviders() {
  const s = useStore()
  return s.reloginEnabled ? (s.providers ?? []).filter((p) => p.authSupported) : []
}
