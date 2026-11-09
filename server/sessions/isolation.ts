/**
 * 격리 세션 — 사용자 전역 설정(~/.claude)·aether MCP·회상 훅 없이, 작업 폴더 설정과 호출자가 준 MCP만 쓰는 세션.
 * 요청 본문 검증(`parseIsolation`)과 Claude 쿼리 옵션 중 격리에 따라 갈리는 부분(`claudeScope`)을 한곳에 둔다.
 */
import { st } from "../i18n";

export type Isolation = { mcpServers: Record<string, string> };

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/|\?|$)/;
const MAX_SERVERS = 8;

/** 본문의 isolated/mcpServers를 검증한다. 격리가 아니면 isolation은 비어 있다. */
export function parseIsolation(body: { isolated?: unknown; mcpServers?: unknown }): { isolation?: Isolation } | { error: string } {
  const { isolated, mcpServers } = body;
  if (isolated !== undefined && typeof isolated !== "boolean") return { error: st("routes.sessions.isolatedInvalid") };
  if (mcpServers !== undefined && isolated !== true) return { error: st("routes.sessions.mcpServersNeedIsolated") };
  if (isolated !== true) return {};
  const out: Record<string, string> = {};
  if (mcpServers !== undefined) {
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return { error: st("routes.sessions.mcpServersInvalid") };
    const entries = Object.entries(mcpServers as Record<string, unknown>);
    if (entries.length > MAX_SERVERS) return { error: st("routes.sessions.mcpServersInvalid") };
    for (const [name, url] of entries) {
      if (!NAME.test(name) || typeof url !== "string" || !LOCAL_URL.test(url)) return { error: st("routes.sessions.mcpServersInvalid") };
      out[name] = url;
    }
  }
  return { isolation: { mcpServers: out } };
}

/** 디스크 meta에서 읽은 값을 다시 검증해 되살린다(변조된 meta가 검증을 우회하지 못하게). */
export function restoreIsolation(raw: unknown): Isolation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = parseIsolation({ isolated: true, mcpServers: (raw as Isolation).mcpServers });
  return "isolation" in r ? r.isolation : undefined;
}

/** Claude 쿼리 옵션 중 격리 여부로 갈리는 부분. */
export function claudeScope<M>(
  isolation: Isolation | undefined,
  normal: { aetherMcp?: M; promptAppend: string; wantsTurnHook: boolean },
): { settingSources: ("user" | "project" | "local")[]; mcpServers?: Record<string, unknown>; extraArgs?: Record<string, string | null>; promptAppend: string; turnHook: boolean } {
  if (!isolation) {
    return {
      settingSources: ["user", "project", "local"],
      ...(normal.aetherMcp ? { mcpServers: { aether: normal.aetherMcp } } : {}),
      promptAppend: normal.promptAppend,
      turnHook: normal.wantsTurnHook,
    };
  }
  const mcpServers = Object.fromEntries(Object.entries(isolation.mcpServers).map(([n, url]) => [n, { type: "http" as const, url }]));
  // strict-mcp-config: 계정에 붙은 claude.ai 커넥터(Gmail·Notion 등)와 사용자 MCP를 끊고 위 서버만 쓴다.
  return { settingSources: ["project", "local"], extraArgs: { "strict-mcp-config": null }, ...(Object.keys(mcpServers).length ? { mcpServers } : {}), promptAppend: "", turnHook: false };
}
