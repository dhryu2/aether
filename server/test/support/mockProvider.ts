/**
 * 가짜 세 번째 provider — 계약 테스트 수단(모델 호출 0).
 *
 * 목적: 실 Claude·실 Codex가 등록된 채로 세 번째 id를 끼워도, 세션 생성·정규화·영속·복원·
 * 턴 종료 판정·검색 색인이 코어를 한 줄도 안 고치고 성립해야 한다. 실 Codex 슬롯을 덮어쓰면
 * 세 번째 자리를 연 것이 아니다.
 *
 * 일부러 실구현과 다르게 잡은 것들(같게 만들면 검증이 헛돈다):
 *   - 원본 이벤트 모양: `{kind:"mock3", msg:{t, …}}` — `msg.type`도 `kind:"sdk"`도 아니다.
 *   - effort 어휘: `brisk|deep` — Claude의 low/medium/high…와 겹치지 않는다.
 *   - 이어가기 식별자 형식: `mock-…` — Claude의 UUID 형식이 아니다.
 *   - 영속 축소 규칙: 시크릿 표시가 붙은 이벤트 *다음* 이벤트를 가린다(이벤트 간 상태 + 재시작 재수화 검증).
 */
import fs from "node:fs";
import path from "node:path";
import { buildAgentEvents, type AgentEvent, type TodoStatus } from "../../../shared/agentEvent";
import { todoToolDef } from "../../knowledge/todoTool";
import type { ProviderEventCodec, ProviderPersistFilter, EventShape } from "../../sessions/codec/types";
import type { ProviderEntry } from "../../providers/registry";
import type {
  AgentRuntime,
  ContextUsage,
  NormalizedUserInput,
  PermissionPolicy,
  ProviderServices,
  RuntimeCommand,
  RuntimeCommandInvocation,
  RuntimeCommandResult,
  RuntimeCapabilities,
  RuntimeHandshake,
  RuntimeStartOptions,
} from "../../providers/types";
import type { PermissionMode } from "../../../shared/http";
import type { AetherEvent, RawProviderEventBody, SessionEffort } from "../../types";

/** 이 가짜 provider가 등록되는 자리 = 세 번째 id. 실 Codex와 동시에 있어야 한다. */
export const MOCK_PROVIDER = "mock3" as const;

/** 가짜 원본 이벤트 본문. Claude의 어떤 필드 이름과도 겹치지 않게 잡았다. */
export type MockRaw = {
  t: "say" | "peek" | "done" | "model" | "bg" | "start" | "limit" | "edit";
  text?: string;
  /** true면 "이 이벤트가 시크릿을 건드렸다" — 다음 say의 본문이 영속에서 가려져야 한다. */
  touchedSecret?: boolean;
  /** `t:"model"`일 때 스트림이 알려 준 실제 모델. 코어는 이걸 model_info로만 본다. */
  model?: string;
  /** `t:"bg"`일 때 지금 뒤에서 살아 있는 작업 id 전체(빈 배열 = 모두 끝남). `t:"start"`는 스스로 시작한 턴이다. */
  tasks?: string[];
  /** `t:"limit"`일 때 한도가 풀리는 시각(초 또는 ms). 없으면 시각을 모르는 막힘이다. */
  resetsAt?: number;
  /** `t:"done"`일 때 참이면 실패로 끝난 턴이다. */
  failed?: true;
  /** `t:"done"`일 때 참이면 사람이 멈춰서 끝난 턴이다. */
  interrupted?: true;
};

export const MOCK_REDACTED = "[mock-redacted]";
/** 이 가짜 provider가 "인증이 만료됐다"고 말하는 방식 — Claude·Codex 어느 문구와도 겹치지 않는다. */
export const MOCK_AUTH_EXPIRED = "mock-auth-gone";
export const MOCK_RESUME_KEY = "mock-thread-0001";
export const MOCK_EFFORTS: readonly SessionEffort[] = ["brisk", "deep"];

function rawOf(ev: EventShape): MockRaw | undefined {
  return ev.kind === MOCK_PROVIDER ? (ev.msg as MockRaw) : undefined;
}

