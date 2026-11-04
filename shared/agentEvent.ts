/**
 * AgentEvent — provider 독립 정규화 이벤트 계약 (Phase 8b · D2/D11).
 *
 * 원본 이벤트(Claude SDKMessage / Codex app-server notification)는 events.jsonl에 그대로 저장하고,
 * read-time에 중앙 normalize 모듈(server/sessions/normalize/{claude,codex}.ts)이 이 AgentEvent[]로 변환한다.
 * **8b 범위**: 검색 인덱싱 경로만 이 계약을 소비한다(SSE·프론트 렌더는 8c). 이 스키마는 8c~8i가 올라타는 초석.
 *
 * ── 식별자 (seq, part) ──
 * 한 raw 이벤트(seq 1건)가 파생 N개로 쪼개져도 원자적 정체성을 유지한다:
 *   - seq  = raw 이벤트의 seq. SSE cursor·재접속 `?since=seq`의 기준이며, 같은 raw에서 나온 파생끼리 공유한다.
 *   - part = 그 raw 안에서의 파생 순번(0..N-1, deterministic). `(seq, part)`가 파생 이벤트의 안정 키다.
 * 8c는 "한 raw의 파생 N개를 하나의 SSE 봉투(id=seq)로 원자 전송"하며, 클라이언트는 `(seq, part)`로 치환한다.
 * → part을 이 계약의 SSOT로 삼아 검색 인덱스((session,seq,part) UNIQUE)와 8c SSE 봉투가 같은 좌표계를 공유한다.
 *
 * ── 원본↔결과 상관 (tool id) ──
 * 한 도구 실행은 raw 스트림에서 호출(call)과 결과(result)가 서로 다른 seq로 도착한다
 * (Claude: assistant.tool_use → user.tool_result / Codex: item/started → item/completed).
 * 그래서 단일 `tool_run`이 아니라 `tool_call`·`tool_result`로 분리하고, provider의 tool id(`toolId`)로 잇는다
 * (Claude tool_use_id / Codex item.id). 프론트(8c)가 이 id로 호출↔결과를 매칭한다.
 */

/** provider 식별자. 세 번째 서비스를 더해도 이 타입과 화면 계약 버전을 바꾸지 않는다. */
export type Provider = string;

/**
 * 화면이 정규화 AgentEvent 계약을 읽는 버전.
 * 화면이 옛 방식으로는 읽을 수 없는 변화가 생길 때만 올린다. 선택 필드를 더하는 것은 못 채우는 쪽의
 * 표시만 빠지는 호환 변경이므로 올리지 않는다.
 * 올리는 예: 기존 이벤트의 필수 필드를 없애거나 뜻을 바꿔 이전 화면이 올바르게 해석할 수 없게 할 때.
 * 안 올리는 예: 기존 이벤트에 선택 필드 `durationMs?`를 더할 때.
 */
export const AGENT_EVENT_CONTRACT_VERSION = 5;

/** 턴 종료 미리보기는 라이브 통로에도 실리므로 푸시 본문에 필요한 길이까지만 둔다. */
export const TURN_RESPONSE_PREVIEW_LIMIT = 200;

/** 최종 답변을 한 줄·상한 안의 턴 종료 미리보기로 만든다. */
export function turnResponsePreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > TURN_RESPONSE_PREVIEW_LIMIT
    ? compact.slice(0, TURN_RESPONSE_PREVIEW_LIMIT - 1).trimEnd() + "…"
    : compact;
}

/** 할 일 항목 상태 — provider 무관 공통 어휘. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 할 일 목록의 한 항목. */
export type TodoItem = { text: string; status: TodoStatus };

/** 도구 실행 종별 — 카드·검색 요약·아이콘 분기용. provider 무관 공통 어휘. */
export type ToolKind =
  | "bash"        // 셸 명령 (Claude Bash / Codex commandExecution)
  | "file_read"   // 읽기 (Read/Grep/Glob 등)
  | "file_change" // 파일 변경 (Edit/Write/NotebookEdit / Codex fileChange·apply_patch)
  | "search"      // 코드 검색 툴
  | "web"         // 웹 검색·fetch (Codex webSearch)
  | "mcp"         // MCP 툴 호출
  | "task"        // 서브에이전트/task
  | "other";

