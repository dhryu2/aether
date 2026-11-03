// i18n 공용 타입 — 엔진(index.ts)과 네임스페이스 사전 파일이 공유. 순환참조 회피용으로 타입만 분리.
export type Locale = 'ko' | 'en'

/** 한 문자열의 로케일별 값. 모든 로케일이 필수(누락 시 타입 에러로 번역 구멍을 컴파일 타임에 차단). */
export type Entry = Record<Locale, string>

/** 네임스페이스 사전 조각 — 점 표기 키(`area.sub`) → 로케일별 문자열. */
export type Dict = Record<string, Entry>