/** 이벤트 간 상태를 드는 영속 축소기 — 세션당 1개(codec 본체는 순수). */
class MockPersistFilter implements ProviderPersistFilter {
  private armed = false; // 직전에 시크릿을 건드렸나

  /** 재시작 뒤 이미 영속된 꼬리를 관측해 상태만 되살린다(디스크 재기록 없음). */
  restore(ev: AetherEvent): void {
    const raw = rawOf(ev);
    if (!raw) return;
    if (raw.t === "say") this.armed = !!raw.touchedSecret;
  }

  apply(ev: AetherEvent): AetherEvent | null {
    const raw = rawOf(ev);
    if (!raw) return ev;
    if (raw.t === "peek") return null; // 라이브 전용은 애초에 여기 안 오지만 방어
    if (raw.t !== "say") return ev;
    const hide = this.armed;
    this.armed = !!raw.touchedSecret;
    return hide ? ({ ...ev, msg: { ...raw, text: MOCK_REDACTED } } as AetherEvent) : ev;
  }
}

export const mockCodec: ProviderEventCodec = {
  provider: MOCK_PROVIDER,
  normalize(ev: AetherEvent): AgentEvent[] {
    const raw = rawOf(ev);
    if (!raw) return [];
    if (raw.t === "say") return buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "text", text: raw.text ?? "" }]);
    if (raw.t === "peek") return buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "text_delta", text: raw.text ?? "" }]);
    if (raw.t === "model") {
      const model = raw.model?.trim();
      return model ? buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "model_info", model }]) : [];
    }
    if (raw.t === "bg") {
      const tasks = (raw.tasks ?? []).map((id) => ({ id, kind: "agent" as const, description: `작업 ${id}` }));
      return buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "background_tasks", tasks }]);
    }
    if (raw.t === "start") return buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "turn_started" }]);
    if (raw.t === "limit") {
      return buildAgentEvents(ev, MOCK_PROVIDER, [
        { type: "provider_notice", kind: "rate_limit", severity: "blocked", ...(raw.resetsAt ? { resetsAt: raw.resetsAt } : {}) },
      ]);
    }
    // 파일 변경 도구 호출 흉내: `text`가 대상 글 그대로다(여러 경로를 한 글로 이어 보내는 provider를 흉내내기도 쉽다).
    if (raw.t === "edit") {
      return buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "tool_call", toolId: `mock-edit-${ev.seq}`, name: "mock_write", toolKind: "file_change", target: raw.text }]);
    }
    return buildAgentEvents(ev, MOCK_PROVIDER, [{ type: "turn_completed", status: raw.interrupted ? "interrupted" : raw.failed ? "failed" : "ok" }]);
  },
  isLiveOnly: (ev) => rawOf(ev)?.t === "peek",
  endsTurn: (ev) => rawOf(ev)?.t === "done",
  // 만료 판정도 provider 어휘다 — 이 가짜 provider는 Claude·Codex 어느 문구도 쓰지 않는 자기 표시를 쓴다.
  // ★ 일부러 **턴을 끝내지 않는 이벤트**에 만료 표시를 단다. provider에 따라 만료는 턴 종료가 아니라
  //   별도 오류 알림으로 먼저 오기 때문이다. 세션이 턴 종료에서만 만료를 확인하면 그런 provider는
  //   재인증 배너가 영영 안 뜬다(2026-08-18 외부 검토에서 실제로 그 상태였다).
  isAuthExpired: (ev) => rawOf(ev)?.text === MOCK_AUTH_EXPIRED,
  persistFilter: () => new MockPersistFilter(),
};

