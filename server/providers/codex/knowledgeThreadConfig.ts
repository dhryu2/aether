import { config } from "../../config";
import { MCP_SERVER_NAME, type KnowledgeHttpAttach } from "../knowledgeBridge";

/**
 * 지식 도구 창구 주소·헤더 → Codex `thread/start`·`thread/resume`의 `config`에 얹을 값.
 * 스레드마다 따로 주므로 사용자의 전역 설정 파일은 건드리지 않는다(D8).
 * 토큰은 여기(스레드 설정)로만 간다 — 환경변수·실행 인자에 두지 않는다(`providers/knowledgeBridge.ts` 머리 주석).
 */
export function codexThreadConfig(attach: KnowledgeHttpAttach): Record<string, unknown> {
  return {
    mcp_servers: {
      [MCP_SERVER_NAME]: {
        url: attach.url,
        http_headers: { Authorization: attach.authorization },
        // Codex의 MCP 승인은 서버 단위라 도구별로 가를 수 없다. 도구별 판정은 창구가 직접 한다.
        default_tools_approval_mode: "approve",
        // 카드가 뜨는 도구(쓰기 승인·되물음)는 **사용자가 답할 때까지** 응답이 안 나간다.
        //   Codex 기본 상한 60초로는 폰에서 답하기 전에 끊긴다(8a).
        tool_timeout_sec: config.codexMcpToolTimeoutSec,
      },
    },
  };
}
