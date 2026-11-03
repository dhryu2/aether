import type { LocalizedText } from './types'

/** provider/Aether가 보낸 번역표에서 현재 화면 언어의 문구를 고른다. 명령 이름이나 의미는 해석하지 않는다. */
export function resolveLocalizedText(value: LocalizedText | undefined, locale: string): string {
  if (!value) return ''
  const exact = value.byLocale?.[locale]
  if (exact) return exact
  const base = locale.split('-')[0]
  const byBase = base !== locale ? value.byLocale?.[base] : undefined
  return byBase || value.text || ''
}
