/**
 * provider 추상화 계약 (Phase 8d · D3).
 *
 * 두 층으로 나눈다:
 *   - `AgentRuntime`     = 세션 1개의 실행(모델 프로세스·턴·권한 왕복). LiveSession이 1개 소유.
 *   - `ProviderServices` = 세션 밖 서비스(인증·백그라운드 경량 모델). provider당 1개.
 *
 * 경계 규칙(D3): 이 계약 밖에서 `@anthropic-ai/claude-agent-sdk`를 런타임 import하면 안 된다
 *   (타입 전용 import는 예외). 검사는 `server/test/provider_boundary.ts`.
 *
 * 8d 범위 주의: 이벤트 *수명주기* 판정(라이브 전용·턴 종료·영속 축소)은 아직 LiveSession/persistFilter에 있다.
 *   `ProviderEventCodec`(D2.6)으로 모으는 것은 8d-1 작업이다. 여기선 실행 코어만 추상화한다.
 */
import type { Provider, TodoItem } from "../../shared/agentEvent";
import type {
  AetherQuestion,
  DocAttachment,
  ImageAttachment,
  LocalizedText,
  ModelInfo,
  MutationPreview,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyScope,
  ProviderAvailability,
  SessionEffort,
  SlashCommandInfo,
  UsageResponse,
  UsageWindow,
} from "../../shared/http";
import type { RawProviderEventBody } from "../types";

export type { LocalizedText, PermissionPolicy, PermissionPolicyScope, ProviderAvailability, UsageWindow };

/** provider 식별자 — 어휘는 shared(AgentEvent)와 공유해 이중 정의를 만들지 않는다. */
export type ProviderId = Provider;

/**
 * 서버 공통 사용자 입력 표현 — provider별 형식 변환은 runtime 책임(D3).
 *
 * 첨부 수명 계약(8d-1): 이 표현은 base64도 경로도 강제하지 않는다. 변환 과정에서 **임시 파일이 생긴다면
 * 그 파일의 생성·유지·정리는 전적으로 runtime의 책임**이다. 규칙은 셋뿐이다.
 *   ① 큐에서 대기 중인 입력이 실제로 소비될 때까지 파일이 살아 있어야 한다(선삭제 금지).
 *   ② 소비된 뒤에는 지워야 한다.
 *   ③ interrupt·크래시·서버 재시작·세션 삭제 어디서도 새면 안 된다 — `dispose()`가 마지막 그물이고,
 *      그마저 못 불린 경우는 부팅 시 `purgeOrphanAttachments()`가 청소한다.
 * 공용 수단은 `sessions/attachments.ts`의 `AttachmentStore`다. Claude는 내용을 메시지에 실어 보내므로
 * 임시 파일이 없고 이 저장소를 쓰지 않는다. Codex는 로컬 이미지를 경로로만 받아 쓰게 된다(8e).
 */
export type NormalizedUserInput = {
  text: string;
  images?: ImageAttachment[];
  documents?: DocAttachment[];
};

/**
 * 권한 승인 요청(runtime → 세션). provider 원본 payload를 중립 필드로 옮긴 것.
 *
 * **`input`은 화면과 기록에 보여줄 인자다(8e 변경).** 실행에 쓰이는 원본은 runtime이 자기 안에 들고 있고
 * 밖으로 내보내지 않는다. 이렇게 바꾼 이유는 둘이다.
 *   ① 비밀 경로의 내용을 가리는 규칙이 provider 인자 이름에 매여 있다 — 그 지식이 공통 계층으로 새면
 *      다른 provider의 인자는 가려지지 않은 채 화면과 디스크로 나간다.
 *   ② 원본이 아예 전달되지 않으면 H1(승인한 카드 = 실제 실행 인자)이 구조적으로 지켜진다. 세션도
 *      클라이언트도 실행 인자를 만질 통로가 없다.
 */
export type PermissionAsk = {
  toolName: string;
  input: Record<string, unknown>;
  /**
   * "무엇이 바뀌는가" 미리보기. 변이가 아니면 없다.
   * 만드는 방법이 provider마다 달라서(도구 인자에서 재구성 vs 이미 만들어진 패치를 읽기) runtime이 채운다.
   */
  mutation?: MutationPreview;
  displayName?: string;
  title?: string;
  toolUseID: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** 진행 턴이 interrupt되면 abort — 세션이 보류 카드를 거부로 정리하는 신호. */
  signal: AbortSignal;
};

