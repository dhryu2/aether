/**
 * Agent Brain REST 응답 모양 (Phase 9e).
 *
 * 과거 대화 검색 API가 JSON으로 주는 형태다. 화면과 서버가 이 파일만 본다.
 * 탭 이름·하이라이트 분해처럼 화면만 쓰는 값은 여기 두지 않는다.
 */

export type SearchHit = {
  id: number;
  sessionId: string;
  seq: number;
  part: number;
  role: "user" | "assistant" | "tool";
  ts: number;
  snippet: string;
  session: { displayName: string | null; cwd: string | null; model: string | null; createdAt: number | null };
  /** 세션은 지워졌고 검색 색인에만 대화가 남아 있다. 열 수 없고 읽기 전용 글로만 본다. */
  deleted?: boolean;
};

/** 지운 세션의 대화 글 한 줄(검색 색인에 남은 것). `id`는 다음 쪽을 부를 때 넘긴다. */
export type DeletedSessionRow = {
  id: number;
  seq: number;
  part: number;
  role: "user" | "assistant" | "tool";
  ts: number;
  content: string;
};

/** 스킬 폴더의 범위 — 사용자 전체 또는 프로젝트. 스킬 폴더 경로 계산(skillPaths)이 쓴다. */
export type SkillTarget = "user" | "project";
