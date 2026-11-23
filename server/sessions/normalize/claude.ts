/**
 * Claude 정규화 (중앙 모듈 — D2.4). raw AetherEvent → AgentEvent[] (순수 함수, 부작용 없음).
 *
 * 입력은 events.jsonl에 실제 저장된 원본 봉투(AetherEvent)다. read-time 변환이므로 원본은 불변.
 * **8b 범위**: 이 출력은 검색 인덱싱 경로(search/extract.ts)만 소비한다. SSE·프론트는 8c에서 배선한다.
 *
 * 매핑 개요:
 *   user_msg                       → user_text
 *   sdk assistant.content[]         → 블록별: text→text, thinking→reasoning, tool_use→tool_call (블록 순서=part) [+ model_info]
 *     (parent_tool_use_id가 비어 있지 않은 문자열인 서브에이전트 발화는 model_info를 빼는다)
 *   sdk user.content[] tool_result  → tool_result * N (결과당 1개, 순서=part)
 *   sdk result                      → turn_completed
 *   sdk system(compact/refusal/retry)·rate_limit_event·conversation_reset → provider_notice
 *   sdk system init                 → model_info + provider_notice(commands_changed)
 *   sdk system local_command_output → command_output
 *   sdk system commands_changed     → provider_notice(commands_changed)
 *   ctx                             → usage_update
 *   그 외(권한/질문/status/notice/thinking_tokens 등) → [] (중립 제어 이벤트는 파생 콘텐츠 없음 — 그대로 통과)
 *
 * ⚠️ **part 순번은 색인 키다.** 검색 인덱스가 `(session, seq, part)`를 UNIQUE로 쓰므로, 색인 대상(text·
 *   tool_call·tool_result·user_text) *앞에* 새 파생을 끼워 넣으면 기존 행의 part가 통째로 밀려 재색인이
 *   필요해진다. 그래서 8d-3이 assistant에 더한 `model_info`는 **블록 뒤에 덧붙인다**.
 *
 * 색인 동등성: text/tool_use/tool_result의 텍스트 추출·정렬은 legacy extract.ts와 동일 규칙을 쓴다
 *   (textFromContent·toolTarget). reasoning/provider_notice/turn_completed/usage_update는 비색인이라
 *   추가로 방출돼도 검색 결과에 영향 없음(계약 확장 + 무회귀).
 *   ⚠️ 다중 text 블록: 이 정규화는 블록별로 text AgentEvent를 방출한다(8c 세그먼트 모델과 일치).
 *   legacy는 한 assistant 메시지의 여러 text 블록을 `\n`으로 join해 1행으로 색인했다 → 한 메시지에 text
 *   블록이 2개 이상이면 색인 행 수가 달라진다(교차 phrase 질의 결과 변동 가능). 단 이 SDK 파이프라인은
 *   assistant 메시지당 content 블록을 정확히 1개만 방출한다(실측: 35k+ 이벤트에서 다중 text 0건).
 *   그래서 실동등이며, 이 가정이 깨지면 normalize_golden (C) 실코퍼스 대조가 즉시 불일치로 잡는다.
 */
import { isControlEvent, type AetherEvent } from "../../types";
import type { AgentEventContent, BackgroundTask, ToolKind } from "../../../shared/agentEvent";
import { buildAgentEvents, turnResponsePreview, type AgentEvent } from "../../../shared/agentEvent";
import { isBlankAssistantText } from "../../../shared/blankAssistantText";

const PROVIDER = "claude" as const;

/** tool_use.input에서 검색가치 높은 핵심 인자(명령/경로/패턴/URL/쿼리)만. 없으면 undefined. (extract.ts와 동일 어휘) */
const TARGET_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"];
function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of TARGET_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** content(문자열 또는 블록 배열)에서 text만 뽑아 합친다. image 등은 무시. (extract.ts textFromContent와 동일) */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
  }
  return parts.join("\n");
}

