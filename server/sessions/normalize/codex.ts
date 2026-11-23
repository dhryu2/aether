import { FailureTracker } from "../../providers/failureTracking";
/**
 * Codex 정규화 (중앙 모듈 — D2.4). Codex app-server 알림 → AgentEvent[] (순수 함수).
 *
 * 8b가 스키마 검산용 최소 구현으로 만들었고, **8e가 화면이 실제로 쓰는 값까지 채웠다**:
 * 도구 호출 인자 전체, 파일 변경 diff 본문, 문맥 점유량(누계가 아니라 마지막 요청분), 모델 전환 상세.
 * 이 모듈은 "무엇을 화면·검색에 보여줄까"만 답한다. "디스크에 남길까·턴이 끝났나·어떻게 줄일까"는
 * 같은 provider의 codec(`sessions/codec/codex.ts`)이 답한다(D2.6).
 *
 * 입력 = JSON-RPC 알림 `{method, params}`, vendored `ServerNotification`(server/codex/protocol, CLI 0.145.0 핀)에
 * 타입 결박한다 — tokenUsage 중첩(`total.totalTokens`)·`thread/compacted`·`error.error`+`willRetry`·`model/rerouted`·
 * 구조화 MCP 결과·turn `durationMs`의 실제 중첩 구조를 그대로 읽는다(평탄 shape 금지 — 골든이 파수).
 * (seq, part, ts, provider) 부여는 Claude 경로와 동일하게 buildAgentEvents가 담당한다.
 */
import type { AgentEventContent, TodoItem, ToolKind, TurnStatus } from "../../../shared/agentEvent";
import { buildAgentEvents, type AgentEvent, type Provider } from "../../../shared/agentEvent";
import { isBlankAssistantText } from "../../../shared/blankAssistantText";
import { isControlEvent, type AetherEvent } from "../../types";
import type { ServerNotification } from "../../codex/protocol/ServerNotification";
import type { ThreadItem } from "../../codex/protocol/v2/ThreadItem";

const jsonFailures = new FailureTracker();

/** reasoning item(content[]/summary[]) 또는 문자열 → 합친 텍스트. */
function joinStrings(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).join("\n");
  return "";
}

