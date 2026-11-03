// Agent Brain 화면들이 공유하는 계산.
import type { State } from '../../lib/store'

/** 지금 보고 있는 환경 이름. 홈과 왼쪽 기둥이 함께 쓴다. */
export function projectLabel(s: State, tr: (key: string) => string): string {
  return s.sessions.find((x) => x.id === s.activeId)?.displayName || tr('brain.hub.defaultEnvLabel')
}

/** 경로의 마지막 조각. 프로젝트 이름으로 쓴다. */
export function projName(cwd?: string): string {
  if (!cwd) return ''
  const segs = cwd.replace(/\/+$/, '').split('/')
  return segs[segs.length - 1] || ''
}
