// 우클릭 메뉴의 복사 — 메뉴는 누르면 닫히므로 「복사했어요」를 짧은 알림으로 알린다.
import { actions } from './store'
import { writeClipboard } from './hooks'
import { t } from './i18n'

/** 클립보드를 쓸 수 있는가. 보안이 아닌 주소에서는 없다. 없으면 복사 항목을 그리지 않는다. */
export function canCopy(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard
}

export async function copyWithNotice(text: string): Promise<void> {
  if (await writeClipboard(text)) actions.showNotice({ title: t('menu.copied') })
}
