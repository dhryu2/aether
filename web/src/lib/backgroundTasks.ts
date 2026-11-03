// 뒤 작업 띠의 화면 읽기 안내문 — 개수가 바뀐 방향에 따라 문장을 고른다. 같으면 빈 글(알리지 않는다).
export type Translate = (key: string, params?: Record<string, string | number>) => string

export function backgroundAnnouncement(prev: number, next: number, tr: Translate): string {
  if (next === prev) return ''
  if (next === 0) return tr('composer.background.announce.none')
  if (next > prev) return tr('composer.background.announce.more', { n: next })
  return tr('composer.background.announce.less', { n: next })
}
