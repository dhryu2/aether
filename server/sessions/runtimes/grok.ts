import { failuresFor, FailureTracker } from "../../providers/failureTracking";
import { reportError } from "../../observability/report";
/**
 * GrokRuntime — Grok 세션 1개의 실행부(Phase 10c · D3/D4/D5, 10e 지식·회상).
 *
 * 세션마다 `grok agent --no-leader stdio` 프로세스 하나. 완료 전 다음 session/prompt를 보내지 않는다.
 * 지식 도구는 Codex와 같은 HTTP 창구를 헤더 토큰으로만 붙인다. 회상은 모델 입력에만 넣는다.
 */
import { randomUUID } from "node:crypto";
import { isBlankAssistantText } from "../../../shared/blankAssistantText";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { st } from "../../i18n";
import { buildKnowledgeTools } from "../../knowledge/tools";
import { grokAgentArgs } from "../../providers/grok/args";
import { grokMenuCommands, withGrokBuiltins } from "../../providers/grok/commands";
import { readGrokModels } from "../../providers/grok/models";
import { GROK_SESSION_EXTRA, grokAuthHome, grokChildEnv } from "../../providers/grok/env";
import { usageFromGrokBilling } from "../../providers/grok/billingUsage";
import { grokErrorStatus, grokLimitResetsAt, grokRateLimitKind } from "../../providers/grok/errorOrigin";
import { contextUsageFromGrokNotice } from "../../providers/grok/contextUsage";
import { grokPermissionPolicy } from "../../providers/grok/permissionPolicy";
import { grokServices } from "../../providers/grok/services";
import { MCP_SERVER_NAME, openKnowledgeBridge, type KnowledgeBridge } from "../../providers/knowledgeBridge";
import {
  GROK_CLIENT_INFO,
  GrokStdio,
  GrokRpcError,
  type GrokNotification,
  type GrokServerRequest,
} from "../../providers/grok/transport";

import { AttachmentStore, type MaterializedAttachment } from "../attachments";
import { previewFromDisk } from "../mutationPreview";
import { mapQuestionOption } from "../questionParse";
import type { AetherQuestion, PermissionMode } from "../../../shared/http";
import type { DocAttachment, ImageAttachment, RawProviderEventBody, SessionEffort } from "../../types";
import type {
  AgentRuntime,
  ContextUsage,
  NormalizedUserInput,
  PermissionAsk,
  PermissionPolicy,
  PlanAsk,
  PlanOutcome,
  ProviderUsage,
  QuestionAsk,
  QuestionOutcome,
  RuntimeCommand,
  RuntimeCommandInvocation,
  RuntimeCommandResult,
  RuntimeCapabilities,
  RuntimeHandshake,
  RuntimeModel,
  RuntimeStartOptions,
} from "../../providers/types";

const failures = new FailureTracker();
const jsonFailures = new FailureTracker();

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob?: string; text?: string; name?: string } };

const KNOWLEDGE_TOOL_RE = /\b(session_search)\b/;

type QueuedTurn = { prompt: ContentBlock[]; files: MaterializedAttachment[]; userText: string };

type GrokMsg = { method: string; params?: unknown };

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};
function extOf(mediaType: string): string {
  return EXT_BY_MIME[mediaType] ?? ".bin";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    const text = JSON.stringify(v);
    jsonFailures.clear("session.json.encode");
    return text;
  } catch (error) {
    jsonFailures.report(error, { component: "session", operation: "session.json.encode", severity: "warning" });
    return String(v);
  }
}

function toolNamesOf(toolCall: Record<string, unknown>, raw: Record<string, unknown>): string[] {
  return [toolCall.toolName, toolCall.name, toolCall.title, toolCall.kind, raw.tool, raw.name]
    .filter((v): v is string => typeof v === "string");
}

function isPlanEnter(toolCall: Record<string, unknown>, raw: Record<string, unknown>): boolean {
  return toolNamesOf(toolCall, raw).some((n) => /enter[_ ]?plan[_ ]?mode/i.test(n));
}

function isPlanExit(toolCall: Record<string, unknown>, raw: Record<string, unknown>): boolean {
  return toolNamesOf(toolCall, raw).some((n) => /exit[_ ]?plan[_ ]?mode/i.test(n));
}

function isExitPlanMethod(method: string): boolean {
  return method === "_x.ai/exit_plan_mode" || method === "x.ai/exit_plan_mode";
}

function planTextFrom(v: unknown): string {
  if (typeof v === "string" && v.trim()) return v;
  const rec = asRecord(v);
  if (!rec) return "";
  for (const key of ["plan", "content", "text", "planContent", "plan_content"]) {
    const hit = rec[key];
    if (typeof hit === "string" && hit.trim()) return hit;
  }
  return "";
}

function grokPlanReply(out: PlanOutcome): { outcome: "approved" | "cancelled" | "abandoned" } {
  if (out.decision === "approve") return { outcome: "approved" };
  if (out.decision === "revise") return { outcome: "cancelled" };
  return { outcome: "abandoned" };
}

function planFilePathOf(update: Record<string, unknown>): string {
  const raw = asRecord(update.rawOutput);
  const entered = asRecord(raw?.Entered) ?? asRecord(asRecord(raw?.EnterPlanMode)?.Entered);
  const p = entered?.plan_file_path ?? raw?.plan_file_path ?? update.plan_file_path;
  return typeof p === "string" && p.trim() ? p : "";
}

function sessionUpdateOf(n: GrokNotification): Record<string, unknown> | null {
  if (n.method !== "session/update") return null;
  const params = asRecord(n.params);
  return params ? asRecord(params.update) : null;
}

