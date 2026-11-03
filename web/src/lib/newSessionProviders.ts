// 새 작업 창이 서비스 줄을 어떻게 고르고 막을지 정하는 순수 함수.
// 화면은 이 결과만 따른다. 서비스 이름을 알지 못하고, 목록의 순서와 가용성 기록만 본다.
import type { ProviderAvailability, ProviderInfo } from './types'

/** 가용성 받는 상태. null은 받는 중, 'failed'는 요청이 실패했다는 뜻이다. */
export type AvailabilityState = Record<string, ProviderAvailability> | null | 'failed'

/** 서비스 목록 받는 상태. loading은 받는 중, failed는 요청 실패. 목록이 이미 있으면 쓰지 않는다. */
export type ProviderListState = 'loading' | 'failed'

/** 쓸 수 없는 이유. requires가 있으면 함께 필요한 다른 프로그램의 표시 이름이다. */
export type UnavailableInfo = { reason: string; requires?: string }

export type NewSessionProviderView = {
  /** 지금 고를 수 있는 서비스(목록 순서 유지). */
  usable: ProviderInfo[]
  /** 시작할 서비스. 쓸 수 있는 줄이 없으면 없다. */
  chosen?: ProviderInfo
  /** none: 안내 없음 · noList: 목록을 못 받음 · listLoading: 목록을 받는 중(시작 막힘) · noProvider: 전부 쓸 수 없음 · checkFailed: 상태 확인 실패(막지는 않음) */
  notice: 'none' | 'noList' | 'listLoading' | 'noProvider' | 'checkFailed'
  /** 쓸 수 없으면 그 이유. 쓸 수 있거나 기록이 없으면 undefined. */
  unavailableOf: (id: string) => UnavailableInfo | undefined
}

export function newSessionProviderView(
  providers: ProviderInfo[] | null | undefined,
  availability: AvailabilityState,
  wanted: string,
  listState?: ProviderListState,
): NewSessionProviderView {
  const list = providers ?? []
  const record = availability && availability !== 'failed' ? availability : null
  const unavailableOf = (id: string): UnavailableInfo | undefined => {
    const a = record?.[id]
    if (!a || a.available) return undefined
    return { reason: a.reason, requires: a.requires }
  }
  if (list.length === 0) return { usable: [], notice: listState === 'loading' ? 'listLoading' : 'noList', unavailableOf }
  const usable = list.filter((p) => !unavailableOf(p.id))
  const want = list.find((p) => p.id === wanted)
  const chosen = want && !unavailableOf(want.id) ? want : usable[0]
  const notice = !chosen ? 'noProvider' : availability === 'failed' ? 'checkFailed' : 'none'
  return { usable, chosen, notice, unavailableOf }
}
