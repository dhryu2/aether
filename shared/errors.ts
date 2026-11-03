/** 실패 원인. 분류가 없으면 결함 가능성을 보존해 수집한다. */
export type ErrorOrigin = 'aether_defect' | 'external_environment' | 'user_action';
export interface ClassifiedError { errorOrigin?: ErrorOrigin }
/** 오류 수집 계약. 실행기·화면·전송 방식에 의존하지 않는다. */
export interface ErrorEvent {
  id: string;
  occurred_at: string;
  severity: 'warning' | 'error' | 'fatal';
  source: string;
  component: string;
  operation: string;
  code: string;
  message: string;
  stack: string | null;
  fingerprint: string;
  request_id: string | null;
  session_id: string | null;
  session_seq: number | null;
  environment: string;
  release: string | null;
  instance_id: string;
  provider: string | null;
  model: string | null;
  context: Record<string, unknown>;
}
export interface ErrorCollectionStatus {
  delivery: 'idle' | 'ok' | 'retrying' | 'disabled';
  pending: number;
  undeliverable: number;
  lastSuccess: string | null;
  retryCount: number;
  fileFailures: number;
  lost: { count: number; from: string | null; to: string | null; reason: string | null };
}
/** 오류 기록 조회의 기간과 출처 거르기 값. */
export type ErrorLogPeriod = '24h' | '7d' | 'all';
export type ErrorLogSource = 'all' | 'server' | 'web';
/** 같은 지문으로 묶인 오류 한 줄. 메시지·위치·출처는 가장 최근 행 값이다. */
export interface ErrorGroupSummary {
  fingerprint: string;
  message: string;
  component: string;
  operation: string;
  source: string;
  count: number;
  lastAt: string;
}
/** total은 같은 거르기 조건의 오류 행 수다(묶음 수가 아니다). */
export interface ErrorGroupListResponse { groups: ErrorGroupSummary[]; nextCursor: string | null; total: number }
/** 상세에 싣는 행 모양. 운영 식별 열(instance_id·environment 등)은 내보내지 않는다. */
export type ErrorEventView = Pick<ErrorEvent, 'id' | 'occurred_at' | 'severity' | 'source' | 'component' | 'operation' | 'code' | 'message' | 'stack' | 'request_id' | 'session_id' | 'release' | 'provider' | 'model' | 'context'>;
export interface ErrorGroupDetailResponse {
  fingerprint: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** 최근 순, 중복 없음, 최대 20개. */
  sessionIds: string[];
  latest: ErrorEventView;
}
export interface ClientErrorInput {
  id: string;
  occurred_at: string;
  component: string;
  operation: string;
  message: string;
  stack?: string;
  code?: string;
  request_id?: string;
  session_id?: string;
  release?: string | null;
  /** 기능을 줄여 계속한 실패만 warning으로 보낸다. 없으면 error이며 fatal은 클라이언트가 보낼 수 없다. */
  severity?: 'error' | 'warning';
}