export const mockServices: ProviderServices = {
  provider: MOCK_PROVIDER,
  displayName: "MockProvider",
  auth: {
    status: async () => ({ loggedIn: true, email: "mock@example.invalid" }),
    start: async () => ({ mode: "submitCode" as const, loginId: "mock-login", url: "https://example.invalid/mock" }),
    submitCode: async () => ({ status: "success" as const, message: "ok" }),
    poll: async (loginId: string) => (loginId === "mock-login" ? { status: "pending" as const } : { status: "error" as const, message: "unknown login" }),
    cancel: () => {},
    disposeAll: () => {
      mockState.authDisposed++;
    },
  },
  // 모델을 부르지 않는다 — 자동 학습 경로가 이 provider의 보조 모델을 타는지만 확인한다(D6).
  distill: async (prompt: string) => {
    mockState.distillCalls.push(prompt);
    return "";
  },
  listBackgroundModels: async () => [],
  availability: async () => ({ available: true }),
};

/** 테스트가 들여다보는 관측점(가짜 provider가 실제로 불렸는지). */
export const mockState = {
  distillCalls: [] as string[],
  authDisposed: 0,
  disposeCalls: 0,
  /** handshake가 불린 횟수 — 준비 대기가 이벤트 스트림이 아니라 이 제어 채널을 쓰는지 보는 관측점. */
  handshakeCalls: 0,
  /** handshake 응답을 일부러 늦추는 시간(ms). 대기 상한 검사용. */
  handshakeDelayMs: 0,
  /** 참이면 처음 준비 신호 결과를 그대로 다시 돌려준다(Codex·Grok runtime처럼). */
  reuseHandshake: false,
  commandCalls: [] as RuntimeCommandInvocation[],
  /** 참이면 이후 만드는 실행부가 뒤 작업 중지를 지원한다(없는 provider 흉내와 구분하는 노브). */
  stopBackgroundSupported: false,
  stoppedBackgroundTasks: [] as string[],
  /** 실행부 push가 불린 횟수 — 모델 호출이 0번인지 보는 관측점. */
  pushCalls: 0,
  /** 참이면 push가 글을 되돌려 주지 않고 턴도 닫지 않는다. 시험이 emitRaw로 직접 답한다. */
  manualReply: false,
  /** 참이면 멈춤이 성공이 아니라 실패한 턴으로 끝난다(멈춤을 따로 구분해 알리지 않는 provider 흉내). */
  interruptFails: false,
  /** 이 가짜 provider가 지금 고를 수 있다고 답하는 권한 모드. 자동을 빼면 자동이 없는 provider를 흉내 낸다. */
  permissionModes: ["manual", "edits", "auto", "full"] as PermissionMode[],
  /** 모드를 바꾸기 직전에 부르는 훅. 늦추거나 실패시켜 변경 경쟁을 재현한다. */
  permissionSetHook: undefined as ((mode: PermissionMode) => Promise<void>) | undefined,
  /** 참이면 권한 모드 조회가 실패한다(준비 신호·조회 실패 흉내). */
  permissionModesFail: false,
  /** 권한 모드 조회가 끝나기 전에 부르는 훅. 조회를 붙잡아 두어 요청 순서 경쟁을 재현한다. */
  permissionModesHook: undefined as (() => Promise<void>) | undefined,
  /** 어댑터가 받은 권한 모드 변경 기록. */
  permissionSets: [] as PermissionMode[],
};

/**
 * 대본대로 이벤트를 뱉는 실행부. 프로세스도 네트워크도 없다.
 * push된 텍스트 1건 = 미리보기(peek) → 본문(say) → 턴 종료(done) 순서로 방출한다.
 * 텍스트가 "SECRET"으로 시작하면 그 say에 시크릿 표시를 달아, 다음 say가 영속에서 가려지는지 볼 수 있게 한다.
 */
/** 별칭이 아니라 정식 id로만 부를 수 있는 두 번째 모델 — 이름 판정이 provider 몫인지 보는 값. */
export const MOCK_ALT_MODEL = "mock-large-2026";

/**
 * 이 가짜 provider가 "안다"고 답할 모델 목록. Claude와 다른 어휘로 잡았고, 별칭(`value`)과
 * 정식 id(`resolvedModel`)가 다른 줄을 일부러 넣었다 — 화면이 둘 중 하나로 맞춰보는지 확인하는 지점이다.
 */