/** 권한 결정(세션 → runtime). 허용은 "허용"만 말한다(인자 수정 통로 없음 — H1). */
export type PermissionOutcome = { allow: true } | { allow: false; message: string };

/** 구조화 질문 요청(runtime → 세션). Claude는 AskUserQuestion 우회, Codex는 native requestUserInput(8e). */
export type QuestionAsk = { toolUseID: string; questions: AetherQuestion[]; signal: AbortSignal; lead?: string };

/**
 * 질문 1개에 대한 답 (8d-3 ⑥ⓒ).
 *
 * 고른 선택지와 직접 적은 문장을 **분리해서** 담는다. 합쳐서 문자열 목록 하나로 넘기면 서버가 "이건
 * 우리가 제시한 선택지인가, 클라이언트가 지어낸 문장인가"를 구분할 수 없고, 그러면 모델에게 나가는
 * "사용자가 고른 답"이 사실은 검증되지 않은 임의 문자열일 수 있다. 자유 입력 자체는 질문 카드의 정당한
 * 기능이므로 금지하지 않고, 대신 어느 쪽인지 끝까지 표시해서 모델에게도 구분해 전달한다.
 *
 * `chosen`의 각 값은 그 질문이 실제로 제시한 선택지 이름이어야 한다(서버가 대조·거부).
 */
export type QuestionAnswer = { chosen: string[]; custom?: string };

/** 질문 결과(세션 → runtime). 모델에 답을 어떤 통로로 되돌리는지는 provider별 수법이라 runtime이 결정. */
export type QuestionOutcome = { answered: true; answers: QuestionAnswer[] } | { answered: false; reason: string };

/**
 * 계획 검토 요청(runtime → 세션). 권한 카드·질문 카드에 넣지 않는다.
 *
 * 계획문은 길고, 동작은 승인·수정요청·취소 세 갈래다.
 */
export type PlanAsk = {
  planId: string;
  text: string;
  signal: AbortSignal;
};

/** 계획 검토 결과(세션 → runtime). */
export type PlanOutcome =
  | { decision: "approve" }
  | { decision: "revise"; message: string }
  | { decision: "cancel" };

/** 작업 폴더 분리 결과. 코어는 경로 두 개만 본다. */
export type IsolatedWorkspace = {
  cwd: string;
  workspaceSource: string;
};

/** HTTP 승인 정책 요약과 같다. 런타임 이름은 기존 호출부를 위해 남긴다. */

/** 현재 컨텍스트 창 점유량 — 턴 종료 후 ctx 이벤트 소스(§0.2 #26). */
export type ContextUsage = { totalTokens: number; maxTokens: number };

export type RuntimeModel = ModelInfo;

/**
 * 배경 작업 1회 실행의 모델 지정. 세 형태다.
 *   - `undefined`: 지금 동작 그대로(어댑터의 기존 자동 선택).
 *   - `account_default`: 계정 기본 모델로 한 번. 가격 순서 질문 전용이다. 자동 선택과 대체 모델을 거치지 않는다.
 *   - `explicit`: 이 모델, 이 effort로. 거부되면 다른 모델로 넘어가지 않고 `UnknownModelNameError`를 던진다.
 *     측정하려는 칸이 조용히 다른 모델로 바뀌면 측정이 무의미하기 때문이다.
 */
export type DistillOptions = undefined | { use: "account_default" } | { use: "explicit"; model: string; effort?: string };

/** 런타임이 대화를 받을 준비가 됐다는 최초 신호의 결과 — provider 중립. */
export type RuntimeHandshake = { models: readonly RuntimeModel[] };

export type ProviderUsage = UsageResponse;

