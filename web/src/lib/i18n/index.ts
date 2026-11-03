// 경량 i18n 엔진 — 라이브러리 없이 사전 + t()로 다국어. 기본 한국어, 설정에서 English 전환.
//  · 반응성: locale은 store 상태 → 컴포넌트는 useT()로 구독, 로케일 변경 시 전역 리렌더(즉시 전환).
//  · 비-React(스토어 액션·format 헬퍼 등)는 t()가 getState().locale을 직접 읽는다.
//  · 키 규약: `<area>.<sub>`(예: settings.title). 파라미터는 본문의 {name} 자리표시자를 치환.
import { useSyncExternalStore } from 'react'
import { getState, subscribeLocale } from '../store'
import type { Dict, Entry, Locale } from './types'
import { common } from './common'
import { settings } from './settings'
import { stream } from './stream'
import { composer } from './composer'
import { brain } from './brain'
import { nav } from './nav'
import { session } from './session'
import { core } from './core'
import { handoff } from './handoff'
import { setup } from './setup'

export type { Locale, Entry, Dict } from './types'
export const LOCALES: Locale[] = ['ko', 'en']
export const LOCALE_LABELS: Record<Locale, string> = { ko: '한국어', en: 'English' }

// 네임스페이스 사전 병합 — 각 조각은 서로 다른 키 공간을 소유(충돌 시 나중 값이 이김, 그럴 일 없게 관리).
const dict: Dict = {
  ...common,
  ...settings,
  ...stream,
  ...composer,
  ...brain,
  ...nav,
  ...session,
  ...core,
  ...handoff,
  ...setup,
}

// 파라미터 값은 undefined도 허용(호출부의 optional 필드 그대로 전달 가능) — 치환 시 빈 문자열로.
type Params = Record<string, string | number | undefined>

/** 로케일별 문자열 조회 + {param} 치환. 키 미존재 시 개발 중 눈에 띄게 키 자체를 반환. */
export function translate(locale: Locale, key: string, params?: Params): string {
  const entry: Entry | undefined = dict[key]
  let s = entry ? entry[locale] : undefined
  if (s === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] 미등록 키: ${key}`)
    return key
  }
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v == null ? '' : String(v))
  return s
}

/** 비-React 컨텍스트용 — 현재 store 로케일로 즉시 번역(스토어 액션·format 헬퍼 등). */
export function t(key: string, params?: Params): string {
  return translate(getState().locale, key, params)
}

/** React 훅 — 로케일 구독 + 바인딩된 t 반환. 컴포넌트에서 `const t = useT()`. */
export function useT(): (key: string, params?: Params) => string {
  const locale = useSyncExternalStore(subscribeLocale, () => getState().locale, () => getState().locale)
  return (key, params) => translate(locale, key, params)
}
