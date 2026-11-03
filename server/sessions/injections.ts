/**
 * 컨텍스트 주입의 provider 공통분 (Phase 8d · D10).
 *
 * 세션 시작 시 1회 고정되는 안내문을 provider 무관하게 조립한다.
 */
import { config } from "../config";
import { TODO_NUDGE } from "../knowledge/todoTool";
import { RECALL_NUDGE } from "../search/agentTool";

/** 세션 시작 시 1회 고정되는 시스템 안내문(공통분) — 회상 안내(검색이 켜졌을 때만)와 할 일 목록 안내(항상). */
export function buildCommonSystemAppend(_cwd: string): string {
  return [config.search ? RECALL_NUDGE() : "", TODO_NUDGE()].filter(Boolean).join("\n\n");
}