export const MOCK_MODELS = [
  // 강도 설명도 provider가 준다(8i). 이 가짜 provider는 원문(`text`)만 주는 쪽을 흉내낸다 — Codex가 그렇다.
  //   `deep`은 일부러 비워 뒀다: 설명을 모르는 값이 섞여도 화면이 이름만 보여주고 버티는지 보는 지점이다.
  { value: "mock-small", displayName: "Mock Small", description: "가벼운 모델", isDefault: true, resolvedModel: "mock-small-2026", supportsEffort: true, supportedEffortLevels: MOCK_EFFORTS, supportedEffortDescriptions: { brisk: { text: "quick pass" } } },
  { value: MOCK_ALT_MODEL, displayName: "Mock Large", description: "무거운 모델", resolvedModel: MOCK_ALT_MODEL, supportsEffort: false },
] as const;

/** 가장 최근 가짜 실행기. 테스트가 스트림에 모델을 싣는 데 쓴다. */
export let lastMockRuntime: MockRuntime | null = null;

export class MockRuntime implements AgentRuntime {
  readonly provider = MOCK_PROVIDER;
  /** provider-native 조회 표면은 일부만 지원한다. 명령은 모든 runtime이 구현하는 핵심 계약이다. */
  readonly capabilities: RuntimeCapabilities = { supportedModels: true, usage: false, planReview: false };

