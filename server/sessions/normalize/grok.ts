import { FailureTracker } from "../../providers/failureTracking";
/**
 * Grok 정규화 — ACP session/update → AgentEvent[] (Phase 10c · D2.4).
 *
 * 입력은 runtime이 만든 `{ kind:"grok", msg:{ method, params } }`. 코어는 이 모양을 모른다.
 * 사용자가 친 글은 `user_msg`에서만 온다. 모델이 되돌려 보낸 사용자 블록은 화면 글이 아니다.
 */
import type { AgentEventContent, TodoItem, ToolKind, TurnStatus } from "../../../shared/agentEvent";
import { buildAgentEvents, type AgentEvent } from "../../../shared/agentEvent";
import { isBlankAssistantText } from "../../../shared/blankAssistantText";
import { contextUsageFromGrokNotice } from "../../providers/grok/contextUsage";
import { grokRateLimitKind } from "../../providers/grok/errorOrigin";
import { isControlEvent, type AetherEvent } from "../../types";

const jsonFailures = new FailureTracker();

const PROVIDER = "grok" as const;

type GrokMsg = { method?: unknown; params?: unknown };

function isGrokRaw(ev: AetherEvent): ev is AetherEvent & { kind: "grok"; msg: GrokMsg } {
  return ev.kind === "grok";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function updateOf(msg: GrokMsg): Record<string, unknown> | null {
  if (msg.method !== "session/update") return null;
  const params = asRecord(msg.params);
  return params ? asRecord(params.update) : null;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  const rec = asRecord(content);
  if (rec && typeof rec.text === "string") return rec.text;
  if (Array.isArray(content)) return content.map(blockText).filter((s) => s.trim()).join("");
  return "";
}

function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(jsonText).filter((x) => x.trim()).join("\n");
  const rec = asRecord(v);
  if (rec && typeof rec.text === "string") return rec.text;
  try {
    const text = JSON.stringify(v);
    jsonFailures.clear("session.json.encode");
    return text;
  } catch (error) {
    jsonFailures.report(error, { component: "session", operation: "session.json.encode", severity: "warning" });
    return String(v);
  }
}

export function toolKindOf(name: string, kind?: string): ToolKind {
  // ACP의 도구 종류(kind)가 있으면 이름보다 먼저 본다. 이름 규칙은 kind가 없는 도구의 대비책이다.
  if (kind === "execute") return "bash";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  const n = `${kind ?? ""} ${name}`.toLowerCase();
  if (/(run_terminal|bash|shell|command)/.test(n)) return "bash";
  if (/(search_replace|write|edit|apply_patch)/.test(n)) return "file_change";
  if (/(read_file|list_dir|grep|glob)/.test(n)) return "file_read";
  if (/web_/.test(n) || n.includes("web search")) return "web";
  if (/(mcp|search_tool|use_tool)/.test(n)) return "mcp";
  if (/(agent|task|subagent)/.test(n)) return "task";
  return "other";
}

/** 승인 요청(session/request_permission)의 toolCall도 도구 호출 사건과 같은 기준으로 가른다. */
export function grokToolKind(update: Record<string, unknown>): ToolKind {
  return toolKindOf(toolName(update), typeof update.kind === "string" ? update.kind : undefined);
}

function stopStatus(stop: unknown): TurnStatus {
  if (stop === "cancelled" || stop === "canceled" || stop === "interrupted") return "interrupted";
  if (stop === "end_turn" || stop === "stop" || stop === "completed") return "ok";
  if (typeof stop === "string" && /fail|error/i.test(stop)) return "failed";
  return "ok";
}

function isAskUserQuestionUpdate(update: Record<string, unknown>): boolean {
  const raw = asRecord(update.rawOutput) ?? asRecord(update.rawInput) ?? {};
  const blob = [update.title, update.kind, update.toolName, raw.type, raw.variant].map((v) => String(v ?? "")).join(" ");
  return /ask[_ ]?user[_ ]?question/i.test(blob);
}

function toolName(update: Record<string, unknown>): string {
  if (typeof update.title === "string" && update.title.trim()) return update.title;
  if (typeof update.kind === "string" && update.kind.trim()) return update.kind;
  if (typeof update.toolName === "string" && update.toolName.trim()) return update.toolName;
  return "tool";
}