/** 세션 실행 시작 옵션. runtime 생성 시 1회 확정(세션 lifecycle 동안 provider 고정 — §0.1-2). */
export type RuntimeStartOptions = {
  /**
   * 이 세션의 식별자. 첨부를 임시 파일로 만들어야 하는 provider가 **세션 전용 폴더**를 잡는 데 쓴다
   * (`sessions/attachments.ts`의 수명 계약). 세션이 끝나면 그 폴더를 통째로 지우면 되므로 누수가 안 생긴다.
   */
  sessionId: string;
  cwd: string;
  /** 미지정 = 계정 기본 모델. */
  model?: string;
  effort?: SessionEffort;
  /**
   * 시작 권한 모드. 시작값일 뿐이다 — 세션 중에는 `setPermissionMode`로 바뀐다.
   * 미지정 = 새 세션. 어댑터가 정한다(자동이 있으면 자동, 아니면 수동). `full`은 사용자가 명시한 경우만 온다.
   */
  permissionMode?: PermissionMode;
  /** 이어갈 세션 식별자(opaque) — Claude=SDK session_id, Codex=threadId(8e). 코어는 의미를 모른다. */
  resumeKey?: string;
  /**
   * 세션 시작 시 1회 고정되는 안내문의 provider 공통분(회상·메모리 스냅샷·스킬 안내).
   * runtime은 이 문자열을 그대로 붙인다. 특정 플러그인 명령 목록은 여기 넣지 않는다.
   */
  systemAppend?: string;
  /**
   * 매 턴 프롬프트 직전에 붙일 휘발성 컨텍스트(자동 회상)를 만드는 함수. 없으면 공통 주입 없음.
   *
   * **어떤 채널로 넣을지는 runtime이 정한다(D10 계약)** — 코어는 "이 문자열들을 이번 턴 모델 입력에 얹어라"만
   * 말하고 수단을 지정하지 않는다. Claude는 `UserPromptSubmit` 훅의 additionalContext를 쓰고, Codex의 채널은
   * 아직 미확정이다(`thread/inject_items` vs 입력 아이템 — R4, 8g에서 확정). 그래서 계약이 특정 채널을
   * 전제하지 않게 넓게 잡아둔다.
   *
   * 불변식: 주입은 **모델 입력에만** 들어간다. 영속본·SSE·UI에는 원본 유저 텍스트만 남는다.
   */
  turnContext?: (prompt: string) => string[] | Promise<string[]>;
  onPermission: (ask: PermissionAsk) => Promise<PermissionOutcome>;
  onQuestion: (ask: QuestionAsk) => Promise<QuestionOutcome>;
  /**
   * 계획 검토(runtime → 세션). 능력이 꺼진 runtime은 부르지 않는다.
   * 선택인 이유는 Claude/Codex처럼 이 표면이 없는 실행기가 있기 때문이다.
   */
  onPlan?: (ask: PlanAsk) => Promise<PlanOutcome>;
  /**
   * 작업 폴더를 분리했을 때 원래 고른 폴더. 없으면 이 세션은 분리되어 있지 않다.
   * 적용/폐기는 이 경로로 돌아간다. 코어는 분리 수단을 모른다.
   */
  workspaceSource?: string;
  /** resume 식별자를 가장 이른 시점에 알린다(멱등 — 같은 값 반복 호출 가능). */
  onResumeKey: (key: string) => void;
  /**
   * 모델 턴이 아닌 장기 명령의 수명주기(runtime → 세션).
   *
   * provider는 자기 프로토콜의 시작·완료 신호를 이 공통 사건으로 바꾼다. 화면은 명령 이름이나
   * provider RPC를 알 필요 없이 이 사건만 그린다. 선택인 이유는 모든 runtime이 장기 명령을
   * 제공하는 것은 아니기 때문이다.
   */
  onCommandOperation?: (operation: RuntimeCommandOperation) => void;
  /** Aether 할 일 도구가 받은 목록 전체를 세션에 알린다(runtime → 세션). 세션이 중립 사건으로 남긴다. */
  onTodoList?: (items: TodoItem[]) => void;
};

/**
 * provider 고유 *추가* 표면의 지원 여부. 핵심 기능을 숨기는 용도가 아니다.
 * supportedModels·usage는 부가 조회 API이고, 현재 REST가 그대로 노출한다.
 * planReview는 추가 기능이다. 화면은 능력이 켜진 세션만 그린다.
 * 작업 복사본은 실행기 능력이 아니다. 공통 디스크 모듈이 만든다.
 * 명령은 핵심 계약이라 빠졌다.
 */
export type RuntimeCapabilities = {
  supportedModels: boolean;
  usage: boolean;
  /** 계획문을 승인·수정요청·취소로 검토한다. */
  planReview: boolean;
};