/** turn 종료 상태 — 양 provider 공통(Claude result.is_error / Codex turn.status). */
export type TurnStatus = "ok" | "interrupted" | "failed";

/** provider 알림 종별 — rate-limit·재시도·컨텍스트 압축·모델 폴백·에러 등. */
export type ProviderNoticeKind =
  | "rate_limit"
  | "retry"
  | "compact"        // 컨텍스트 압축/리셋 경계
  | "model_fallback" // 모델 자동 전환(예: refusal → 대체 모델)
  | "error";

/**
 * 알림의 심각도. **없으면 정보성이고 화면에 배너를 띄우지 않는다** — provider가 상태 변화를 알려주기만 하는
 * 경우(예: Claude의 rate_limit status="allowed")까지 배너를 띄우면 매 턴 알림이 쌓인다.
 */
export type NoticeSeverity = "warn" | "blocked";

/** 모든 AgentEvent가 지니는 식별·출처 좌표. */
export interface AgentEventBase {
  provider: Provider;
  seq: number; // raw 이벤트 seq (같은 raw 파생끼리 공유)
  part: number; // raw 내 파생 순번 (0..N-1)
  ts: number; // raw 이벤트 ts
  /** 이 toolId의 도구 호출이 띄운 하위 작업(보조 에이전트) 안에서 나온 사건이다. 화면은 메인 대화에서 숨긴다. */
  subtaskOf?: string;
}

/** 메인 턴이 끝난 뒤에도 뒤에서 도는 작업 하나(하위 에이전트·백그라운드 명령 등). */
export type BackgroundTask = { id: string; kind: "agent" | "command" | "other"; description: string };

/**
 * 식별자를 뺀 순수 콘텐츠 변형 — normalize 구현이 이 배열을 만들면 build()가 (seq,part,ts,provider)를 부여한다.
 *
 * ── 선택 필드 규율 (8d-3) ──
 * 8d-3에서 화면이 provider 원본을 직접 읽던 것을 끊으면서, 원본에만 있던 표시 정보를 이 계약으로 옮겼다.
 * **추가분은 전부 선택 필드이거나 신규 타입이다** — 어떤 provider가 그 값을 못 주면 그 표시만 빠지고
 * 나머지 화면은 그대로 산다(`durationMs?`·`error?`가 이미 쓰던 규율). 계약이 특정 provider의 필드 유무를
 * 기다릴 이유는 없다. provider별 원본 모양의 차이를 흡수하는 것이 codec의 존재 이유다.
 */