function toolIdOf(update: Record<string, unknown>): string {
  if (typeof update.toolCallId === "string") return update.toolCallId;
  if (typeof update.id === "string") return update.id;
  return "";
}

function rawInput(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = asRecord(update.rawInput) ?? asRecord(update.input);
  if (!raw) return undefined;
  const path = raw.file_path ?? raw.path;
  const command = raw.command;
  const out: Record<string, unknown> = { ...raw };
  if (typeof path === "string" && !out.path) out.path = path;
  if (typeof command === "string" && !out.command) out.command = command;
  return out;
}

/** 파일 변경 도구의 대상 경로 — 인자(file_path·path·target_file)와 알림의 locations[].path를 모은다. */
function changedPaths(update: Record<string, unknown>, input: Record<string, unknown> | undefined): { paths?: string[] } {
  const found = [input?.file_path, input?.path, input?.target_file];
  if (Array.isArray(update.locations)) for (const loc of update.locations) found.push(asRecord(loc)?.path);
  const paths = [...new Set(found.filter((p): p is string => typeof p === "string" && !!p))];
  return paths.length ? { paths } : {};
}

function toolTarget(input: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!input) return undefined;
  const command = input.command;
  if (typeof command === "string" && command.trim()) return command;
  const path = input.path ?? input.file_path;
  if (typeof path === "string" && path.trim()) return path;
  const query = input.query;
  if (typeof query === "string" && query.trim()) return query;
  return name;
}

/** normalize가 파일 변경 도구 호출(tool_call)로 보는 알림이면 그 id와 인자. 아니면 null. codec이 같은 기준으로 조각을 내도록 export한다. */
export function grokFileChangeCall(update: Record<string, unknown>): { toolId: string; input: Record<string, unknown> | undefined } | null {
  if (isAskUserQuestionUpdate(update)) return null;
  const toolId = toolIdOf(update);
  if (!toolId || toolKindOf(toolName(update), typeof update.kind === "string" ? update.kind : undefined) !== "file_change") return null;
  return { toolId, input: rawInput(update) };
}

function usageFrom(update: Record<string, unknown>): { totalTokens: number; maxTokens: number } | null {
  const used = update.used ?? update.usedTokens ?? update.tokens;
  const size = update.size ?? update.maxTokens ?? update.contextWindow;
  const rec = asRecord(update.usage) ?? asRecord(update.tokenUsage) ?? asRecord(update.context);
  const u = typeof used === "number" ? used : typeof rec?.used === "number" ? rec.used : typeof rec?.totalTokens === "number" ? rec.totalTokens : null;
  const s = typeof size === "number" ? size : typeof rec?.size === "number" ? rec.size : typeof rec?.maxTokens === "number" ? rec.maxTokens : null;
  if (u == null || s == null || s <= 0) return null;
  return { totalTokens: u, maxTokens: s };
}

