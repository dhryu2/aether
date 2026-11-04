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

/** 작업 검토함 — 한 세션의 기록에서 모은 요약. 모든 값에는 그 사건의 순번(seq)이 붙어 세션의 그 지점으로 갈 수 있다. */
export type ReviewSummary = {
  /** 바뀐 파일. 실패한 수정은 빠지고, 같은 경로는 마지막 변경만 남는다. */
  changedFiles: { path: string; seq: number }[];
  /** 실패한 채 끝난 명령. 범위 안 마지막 성공 명령 뒤의 실패이고, 같은 명령은 마지막 하나만 남는다. */
  failedCommands: { text: string; seq: number }[];
  /** 도중에 실패했지만 뒤에 다른 명령이 성공한 것. 같은 명령이 뒤에서 성공했으면 빠진다. 먼저 볼 것 판단에 넣지 않는다. */
  otherFailures: { text: string; seq: number }[];
  /** 범위의 마지막 턴이 실패나 중단으로 끝났다. */
  turnFailed?: "failed" | "interrupted";
  /** 마지막 할 일 목록의 끝나지 않은 항목. */
  openTodos: { text: string; seq: number }[];
};

/** 검토 대상 세션의 공통 머리 정보. */
export type ReviewSessionHead = {
  id: string;
  /** 세션 목록과 같은 표시 이름. 비어 있으면 화면이 기본 문구를 채운다. */
  title: string;
  /** 프로젝트 폴더. 작업 복사본이면 원래 폴더. */
  projectPath: string;
  projectName: string;
  /** 세션의 작업 폴더. 파일 경로를 줄여 보일 때 기준이다. */
  cwd: string;
  lastActivityAt: number;
  /** 읽은 범위의 마지막 사건 순번. 검토 완료는 이 값을 저장한다. */
  lastSeq: number;
  /** 사건이 많아 최근 일부만 읽었다. */
  partial: boolean;
};

export type ReviewRow = ReviewSessionHead & {
  fileCount: number;
  failureCount: number;
  todoCount: number;
  /** 실패한 채 끝난 명령, 실패·중단으로 끝난 턴, 남은 할 일 중 하나가 있다. */
  needsAttention: boolean;
  turnFailed?: "failed" | "interrupted";
};

export type ReviewListResponse = { rows: ReviewRow[] };

/** git 상태: 읽었음 / 읽지 못함 / 아직 읽지 않음(?git=0). */
export type ReviewGitState = "ok" | "unavailable" | "skipped";

export type ReviewDetailResponse = ReviewSessionHead & ReviewSummary & {
  git: ReviewGitState;
  /** 저장소 상태를 읽었을 때만 채운다. changedFiles와 같은 순서이고 uncommitted는 커밋 안 됨, clean은 지금은 변경 없음, unknown은 저장소 밖이거나 무시된 파일이라 알 수 없음. */
  fileStates: ("uncommitted" | "clean" | "unknown")[];
  /** 그 폴더의 커밋 안 된 변경 중 이 세션 기록에 없는 것(최대 200개). */
  unrecorded: string[];
};

/** 검토 완료·되돌리기 응답. previous는 되돌릴 때 쓸 이전 위치(없으면 처음 처리한 것). 되돌릴 때 본문의 expected는 그 완료가 저장한 reviewedSeq이고, 지금 값과 다르면 409다. */
export type ReviewMarkResponse = { reviewedSeq: number | null; previous: number | null };