/**
 * 세션이 지금 실행할 수 있는 슬래시 명령 1개.
 *
 * 목록의 정본은 provider adapter다. 공통 계층과 GUI는 명령 이름의 의미를 해석하지 않고 이 값을
 * 그대로 전달·표시한다. `startsTurn`은 실행 전에 화면이 진행 상태를 먼저 표시할 때만 쓴다.
 */
export type RuntimeCommand = SlashCommandInfo;

/** GUI가 고른 명령을 provider에 넘기는 중립 입력. `arguments`는 사용자가 직접 적은 원문이다. */
export type RuntimeCommandInvocation = { name: string; arguments: string };

/** 모델 턴과 별개로 실행되는 명령 작업의 상태. 문자열은 adapter가 채우고 core는 전달만 한다. */
export type RuntimeCommandOperation = {
  operationId: string;
  state: "started" | "completed" | "failed";
  detail: string;
  /** true면 완료 전 새 입력·명령을 받지 않는다. */
  blocksInput: boolean;
};

/**
 * 명령 실행 결과. 모르는 명령을 일반 대화로 되돌리지 않는다 — 그렇게 하면 Codex에서는 `/compact`가
 * 압축 RPC가 아니라 모델 프롬프트가 되어, 성공처럼 보이면서 실제 동작은 달라진다.
 */
export type RuntimeCommandResult =
  | { accepted: true; startsTurn: boolean }
  | { accepted: false; error: string };

