/**
 * 검색 결과 행 모양과 스니펫 하이라이트 마커.
 * 저장소(글자 색인)는 db/sessionLetter.ts가 맡는다. 이 파일은 DB를 열지 않는다.
 */

// 스니펫 하이라이트 마커(제어문자 — 일반 텍스트엔 안 나옴). SQL snippet()의 char(1)/char(2)와 동일.
const HL_OPEN = String.fromCharCode(1);
const HL_CLOSE = String.fromCharCode(2);

export type SearchHit = {
  id: number;
  sessionId: string;
  seq: number;
  part: number;
  role: string;
  ts: number;
  snippet: string;
  session: SessionMetaRow;
};

export type SessionMetaRow = { displayName: string | null; cwd: string | null; model: string | null; createdAt: number | null; lineageId: string | null };

export type CtxRow = { id: number; seq: number; part: number; role: string; ts: number; content: string };

export type SessionContextHit = {
  sessionId: string;
  session: SessionMetaRow;
  anchor: SearchHit;
  window: CtxRow[];
  bookendStart: CtxRow[];
  bookendEnd: CtxRow[];
};

export { HL_OPEN, HL_CLOSE };