/** Claude 툴 이름 → ToolKind. 카드·검색 요약·아이콘 분기용(색인엔 무영향). */
export function claudeToolKind(name: string): ToolKind {
  switch (name) {
    case "Bash":
      return "bash";
    case "Read":
    case "Grep":
    case "Glob":
      return "file_read";
    case "Edit":
    case "Write":
    case "NotebookEdit":
    case "MultiEdit":
      return "file_change";
    case "WebSearch":
    case "WebFetch":
      return "web";
    case "Task":
      return "task";
    default:
      return name.startsWith("mcp__") ? "mcp" : "other";
  }
}

/** 파일 변경 도구의 대상 경로 — 인자의 file_path(노트북은 notebook_path). */
function changedPaths(name: string, input: unknown): { paths?: string[] } {
  if (claudeToolKind(name) !== "file_change") return {};
  const rec = toolInput(input);
  const p = rec?.file_path ?? rec?.notebook_path;
  return typeof p === "string" && p ? { paths: [p] } : {};
}

/** 도구 호출 인자 전체 — 객체일 때만 싣는다(카드가 키/값을 순회하므로). */
function toolInput(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

/**
 * 모델 이름 슬롯에 실어도 되는 값인가. 슬래시 명령(`/clear`·`/compact`)이 만드는 합성 메시지는
 * `model:"<synthetic>"` 같은 꺾쇠 플레이스홀더라 실제 모델이 아니다 — 여기서 걸러야 화면이 그걸 모델로 표시하지 않는다.
 */
function realModel(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() && !v.startsWith("<") ? v : undefined;
}

/** sdk 봉투(assistant/user/result/system/rate_limit_event/…) → 콘텐츠 변형 배열. */
function normalizeSdk(msg: unknown): AgentEventContent[] {
  const m = msg as { type?: string; subtype?: string; message?: { content?: unknown; model?: unknown }; [k: string]: unknown };
  const t = m?.type;

  if (t === "assistant") {
    const items: AgentEventContent[] = [];
    const content = m.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        const blk = b as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown };
        if (blk.type === "text") {
          if (typeof blk.text === "string" && !isBlankAssistantText(blk.text)) items.push({ type: "text", text: blk.text });
        } else if (blk.type === "thinking") {
          if (typeof blk.thinking === "string" && blk.thinking.trim()) items.push({ type: "reasoning", text: blk.thinking });
        } else if (blk.type === "tool_use") {
          if (typeof blk.id !== "string" || !blk.id.trim()) continue; // toolId 링크 계약을 만족하지 못하는 손상 블록은 파생 금지.
          const name = typeof blk.name === "string" ? blk.name : "tool";
          items.push({
            type: "tool_call",
            toolId: blk.id,
            name,
            toolKind: claudeToolKind(name),
            // MCP 규약 이름(mcp__서버__도구)을 다른 provider와 같은 `서버.도구` 모양으로 보인다.
            ...(name.startsWith("mcp__") ? { displayName: name.replace(/^mcp__(.+?)__(.+)$/, "$1.$2") } : {}),
            target: toolTarget(blk.input),
            ...changedPaths(name, blk.input),
            input: toolInput(blk.input),
          });
        }
        // 그 외 블록(fallback·image 등)은 파생 없음 — 현행 색인/렌더 동작 보존.
      }
    }
    // ★ 반드시 블록 뒤 — 앞에 끼우면 색인 대상의 part가 밀린다(파일 머리 주석).
    // 서브에이전트 발화는 parent_tool_use_id가 비어 있지 않은 문자열이다. 그 message.model은
    // 서브에이전트 모델이라, model_info로 올리면 세션 모델 표시와 저장된 관측 값이 그쪽으로 바뀐다.
    const fromSubagent = typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id.length > 0;
    const model = realModel(m.message?.model);
    if (model && !fromSubagent) items.push({ type: "model_info", model });
    return items;
  }

  if (t === "user") {
    const content = m.message?.content;
    if (!Array.isArray(content)) return [];
    const items: AgentEventContent[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "tool_result") continue;
      const blk = b as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (typeof blk.tool_use_id !== "string" || !blk.tool_use_id.trim()) continue;
      items.push({
        type: "tool_result",
        toolId: blk.tool_use_id,
        output: textFromContent(blk.content),
        isError: blk.is_error === true ? true : undefined,
      });
    }
    return items;
  }

  if (t === "result") {
    // 실패 판정은 두 조건의 합집합이다 — `is_error`가 꺼져 있어도 subtype이 success가 아니면 실패로 본다.
    //   (결과 푸터가 원래 쓰던 규칙 그대로. 한쪽만 보면 화면 표시가 달라진다.)
    const isErr = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
    const usage = m.usage as { output_tokens?: unknown } | undefined;
    const errs = Array.isArray(m.errors) ? (m.errors as unknown[]).filter((e): e is string => typeof e === "string") : [];
    return [
      {
        type: "turn_completed",
        status: isErr ? "failed" : "ok",
        durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
        error: isErr ? String((m.result as unknown) ?? m.subtype ?? "") || undefined : undefined,
        outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
        errors: errs.length ? errs : undefined,
        // `result`·`num_turns`는 기존 푸시 본문이 읽던 바로 그 원본 값이다. 미리보기는 라이브 통로에도
        // 실리므로 전문을 복제하지 않고, 푸시 본문과 같은 한 줄 상한으로 여기서 고정한다.
        responsePreview: typeof m.result === "string" && m.result.trim() ? turnResponsePreview(m.result) : undefined,
        modelTurnCount: typeof m.num_turns === "number" ? m.num_turns : undefined,
      },
    ];
  }

  if (t === "rate_limit_event") {
    const info = m.rate_limit_info as { status?: unknown; rateLimitType?: unknown; resetsAt?: unknown; utilization?: unknown } | undefined;
    const status = typeof info?.status === "string" ? info.status : undefined;
    return [
      {
        type: "provider_notice",
        kind: "rate_limit",
        detail: status,
        // "allowed"(정상 사용 중)는 매 행동마다 오므로 배너를 띄우지 않는다 — severity 없음 = 정보성.
        severity: status === "rejected" ? "blocked" : status === "allowed_warning" ? "warn" : undefined,
        utilization: typeof info?.utilization === "number" ? info.utilization : undefined,
        resetsAt: typeof info?.resetsAt === "number" ? info.resetsAt : undefined,
        limitType: typeof info?.rateLimitType === "string" ? info.rateLimitType : undefined,
      },
    ];
  }

  if (t === "conversation_reset") {
    // `/clear`로 사용자가 직접 대화를 비운 경우. **severity 없음 = 배너 안 띄움** — 방금 자기가 친 명령이라
    //   알려줄 게 없다. 반면 아래 compact_boundary는 사용자가 시키지 않았는데 일어난 일이라 표면화한다.
    return [{ type: "provider_notice", kind: "compact" }];
  }

  if (t === "system") {
    const sub = m.subtype;
    if (sub === "compact_boundary") {
      // 사용자가 `/compact`로 직접 시킨 압축은 진행 카드가 이미 알렸으므로 배너를 또 띄우지 않는다.
      const trigger = (m.compact_metadata as { trigger?: unknown } | undefined)?.trigger;
      return [{ type: "provider_notice", kind: "compact", ...(trigger === "manual" ? {} : { severity: "warn" as const }) }];
    }
    if (sub === "model_refusal_fallback") {
      const fallback = realModel(m.fallback_model);
      const items: AgentEventContent[] = [
        {
          type: "provider_notice",
          kind: "model_fallback",
          severity: "warn",
          detail: fallback, // 전환 *후* 모델
          originalModel: realModel(m.original_model),
          category: typeof m.api_refusal_category === "string" ? m.api_refusal_category : undefined,
        },
      ];
      // 폴백은 세션 모델을 영구히 바꾼다 — 알림만 내면 화면의 "현재 모델"이 옛 값에 머문다.
      if (fallback) items.push({ type: "model_info", model: fallback });
      return items;
    }
    if (sub === "api_retry")
      return [
        {
          type: "provider_notice",
          kind: "retry",
          severity: "warn",
          detail: typeof m.error === "string" ? m.error : undefined,
          attempt: typeof m.attempt === "number" ? m.attempt : undefined,
          max: typeof m.max_retries === "number" ? m.max_retries : undefined,
        },
      ];
    if (sub === "local_command_output") {
      const text = typeof m.content === "string" ? m.content : "";
      return text.trim() ? [{ type: "command_output", text }] : [];
    }
    if (sub === "background_tasks_changed") {
      const raw = Array.isArray(m.tasks) ? (m.tasks as unknown[]) : [];
      const tasks: BackgroundTask[] = [];
      for (const r of raw) {
        const t = r as { task_id?: unknown; task_type?: unknown; description?: unknown };
        if (typeof t?.task_id !== "string") continue;
        const kind = t.task_type === "local_agent" ? "agent" : t.task_type === "local_bash" ? "command" : "other";
        const description = (typeof t.description === "string" ? t.description : "").trim().slice(0, 200);
        tasks.push({ id: t.task_id, kind, description });
      }
      return [{ type: "background_tasks", tasks }];
    }
    if (sub === "init") {
      // init은 새 턴의 시작 신호이기도 하다 — 뒤 작업이 모두 끝나 Claude가 스스로 여는 턴은 사용자 입력 없이 이것으로만 알린다.
      const items: AgentEventContent[] = [{ type: "turn_started" }];
      const model = realModel(m.model);
      if (model) items.push({ type: "model_info", model });
      const names = Array.isArray(m.slash_commands) ? (m.slash_commands as unknown[]).filter((n): n is string => typeof n === "string") : null;
      if (names) items.push({ type: "commands_available", names });
      return items;
    }
    if (sub === "commands_changed") {
      const cmds = Array.isArray(m.commands) ? (m.commands as unknown[]) : null;
      if (!cmds) return [];
      const names = cmds.map((c) => (c as { name?: unknown })?.name).filter((n): n is string => typeof n === "string");
      return [{ type: "commands_available", names }];
    }
    return []; // thinking_tokens·task_* 등 → 파생 없음(현행 미색인·미렌더)
  }

  if (t === "stream_event") {
    const event = m.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } } | undefined;
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
      return [{ type: "text_delta", text: event.delta.text }];
    }
    return []; // thinking/input_json/signature delta는 현행 미렌더 — text만 라이브 미리보기.
  }

  return [];
}