export interface AgentRuntime {
  readonly provider: ProviderId;
  readonly capabilities: RuntimeCapabilities;
  /**
   * provider 원본 이벤트 스트림. 정규화는 하지 않는다(D2.4 — normalize는 중앙 모듈 단독 책임).
   *
   * ★ 단독 소비 계약: 이 스트림을 순회하는 곳은 `LiveSession.run()` **하나뿐**이다.
   *   ① 두 번째 소비자가 붙으면 이벤트가 둘로 갈린다. 한쪽이 받은 것은 다른 쪽에서 영영 사라지고,
   *      그 이벤트는 화면에도 디스크에도 안 남는다(대화 유실).
   *   ② 중간에 `break`로 빠져나오면 제너레이터의 `finally`가 돌아 모델 프로세스가 그대로 죽는다.
   *   그래서 "떴는지"를 알고 싶으면 여기가 아니라 `handshake()`(제어 채널)를 쓴다.
   */
  events(): AsyncIterable<RawProviderEventBody>;
  /**
   * 프로세스가 떠서 대화를 받을 준비가 됐다는 최초 신호까지 기다린다.
   *
   * ★ 계약: 턴을 소비하지 않고 `events()`를 절대 순회하지 않는다 — 제어 채널로만 구현할 것.
   *   실패하면 provider가 준 원문을 담아 reject한다. 여러 번 불러도 같은 결과를 준다(멱등).
   *
   * optional이 아닌 이유는 `effectivePermissionPolicy()`와 같다: "떴는가"는 모든 provider가 답해야 하는
   * 안전 표면이라, 모르는 provider가 조용히 "떴다고 치고" 넘어가면 안 된다.
   */
  handshake(): Promise<RuntimeHandshake>;
  /** 턴 입력. 실행 중이면 다음 턴으로 큐잉(의미는 양 provider 공통 — D5.5). */
  push(input: NormalizedUserInput): void;
  interrupt(): Promise<void>;
  /**
   * 메인 턴이 끝난 뒤에도 백그라운드 작업 하나를 멈춘다. 뒤 작업을 따로 멈출 수 있는 provider만 구현한다.
   * `interrupt()`와 다르다: 그쪽은 진행 중인 턴을 멈출 뿐 뒤 작업은 그대로 둘 수 있다.
   */
  stopBackgroundTask?(taskId: string): Promise<void>;
  /**
   * 세션 종료·삭제·서버 종료 시 이 runtime이 잡고 있는 자원을 전부 놓는다(D3).
   * 정리 대상: 입력 스트림·모델 프로세스(Codex는 세션당 1개 — D4)·임시 첨부 파일·보류 중인 승인 요청.
   * **멱등이어야 하고**, 이미 죽은 프로세스나 이미 지운 파일에도 안전해야 한다.
   * 호출부(LiveSession.dispose)는 결과를 기다리지 않는다 — 세션 삭제 경로가 동기여야 하기 때문이다.
   * 따라서 구현은 실패를 스스로 삼키고 로그로 남긴다(정리 실패가 삭제를 막지 않는다).
   */
  dispose(): Promise<void>;
  /** 다음 턴부터 적용(§0.2 #8). 핵심 기능이라 optional이 아니다(§0.1-5). */
  setModel(model: string): Promise<void>;
  /** 다음 턴부터 적용(§0.2 #9). 지원하지 않는 값은 조용히 무시하지 말고 오류로 거부한다(D12). */
  setEffort(effort: SessionEffort): Promise<void>;
  /**
   * 권한 모드를 바꾼다. 늦어도 다음 턴부터 적용한다.
   * 핵심 안전 조작이라 optional이 아니다 — 못 바꾸는 provider가 조용히 성공하면 화면이 거짓 상태를 보인다.
   * 목록에 없는 모드이거나 바꿀 수 없는 상황이면 오류로 거부하고, 이후 `effectivePermissionPolicy()`는 바뀐 값을 기준으로 답한다.
   */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * 이 세션이 지금 고를 수 있는 권한 모드와 실제 적용 중인 모드. 안전 판단(어느 모드가 가능한가)은 provider 몫이다.
   * 모델에 따라 목록이 달라질 수 있어(자동 모드 지원 여부) 모델을 바꾼 뒤에 다시 부른다.
   */
  permissionModes(): Promise<{ modes: readonly PermissionMode[]; current: PermissionMode }>;
  contextUsage(): Promise<ContextUsage>;
  /**
   * 이 세션에 실제로 적용 중인 승인 정책 요약(8d-3 ⑥ⓕ). 화면 배지의 출처다.
   * 핵심 안전 표시라 optional이 아니다 — 모르는 provider가 조용히 "없음"으로 보이면 안 된다.
   */
  effectivePermissionPolicy(): Promise<PermissionPolicy>;
  // ── capability 가드 대상(provider-native 조회 표면) ──
  //   모델 목록은 여기 없다 — `handshake()`가 이미 중립 목록으로 주므로 같은 일을 하는 문이 둘일 이유가 없다.
  //   `capabilities.supportedModels`는 "그 목록이 쓸 만한가"를 나타내는 표시로 남아 조회 라우트를 가른다.
  /** 중립 스키마로 돌려준다(8d-3 ④) — provider 원본 모양을 프론트까지 흘리지 않는다. */
  usage(): Promise<ProviderUsage>;
  /** 이 runtime이 지금 실제로 실행할 수 있는 명령만 돌려준다. */
  listCommands(): Promise<RuntimeCommand[]>;
  /** 명령 의미 해석과 provider 프로토콜 변환은 전적으로 adapter 책임이다. */
  executeCommand(command: RuntimeCommandInvocation): Promise<RuntimeCommandResult>;
  /** 이 Run의 공책 압축. 프로토콜 이름은 adapter만 안다. */
  compactContext(): Promise<void>;
}

export type AuthStatus = { loggedIn: boolean; email?: string; subscriptionType?: string };

/**
 * 로그인을 시작했을 때 사용자가 할 일 — provider마다 방향이 반대다(8f 확장).
 *
 * 8f 이전 계약은 한쪽만 가정했다. "서버가 주소를 주면 사용자가 코드를 받아 되돌려 보낸다"는 Claude 방식이다.
 * Codex의 기기 코드 로그인은 반대다. 서버가 주소와 코드를 **함께** 주고, 사용자는 아무것도 되돌려 보내지
 * 않으며, 끝났다는 사실은 나중에 알림으로 온다. 두 방향을 한 모양에 욱여넣으면 어느 한쪽이 거짓말을 하게
 * 되므로(코드 입력칸이 필요 없는데 있거나, 코드가 있는데 보여줄 자리가 없거나) 시작 결과에 방식을 적는다.
 */
export type LoginStart =
  /** 서버가 주소를 주고, 사용자가 그 화면에서 받은 코드를 `submitCode`로 되돌려 보낸다. */
  | { mode: "submitCode"; loginId: string; url: string }
  /** 서버가 주소와 코드를 함께 주고, 사용자는 그 화면에서 끝낸다. 완료 확인은 `poll`뿐이다. */
  | { mode: "deviceCode"; loginId: string; url: string; userCode: string };

