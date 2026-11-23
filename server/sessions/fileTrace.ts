/**
 * 파일에서 그 파일을 고친 세션 찾기 — 중립 사건을 하나씩 받아 "어느 턴에 어느 파일을 고쳤는지" 모으는 순수 누적기.
 * AI도 git도 부르지 않는다. provider 이름이나 도구 원본 이름은 보지 않고 중립 필드(toolKind, paths, isError, user_text)만 읽는다.
 * 한계: 셸 명령으로 고친 파일은 기록에 경로가 없어 찾지 못한다.
 */
import type { AgentEvent } from "../../shared/agentEvent";

const PROMPT_MAX = 300;
const COMMANDS_PER_TURN = 5;
const COMMAND_MAX = 300;

export type FileTouch = { seq: number; at: number; prompt?: { text: string; seq: number }; commands: { text: string; seq: number }[] };

type Turn = { prompt?: { text: string; seq: number }; commands: { text: string; seq: number }[]; edits: { toolId: string; keys: string[]; seq: number; at: number }[] };

/** keyOf는 기록의 경로를 비교용 열쇠(실제 절대 경로)로 바꾼다. 사건은 오래된 것부터 넣는다. */
export function createFileTouches(keyOf: (p: string) => string) {
  const turns: Turn[] = [{ commands: [], edits: [] }];
  const failed = new Map<string, boolean>(); // 같은 toolId의 마지막 결과가 유효하다
  return {
    add(ev: AgentEvent) {
      if (ev.type === "user_text") {
        turns.push({ prompt: { text: ev.text.slice(0, PROMPT_MAX), seq: ev.seq }, commands: [], edits: [] });
      } else if (ev.type === "tool_result") {
        failed.set(ev.toolId, ev.isError === true);
      } else if (ev.type === "tool_call") {
        const turn = turns[turns.length - 1];
        if (ev.toolKind === "file_change" && ev.paths?.length) turn.edits.push({ toolId: ev.toolId, keys: ev.paths.map(keyOf), seq: ev.seq, at: ev.ts });
        else if (ev.toolKind === "bash" && ev.target?.trim() && turn.commands.length < COMMANDS_PER_TURN) turn.commands.push({ text: ev.target.trim().slice(0, COMMAND_MAX), seq: ev.seq });
      }
    },
    /** 경로 열쇠 → 그 파일을 고친 턴들(오래된 것부터). 실패한 수정만 있는 턴은 빠진다. */
    result(): Map<string, FileTouch[]> {
      const out = new Map<string, FileTouch[]>();
      for (const t of turns) {
        const last = new Map<string, { seq: number; at: number }>();
        for (const e of t.edits) if (failed.get(e.toolId) !== true) for (const k of e.keys) last.set(k, { seq: e.seq, at: e.at });
        for (const [k, m] of last) out.set(k, [...(out.get(k) ?? []), { ...m, ...(t.prompt ? { prompt: t.prompt } : {}), commands: t.commands }]);
      }
      return out;
    },
  };
}