function optionIdOf(o: Record<string, unknown>): string | undefined {
  return typeof o.optionId === "string" && o.optionId ? o.optionId : undefined;
}

/**
 * 한 번만 허용이 있으면 그걸 고른다. 없으면 세션 허용(`allow-edits-session` 등)도 받는다.
 * 세션 허용만 있는데 건너뛰면 사용자가 허용해도 Grok은 cancelled가 된다.
 */
export function pickOptionId(options: unknown, want: "allow" | "deny"): string | undefined {
  const opts = Array.isArray(options) ? options.map(asRecord).filter((o): o is Record<string, unknown> => !!o) : [];
  const kindPrefix = want === "allow" ? "allow" : "reject";
  const kindOf = (o: Record<string, unknown>) => String(o.kind ?? "");
  const once = opts.find((o) => kindOf(o) === `${kindPrefix}_once` || kindOf(o) === `${kindPrefix}-once`);
  const nonSession = opts.find((o) => {
    const kind = kindOf(o);
    return kind.startsWith(kindPrefix) && !/session|always|edits/i.test(kind);
  });
  const any = opts.find((o) => kindOf(o).startsWith(kindPrefix));
  const picked = once ?? nonSession ?? any;
  return picked ? optionIdOf(picked) : undefined;
}

function parseQuestions(params: unknown): AetherQuestion[] {
  const rec = asRecord(params);
  const raw = rec?.questions ?? rec?.questionnaire ?? rec?.items;
  const list = Array.isArray(raw) ? raw : rec && (rec.question || rec.prompt) ? [rec] : [];
  const out: AetherQuestion[] = [];
  for (const item of list) {
    const q = asRecord(item) ?? { question: String(item) };
    const question = String(q.question ?? q.prompt ?? q.text ?? q.header ?? "").trim();
    if (!question) continue;
    const optsRaw = Array.isArray(q.options) ? q.options : [];
    const options = optsRaw.map(mapQuestionOption).filter((o): o is NonNullable<typeof o> => !!o);
    out.push({
      question,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      ...(q.allow_multiple === true || q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

/**
 * `_x.ai/ask_user_question` JSON-RPC 결과.
 *
 * 실측(2026-08-23): `answers`를 배열로 내면 Grok이
 * `invalid type: sequence, expected a map`으로 도구를 실패시키고, 모델은 답을 못 받아
 * 같은 질문을 글으로 다시 묻는다. 질문 본문을 열쇠로 하는 맵이다.
 * 고르지 않으면 `skip_interview`(내부 태그 SkipInterview). `cancelled`+빈 배열은 같은 오류다.
 */
export function grokAskUserQuestionReply(questions: AetherQuestion[], out: QuestionOutcome): Record<string, unknown> {
  if (!out.answered) return { outcome: "skip_interview" };
  const answers: Record<string, string[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = out.answers[i];
    const key = q.question.trim() || String(i);
    const picked = [...(a?.chosen ?? [])];
    if (a?.custom) picked.push(a.custom);
    answers[key] = picked;
  }
  // Accepted 변형은 필드 2개(실측 type dump). 제출 시점엔 고른 답이 곧 전부라 같은 맵을 넣는다.
  return { outcome: "accepted", answers, partial_answers: answers };
}

function abortAny(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const c = new AbortController();
  const onAbort = () => c.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return c.signal;
}

function grokAskToolNamed(update: Record<string, unknown>): boolean {
  const raw = asRecord(update.rawOutput) ?? asRecord(update.rawInput) ?? {};
  const blob = [update.title, update.kind, update.toolName, raw.type, raw.variant].map((v) => String(v ?? "")).join(" ");
  return /ask[_ ]?user[_ ]?question/i.test(blob);
}

function grokAskToolId(update: Record<string, unknown>): string {
  if (typeof update.toolCallId === "string" && update.toolCallId) return update.toolCallId;
  if (typeof update.id === "string" && update.id) return update.id;
  return "";
}

/** Grok이 역방향 대기 도구를 끝냈는지. 끝나면 화면 카드도 닫아야 한다. */
export function grokReverseToolSettled(update: Record<string, unknown>, heldToolId: string, named?: (u: Record<string, unknown>) => boolean): boolean {
  if (String(update.sessionUpdate ?? "") !== "tool_call_update") return false;
  if (!/complet|fail|error|cancel|reject|denied/i.test(String(update.status ?? ""))) return false;
  const id = grokAskToolId(update);
  if (heldToolId && id && heldToolId === id) return true;
  return named ? named(update) : false;
}

/** Grok이 질문 도구를 끝냈는지. 끝나면 화면 카드도 닫아야 한다. */
export function grokAskToolSettled(update: Record<string, unknown>, heldToolId: string): boolean {
  return grokReverseToolSettled(update, heldToolId, grokAskToolNamed);
}

export class GrokRuntime implements AgentRuntime {
  readonly provider = "grok" as const;
  readonly capabilities: RuntimeCapabilities = {
    supportedModels: true,
    usage: true,
    planReview: true,
  };

  private readonly opts: RuntimeStartOptions;
  private readonly attachments: AttachmentStore;
  private stdio: GrokStdio;
  private bridge: KnowledgeBridge | null = null;

  private booted: Promise<RuntimeHandshake> | null = null;
  private sessionId: string | null = null;
  private models: RuntimeModel[] = [];
  private model?: string;
  private effort?: SessionEffort;

  private readonly queue: QueuedTurn[] = [];
  private prompting = false;
  private pumping = false;
  private preparing = false;
  private cancelPending = false;

  private lastUsage: ContextUsage | null = null;
  /** handshake/available_commands가 준 것 중 Aether가 지금 실행할 수 있는 목록. */
  private advertisedCommands: RuntimeCommand[] = [];
  /** 세션 사건으로 마지막 전달한 명령 목록. handshake 상태와 분리해 첫 알림은 반드시 한 번 남긴다. */
  private lastEmittedCommandSignature: string | null = null;
  private disposed = false;
  private turnAbort: AbortController | null = null;
  private askHold: { abort: AbortController; toolId: string } | null = null;
  private permHold: { abort: AbortController; toolId: string } | null = null;
  private planHold: { abort: AbortController; toolId: string } | null = null;
  private lastAskToolId = "";
  private lastPlanToolId = "";
  private messageBuf = "";
  private thoughtBuf = "";
  private lastPlanText = "";
  private lastPlanPath = "";
  /** initialize.promptCapabilities.image. 꺼져 있으면 이미지 블록 대신 첨부 자원으로 보낸다. */
  private promptImage = false;
  private respawning = false;
  /** 지금 적용 중인 권한 모드. 시작값은 opts에서 오고(미지정 = 새 세션은 자동) `setPermissionMode`로 바뀐다. */
  private permissionMode: PermissionMode;

  private readonly pending: RawProviderEventBody[] = [];
  private wake: (() => void) | null = null;
  private streamEnded = false;
  private streamError: Error | null = null;

  constructor(opts: RuntimeStartOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
    this.permissionMode = opts.permissionMode ?? "auto";
    this.attachments = new AttachmentStore(opts.sessionId);
    this.stdio = this.openStdio();
  }

  handshake(): Promise<RuntimeHandshake> {
    return this.ready();
  }

  private ready(): Promise<RuntimeHandshake> {
    return (this.booted ??= this.boot());
  }

  private openStdio(): GrokStdio {
    return new GrokStdio({
      args: grokAgentArgs({ model: this.model, effort: this.effort, permissionMode: this.permissionMode }),
      env: grokChildEnv(GROK_SESSION_EXTRA),
      onNotification: (n) => this.onNotification(n),
      onServerRequest: (r) => this.onServerRequest(r),
      onExit: (info) => this.onExit(info),
    });
  }

  private async boot(): Promise<RuntimeHandshake> {
    const init = await this.stdio.request<Record<string, unknown>>("initialize", {
      protocolVersion: 1,
      clientInfo: GROK_CLIENT_INFO,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.models = this.readModels(init);
    const caps = asRecord(init.agentCapabilities);
    const promptCaps = asRecord(caps?.promptCapabilities);
    this.promptImage = promptCaps?.image === true;
    if (!this.model) this.model = this.models.find((m) => m.isDefault)?.value ?? this.models[0]?.value;
    this.ingestAvailableCommands(asRecord(init._meta)?.availableCommands);
    if (!this.bridge) {
      const bridge = await this.openBridge();
      if (this.disposed) {
        bridge?.dispose();
        throw new Error(st("notice.grok.notReady"));
      }
      this.bridge = bridge;
    }
    const sessionParams = this.sessionNewParams();
    try {
      const resumeId = this.sessionId ?? this.opts.resumeKey;
      const sess = resumeId
        ? await this.stdio.request<{ sessionId?: string }>("session/resume", { sessionId: resumeId, ...sessionParams })
        : await this.stdio.request<{ sessionId?: string }>("session/new", sessionParams);
      const id = sess?.sessionId ?? resumeId;
      if (!id || typeof id !== "string") throw new Error(st("notice.grok.noSessionId"));
      this.sessionId = id;
      this.opts.onResumeKey(id);
      return { models: this.models };
    } catch (e) {
      if (!this.respawning) {
        this.bridge?.dispose();
        this.bridge = null;
      }
      throw e;
    }
  }

  /**
   * 이 세션의 지식툴 창구를 연다. 켜진 도구가 없으면 붙이지 않는다.
   * 토큰은 세션 열기 헤더로만 가고, 자식 환경에는 두지 않는다.
   */
  private async openBridge(): Promise<KnowledgeBridge | null> {
    const tools = buildKnowledgeTools();
    if (!tools.length) return null;
    const bridge = await openKnowledgeBridge({
      sessionId: this.opts.sessionId,
      cwd: this.opts.cwd,
      services: grokServices,
      engine: this.provider,
      tools,
      onTodoList: this.opts.onTodoList,
      approve: async (def, args) => {
        const out = await this.opts.onPermission({
          toolName: def.name,
          displayName: st("notice.grok.tool.knowledge", { name: def.name }),
          input: args,
          toolUseID: `knowledge-${randomUUID()}`,
          signal: this.turnSignal(),
        });
        return out.allow ? { allow: true } : { allow: false, message: out.message };
      },
    });
    if (this.disposed) {
      bridge?.dispose();
      return null;
    }
    return bridge;
  }

  private readModels(init: Record<string, unknown>): RuntimeModel[] {
    return readGrokModels(init);
  }

  push(input: NormalizedUserInput): void {
    if (this.disposed) return;
    this.queue.push(this.prepare(input));
    void this.pump();
  }

  private prepare(input: NormalizedUserInput): QueuedTurn {
    const files: MaterializedAttachment[] = [];
    const prompt: ContentBlock[] = [];
    if (input.text.trim()) prompt.push({ type: "text", text: input.text });
    for (const im of input.images ?? []) {
      if (this.promptImage) {
        prompt.push({ type: "image", mimeType: im.media_type, data: im.data });
        continue;
      }
      const f = this.materialize(im);
      if (f) files.push(f);
      prompt.push({
        type: "resource",
        resource: {
          uri: f ? pathToFileURL(f.path).href : `aether://image/${im.media_type}`,
          mimeType: im.media_type,
          blob: im.data,
          name: `image${extOf(im.media_type)}`,
        },
      });
    }
    for (const d of input.documents ?? []) {
      const f = this.materialize(d);
      if (f) files.push(f);
      prompt.push({
        type: "resource",
        resource: {
          uri: f ? pathToFileURL(f.path).href : `aether://doc/${d.name}`,
          mimeType: d.media_type,
          blob: d.data,
          name: d.name,
        },
      });
    }
    if (!prompt.length) prompt.push({ type: "text", text: input.text });
    return { prompt, files, userText: input.text };
  }

  private materialize(att: ImageAttachment | DocAttachment): MaterializedAttachment | null {
    try {
      return this.attachments.materialize(att.data, extOf(att.media_type));
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "provider.grok.attachments_prepare", session_id: this.opts.sessionId }); console.error("[aether] Grok 첨부 임시 파일 생성 실패(첨부 없이 진행):", e);
      return null;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.prompting || this.disposed || this.queue.length === 0) return;
    this.pumping = true;
    let resume = false;
    try {
      await this.ready();
      if (this.disposed || this.prompting || this.queue.length === 0 || !this.sessionId) return;
      const job = this.queue.shift()!;
      this.activeFiles(job.files);
      this.preparing = true;
      const prompt = await this.withTurnContext(job);
      if (this.disposed || this.cancelPending) {
        this.cancelPending = false;
        this.finishTurn();
        if (!this.disposed) {
          this.emitMsg({ method: "session/prompt_result", params: { stopReason: "cancelled" } });
          resume = true;
        }
      } else {
        this.prompting = true;
        this.messageBuf = "";
        this.thoughtBuf = "";
        this.emitMsg({ method: "session/prompt_started", params: { sessionId: this.sessionId } });
        let stopReason = "end_turn";
        let error: string | undefined;
        let limit: { errorStatus?: number; resetsAt?: number } = {};
        try {
          const result = await this.stdio.request<{ stopReason?: string }>("session/prompt", { sessionId: this.sessionId, prompt }, 0);
          stopReason = result?.stopReason ?? "end_turn";
        } catch (e) {
          void reportError(e, { component: "session", operation: "session.turn", session_id: this.opts.sessionId, model: this.opts.model, provider: "grok" });
          stopReason = "failed";
          error = String((e as Error)?.message ?? e);
          limit = await this.rateLimitInfo(e, error);
        }
        this.flushBuffers();
        this.emitMsg({ method: "session/prompt_result", params: { stopReason, ...(error ? { error } : {}), ...limit } });
        this.finishTurn();
        resume = true;
      }
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.turn.start", session_id: this.opts.sessionId, model: this.opts.model, provider: "grok" });
      this.finishTurn();
      this.emitMsg({ method: "error", params: { message: st("notice.grok.turnFailed", { error: String((e as Error)?.message ?? e) }) } });
      this.emitMsg({ method: "session/prompt_result", params: { stopReason: "failed", error: String((e as Error)?.message ?? e) } });
      resume = true;
    } finally {
      this.prompting = false;
      this.preparing = false;
      this.pumping = false;
    }
    if (resume && !this.disposed) void this.pump();
  }

  /**
   * 실패한 턴이 한도 오류면 상태 숫자와 풀리는 시각을 prompt_result에 싣는다(정규화가 중립 한도 알림으로 바꾼다).
   * 시각은 요금 조회(5초 제한)로 구하고, 조회가 실패하면 시각 없이 둔다.
   * shortcut: 판별은 errorOrigin의 임시 문구·상태 판별을 따른다.
   */
  private async rateLimitInfo(e: unknown, message: string): Promise<{ errorStatus?: number; resetsAt?: number }> {
    const errorStatus = grokErrorStatus(e);
    const kind = grokRateLimitKind(message, errorStatus);
    if (!kind) return {};
    let resetsAt: number | undefined;
    if (kind !== "plan") {
      try {
        resetsAt = grokLimitResetsAt(kind, usageFromGrokBilling(await this.stdio.request("_x.ai/billing", {}, 5000)));
      } catch {
        /* 시각을 못 구하면 간격 규칙으로 간다 */
      }
    }
    return { ...(errorStatus !== undefined ? { errorStatus } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
  }

  private activeHeld: MaterializedAttachment[] = [];
  private activeFiles(files: MaterializedAttachment[]) {
    this.activeHeld = files;
  }

  private flushBuffers() {
    if (this.thoughtBuf.trim()) {
      this.emitMsg({
        method: "session/update",
        params: { sessionId: this.sessionId, update: { sessionUpdate: "agent_thought", content: { type: "text", text: this.thoughtBuf } } },
      });
    }
    if (this.messageBuf.trim()) {
      this.emitMsg({
        method: "session/update",
        params: { sessionId: this.sessionId, update: { sessionUpdate: "agent_message", content: { type: "text", text: this.messageBuf } } },
      });
    }
    this.messageBuf = "";
    this.thoughtBuf = "";
  }

  private releaseHold(hold: { abort: AbortController; toolId: string } | null, abort: boolean): null {
    if (abort && hold && !hold.abort.signal.aborted) hold.abort.abort();
    return null;
  }

  private finishTurn() {
    this.askHold = this.releaseHold(this.askHold, false);
    this.permHold = this.releaseHold(this.permHold, false);
    this.planHold = this.releaseHold(this.planHold, false);
    this.turnAbort?.abort();
    this.turnAbort = null;
    for (const f of this.activeHeld) f.release();
    this.activeHeld = [];
  }

  async interrupt(): Promise<void> {
    // 질문·권한·계획 카드는 JSON-RPC가 끝날 때까지 기다리지 않는다. Grok이 cancel을 나중에 처리해도
    //   화면은 바로 넘어가야 한다.
    this.askHold = this.releaseHold(this.askHold, true);
    this.permHold = this.releaseHold(this.permHold, true);
    this.planHold = this.releaseHold(this.planHold, true);
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (!this.sessionId || !this.prompting) {
      if (this.preparing || this.pumping) this.cancelPending = true;
      return;
    }
    this.stdio.notify("session/cancel", { sessionId: this.sessionId });
  }

  async setModel(model: string): Promise<void> {
    await this.ready();
    const found = this.models.find((m) => m.value === model || m.displayName === model);
    if (this.models.length && !found) throw new Error(st("notice.grok.modelUnknown", { model }));
    const next = found?.value ?? model;
    if (next === this.model) return;
    const previous = this.model;
    this.model = next;
    try {
      await this.respawnProcess();
    } catch (e) {
      this.model = previous;
      throw e;
    }
  }

  async setEffort(effort: SessionEffort): Promise<void> {
    await this.ready();
    const current = this.models.find((m) => m.value === this.model) ?? this.models.find((m) => m.isDefault);
    const allowed = current?.supportedEffortLevels ?? [];
    if (allowed.length && !allowed.includes(effort)) {
      throw new Error(st("notice.grok.effortUnsupported", { model: current?.value ?? "?", effort, allowed: allowed.join(", ") }));
    }
    if (!allowed.length && this.models.length) {
      throw new Error(st("notice.grok.effortUnavailable", { model: current?.value ?? "?" }));
    }
    if (effort === this.effort) return;
    const previous = this.effort;
    this.effort = effort;
    try {
      await this.respawnProcess();
    } catch (e) {
      this.effort = previous;
      throw e;
    }
  }

  /** 권한 모드는 실행 인자와 세션 열기 설정에 박히므로 모델·강도 변경처럼 프로세스를 다시 띄운다. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.ready();
    if (mode === this.permissionMode) return;
    const previous = this.permissionMode;
    this.permissionMode = mode;
    try {
      await this.respawnProcess();
    } catch (e) {
      this.permissionMode = previous;
      throw e;
    }
  }

  /** Grok CLI는 네 모드를 모두 가진다. */
  async permissionModes(): Promise<{ modes: readonly PermissionMode[]; current: PermissionMode }> {
    return { modes: ["manual", "edits", "auto", "full"], current: this.permissionMode };
  }

  async contextUsage(): Promise<ContextUsage> {
    if (!this.lastUsage) throw new Error(st("notice.grok.noUsageYet"));
    return this.lastUsage;
  }

  async effectivePermissionPolicy(): Promise<PermissionPolicy> {
    return grokPermissionPolicy(this.permissionMode === "full");
  }

  async usage(): Promise<ProviderUsage> {
    await this.ready();
    let billed: ProviderUsage = { windowsAvailable: false, windows: [] };
    try {
      // 이름은 앞에 밑줄이 있다. `x.ai/billing`은 Method not found(실측 2026-08-22).
      billed = usageFromGrokBilling(await this.stdio.request("_x.ai/billing", {}));
      failuresFor(this).clear("provider.usage.load");
    } catch (error) {
      // 청구 조회를 지원하지 않는 버전은 정상 기능 탐지다. 다른 실패만 수집한다.
      if (!(error instanceof GrokRpcError && error.code === -32601)) failuresFor(this).report(error, { component: "session", operation: "provider.usage.load", severity: "warning", session_id: this.opts.sessionId });
      // 구독 창을 못 받으면 지어내지 않는다.
    }
    return {
      ...billed,
      ...(this.lastUsage ? { context: { used: this.lastUsage.totalTokens, size: this.lastUsage.maxTokens } } : {}),
    };
  }

  async listCommands(): Promise<RuntimeCommand[]> {
    await this.ready();
    return withGrokBuiltins(this.advertisedCommands);
  }

  async executeCommand(command: RuntimeCommandInvocation): Promise<RuntimeCommandResult> {
    await this.ready();
    const wanted = command.name.toLowerCase();
    const found = withGrokBuiltins(this.advertisedCommands).find((c) => c.name === wanted || c.aliases?.includes(wanted));
    if (!found) return { accepted: false, error: st("notice.command.unsupported", { command: command.name }) };
    if (found.uiAction) return { accepted: true, startsTurn: false };
    if (!this.sessionId) return { accepted: false, error: st("notice.grok.notReady") };
    if (this.prompting || this.pumping || this.preparing || this.queue.length > 0) {
      return { accepted: false, error: st("notice.command.busy") };
    }
    if (found.name === "clear") {
      try {
        await this.resetGrokContext();
        failuresFor(this).clear("provider.context.reset");
        return { accepted: true, startsTurn: false };
      } catch (e) {
        failuresFor(this).report(e, { component: "session", operation: "provider.context.reset", severity: "error", session_id: this.opts.sessionId });
        return { accepted: false, error: String((e as Error)?.message ?? e) };
      }
    }
    const text = `/${found.name}${command.arguments.trim() ? ` ${command.arguments.trim()}` : ""}`;
    this.queue.push({ prompt: [{ type: "text", text }], files: [], userText: text });
    void this.pump();
    return { accepted: true, startsTurn: true };
  }

  async compactContext(): Promise<void> {
    // Grok 전용 압축 RPC는 아직 없다. 빈 본문으로 계약을 만족한다.
  }

  private ingestAvailableCommands(raw: unknown): string {
    const next = grokMenuCommands(raw);
    // 명시적인 빈 배열은 "provider 명령 없음"이라는 최신 상태다. 필드 자체가 없을 때만 기존 관측을 유지한다.
    if (next.length || Array.isArray(raw)) this.advertisedCommands = next;
    this.advertisedCommands = withGrokBuiltins(this.advertisedCommands);
    return JSON.stringify(this.advertisedCommands);
  }

  private sessionNewParams(): { cwd: string; mcpServers: unknown[]; _meta?: Record<string, unknown> } {
    const meta: Record<string, unknown> = {};
    if (this.permissionMode === "full") meta.yoloMode = true;
    if (this.permissionMode === "auto") meta.autoMode = true;
    if (this.opts.systemAppend) meta.rules = this.opts.systemAppend;
    return {
      cwd: this.opts.cwd,
      mcpServers: mcpServersOf(this.bridge),
      ...(Object.keys(meta).length ? { _meta: meta } : {}),
    };
  }

  /** TUI `/clear`=`/new`의 ACP 대응. 같은 프로세스에 새 Grok 세션을 연다. Aether 대화 기록은 그대로다. */
  private async resetGrokContext(): Promise<void> {
    const sess = await this.stdio.request<{ sessionId?: string }>("session/new", this.sessionNewParams());
    const id = sess?.sessionId;
    if (!id || typeof id !== "string") throw new Error(st("notice.grok.noSessionId"));
    this.sessionId = id;
    this.lastUsage = null;
    this.messageBuf = "";
    this.thoughtBuf = "";
    this.lastPlanText = "";
    this.lastPlanPath = "";
    this.opts.onResumeKey(id);
  }

  async *events(): AsyncIterable<RawProviderEventBody> {
    for (;;) {
      if (this.pending.length === 0) {
        if (this.streamError) throw this.streamError;
        if (this.streamEnded) return;
        await new Promise<void>((r) => (this.wake = r));
        continue;
      }
      yield this.pending.shift()!;
    }
  }

  private emitMsg(msg: GrokMsg) {
    const raw: RawProviderEventBody = { kind: "grok", msg };
    this.pending.push(raw);
    this.wake?.();
    this.wake = null;
  }

  private endStream(err?: Error) {
    if (err) this.streamError = err;
    this.streamEnded = true;
    this.wake?.();
    this.wake = null;
  }

  private onNotification(n: GrokNotification) {
    if (this.disposed) return;
    if (n.method.startsWith("_x.ai/") || n.method.startsWith("x.ai/") || n.method.startsWith("fs/") || n.method.startsWith("terminal/")) return;
    const usage = contextUsageFromGrokNotice(n.params);
    if (usage) this.lastUsage = usage;
    const update = sessionUpdateOf(n);
    if (update) {
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk") this.messageBuf += typeof (asRecord(update.content)?.text) === "string" ? (asRecord(update.content)!.text as string) : "";
      if (kind === "agent_thought_chunk") this.thoughtBuf += typeof (asRecord(update.content)?.text) === "string" ? (asRecord(update.content)!.text as string) : "";
      if (kind === "plan") {
        const text = typeof update.plan === "string" ? update.plan : jsonText(update.plan ?? update.content);
        if (text.trim()) this.lastPlanText = text;
      }
      const planPath = planFilePathOf(update);
      if (planPath) this.lastPlanPath = planPath;
      if (kind === "available_commands_update") {
        const signature = this.ingestAvailableCommands(update.availableCommands ?? update.available_commands);
        // Grok이 같은 목록을 주기적으로 다시 알린다. 최신 상태는 위에서 이미 갱신했으므로, 첫 관측과
        // 실제 변경만 세션 사건으로 넘겨 잠든 세션용 명령 목록은 보존하면서 로그 폭증을 막는다.
        if (signature === this.lastEmittedCommandSignature) return;
        this.lastEmittedCommandSignature = signature;
      }
      if (kind === "current_mode_update") return;
      if (kind === "tool_call") {
        const id = grokAskToolId(update);
        const raw = asRecord(update.rawInput) ?? {};
        if (id && grokAskToolNamed(update)) {
          this.lastAskToolId = id;
          if (this.askHold) this.askHold.toolId = id;
        }
        if (id && isPlanExit(update, raw)) {
          this.lastPlanToolId = id;
          if (this.planHold) this.planHold.toolId = id;
        }
      }
      if (this.askHold && grokAskToolSettled(update, this.askHold.toolId || this.lastAskToolId)) {
        this.askHold = this.releaseHold(this.askHold, true);
      }
      if (this.planHold && grokReverseToolSettled(update, this.planHold.toolId || this.lastPlanToolId, (u) => isPlanExit(u, asRecord(u.rawInput) ?? asRecord(u.rawOutput) ?? {}))) {
        this.planHold = this.releaseHold(this.planHold, true);
      }
      if (this.permHold && grokReverseToolSettled(update, this.permHold.toolId)) {
        this.permHold = this.releaseHold(this.permHold, true);
      }
    }
    this.emitMsg({ method: n.method, params: n.params });
  }

  /**
   * 매 턴 회상은 사용자 글 앞의 첨부 자원 블록으로만 넣는다(10a `embeddedContext`).
   * 실패는 턴을 막지 않는다. 화면·저장의 사용자 글은 LiveSession이 원본을 따로 남긴다.
   */
  private async withTurnContext(job: QueuedTurn): Promise<ContentBlock[]> {
    if (!this.opts.turnContext) return job.prompt;
    let parts: string[] = [];
    try {
      parts = await Promise.resolve(this.opts.turnContext(job.userText));
    } catch (e) {
      void reportError(e, { component: "session", severity: "warning", operation: "provider.grok.recall_prepare", session_id: this.opts.sessionId }); console.error("[aether] Grok 자동 회상 준비 실패(회상 없이 진행):", e);
      return job.prompt;
    }
    if (!parts.length) return job.prompt;
    const text = `<aether-context>\n${parts.join("\n\n")}\n</aether-context>`;
    if (process.env.AETHER_RECALL_DEBUG) console.error(`[recall:debug] Grok 턴에 회상 ${parts.length}건 주입(${text.length}자)`);
    return [
      { type: "resource", resource: { uri: "aether://recall", mimeType: "text/plain", text, name: "aether-recall" } },
      ...job.prompt,
    ];
  }

  private async onServerRequest(r: GrokServerRequest): Promise<unknown> {
    const signal = this.turnSignal();
    if (r.method === "session/request_permission") {
      const p = asRecord(r.params) ?? {};
      const toolCall = asRecord(p.toolCall) ?? {};
      const raw = asRecord(toolCall.rawInput) ?? asRecord(toolCall.input) ?? {};
      // 지식 도구의 쓰기 승인은 창구가 집행한다. 여기서 카드를 또 띄우면 같은 호출이 두 번 묻힌다.
      if (this.bridge && isAetherKnowledgeCall(toolCall, raw)) {
        const optionId = pickOptionId(p.options, "allow");
        if (!optionId) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId } };
      }
      if (isPlanEnter(toolCall, raw)) {
        const optionId = pickOptionId(p.options, "allow");
        if (!optionId) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId } };
      }
      if (isPlanExit(toolCall, raw)) {
        const toolId = String(toolCall.toolCallId ?? toolCall.id ?? this.lastPlanToolId);
        this.planHold = this.releaseHold(this.planHold, true);
        this.planHold = { abort: new AbortController(), toolId };
        try {
          const out = await this.presentPlan(
            toolId || `plan-${randomUUID()}`,
            planTextFrom(raw) || planTextFrom(p),
            abortAny(signal, this.planHold.abort.signal),
          );
          if (out.decision === "approve") {
            const optionId = pickOptionId(p.options, "allow");
            if (!optionId) return { outcome: { outcome: "cancelled" } };
            return { outcome: { outcome: "selected", optionId } };
          }
          const rejectId = pickOptionId(p.options, "deny");
          if (out.decision === "cancel") void this.interrupt();
          if (!rejectId) return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: rejectId } };
        } finally {
          this.planHold = this.releaseHold(this.planHold, false);
        }
      }
      const path = typeof raw.file_path === "string" ? raw.file_path : typeof raw.path === "string" ? raw.path : undefined;
      const command = typeof raw.command === "string" ? raw.command : undefined;
      const content = typeof raw.content === "string" ? raw.content : undefined;
      const title = typeof toolCall.title === "string" ? toolCall.title : typeof p.title === "string" ? p.title : st("notice.grok.tool.generic");
      const input: Record<string, unknown> = { ...raw };
      if (path && !input.path) input.path = path;
      if (command && !input.command) input.command = command;
      let mutation: ReturnType<typeof previewFromDisk> | undefined;
      try {
        mutation = path && content != null ? previewFromDisk("write", path, content, this.opts.cwd) : undefined;
        failuresFor(this).clear("provider.mutation.preview");
      } catch (error) {
        failuresFor(this).report(error, { component: "session", operation: "provider.mutation.preview", severity: "warning", session_id: this.opts.sessionId });
        mutation = undefined;
      }
      const toolId = String(toolCall.toolCallId ?? toolCall.id ?? "");
      this.permHold = this.releaseHold(this.permHold, true);
      this.permHold = { abort: new AbortController(), toolId };
      try {
        const out = await this.opts.onPermission({
          toolName: typeof toolCall.kind === "string" ? toolCall.kind : title,
          displayName: title,
          input,
          ...(mutation ? { mutation } : {}),
          toolUseID: toolId || `perm-${randomUUID()}`,
          signal: abortAny(signal, this.permHold.abort.signal),
        } satisfies PermissionAsk);
        const optionId = pickOptionId(p.options, out.allow ? "allow" : "deny");
        if (!optionId) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId } };
      } finally {
        this.permHold = this.releaseHold(this.permHold, false);
      }
    }
    if (r.method === "_x.ai/ask_user_question" || r.method === "x.ai/ask_user_question") {
      if (!this.prompting && !this.preparing) {
        return grokAskUserQuestionReply([], { answered: false, reason: "not-in-turn" });
      }
      // 청크는 턴이 끝나야 영속된다. 설명이 없으면 카드를 열지 않고, 있으면 카드에 실어 턴 끝 중복을 막는다.
      // skip_interview는 사용자가 건너뛴 것으로 읽히므로 여기선 쓰지 않는다.
      const lead = this.messageBuf.trim();
      if (isBlankAssistantText(lead)) {
        throw new Error(st("notice.grok.questionNeedsExplanation"));
      }
      this.messageBuf = "";
      const p = asRecord(r.params) ?? {};
      const toolId = String(p.toolCallId ?? p.id ?? this.lastAskToolId);
      this.askHold = this.releaseHold(this.askHold, true);
      this.askHold = { abort: new AbortController(), toolId };
      const questions = parseQuestions(r.params);
      try {
        const out = await this.opts.onQuestion({
          toolUseID: toolId || `ask-${randomUUID()}`,
          questions,
          lead,
          signal: abortAny(signal, this.askHold.abort.signal),
        } satisfies QuestionAsk);
        return grokAskUserQuestionReply(questions, out);
      } finally {
        this.askHold = this.releaseHold(this.askHold, false);
      }
    }
    if (isExitPlanMethod(r.method)) {
      const p = asRecord(r.params) ?? {};
      const toolId = String(p.toolCallId ?? p.id ?? this.lastPlanToolId);
      this.planHold = this.releaseHold(this.planHold, true);
      this.planHold = { abort: new AbortController(), toolId };
      try {
        const out = await this.presentPlan(
          toolId || `plan-${randomUUID()}`,
          planTextFrom(p),
          abortAny(signal, this.planHold.abort.signal),
        );
        return grokPlanReply(out);
      } catch (e) {
        void reportError(e, { component: "session", operation: "provider.grok.plan_exit", session_id: this.opts.sessionId }); console.error("[aether] Grok 계획 종료 응답 실패(계획 모드 유지):", e);
        return { outcome: "cancelled" };
      } finally {
        this.planHold = this.releaseHold(this.planHold, false);
      }
    }
    if (r.method.startsWith("fs/") || r.method.startsWith("x.ai/fs") || r.method.startsWith("terminal/")) {
      throw new Error(`Method not found: ${r.method}`);
    }
    throw new Error(`Aether가 처리하지 않는 요청이다: ${r.method}`);
  }

  /** 계획 종료 요청 → 공통 계획 카드. 실패해도 Grok에는 오류를 안 보낸다. */
  private async presentPlan(planId: string, explicitText: string, signal: AbortSignal): Promise<PlanOutcome> {
    const text = explicitText.trim() || this.lastPlanText.trim() || this.readSessionPlan();
    if (!this.opts.onPlan) return { decision: "revise", message: "" };
    try {
      return await this.opts.onPlan({ planId, text, signal } satisfies PlanAsk);
    } catch (e) {
      void reportError(e, { component: "session", operation: "provider.grok.plan_review", session_id: this.opts.sessionId }); console.error("[aether] Grok 계획 검토 실패(계획 모드 유지):", e);
      return { decision: "revise", message: "" };
    }
  }

  private readSessionPlan(): string {
    const candidates: string[] = [];
    if (this.lastPlanPath) candidates.push(this.lastPlanPath);
    if (this.sessionId) {
      candidates.push(path.join(grokAuthHome(), "sessions", encodeURIComponent(this.opts.cwd), this.sessionId, "plan.md"));
    }
    for (const file of candidates) {
      try {
        const text = readFileSync(file, "utf8");
        failures.recoveredFile(file);
        if (text.trim()) return text;
      } catch (error) {
        failures.file(error, { component: "session", operation: "provider.plan.read" }, file);
        /* 다음 후보 */
      }
    }
    return "";
  }

  private turnSignal(): AbortSignal {
    return (this.turnAbort ??= new AbortController()).signal;
  }

  private assertIdleForRespawn() {
    if (this.disposed) throw new Error(st("notice.grok.notReady"));
    if (this.prompting || this.pumping || this.preparing || this.queue.length > 0) {
      throw new Error(st("notice.command.busy"));
    }
  }

  /** `-m`/`--reasoning-effort`/MCP 헤더는 spawn 인자·세션 열기에만 있다. 같은 프로세스를 못 고친다. */
  private async respawnProcess(): Promise<void> {
    this.assertIdleForRespawn();
    if (!this.sessionId) throw new Error(st("notice.grok.notReady"));
    this.respawning = true;
    try {
      await this.stdio.close().catch((e) => { void reportError(e, { component: "session", operation: "provider.transport.close", session_id: this.opts.sessionId }); console.error("[aether] grok agent 재기동 전 종료 실패:", e); });
      this.stdio = this.openStdio();
      this.booted = this.boot();
      await this.booted;
    } catch (e) {
      this.booted = null;
      throw e;
    } finally {
      this.respawning = false;
    }
  }

  private onExit(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) {
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.finishTurn();
    if (this.respawning) return;
    for (const job of this.queue.splice(0)) for (const f of job.files) f.release();
    this.bridge?.dispose();
    this.bridge = null;
    if (this.disposed) {
      this.endStream();
      return;
    }
    const detail = info.stderr.trim().slice(-500);
    this.endStream(new Error(`grok agent가 예기치 않게 종료됐다(code=${info.code ?? "-"} signal=${info.signal ?? "-"})${detail ? `: ${detail}` : ""}`));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.turnAbort?.abort();
    this.turnAbort = null;
    for (const job of this.queue.splice(0)) for (const f of job.files) f.release();
    this.finishTurn();
    this.attachments.disposeAll();
    this.bridge?.dispose();
    this.bridge = null;
    this.endStream();
    await this.stdio.close().catch((e) => { void reportError(e, { component: "session", operation: "provider.transport.close", session_id: this.opts.sessionId }); console.error("[aether] grok agent 종료 실패:", e); });
  }
}

function mcpServersOf(bridge: KnowledgeBridge | null): unknown[] {
  if (!bridge) return [];
  return [
    {
      type: "http",
      name: MCP_SERVER_NAME,
      url: bridge.httpAttach.url,
      headers: [{ name: "Authorization", value: bridge.httpAttach.authorization }],
    },
  ];
}

function isAetherKnowledgeCall(toolCall: Record<string, unknown>, raw: Record<string, unknown>): boolean {
  const names = [toolCall.toolName, toolCall.name, toolCall.title, toolCall.kind, toolCall.server, raw.tool, raw.name, raw.server, raw.serverName]
    .filter((v): v is string => typeof v === "string");
  return names.some((n) => KNOWLEDGE_TOOL_RE.test(n) || n === "aether" || n.startsWith("mcp__aether") || n.includes("aether__"));
}
