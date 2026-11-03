/**
 * Grok handshake가 준 명령 이름 → Aether 메뉴에 올릴 실행 가능 목록 (Phase 10i).
 *
 * 실행기가 지금 실행 가능하다고 준 것만 올린다. 터미널 창만 여는 이름, 아직 없는 동작(`/rewind` `/fork`),
 * Grok 자체 기억 도구는 광고하지 않는다. `/memory`는 Grok 기억 폴더가 아니라 Agent Brain 화면이다.
 */
import type { RuntimeCommand } from "../types";

/**
 * 터미널 창·TUI 모달만 여는 이름. Aether 화면으로 구현하지 않았으므로 목록에 올리지 않는다.
 * `/clear`는 여기 두지 않는다. 실행기에 `/clear` 원문을 넘겨 CLI 문맥만 지운다. Aether 대화 기록은 유지한다.
 */
const TERMINAL_ONLY = new Set([
  "dashboard",
  "agents-dashboard",
  "sessions",
  "resume",
  "history",
  "config-agents",
  "agents",
  "settings",
  "quit",
  "exit",
  "home",
  "welcome",
  "copy",
  "export",
  "vim-mode",
  "compact-mode",
  "multiline",
  "ml",
  "minimal",
  "fullscreen",
  "full",
  "find",
  "jump",
  "timeline",
  "theme",
  "tutorial",
  "workflows",
  "expand",
  "edit-prompt",
  "always-approve",
  "auto",
  "hooks",
  "plugins",
  "marketplace",
  "skills",
  "hooks-list",
  "hooks-trust",
  "hooks-add",
  "hooks-remove",
  "hooks-untrust",
  "session-info",
  "status",
  "info",
  "context",
  "view-plan",
  "show-plan",
  "plan-view",
  "new",
  "delete",
  "rename",
  "title",
  "login",
  "help",
]);

/** Aether가 아직 구현하지 않은 동작. 메뉴에 있는데 실패하면 더 나쁘다. */
const UNIMPLEMENTED = new Set(["rewind", "undo", "fork"]);

/** Grok 자체 기억 도구. GROK_MEMORY=0 이라 광고하지 않는다. */
const GROK_MEMORY_NATIVE = new Set(["flush", "dream", "remember", "memory"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function commandNameOf(item: unknown): string {
  if (typeof item === "string") return item.replace(/^\//, "").trim().toLowerCase();
  const rec = asRecord(item);
  const name = rec?.name ?? rec?.command;
  return typeof name === "string" ? name.replace(/^\//, "").trim().toLowerCase() : "";
}

function commandDescriptionOf(item: unknown, fallback: string): string {
  const rec = asRecord(item);
  if (typeof rec?.description === "string" && rec.description.trim()) return rec.description.trim();
  if (typeof rec?.title === "string" && rec.title.trim()) return rec.title.trim();
  return fallback;
}

/**
 * Grok TUI의 `/clear`는 `/new` 별칭이고 ACP handshake 목록에 안 실린다(실측).
 * Claude 내장 `/clear`와 같이 실행기가 항상 받는다. 화면 세션 삭제가 아니다.
 */
export const GROK_CLEAR_COMMAND: RuntimeCommand = {
  name: "clear",
  description: { byLocale: { ko: "대화 컨텍스트 초기화", en: "Clear conversation context" } },
  argumentHint: {},
  startsTurn: false,
};

/** handshake 필터 결과에 내장 `/clear`를 채운다. 이미 있으면 그대로 둔다. */
export function withGrokBuiltins(cmds: readonly RuntimeCommand[]): RuntimeCommand[] {
  const out: RuntimeCommand[] = cmds.map((c) => ({ ...c, aliases: c.aliases ? [...c.aliases] : undefined }));
  if (!out.some((c) => c.name === "clear")) out.push({ ...GROK_CLEAR_COMMAND });
  return out;
}

/** handshake/available_commands 원본 → 메뉴에 올릴 실행 가능 명령. */
export function grokMenuCommands(raw: unknown): RuntimeCommand[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: RuntimeCommand[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const name = commandNameOf(item);
    if (!name || seen.has(name)) continue;
    if (TERMINAL_ONLY.has(name) || UNIMPLEMENTED.has(name) || GROK_MEMORY_NATIVE.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: { text: commandDescriptionOf(item, name) },
      argumentHint: {},
      startsTurn: true,
    });
  }
  return out;
}