/**
 * 진행 중인 로그인의 현재 상태.
 *
 * `deviceCode` 방식에는 완료를 알 통로가 이것뿐이다 — 완료가 provider의 비동기 알림으로 오는데,
 * 서버가 브라우저로 실시간으로 밀어 보내는 통로(SSE)는 대화 세션마다 붙는 것이고 로그인은 세션 밖에서
 * 일어나기 때문이다. 그래서 브라우저가 주기적으로 물어보는 방식으로 맞춘다.
 */
export type LoginProgress = { status: "pending" | "success" | "error"; message?: string };

/** provider 인증 — 상태 조회 + UI에서 완료 가능한 headless 로그인(D9). */
export interface ProviderAuth {
  status(): Promise<AuthStatus>;
  start(): Promise<LoginStart>;
  /**
   * `submitCode` 방식인 provider만 구현한다. 기기 코드 방식엔 되돌려 보낼 코드가 없으므로 이 함수가 없고,
   * 라우트는 그런 provider에 대한 코드 제출을 명시적으로 거부한다(빈 구현으로 성공한 척하지 않는다).
   */
  submitCode?(loginId: string, code: string): Promise<{ status: "success" | "invalid_code" | "error"; message: string }>;
  /**
   * 이 로그인이 끝났는가. 방식과 무관하게 모든 provider가 답한다 — optional로 두면 기기 코드 방식이
   * 완료를 알 방법이 없어지고, 그건 §0.1-5가 금지하는 "핵심 기능을 capability로 숨기기"다.
   * 모르는 loginId·이미 정리된 로그인은 `error`로 답한다(조용한 `pending`은 화면을 영원히 돌게 만든다).
   */
  poll(loginId: string): Promise<LoginProgress>;
  cancel(loginId?: string): void;
  /** 서버 종료 시 진행 중 로그인 정리(좀비 프로세스 방지). */
  disposeAll(): void;
}

export interface ProviderServices {
  readonly provider: ProviderId;
  /**
   * 사용자에게 보여줄 이름("Claude"·"Codex"). 안내문에 provider 이름을 박지 않으려고 둔다 —
   * 예를 들어 인증 만료 안내는 공통 경로에서 나가는데, 문구가 한 provider 이름을 고정하면
   * 다른 provider 세션의 사용자가 엉뚱한 서비스에 다시 로그인하러 간다.
   */
  readonly displayName: string;
  /** 새 세션 창이 계획 검토 카드를 그릴지. 없으면 그리지 않는다. */
  readonly planReview?: boolean;
  /**
   * 원격 대화형 인증을 UI에서 완료할 수 있는 provider만 구현한다.
   * API key 전용·외부 자격증명 전용 provider까지 빈 인증 구현을 만들게 하면 설정 화면에 죽은 버튼이 생긴다.
   */
  readonly auth?: ProviderAuth;
  /**
   * 백그라운드 경량 모델 1회 실행(도구 차단) — 자동 메모리 캡처·압축·검색요약·자동 스킬 생성 공용 엔진(D6).
   * 세션 provider를 따라야 하므로 호출측은 이 함수를 주입받는다(직접 구현 import 금지).
   */
  distill(prompt: string, cwd: string, opts?: DistillOptions): Promise<string>;
  /**
   * 턴을 쓰지 않는 모델 목록 조회 — 배경 작업 모델 측정용. 어댑터가 중립 필드(`followsAccountDefault`,
   * `movingAlias`)를 채운다. 배경 작업과 같은 실행 경로로 묻는다(실제로 쓸 별칭 대응이 나와야 한다).
   */
  listBackgroundModels(): Promise<RuntimeModel[]>;
  /**
   * 지금 이 provider로 세션을 열 수 있는가. 실행 프로그램, 로그인, 모델 서버처럼 세션 밖에서 확인할 수
   * 있는 것만 본다. 못 쓰면 새 세션 창이 그 줄을 흐리게 그리고, 세션 만들기 요청은 거절된다.
   */
  availability(): Promise<ProviderAvailability>;
  /** 부팅 때 살아 있는 세션이 없을 때 한 번 부른다. 강제 종료로 남은 이 provider의 임시 자원을 치운다. 던지지 않는다. */
  cleanupAtBoot?(): void;
}
