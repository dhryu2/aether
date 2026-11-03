import { createStorageErrorReporter } from './errors'
// 보낸 문장을 세션마다 최대 50개만 이 탭에 기억한다. 서버에는 올리지 않는다.

const KEY = "aether.promptHistory";
const CAP = 50;
const readFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.prompt_history.read' });
const writeFailure = createStorageErrorReporter({ component: 'storage', operation: 'web.prompt_history.write' });

export type HistoryBrowse = { cursor: number | null; draft: string };

function readAll(): Record<string, string[]> {
  try {
    const raw = sessionStorage.getItem(KEY);
    readFailure.reset();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, string[]>;
  } catch (error) {
    readFailure.report(error);
    return {};
  }
}

export function promptsFor(sessionId: string): string[] {
  const list = readAll()[sessionId];
  if (!Array.isArray(list)) return [];
  return list.filter((item) => typeof item === "string" && item.trim().length > 0);
}

export function rememberPrompt(sessionId: string, text: string): void {
  const trimmed = text.trim();
  if (!sessionId || !trimmed) return;
  const all = readAll();
  const prev = (Array.isArray(all[sessionId]) ? all[sessionId] : []).filter((item) => item !== trimmed);
  prev.push(trimmed);
  all[sessionId] = prev.slice(-CAP);
  try {
    sessionStorage.setItem(KEY, JSON.stringify(all));
    writeFailure.reset();
  } catch (error) {
    writeFailure.report(error, { session_id: sessionId });
    /* 저장 한도를 넘기면 이번 문장만 포기한다. */
  }
}

export function browseUp(
  history: readonly string[],
  state: HistoryBrowse,
  current: string,
): { state: HistoryBrowse; text: string } | null {
  if (history.length === 0) return null;
  if (state.cursor == null) {
    const cursor = history.length - 1;
    return { state: { cursor, draft: current }, text: history[cursor] };
  }
  if (state.cursor <= 0) return { state, text: history[0] };
  const cursor = state.cursor - 1;
  return { state: { ...state, cursor }, text: history[cursor] };
}

export function browseDown(
  history: readonly string[],
  state: HistoryBrowse,
): { state: HistoryBrowse; text: string } | null {
  if (state.cursor == null || history.length === 0) return null;
  if (state.cursor >= history.length - 1) return { state: { cursor: null, draft: "" }, text: state.draft };
  const cursor = state.cursor + 1;
  return { state: { ...state, cursor }, text: history[cursor] };
}