function normalizeUpdate(update: Record<string, unknown>): AgentEventContent[] {
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  switch (kind) {
    case "agent_message_chunk": {
      const text = blockText(update.content);
      return text ? [{ type: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = blockText(update.content);
      return text ? [{ type: "reasoning", text }] : [];
    }
    case "agent_message": {
      const text = blockText(update.content);
      return isBlankAssistantText(text) ? [] : [{ type: "text", text }];
    }
    case "agent_thought": {
      const text = blockText(update.content);
      return text.trim() ? [{ type: "reasoning", text }] : [];
    }
    case "user_message_chunk":
    case "user_message":
      // 회상 첨부·모델이 되돌려 보낸 사용자 블록은 사용자가 친 글이 아니다.
      return [];
    case "tool_call": {
      // 질문 카드가 따로 있다. 같은 내용을 명령 줄에 한 번 더 그리지 않는다.
      if (isAskUserQuestionUpdate(update)) return [];
      const id = toolIdOf(update);
      if (!id) return [];
      const name = toolName(update);
      const input = rawInput(update);
      const toolKind = toolKindOf(name, typeof update.kind === "string" ? update.kind : undefined);
      const paths = toolKind === "file_change" ? changedPaths(update, input) : {};
      return [{ type: "tool_call", toolId: id, name, toolKind, target: toolTarget(input, name), ...paths, input }];
    }
    case "tool_call_update": {
      if (isAskUserQuestionUpdate(update)) return [];
      const id = toolIdOf(update);
      if (!id) return [];
      const status = String(update.status ?? "");
      const output = jsonText(update.content ?? update.rawOutput ?? update.result ?? status);
      const failed = /fail|error|cancel|reject|denied/i.test(status) || /^\s*rejected:/i.test(output);
      if (status && !/complet|success|fail|error|cancel|reject|denied/i.test(status) && !output.trim()) return [];
      return [{ type: "tool_result", toolId: id, output, ...(failed ? { isError: true as const } : {}) }];
    }
    case "available_commands_update": {
      const cmds = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      const names = cmds.map((c) => (asRecord(c)?.name ?? c)).filter((n): n is string => typeof n === "string" && !!n);
      return [{ type: "commands_available", names }];
    }
    case "usage_update": {
      const u = usageFrom(update);
      return u ? [{ type: "usage_update", ...u }] : [];
    }
    case "session_info_update": {
      const u = usageFrom(update);
      return u ? [{ type: "usage_update", ...u }] : [];
    }
    case "plan": {
      // ACP 계획 알림: entries[] = {content, priority, status}. 모르는 상태는 대기로, priority는 버린다.
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const todos: TodoItem[] = [];
      for (const entry of entries) {
        const rec = asRecord(entry);
        const text = typeof rec?.content === "string" ? rec.content.trim() : "";
        if (!rec || !text) continue;
        todos.push({ text, status: rec.status === "in_progress" || rec.status === "completed" ? rec.status : "pending" });
      }
      return [{ type: "plan_update", items: todos }];
    }
    case "current_mode_update":
      return [];
    default:
      return [];
  }
}

function normalizeMsg(msg: GrokMsg): AgentEventContent[] {
  if (msg.method === "session/prompt_started") return [{ type: "turn_started" }];
  if (msg.method === "session/prompt_result") {
    const params = asRecord(msg.params);
    const stop = params?.stopReason;
    const status = stopStatus(stop);
    const error = status === "failed" && typeof params?.error === "string" ? params.error : undefined;
    const completed: AgentEventContent = { type: "turn_completed", status, ...(error ? { error } : {}) };
    // 한도 오류로 실패했으면 막힘 알림을 실패보다 앞에 낸다(한 사건 안에서 배열 순서가 곧 도착 순서다).
    const errorStatus = typeof params?.errorStatus === "number" ? params.errorStatus : undefined;
    if (error && grokRateLimitKind(error, errorStatus)) {
      const resetsAt = typeof params?.resetsAt === "number" ? params.resetsAt : undefined;
      return [{ type: "provider_notice", kind: "rate_limit", severity: "blocked", detail: error, ...(resetsAt ? { resetsAt } : {}) }, completed];
    }
    return [completed];
  }
  if (msg.method === "error") {
    const params = asRecord(msg.params);
    const text = typeof params?.message === "string" ? params.message : jsonText(params);
    return text.trim() ? [{ type: "provider_notice", kind: "error", severity: "blocked", detail: text }] : [];
  }
  const update = updateOf(msg);
  const items = update ? normalizeUpdate(update) : [];
  const usage = contextUsageFromGrokNotice(msg.params);
  if (usage && !items.some((it) => it.type === "usage_update")) {
    items.push({ type: "usage_update", ...usage });
  }
  return items;
}

export function normalizeGrok(ev: AetherEvent): AgentEvent[] {
  let items: AgentEventContent[];
  if (isControlEvent(ev, "user_msg")) {
    const text = ev.text.trim();
    items = text ? [{ type: "user_text", text }] : [];
  } else if (isControlEvent(ev, "ctx")) {
    items = [{ type: "usage_update", totalTokens: ev.totalTokens, maxTokens: ev.maxTokens }];
  } else if (isGrokRaw(ev)) {
    items = normalizeMsg(ev.msg);
  } else {
    items = [];
  }
  return buildAgentEvents(ev, PROVIDER, items);
}
