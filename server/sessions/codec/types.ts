/**
 * ProviderEventCodec — 한 provider가 뱉은 이벤트의 *수명주기 판정* 일체 (Phase 8d-1 · D2.6).
 *
 * 8b/8c의 normalize는 "콘텐츠를 어떻게 AgentEvent로 바꾸는가"만 provider별로 나눴다. 그런데
 *   ① 이 이벤트가 라이브 전용인가(디스크·replay 제외)
 *   ② 이 이벤트가 턴을 끝내는가(자동 학습·컨텍스트 갱신 트리거, 재시작 복원의 꼬리 판정)
 *   ③ 디스크에 남길 때 어떻게 줄이는가(클램프·시크릿 마스킹)
 * 도 전부 Claude 규약(`msg.type`이 "stream_event"/"result")으로 코드 곳곳에 흩어져 있었다.
 * 이 넷을 한 계약으로 모아, 소비처가 provider 원본 필드를 직접 검사하지 않게 한다.
 *
 * codec 선택 규칙(D2.6):
 *   - 세션 인스턴스가 있으면 그 세션의 codec을 쓴다(LiveSession이 생성 시 확정·보관).
 *   - 세션 인스턴스가 없는 저수준 경로(`persistence.tailInfo`·검색 백필·디스크 replay)는
 *     `meta.json`의 provider로 고른다.
 *   - provider 값이 없는 기존 meta·이벤트는 Claude codec으로 해석한다(무마이그레이션 호환).
 */
import type { Provider, AgentEvent } from "../../../shared/agentEvent";
import type { AetherEvent } from "../../types";

/**
 * kind/msg만 보는 느슨한 이벤트 뷰. 디스크에서 한 줄씩 JSON 파싱한 값(seq/ts가 없거나 타입이 불확실)도
 * 그대로 넘길 수 있어야 하므로 AetherEvent를 요구하지 않는다.
 */
export type EventShape = { kind?: string; msg?: unknown };

/**
 * 디스크 영속 직전 축소기 — 세션 1개당 1개.
 * 상태를 들고 있다: Claude는 "시크릿 경로를 읽은 tool_use id"를 이벤트 간에 추적해 뒤따르는 결과를 가린다.
 * 그래서 codec 본체(provider당 1개·순수)와 분리한다.
 */
export interface ProviderPersistFilter {
  /**
   * 재시작 뒤 기존 영속 이벤트를 관측해 이벤트 간 상태를 복원한다.
   * `apply()`와 달리 반환값을 디스크에 다시 쓰지 않는다. Claude의 시크릿 tool_use 추적처럼 앞 이벤트의
   * 판단이 뒤 이벤트 축소에 필요한 provider는 반드시 구현해야 한다.
   */
  restore(ev: AetherEvent): void;
  /** 영속본으로 축소한 이벤트. `null`이면 이 이벤트는 디스크에 남기지 않는다. */
  apply(ev: AetherEvent): AetherEvent | null;
}

/**
 * 사건 하나가 말하는 파일 변경 조각 하나(중립 모양). 일부 수정은 before+after, 전체 쓰기는 after만,
 * 패치는 diff만 채운다. 사건(AgentEvent)에 싣지 않고 요청 때 원본에서 꺼낸다 — 실으면 기록을 불러올 때마다 본문이 두 번 전송된다.
 */
export type FileEdit = {
  toolId: string;
  path: string;
  before?: string;
  after?: string;
  diff?: string;
  isCreate?: boolean;
  replaceAll?: boolean;
  /** 이름을 바꾼 파일의 새 경로. 내용은 원래 경로 기준 하나만 둔다. */
  movePath?: string;
};

export interface ProviderEventCodec {
  readonly provider: Provider;
  /** raw 이벤트 → AgentEvent[] (D2.4 — 순수 함수, 1 raw → 0..N). */
  normalize(ev: AetherEvent): AgentEvent[];
  /** 이 사건이 시작하거나 갱신하는 파일 변경 조각들. 같은 toolId의 뒤 사건이 앞 사건을 대체한다. 모르는 모양은 빈 배열. */
  fileEdits(ev: AetherEvent): FileEdit[];
  /** 라이브 전용(토큰 미리보기 등) — 영속·replay·역압 드롭 판정이 전부 이걸 참조한다. */
  isLiveOnly(ev: EventShape): boolean;
  /** 이 이벤트로 한 턴이 끝나는가 — 자동 학습·컨텍스트 갱신 트리거와 재시작 복원의 꼬리 판정. */
  endsTurn(ev: EventShape): boolean;
  /**
   * 턴 바깥에서 저절로 들어오는 사건인가 — 재시작 복원의 꼬리 판정은 이 사건을 건너뛰고 그 앞 사건으로 본다.
   * (세션을 깨운 직후 명령 목록 갱신 같은 것. 없으면 다음 재시작이 이를 "턴이 열린 채 끊김"으로 오판한다.)
   */
  isTurnNeutral?(ev: EventShape): boolean;
  /**
   * 이 이벤트가 "인증이 만료됐다"고 말하는가 (8e 신설).
   *
   * 예전에는 세션이 Claude의 턴 결과 봉투(`is_error`·`subtype`·`errors`)를 직접 읽어 판정했다. 그러면
   * 다른 provider 세션에서는 **재인증 배너가 영영 안 뜬다** — 만료 사실이 그 provider의 다른 모양으로
   * 오기 때문이다. 사용자는 이유를 모른 채 계속 실패하는 세션을 보게 된다.
   * 어떤 문구·어떤 필드가 만료를 뜻하는지는 provider마다 다르므로 판정도 provider가 한다.
   */
  isAuthExpired(ev: EventShape): boolean;
  /** 이 세션 전용 영속 축소기 1개. */
  persistFilter(): ProviderPersistFilter;
}
