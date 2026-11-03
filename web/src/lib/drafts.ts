import { createStorageErrorReporter } from './errors'
// 컴포저 입력 임시저장(드래프트) — 세션별로 sessionStorage에 보관(탭 한정·새로고침 생존, queued 미러와 동형).
//   세션 전환 시 입력이 엉뚱하게 공유되거나 새로고침 시 유실되던 문제 해결. 키스트로크당 store set을 피해(Stream 재렌더 회피)
//   sessionStorage에만 직접 쓴다(쓰기 비용 작음).
const KEY = 'aether.drafts'
let cache: Record<string, string> | null = null
const readFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.drafts.read' })
const writeFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.drafts.write' })

function all(): Record<string, string> {
  if (!cache) {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(KEY) || '{}')
      cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
      readFailure.reset()
    } catch (error) {
      readFailure.report(error)
      cache = {}
    }
  }
  return cache
}

export const drafts = {
  get(id: string | null): string {
    if (!id) return ''
    return all()[id] ?? ''
  },
  set(id: string | null, text: string) {
    if (!id) return
    const a = all()
    if (text) a[id] = text
    else delete a[id]
    try {
      sessionStorage.setItem(KEY, JSON.stringify(a))
      writeFailure.reset()
    } catch (error) {
      writeFailure.report(error, { session_id: id })
      /* sessionStorage 불가 — 휘발 */
    }
  },
}