export type AgentEventContent =
  | { type: "turn_started" }
  | { type: "user_text"; text: string }
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string } // 라이브 전용(영속·색인 제외 — D2.3)
  | { type: "reasoning"; text: string } // thinking/reasoning (현행 미색인)
  | {
      type: "tool_call";
      toolId: string;
      name: string;
      toolKind: ToolKind;
      /** 화면에 보일 이름. 없으면 name을 보인다. name은 검색 색인과 판정에 쓰므로 그대로 둔다. */
      displayName?: string;
      /** 검색·요약용 핵심 인자 1개(명령·경로 등). 색인이 이 값을 쓴다. */
      target?: string;
      /** 파일 변경(toolKind file_change)이 바꾸는 파일 경로들. 변경 도구가 아니거나 경로를 모르면 생략한다. */
      paths?: string[];
      /**
       * 도구 호출 인자 전체 — 도구 카드가 명령 전문·파일 편집 전후 문자열을 보여주는 데 쓴다.
       * `target` 하나만으로는 카드가 요약으로 퇴화한다. 이미 마스킹·clamp를 거친 영속본에서 읽으므로
       * 새로 드러나는 값은 없다(D2.3).
       */
      input?: Record<string, unknown>;
    }
  | { type: "tool_result"; toolId: string; output: string; isError?: boolean }
  /**
   * 할 일 목록(체크리스트) 전체. 갱신할 때마다 전체를 다시 보내며 마지막 사건이 유효하다.
   * Aether 할 일 도구·Codex 계획 갱신·Grok 계획 알림이 모두 이 한 모양으로 모인다.
   */
  | { type: "plan_update"; items: TodoItem[] }
  /** 글로 된 계획 제안 본문(Codex 계획 모드 등). 체크리스트가 아니다. 승인 왕복은 plan_request 제어 사건이다. */
  | { type: "plan_text"; text: string }
  | {
      type: "turn_completed";
      status: TurnStatus;
      error?: string;
      durationMs?: number;
      /** 이 턴이 만들어낸 출력 토큰 수 — 결과 푸터 표시용. */
      outputTokens?: number;
      /** 실패 사유 여러 건(단일 `error`로는 "여러 에러 중 하나가 과부하인가"를 판정할 수 없다). */
      errors?: string[];
      /** 최종 답변 미리보기 1줄 — 실시간 통로 비용을 막기 위해 `TURN_RESPONSE_PREVIEW_LIMIT`으로 자른다. */
      responsePreview?: string;
      /** 이 턴에서 실제로 모델이 돈 횟수. provider가 모르면 생략한다. */
      modelTurnCount?: number;
    }
  | { type: "usage_update"; totalTokens: number; maxTokens: number }
  /** 슬래시 명령 등이 모델을 거치지 않고 낸 텍스트 출력(표 형식 보존이 필요해 별도 타입). */
  | { type: "command_output"; text: string }
  /**
   * 이 시점에 이 세션이 쓰고 있는 모델. 모델 피커의 활성 표시·상단 라벨이 소비한다.
   * 원본에서 "마지막으로 관측된 모델"을 프론트가 직접 훑던 것을 계약으로 옮긴 것이다.
   */
  | { type: "model_info"; model: string }
  /**
   * 이 세션에서 쓸 수 있는 슬래시 명령 **이름**들. 마지막 관측이 유효하다(목록이 바뀌면 전체를 다시 보낸다).
   * 이름만 싣는 이유: 설명·인자 힌트는 라이브 세션 조회 API(`runtime.supportedCommands()`)가 더 풍부하게 주고,
   * 그건 화면이 있을 때만 필요하다. 반면 **이름은 잠든 세션을 다시 열었을 때도 메뉴에 떠야 하므로**
   * 이벤트로 남아야 한다(그래야 서버가 별도 캐시를 들지 않아도 재시작 뒤까지 살아남는다).
   */
  | { type: "commands_available"; names: string[] }
  /** 지금 뒤에서 살아 있는 작업 전체. 받을 때마다 기존 목록을 이 목록으로 통째로 바꾼다(빈 목록 = 모두 끝남). */
  | { type: "background_tasks"; tasks: BackgroundTask[] }
  | {
      type: "provider_notice";
      kind: ProviderNoticeKind;
      detail?: string;
      /** 없으면 정보성 — 배너를 띄우지 않는다. */
      severity?: NoticeSeverity;
      // ── rate_limit ──
      /** 사용률 0..1. */
      utilization?: number;
      /** 한도 리셋 시각. 초·밀리초 어느 쪽이든 올 수 있어 표시 측이 판별한다. */
      resetsAt?: number;
      /** 어떤 한도인가(provider 어휘 그대로 — 표시 측이 아는 값만 번역하고 나머지는 그대로 보여준다). */
      limitType?: string;
      // ── retry ──
      attempt?: number;
      max?: number;
      // ── model_fallback ──
      /** 전환 *전* 모델. `detail`이 전환 후 모델이다. */
      originalModel?: string;
      /** 전환 사유 분류(provider 어휘). */
      category?: string;
    };

export type AgentEvent = AgentEventBase & AgentEventContent;

/** raw 이벤트(seq/ts 보유)에서 콘텐츠 변형 배열 → AgentEvent[](part 부여). normalize 구현 공용. */
export function buildAgentEvents(
  ev: { seq: number; ts: number },
  provider: Provider,
  items: AgentEventContent[],
): AgentEvent[] {
  return items.map((it, part) => ({ provider, seq: ev.seq, part, ts: ev.ts, ...it }));
}
