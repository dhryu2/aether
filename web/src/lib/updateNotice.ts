// 새 버전 알림의 순수 로직. 서버가 알려 준 결과(UpdateStatusResponse)로 링크 검사와 "버전별 한 번" 판정을 한다.
import type { UpdateStatusResponse } from '@shared/http'

/** 브라우저에 마지막으로 알린 버전을 적어 두는 키(같은 버전은 다시 알리지 않는다). */
export const UPDATE_SEEN_KEY = 'aether.updateNoticeSeen'

/** http 또는 https 주소만 돌려준다. 그 밖(javascript: 등)이거나 잘못된 주소면 null. */
export function safeHttpUrl(u: string | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** 새 버전이 있고 열 수 있는 링크가 있으며 이 버전을 아직 알리지 않았을 때만 true. */
export function shouldAnnounceUpdate(s: UpdateStatusResponse, seenVersion: string | null): boolean {
  return s.enabled && s.available && !!s.latest && s.latest !== seenVersion && safeHttpUrl(s.pageUrl) !== null
}

export interface UpdateNoticeDeps {
  fetchStatus: () => Promise<UpdateStatusResponse>
  getSeen: () => string | null
  setSeen: (version: string) => void
  isHidden: () => boolean
  show: (s: UpdateStatusResponse, url: string) => void
}

/**
 * 알림 흐름 한 번. 새 버전이면 기록하고 보여 준다.
 *  - 숨은 탭이면 기록도 표시도 미루고 'deferred'를 돌려준다(보일 때 다시 부른다).
 *  - 저장소 읽기·쓰기 실패와 확인 실패는 알림을 막지 않고 조용히 넘긴다.
 */
export async function runUpdateNotice(d: UpdateNoticeDeps): Promise<'shown' | 'skipped' | 'deferred'> {
  let s: UpdateStatusResponse
  try { s = await d.fetchStatus() } catch { return 'skipped' }
  let seen: string | null = null
  try { seen = d.getSeen() } catch { /* 저장소 불가 — 알림이 반복될 수 있다 */ }
  if (!shouldAnnounceUpdate(s, seen)) return 'skipped'
  if (d.isHidden()) return 'deferred'
  try { d.setSeen(s.latest!) } catch { /* 저장소 불가 */ }
  d.show(s, safeHttpUrl(s.pageUrl)!)
  return 'shown'
}
