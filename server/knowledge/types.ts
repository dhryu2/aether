/**
 * 지식툴 서술자 — provider 중립 툴 정의 (Phase 8d-1 · D8.1).
 *
 * 8d-1 이전엔 `session_search` 등의 *정의 자체*가 Anthropic SDK의 `tool()`
 * 호출로 만들어졌다. 그대로 두고 8g에서 Codex용 HTTP MCP 브릿지를 따로 구현하면 같은 툴의 스키마와
 * 권한 규칙이 두 벌로 갈라져, 한쪽만 고치는 버그가 구조적으로 생긴다. 그래서 정의를 SDK 객체가 아닌
 * 이 서술자로 먼저 분리하고, provider 부착 방식(Claude = in-process MCP, Codex = HTTP 브릿지)을
 * adapter가 맡는다. 8g는 이 서술자를 **소비만** 한다.
 *
 * 보안 경계(D8): cwd와 보조 모델(services)은 **서버가 세션에서 해석해** 핸들러에 넘긴다.
 *   모델은 이 값을 인자로 줄 수 없고 스키마에도 없다. 화이트리스트 검증 방식으로는 모델이 다른
 *   프로젝트 cwd를 지정해 교차 접근하는 것을 막지 못하므로 채택하지 않는다.
 */
import type { TodoItem } from "../../shared/agentEvent";
import type { ProviderServices } from "../providers/types";

/**
 * `ask_user`는 지식툴이 아니라 **질문 카드의 폴백**이다(D5.4). 정본은 Codex가 직접 보내는 질문 요청이고,
 * 그 기능이 개발 중 표시를 달고 있어(위험 R14) 사라졌을 때를 대비해 도구로도 하나 열어 둔다.
 * 이 이름을 여기 적어 두는 이유는 부착 방식이 지식툴과 완전히 같기 때문이다 — 정의는 Codex adapter에만 있고
 * `buildKnowledgeTools()`는 이 이름을 만들지 않는다(Claude에는 native 우회가 이미 있다).
 */
export type KnowledgeToolName = "session_search" | "ask_user" | "todo_update";

/**
 * 3툴이 실제로 쓰는 인자 모양만 담은 최소 어휘(JSON Schema의 부분집합).
 * provider adapter가 자기 형식으로 옮긴다(Claude adapter = zod). 여기 없는 모양이 필요해지면 그때 넓힌다.
 */
export type KnowledgeParam =
  | { kind: "string"; description: string; optional?: boolean }
  | { kind: "integer"; description: string; optional?: boolean; min?: number; max?: number }
  | { kind: "enum"; values: readonly [string, ...string[]]; description: string; optional?: boolean }
  /** 같은 모양의 객체를 여러 개 받는 인자. `fields`는 객체 안 각 칸의 서술이다. */
  | { kind: "list"; description: string; optional?: boolean; maxItems?: number; fields: Record<string, KnowledgeParam> };

/** MCP 표준 툴 결과 형태 — 양 provider 공통이라 그대로 중립 표현으로 쓴다. */
export type KnowledgeToolResult = { content: { type: "text"; text: string }[] };

/** 핸들러가 서버에서 받는 세션 컨텍스트. 모델이 아니라 서버가 채운다. */
export type KnowledgeToolContext = {
  /** 이 세션의 작업 폴더. target="project" 계열 연산과 보조 모델 실행 컨텍스트. */
  cwd: string;
  /** 이 세션 provider의 보조 모델(D6) — 검색결과 요약이 세션 provider를 따르게 하는 통로. */
  services: ProviderServices;
  /** 관측 카운터 내부 라벨. 모델 인자 아님. 화면 계약에 안 실음. */
  sessionId?: string;
  /** 실행기 id. 관측 카운터 meta 전용. 화면은 횟수만 본다. */
  engine?: string;
  /** 할 일 도구가 목록을 넘기는 통로. 세션이 채운다. 없으면 도구가 "쓸 수 없다"고 답한다. */
  onTodoList?: (items: TodoItem[]) => void;
};

export interface KnowledgeToolDefinition {
  readonly name: KnowledgeToolName;
  readonly description: string;
  readonly parameters: Record<string, KnowledgeParam>;
  /** cwd·services를 모델이 인자로 못 주고 서버가 세션에서 해석한다는 표시(D8 보안 경계). */
  readonly binding: "session";
  /**
   * 권한 카드 없이 자동 허용해도 되는가. 3툴 전부 true —
   * 읽기 전용이거나 aether 자체 메모리·스킬 파일 쓰기로 바운디드·안전하고, 카드가 뜨면 흐름만 끊는다.
   */
  readonly autoApprove: boolean;
  handler(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<KnowledgeToolResult>;
}

/** 텍스트 한 덩이짜리 결과(3툴이 전부 이 형태). */
export function textResult(text: string): KnowledgeToolResult {
  return { content: [{ type: "text", text }] };
}