  private readonly opts: RuntimeStartOptions;
  /** 뒤 작업 중지 — mockState.stopBackgroundSupported일 때만 생긴다(선택 메서드). */
  stopBackgroundTask?: (taskId: string) => Promise<void>;
  private queue: RawProviderEventBody[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private disposed = false;
  model?: string;
  effort?: SessionEffort;
  permissionMode: PermissionMode;

  constructor(opts: RuntimeStartOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
    // 미지정(새 세션)은 시험이 모드별 동작을 고르기 쉽게 자동으로 시작한다. 목록은 mockState.permissionModes로 바꾼다.
    this.permissionMode = opts.permissionMode ?? (mockState.permissionModes.includes("auto") ? "auto" : "manual");
    lastMockRuntime = this;
    if (mockState.stopBackgroundSupported) {
      this.stopBackgroundTask = async (taskId) => {
        mockState.stoppedBackgroundTasks.push(taskId);
        this.emit({ t: "bg", tasks: this.bgIds.filter((x) => x !== taskId) });
      };
    }
    // 이어가기 식별자는 가장 이른 시점에 알린다(멱등) — 코어가 이 문자열의 의미를 모르는지 확인하는 지점.
    opts.onResumeKey(opts.resumeKey ?? MOCK_RESUME_KEY);
  }

  /** 테스트가 스트림에 실제 모델을 싣는다. 코어는 원본이 아니라 model_info만 본다. */
  emitModel(model: string) {
    this.emit({ t: "model", model });
  }

  /** 테스트가 원본 이벤트를 직접 흘려 넣는다(뒤 작업·스스로 시작한 턴 재현용). */
  private bgIds: string[] = [];
  emitRaw(msg: MockRaw) {
    if (msg.t === "bg") this.bgIds = msg.tasks ?? [];
    this.emit(msg);
  }

  private emit(msg: MockRaw) {
    this.queue.push({ kind: MOCK_PROVIDER, msg });
    this.wake?.();
    this.wake = null;
  }

  async *events(): AsyncIterable<RawProviderEventBody> {
    for (;;) {
      if (this.queue.length === 0) {
        if (this.closed) return;
        await new Promise<void>((r) => (this.wake = r));
        if (this.closed && this.queue.length === 0) return;
      }
      yield this.queue.shift()!;
    }
  }

  push(input: NormalizedUserInput): void {
    const text = input.text;
    mockState.pushCalls++;
    if (mockState.manualReply) return;
    void (async () => {
      // 승인이 필요한 입력이면 카드를 띄우고 사용자 결정까지 기다린다(promise-hold — 권한 왕복 계약).
      if (text.startsWith("ASK:")) {
        const outcome = await this.opts.onPermission({
          toolName: "mock_write",
          input: { target: text.slice(4) },
          toolUseID: "mock-tool-1",
          signal: new AbortController().signal,
        });
        this.emit({ t: "say", text: outcome.allow ? "allowed" : "denied" });
        this.emit({ t: "done" });
        return;
      }
      // 할 일 도구 흉내: `TODO:상태:글|상태:글` → 실제 도구 처리 함수를 같은 맥락(콜백)으로 부른다.
      //   시험이 코어를 건드리지 않고 목록 사건을 만들게 하는 통로다. 상태가 틀린 입력도 그대로 넘겨 검사 경로를 탄다.
      if (text.startsWith("TODO:")) {
        const items = text.slice(5).split("|").filter(Boolean).map((part) => {
          const at = part.indexOf(":");
          return { status: part.slice(0, at) as TodoStatus, text: part.slice(at + 1) };
        });
        const out = await todoToolDef().handler({ items }, { cwd: this.opts.cwd, services: mockServices, sessionId: this.opts.sessionId, onTodoList: this.opts.onTodoList });
        this.emit({ t: "say", text: out.content[0].text });
        this.emit({ t: "done" });
        return;
      }
      // 한도 막힘 흉내: `LIMIT:<resetsAt>` → 한도 막힘 알림 뒤 실패로 끝나는 턴. resetsAt(초 또는 ms)은 생략할 수 있다.
      //   Claude처럼 막힘 알림이 실패보다 먼저 오는 순서다.
      if (text.startsWith("LIMIT:")) {
        const resetsAt = Number(text.slice(6));
        this.emit({ t: "limit", ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}) });
        this.emit({ t: "done", failed: true });
        return;
      }
      this.emit({ t: "peek", text: text.slice(0, 3) }); // 라이브 전용(영속·replay 제외 대상)
      this.emit({ t: "say", text, touchedSecret: text.startsWith("SECRET") });
      this.emit({ t: "done" });
      // 승인 대기가 거절 대신 reject로 끝나도 처리 안 된 promise를 남기지 않는다(테스트 산발 실패 방지).
    })().catch((e) => {
      console.error("[mock] push 처리 실패:", e);
      this.emit({ t: "done" }); // 턴은 반드시 닫아 대기 중인 검사가 매달리지 않게
    });
  }

  async interrupt(): Promise<void> {
    this.emit(mockState.interruptFails ? { t: "done", failed: true } : { t: "done" });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return; // 멱등
    this.disposed = true;
    mockState.disposeCalls++;
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  /**
   * 모델 이름의 유효성은 **provider가 판정한다** — 서버 쪽 목록 대조가 사라졌으므로, 없는 이름을 거부하는
   * 책임이 여기로 왔다. 거부 문구는 사용자에게 그대로 보이므로 어떤 이름이 막혔는지 적는다.
   */
  async setModel(model: string): Promise<void> {
    if (!MOCK_MODELS.some((m) => m.value === model || m.resolvedModel === model)) {
      throw new Error(`mock: "${model}"은(는) 아는 모델 이름이 아니다`);
    }
    this.model = model;
  }
  async setEffort(effort: SessionEffort): Promise<void> {
    if (!MOCK_EFFORTS.includes(effort)) throw new Error(`mock: 지원하지 않는 effort ${effort}`); // 조용한 무시 금지(D12)
    this.effort = effort;
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await mockState.permissionSetHook?.(mode);
    if (!mockState.permissionModes.includes(mode)) throw new Error(`mock: 지원하지 않는 권한 모드 ${mode}`); // 조용한 무시 금지
    mockState.permissionSets.push(mode);
    this.permissionMode = mode;
  }
  async permissionModes(): Promise<{ modes: readonly PermissionMode[]; current: PermissionMode }> {
    await mockState.permissionModesHook?.();
    if (mockState.permissionModesFail) throw new Error("mock: 권한 모드 조회 실패");
    return { modes: mockState.permissionModes, current: this.permissionMode };
  }
  async contextUsage(): Promise<ContextUsage> {
    return { totalTokens: 1234, maxTokens: 10000 };
  }

  /**
   * 실효 승인 정책 요약(8d-3 ⑥ⓕ) — **Claude와 전혀 다른 출처에서** 계산한다.
   * Claude는 `.claude/settings.json`의 `permissions.allow`를 보지만 이쪽은 `<cwd>/.mock/approvals.json`을 본다.
   * 계약이 provider 중립인지(코어·화면이 Claude의 설정 파일 모양을 전제하지 않는지) 확인하는 지점이다.
   */
  async effectivePermissionPolicy(): Promise<PermissionPolicy> {
    let rules = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.opts.cwd, ".mock", "approvals.json"), "utf8")) as { allow?: unknown };
      rules = Array.isArray(parsed.allow) ? parsed.allow.length : 0;
    } catch {
      rules = 0; // 파일이 없으면 자동승인 없음
    }
    return { bypassAll: this.permissionMode === "full", autoApproveRules: rules, sources: rules > 0 ? ["project"] : [] };
  }

  /**
   * "대화를 받을 준비가 됐다"는 최초 신호. 여기서도 **이벤트 스트림을 건드리지 않는다** — 계약대로
   * 제어 채널만 쓴다(이 가짜 구현에선 그냥 목록을 돌려주는 것). 여러 번 불러도 같은 값이다.
   */
  async handshake(): Promise<RuntimeHandshake> {
    mockState.handshakeCalls++;
    // 느린 기동을 흉내 내는 노브 — 대기 상한이 실제로 걸리는지 보려면 답을 늦출 수 있어야 한다.
    if (mockState.handshakeDelayMs > 0) await new Promise<void>((r) => setTimeout(r, mockState.handshakeDelayMs));
    if (mockState.reuseHandshake) return (this.cachedHandshake ??= { models: MOCK_MODELS.map((m) => ({ ...m })) });
    return { models: MOCK_MODELS.map((m) => ({ ...m })) };
  }
  private cachedHandshake: RuntimeHandshake | undefined;

  // capability가 false인 표면 — 라우트가 호출하기 전에 막아야 한다. 불리면 그 자체가 게이트 실패의 증거다.
  private unsupported(): never {
    throw new Error("mock: 지원하지 않는 조회");
  }
  async usage() { return this.unsupported(); }
  async listCommands(): Promise<RuntimeCommand[]> {
    return [
      { name: "mock-ping", description: { text: "mock command" }, argumentHint: { text: "[text]" }, startsTurn: false },
      { name: "mock-turn", description: { text: "mock turn command" }, argumentHint: { text: "[text]" }, startsTurn: true },
      { name: "mock-operation", description: { text: "mock operation" }, argumentHint: {}, startsTurn: false },
      { name: "clear", description: { text: "mock clear" }, argumentHint: {}, startsTurn: false },
    ];
  }
  async executeCommand(command: RuntimeCommandInvocation): Promise<RuntimeCommandResult> {
    if (command.name !== "mock-ping" && command.name !== "mock-turn" && command.name !== "mock-operation" && command.name !== "clear") return { accepted: false, error: `mock: unsupported command /${command.name}` };
    mockState.commandCalls.push({ ...command });
    if (command.name === "mock-operation") {
      const operationId = "mock-operation-1";
      this.opts.onCommandOperation?.({ operationId, state: "started", detail: "mock working", blocksInput: true });
      setTimeout(() => this.opts.onCommandOperation?.({ operationId, state: "completed", detail: "mock done", blocksInput: true }), 15);
    }
    return { accepted: true, startsTurn: command.name === "mock-turn" };
  }

  async compactContext(): Promise<void> {
    return Promise.resolve();
  }
}

/** 등록표에 넣을 항목. `__registerProviderForTest(mockEntry)`로 끼우고 반환된 함수로 뺀다. */
export const mockEntry: ProviderEntry = {
  id: MOCK_PROVIDER,
  services: mockServices,
  codec: mockCodec,
  // Claude의 UUID 형식과 겹치지 않는다 — 형식 판정이 provider 몫인지 확인하는 지점(D12).
  isValidResumeKey: (key) => /^mock-[a-z0-9-]+$/i.test(key),
  createRuntime: (opts) => new MockRuntime(opts),
};