/** JSON/MCP 결과를 검색·렌더 가능한 텍스트로 best-effort 투영(8e에서 clamp·마스킹 추가). */
function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(jsonText).filter((x) => x.trim()).join("\n");
  if (typeof v === "object") {
    const text = (v as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  try {
    const text = JSON.stringify(v);
    jsonFailures.clear("session.json.encode");
    return text;
  } catch (error) {
    jsonFailures.report(error, { component: "session", operation: "session.json.encode", severity: "warning" });
    return String(v);
  }
}

/** Codex turn.status → 공통 TurnStatus. inProgress(비종료)는 null. */
function turnStatus(s: unknown): TurnStatus | null {
  switch (s) {
    case "completed":
      return "ok";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return null; // inProgress 등 비종료
  }
}

/** ThreadItem(의 type) → 도구 종별. 메시지/추론/플랜 아이템은 도구 아님(null). */
export function itemToolKind(itemType: ThreadItem["type"]): ToolKind | null {
  switch (itemType) {
    case "commandExecution":
      return "bash";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "mcp";
    case "webSearch":
      return "web";
    case "collabAgentToolCall":
      return "task";
    case "imageView":
      return "file_read";
    case "imageGeneration":
    case "sleep":
      return "other";
    default:
      return null;
  }
}

/**
 * 도구 호출 인자 전체 — 도구 카드가 명령 전문·대상 경로를 보여주는 데 쓴다(8d-3 계약 슬롯).
 * 화면은 `command`·`path` 같은 키를 찾아 한 줄로 보여주므로 그 이름에 맞춰 담는다.
 * 여기 실리는 값은 이미 영속 축소(자르기·마스킹)를 거친 것이라 새로 드러나는 내용은 없다(D2.3).
 */
function itemInput(item: ThreadItem): Record<string, unknown> | undefined {
  switch (item.type) {
    case "commandExecution":
      return { command: item.command, cwd: item.cwd };
    case "fileChange": {
      const paths = item.changes.map((c) => c.path).filter(Boolean);
      return paths.length ? { path: paths.join(", ") } : undefined;
    }
    case "mcpToolCall":
      return { server: item.server, tool: item.tool, arguments: item.arguments };
    case "dynamicToolCall":
      return { tool: item.tool, arguments: item.arguments };
    case "webSearch":
      return item.query ? { query: item.query } : undefined;
    case "imageView":
      return { path: item.path };
    default:
      return undefined;
  }
}

/**
 * 파일 변경 결과 본문 — 실제 diff를 싣는다.
 * 승인 payload에는 diff가 없고 이 항목에만 있다(8a 실측). 비밀을 담은 경로의 diff는 영속 축소기가 지우므로
 * 여기서 다시 판정하지 않는다 — 이 함수가 읽는 것은 이미 축소를 거친 영속본이다.
 */
function fileChangeOutput(item: Extract<ThreadItem, { type: "fileChange" }>): string {
  const diffs = item.changes.map((c) => c.diff).filter((d) => typeof d === "string" && d.trim());
  return diffs.length ? diffs.join("\n") : item.status || "";
}

/**
 * item/started·item/completed 의 ThreadItem → 콘텐츠 변형.
 *  - 도구 아이템(commandExecution/fileChange/mcp/web): started→tool_call, completed→tool_result
 *  - 메시지 아이템(agentMessage/reasoning/plan/userMessage): completed에서만 최종 텍스트 방출(started는 델타가 담당)
 */
function itemToContent(item: ThreadItem, phase: "started" | "completed"): AgentEventContent[] {
  const itemType = item.type;
  const id = "id" in item ? item.id : "";
  const kind = itemToolKind(itemType);

  if (kind) {
    if (!id) return []; // toolId 상관 불변식: 식별자 없는 도구 이벤트는 만들지 않는다.
    if (phase === "started") {
      let name: string = itemType;
      let target: string | undefined;
      if (item.type === "commandExecution") target = item.command;
      else if (item.type === "fileChange") target = item.changes.map((c) => c.path).filter(Boolean).join(", ") || undefined;
      else if (item.type === "mcpToolCall") name = `${item.server}.${item.tool}`;
      else if (item.type === "dynamicToolCall") name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
      else if (item.type === "webSearch") target = item.query;
      else if (item.type === "collabAgentToolCall") {
        name = `collab.${item.tool}`;
        target = item.prompt ?? undefined;
      } else if (item.type === "imageView") target = item.path;
      else if (item.type === "imageGeneration") target = item.revisedPrompt ?? undefined;
      else if (item.type === "sleep") target = `${item.durationMs}ms`;
      // 이름 바꾸기·옮기기는 새 경로(move_path)도 바뀐 파일이다.
      const paths = item.type === "fileChange"
        ? item.changes.flatMap((c) => [c.path, (c.kind as { move_path?: unknown } | undefined)?.move_path]).filter((p): p is string => typeof p === "string" && !!p)
        : [];
      return [{ type: "tool_call", toolId: id, name, toolKind: kind, target, ...(paths.length ? { paths } : {}), input: itemInput(item) }];
    }
    // completed → 결과
    let output = "";
    let isError: true | undefined;
    if (item.type === "commandExecution") {
      output = item.aggregatedOutput ?? "";
      if (item.status === "failed" || item.status === "declined") isError = true;
    } else if (item.type === "mcpToolCall") {
      if (item.error) {
        output = item.error.message;
        isError = true;
      } else if (item.result) {
        output = jsonText(item.result.content) || jsonText(item.result.structuredContent);
      }
      if (item.status === "failed") isError = true;
    } else if (item.type === "dynamicToolCall") {
      output = jsonText(item.contentItems);
      if (item.status === "failed" || item.success === false) isError = true;
    } else if (item.type === "fileChange") {
      output = fileChangeOutput(item);
      if (item.status === "failed" || item.status === "declined") isError = true;
    } else if (item.type === "webSearch") {
      output = jsonText(item.results);
    } else if (item.type === "collabAgentToolCall") {
      output = item.status;
      if (item.status === "failed") isError = true;
    } else if (item.type === "imageView") {
      output = item.path;
    } else if (item.type === "imageGeneration") {
      output = item.result || item.savedPath || "";
      if (item.status === "failed") isError = true;
    } else if (item.type === "sleep") {
      output = `${item.durationMs}ms`;
    }
    return [{ type: "tool_result", toolId: id, output, isError }];
  }

  if (phase !== "completed") return []; // 메시지 아이템은 완료 시점 최종본만
  switch (item.type) {
    case "agentMessage": {
      const text = item.text;
      return isBlankAssistantText(text) ? [] : [{ type: "text", text }];
    }
    case "reasoning": {
      const text = joinStrings(item.content) || joinStrings(item.summary);
      return text.trim() ? [{ type: "reasoning", text }] : [];
    }
    case "plan": {
      const text = item.text;
      return text.trim() ? [{ type: "plan_text", text }] : [];
    }
    case "userMessage":
      // 우리가 보낸 입력을 Codex가 그대로 되돌려 주는 항목이다. 사용자가 친 글은 Aether가 이미 자기
      //   이벤트(`user_msg`)로 남기므로, 이것까지 말풍선으로 바꾸면 **같은 글이 화면에 두 번 그려진다**
      //   (8g 카나리 실측: 말풍선 2개). Claude 쪽도 같은 이유로 되돌아온 사용자 메시지에서 도구 결과만
      //   꺼내고 본문은 무시한다(`normalize/claude.ts`의 user 분기) — 규칙을 맞춘다.
      return [];
    case "contextCompaction":
      // 사용자가 시키지 않았는데 문맥이 잘린 사건이라 표면화한다(thread/compacted와 같은 취급).
      return [{ type: "provider_notice", kind: "compact", severity: "warn" }];
    default:
      return []; // hookPrompt·subAgentActivity·imageView 등 → 8e/8h 판단
  }
}

/** Codex app-server 알림 1건 → 콘텐츠 변형 배열. */
function normalizeNotification(notification: ServerNotification): AgentEventContent[] {
  let items: AgentEventContent[] = [];

  switch (notification.method) {
    case "item/started":
      items = itemToContent(notification.params.item, "started");
      break;
    case "item/completed": {
      items = itemToContent(notification.params.item, "completed");
      break;
    }
    case "turn/started":
      items = [{ type: "turn_started" }];
      break;
    case "turn/plan/updated": {
      // 체크리스트 갱신. 진행 중 표기만 중립 어휘로 옮기고 설명문(explanation)은 쓰지 않는다.
      const todos: TodoItem[] = [];
      for (const step of notification.params.plan) {
        const text = typeof step.step === "string" ? step.step.trim() : "";
        if (!text) continue;
        todos.push({ text, status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending" });
      }
      items = [{ type: "plan_update", items: todos }];
      break;
    }
    case "turn/completed": {
      const { turn } = notification.params;
      const status = turnStatus(turn.status);
      if (status) {
        items = [{
          type: "turn_completed",
          status,
          error: turn.error?.message,
          durationMs: turn.durationMs ?? undefined,
        }];
      }
      break;
    }
    case "thread/tokenUsage/updated": {
      const usage = notification.params.tokenUsage;
      // ★ `total`이 아니라 `last`다(8e 실측). `total`은 이 대화가 지금까지 쓴 토큰의 **누계**라 턴마다
      //   계속 커진다 — 실측에서 두 턴 만에 12,939 → 25,899가 됐는데 실제로 문맥에 들어 있는 양은
      //   12,939 → 12,960으로 거의 그대로였다. 누계로 게이지를 그리면 대화가 길어질수록 저절로 100%에
      //   닿아 "문맥이 곧 찬다"는 거짓 경고와 알림이 나간다. `last`는 마지막 요청이 실제로 실어 보낸 양이라
      //   Claude가 주는 "지금 문맥에 들어있는 토큰"과 같은 뜻이다.
      items = [{
        type: "usage_update",
        totalTokens: usage.last.totalTokens,
        maxTokens: usage.modelContextWindow ?? 0,
      }];
      break;
    }
    case "account/rateLimits/updated": {
      const rateLimits = notification.params.rateLimits;
      const primary = rateLimits.primary;
      const utilization = primary ? primary.usedPercent / 100 : undefined;
      const resetsAt = primary?.resetsAt ?? undefined;
      const limitType = rateLimits.rateLimitReachedType ?? rateLimits.limitName ?? rateLimits.limitId ?? undefined;
      const severity = rateLimits.rateLimitReachedType != null || rateLimits.spendControlReached === true ? "blocked" : undefined;

      // Codex는 경고 단계를 알려주지 않으므로 차단만 배너로 뜬다. 사용률 자체는 설정 화면의 막대로 계속 보인다.
      // 이 알림은 sparse rolling update라 누락값이 기존 값을 지웠다는 뜻이 아니다. 새 정보가 전혀 없으면
      // 빈 상태(예: 한도가 풀림)를 지어내지 않고 아무 이벤트도 만들지 않는다.
      if (severity === undefined && utilization === undefined && resetsAt === undefined && limitType === undefined) break;
      items = [{ type: "provider_notice", kind: "rate_limit", severity, utilization, resetsAt, limitType }];
      break;
    }
    case "item/agentMessage/delta": {
      const d = notification.params.delta;
      items = d ? [{ type: "text_delta", text: d }] : []; // 라이브 전용
      break;
    }
    case "thread/compacted":
      // 사용자가 시키지 않았는데 문맥이 잘린 사건이라 표면화한다(Claude의 compact_boundary와 같은 취급).
      items = [{ type: "provider_notice", kind: "compact", severity: "warn" }];
      break;
    case "model/rerouted": {
      const p = notification.params;
      const items2: AgentEventContent[] = [
        { type: "provider_notice", kind: "model_fallback", severity: "warn", detail: p.toModel, originalModel: p.fromModel, category: p.reason },
      ];
      // 전환은 이 세션의 모델을 바꾼다 — 알림만 내면 화면의 "지금 모델"이 옛 값에 머문다(Claude 경로와 동형).
      if (p.toModel) items2.push({ type: "model_info", model: p.toModel });
      items = items2;
      break;
    }
    case "error": {
      const p = notification.params;
      // 다시 시도하는 오류는 경고, 그렇지 않은 오류는 막힌 상태다. 심각도가 없으면 화면에 배너를 띄우지 않는다.
      // 한도 오류는 알림·주의 표시가 공통으로 읽는 rate_limit 사건으로 올린다(resetsAt은 이 오류에 없다).
      if (!p.willRetry && isRateLimitInfo(p.error.codexErrorInfo)) {
        items = [{ type: "provider_notice", kind: "rate_limit", severity: "blocked", detail: p.error.message }];
        break;
      }
      items = [{ type: "provider_notice", kind: p.willRetry ? "retry" : "error", severity: p.willRetry ? "warn" : "blocked", detail: p.error.message }];
      break;
    }
    default:
      // 라이브 델타(추론·명령 출력·패치)와 계정·MCP 상태 알림은 파생 콘텐츠가 없다.
      //   추론 델타를 화면에 흘리지 않는 것은 Claude 경로와 같은 규칙이다(중간 추론은 렌더하지 않는다).
      //   "디스크에 남기느냐"는 별개 판정이며 codec의 `isLiveOnly`가 담당한다.
      items = [];
  }
  return items;
}

/** 이용 한도·요청 한도 초과를 가리키는 codexErrorInfo인가. 문자열 값이거나, 내부 httpStatusCode가 429인 객체 값이다. */
function isRateLimitInfo(info: unknown): boolean {
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded") return true;
  if (info && typeof info === "object") {
    const inner = Object.values(info)[0] as { httpStatusCode?: number | null } | undefined;
    return inner?.httpStatusCode === 429;
  }
  return false;
}

/**
 * 영속 봉투(AetherEvent) → AgentEvent[]. (seq, part, ts, provider) 부여는 buildAgentEvents가 담당한다.
 *
 * Codex 원본 알림만 다루면 안 된다. 사용자가 보낸 메시지(`user_msg`)와 턴 종료 후의 문맥 점유량(`ctx`)은
 * Aether가 직접 만드는 중립 이벤트인데, **이것도 provider의 codec을 거쳐 화면에 간다**. 여기서 빠뜨리면
 * Codex 세션에서 자기가 보낸 말과 문맥 게이지가 화면에 뜨지 않는다(Claude 경로와 같은 구조다).
 *
 * `provider`는 이 이벤트가 속한 세션의 provider다. Codex 실행기를 빌려 쓰는 provider(Ollama)도 있어서
 * 원본 모양이 Codex라고 provider 이름까지 Codex로 찍으면 안 된다.
 */
export function normalizeCodex(ev: AetherEvent, provider: Provider = "codex"): AgentEvent[] {
  let items: AgentEventContent[];
  if (isControlEvent(ev, "user_msg")) {
    const text = ev.text.trim();
    items = text ? [{ type: "user_text", text }] : [];
  } else if (isControlEvent(ev, "ctx")) {
    items = [{ type: "usage_update", totalTokens: ev.totalTokens, maxTokens: ev.maxTokens }];
  } else if (ev.kind === "codex" && "msg" in ev) {
    items = normalizeNotification(ev.msg as ServerNotification);
  } else {
    // permission_request·question_request·status·notice 등은 이미 중립인 Aether 제어 이벤트다(D2.5).
    items = [];
  }
  return buildAgentEvents(ev, provider, items);
}
