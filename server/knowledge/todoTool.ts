/**
 * 할 일 목록 도구 `todo_update` — 모델이 자기 작업 단계를 사용자에게 보여 주는 통로.
 *
 * 정의는 provider 중립 서술자 하나다. Claude는 in-process MCP, 나머지는 HTTP MCP 창구로 같은 정의를
 * 그대로 붙이므로 네 provider에서 똑같이 동작한다. 목록은 세션이 넘겨 준 `onTodoList`로 전달되고,
 * 세션이 이를 Aether 제어 사건(`todo_list`)으로 남긴다. 이 파일은 저장하지 않는다.
 */
import type { TodoItem, TodoStatus } from "../../shared/agentEvent";
import { pick } from "../i18n";
import { textResult, type KnowledgeToolDefinition, type KnowledgeToolResult } from "./types";

const MAX_ITEMS = 50;
const MAX_TEXT = 300;
const STATUSES: readonly [TodoStatus, ...TodoStatus[]] = ["pending", "in_progress", "completed"];

/** 시스템 안내문에 붙는 사용 안내. 도구는 provider마다 표기가 다르므로 이름은 중립으로만 적는다. */
export function TODO_NUDGE(): string {
  return pick({
    ko: [
      "[Aether 할 일 목록] 세 단계 이상인 작업은 시작할 때 aether 도구 todo_update로 할 일 목록을 만들어라.",
      "단계를 시작하거나 끝낼 때마다 전체 목록을 다시 보내라. 사용자는 이 목록을 화면에서 본다.",
      "목록 도구는 이것 하나만 써라. 한 번에 끝나는 질문에는 쓰지 마라.",
    ].join("\n"),
    en: [
      "[Aether to-do list] For work with three or more steps, create a to-do list with the aether tool todo_update when you start.",
      "Resend the whole list every time you start or finish a step. The user sees this list on screen.",
      "Use this as your only list tool. Do not use it for questions you answer in one go.",
    ].join("\n"),
  });
}

/** 입력 검사. 위반하면 이유를 문자열로 돌려준다(예외로 던지면 모델 실수가 오류 기록을 채운다). */
function parseItems(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) return pick({ ko: "items는 배열이어야 한다.", en: "items must be an array." });
  if (raw.length > MAX_ITEMS) return pick({ ko: `항목은 최대 ${MAX_ITEMS}개다.`, en: `At most ${MAX_ITEMS} items.` });
  const items: TodoItem[] = [];
  for (const [i, entry] of raw.entries()) {
    const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const text = typeof rec?.text === "string" ? rec.text.trim() : "";
    if (!text) return pick({ ko: `${i + 1}번째 항목의 text가 비었다.`, en: `Item ${i + 1} has empty text.` });
    const status = STATUSES.find((s) => s === rec?.status);
    if (!status) return pick({ ko: `${i + 1}번째 항목의 status는 pending, in_progress, completed 중 하나여야 한다.`, en: `Item ${i + 1} status must be pending, in_progress or completed.` });
    items.push({ text: Array.from(text).slice(0, MAX_TEXT).join(""), status });
  }
  return items;
}

export function todoToolDef(): KnowledgeToolDefinition {
  return {
    name: "todo_update",
    binding: "session",
    autoApprove: true,
    description: pick({
      ko:
        "사용자에게 보여 줄 할 일 목록을 갱신한다. 부를 때마다 목록 전체를 보낸다(일부만 보내면 나머지가 사라진다). " +
        "status는 pending, in_progress, completed 셋이다. 진행 중은 한 번에 하나만 둔다. " +
        "끝낸 단계는 바로 completed로 바꾼다. 빈 목록을 보내면 목록이 지워진다.",
      en:
        "Update the to-do list shown to the user. Send the whole list on every call (anything omitted disappears). " +
        "status is one of pending, in_progress, completed. Keep only one item in progress at a time. " +
        "Mark a finished step completed right away. Sending an empty list clears it.",
    }),
    parameters: {
      items: {
        kind: "list",
        maxItems: MAX_ITEMS,
        description: pick({ ko: "할 일 목록 전체.", en: "The whole to-do list." }),
        fields: {
          text: { kind: "string", description: pick({ ko: "할 일 한 줄 설명.", en: "One-line description of the step." }) },
          status: { kind: "enum", values: STATUSES, description: pick({ ko: "항목 상태.", en: "Item status." }) },
        },
      },
    },
    async handler(args, ctx): Promise<KnowledgeToolResult> {
      if (!ctx.onTodoList) return textResult(pick({ ko: "이 세션에서는 할 일 목록을 쓸 수 없다.", en: "The to-do list is not available in this session." }));
      const items = parseItems(args.items);
      if (typeof items === "string") return textResult(pick({ ko: `할 일 목록을 갱신하지 못했다: ${items}`, en: `To-do list not updated: ${items}` }));
      ctx.onTodoList(items);
      const done = items.filter((i) => i.status === "completed").length;
      return textResult(pick({ ko: `할 일 목록을 갱신했다(완료 ${done}/${items.length}).`, en: `To-do list updated (${done}/${items.length} done).` }));
    },
  };
}
