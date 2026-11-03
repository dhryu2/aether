/**
 * grok agent stdio 실행 인자 (Phase 10c · D3/D4).
 *
 * 전역 `permission_mode=always-approve`가 카드를 없애므로, 기본 세션은 CLI `--permission-mode`를
 * 매번 못 박는다(10a S20). 샌드박스는 workspace. `/tmp` 쓰기는 카드가 뜬다(S21).
 */
import type { PermissionMode } from "../../../shared/http";

export type GrokSpawnFlags = {
  /** 미지정 = CLI/계정 기본. */
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
};

/** Aether 중립 권한 모드 → Grok CLI의 `--permission-mode` 값. full은 이 값 대신 `--always-approve`를 쓴다. */
const GROK_CLI_MODE = { manual: "default", edits: "acceptEdits", auto: "auto" } as const;

/**
 * `grok` 뒤에 붙는 인자. 테스트가 실제 spawn 조립을 대조한다.
 *
 * manual·edits·auto: `--permission-mode <default|acceptEdits|auto> --sandbox workspace agent --no-leader -m … stdio`
 * full: `agent --no-leader --always-approve -m … stdio` (전역 우회 허용).
 */
export function grokAgentArgs(flags: GrokSpawnFlags): string[] {
  const global: string[] = [];
  if (flags.permissionMode !== "full") {
    global.push("--permission-mode", GROK_CLI_MODE[flags.permissionMode], "--sandbox", "workspace");
  }
  return [
    ...global,
    "agent",
    "--no-leader",
    ...(flags.permissionMode === "full" ? ["--always-approve"] : []),
    ...(flags.model ? ["-m", flags.model] : []),
    ...(flags.effort ? ["--reasoning-effort", flags.effort] : []),
    "stdio",
  ];
}
