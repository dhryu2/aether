import { reportError } from "../../observability/report";
/**
 * 지식툴 서술자 → Claude in-process MCP 서버 (Phase 8d-1 · D8.1).
 *
 * 8d-1 이전엔 `server/aetherMcp.ts`가 이 역할과 툴 *정의*를 겸했다. 이제 정의는 provider 중립
 * 서술자(`knowledge/types.ts`)에 있고, 이 파일은 그것을 Anthropic SDK 형식으로 옮기기만 한다.
 * 8g의 Codex HTTP 브릿지는 같은 서술자를 소비하므로 스키마·핸들러·권한 규칙이 두 벌로 갈라지지 않는다.
 *
 * 세션 바인딩: cwd와 보조 모델(services)은 여기서 클로저로 묶어 핸들러에 넘긴다 —
 *   모델이 보는 스키마엔 없으므로 인자로 지정할 수 없다(D8 보안 경계, 8d-1 이전과 동일).
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { z as ZodNs } from "zod";
import type { KnowledgeParam, KnowledgeToolContext, KnowledgeToolDefinition } from "../../knowledge/types";
import type { ClaudeSdkModule } from "./sdk";

/** zod는 첫 Claude 세션이 MCP 서버를 만들 때 불러온다. 부팅 때는 싣지 않는다. */
type Zod = typeof ZodNs;
type ZodAny = ZodNs.ZodTypeAny;

/** SDK 값은 부팅 때 싣지 않으므로 호출자가 불러온 것을 넘긴다(`loadClaudeSdk`). */
type SdkTools = Pick<ClaudeSdkModule, "createSdkMcpServer" | "tool">;

/** Claude MCP 서버 이름 — 모델이 보는 툴 이름의 접두사(`mcp__aether__<tool>`)를 정한다. */
const MCP_SERVER_NAME = "aether";

/** 이 서술자를 Claude에 붙였을 때 모델이 보는 툴 이름. 권한 자동 허용 판정이 이 이름으로 이뤄진다. */
export function claudeToolName(def: KnowledgeToolDefinition): string {
  return `mcp__${MCP_SERVER_NAME}__${def.name}`;
}

/**
 * 중립 인자 서술 → zod. 체이닝 순서(optional → describe)는 8d-1 이전 정의와 동일하게 유지한다
 * (SDK가 zod에서 뽑아내는 JSON Schema 모양이 순서에 따라 달라질 수 있어 무회귀를 위해 고정).
 */
function toZod(z: Zod, p: KnowledgeParam): ZodAny {
  let base: ZodAny;
  if (p.kind === "string") base = z.string();
  else if (p.kind === "integer") {
    let n = z.number().int();
    if (p.min !== undefined) n = n.min(p.min);
    if (p.max !== undefined) n = n.max(p.max);
    base = n;
  } else if (p.kind === "list") {
    const shape: Record<string, ZodAny> = {};
    for (const [key, field] of Object.entries(p.fields)) shape[key] = toZod(z, field);
    let arr = z.array(z.object(shape));
    if (p.maxItems !== undefined) arr = arr.max(p.maxItems);
    base = arr;
  } else base = z.enum(p.values as [string, ...string[]]);
  return (p.optional ? base.optional() : base).describe(p.description);
}

/** 서술자의 인자 전체 → zod raw shape. (테스트가 변환 규칙을 직접 검산할 수 있게 export한다.) */
export function toZodShape(z: Zod, def: KnowledgeToolDefinition): Record<string, ZodAny> {
  const shape: Record<string, ZodAny> = {};
  for (const [key, param] of Object.entries(def.parameters)) shape[key] = toZod(z, param);
  return shape;
}

function toSdkTool(sdk: SdkTools, z: Zod, def: KnowledgeToolDefinition, ctx: KnowledgeToolContext) {
  return sdk.tool(def.name, def.description, toZodShape(z, def), async (args) => {
    try { return await def.handler(args as Record<string, unknown>, ctx); }
    catch (error) { void reportError(error, { component: "mcp", operation: "mcp.tool.call", context: { tool: def.name }, session_id: ctx.sessionId }); throw error; }
  });
}

/**
 * 켜진 지식툴을 한 MCP 서버로 묶는다. 툴이 없으면 null(runtime이 주입 생략).
 * ctx.services = 검색결과 요약에 쓸 보조 모델의 provider — 세션 provider를 따라야 한다(D6).
 */
export async function buildAetherMcpServer(sdk: SdkTools, defs: KnowledgeToolDefinition[], ctx: KnowledgeToolContext): Promise<McpSdkServerConfigWithInstance | null> {
  if (!defs.length) return null;
  const { z } = await import("zod");
  return sdk.createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", alwaysLoad: true, tools: defs.map((d) => toSdkTool(sdk, z, d, ctx)) });
}
