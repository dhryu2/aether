/**
 * 이 서버가 모델에게 열어주는 지식툴 묶음 (Phase 8d-1 · D8.1).
 *
 * provider 무관하게 "무엇을 열어줄지"만 정한다. 모델이 보는 이름과 부착 방식은 provider adapter가 정한다:
 *   Claude = in-process MCP(`providers/claude/knowledgeMcp.ts`), Codex = streamable HTTP MCP 브릿지(8g).
 *
 * 서술자를 세션마다 새로 만드는 이유: 설명·인자 문구가 서버 로케일에 따라 달라진다(`pick()`).
 *   모듈 로드 시점에 한 번 굳히면 `/api/locale`로 언어를 바꿔도 새 세션에 반영되지 않는다.
 */
import { config } from "../config";
import { searchToolDef } from "../search/agentTool";
import { todoToolDef } from "./todoTool";
import type { KnowledgeToolDefinition } from "./types";

/** 항상 여는 할 일 도구 + search 플래그로 켜진 툴. */
export function buildKnowledgeTools(): KnowledgeToolDefinition[] {
  const tools: KnowledgeToolDefinition[] = [todoToolDef()];
  if (config.search) tools.push(searchToolDef());
  return tools;
}
