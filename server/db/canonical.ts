/**
 * 세션 일기 정본 스위치.
 * Pool·HTTP·SearchIndex 없음.
 */

/** sqlite=운영 정본. blocked=아직 열지 않았거나 데이터베이스 실패. 파일로 되돌리지 않는다. */
export type SessionDiaryMode = "sqlite" | "blocked";

let diaryMode: SessionDiaryMode = "blocked";

export function configureCanonical(opts: { diary?: SessionDiaryMode }): void {
  if (opts.diary !== undefined) diaryMode = opts.diary;
}

/** 시험용 — 세션 일기를 열기 전 상태로 되돌린다. */
export function __resetCanonicalForTest(): void {
  diaryMode = "blocked";
}

export function sessionDiaryMode(): SessionDiaryMode {
  return diaryMode;
}