/** raw AetherEvent → AgentEvent[]. (seq, part, ts, provider) 부여는 buildAgentEvents가 담당. */
export function normalizeClaude(ev: AetherEvent): AgentEvent[] {
  let items: AgentEventContent[];
  if (isControlEvent(ev, "user_msg")) {
    const text = ev.text.trim();
    items = text ? [{ type: "user_text", text }] : [];
  } else if (isControlEvent(ev, "ctx")) {
    items = [{ type: "usage_update", totalTokens: ev.totalTokens, maxTokens: ev.maxTokens }];
  } else if (ev.kind === "sdk" && "msg" in ev) {
    items = normalizeSdk(ev.msg);
  } else {
    // permission_request·permission_resolved·question_request·question_resolved·status·notice
    //  → 이미 중립인 Aether 제어 이벤트(D2.5). 파생 콘텐츠 없음. SSE/프론트는 원본 그대로 통과(8c).
    items = [];
  }
  const built = buildAgentEvents(ev, PROVIDER, items);
  // 하위 작업(보조 에이전트) 안에서 나온 발화에는 어느 도구 호출 소속인지 표시한다.
  const m = ev.kind === "sdk" && "msg" in ev ? (ev.msg as { type?: string; parent_tool_use_id?: unknown }) : undefined;
  if (m && (m.type === "assistant" || m.type === "user" || m.type === "stream_event") && typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id) {
    for (const e of built) e.subtaskOf = m.parent_tool_use_id;
  }
  return built;
}
