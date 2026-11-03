// 서버 i18n 공용 타입 — 프론트(web/src/lib/i18n)와 동일 규약. 순환참조 회피용 타입 분리.
export type Locale = "ko" | "en";

/** 한 문자열의 로케일별 값(모든 로케일 필수 — 번역 구멍을 컴파일 타임 차단). */
export type Entry = Record<Locale, string>;

/** 네임스페이스 사전 조각 — 점 표기 키(`area.sub`) → 로케일별 문자열. */
export type Dict = Record<string, Entry>;
