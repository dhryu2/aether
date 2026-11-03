import { reportError } from "../observability/report";
/**
 * 에이전트용 과거이력 검색 툴 — Hermes session_search 모방.
 * 모델이 "지난번에 어떻게 했더라" 식으로 현재 컨텍스트에 없는 과거 작업(채팅+action)을 DB에서
 * 동적으로 회상할 때 호출한다.
 *
 * 3모드(인자로 추론):
 *   - DISCOVERY: query 지정 → 검색 → 세션별 transcript(시작/매칭맥락/끝). action 시퀀스를 맥락째 회상.
 *   - SCROLL: session_id + around_id 지정 → 그 지점 ±window 더 파고들기(FTS 없음).
 *   - BROWSE: session_id 지정 → 세션 전체를 after_id 커서로 순서대로 읽기.
 * scope="project"면 서버 작업 폴더(ctx.cwd)의 세션만, 지금 세션과 같은 이어가기 묶음은 빼고, 요약 없이 행마다 날짜를 붙인다.
 * 생략과 "all"은 아래 기존 경로 그대로다.
 * 읽기 전용 → autoApprove(권한 카드 없이 자동 허용).
 *
 * 8d-1: 정의는 provider 중립 서술자다(D8.1). 모델이 보는 이름·부착 방식(Claude = in-process MCP,
 *   Codex = HTTP 브릿지)은 provider adapter가 정한다 — 여기엔 SDK 의존이 없다.
 */
import { backgroundDistill } from "../providers/backgroundDistill";
import { HL_OPEN, HL_CLOSE, type CtxRow, type SessionContextHit } from "./queryTokens";
import { readSearchSummarize } from "./summarySetting";
import { pick } from "../i18n";
import { textResult, type KnowledgeToolDefinition } from "../knowledge/types";
import type { ProviderServices } from "../providers/types";
import { PAST_SEARCH_RESULT } from "./pastSearchResult";
import {
  getLetterContext,
  getLetterSessionPage,
  letterSessionInProject,
  searchLettersWithContext,
  sessionLetterReady,
} from "../db/sessionLetter";
import { recordSearchAudit } from "../db/searchAudit";

/**
 * 시스템 프롬프트에 append할 회상 nudge — 만든 session_search 툴을 모델이 실제로 쓰게 유도(기둥1+2 작동).
 * 매 세션 프롬프트에 들어가므로 짧게. config.search일 때만 주입.
 */
export function RECALL_NUDGE(): string {
  return pick({
    ko: [
      "[Aether 과거 회상] 너에겐 mcp__aether__session_search 툴이 있다 — 과거 모든 세션의 대화와 작업이력(실행한 명령·발생한 에러·해결책·내린 결정)을 검색한다.",
      "다음 상황에선 작업 착수 전에 먼저 이 툴로 과거를 확인하라:",
      "- 빌드/배포/설정/디버깅 등 전에 해봤을 법한 작업",
      "- 짧은 절차 요청(\"배포해줘\", \"재시작해\") — 이 프로젝트에서 예전에 한 방법일 수 있다",
      "- 낯익은 에러를 만났을 때",
      '- "지난번", "예전에", "원래", "그때처럼", "비슷" 같은 언급이 나올 때',
      "과거에 같은 문제를 푼 이력이 있으면 그 해결책(명령·수정)을 참조해 더 빠르고 정확히 처리하라. 검색은 읽기 전용이고 토큰을 거의 안 쓴다. 단, 매 턴 습관적으로 부르지는 말고 위 상황에서만.",
    ].join("\n"),
    en: [
      "[Aether recall] You have the mcp__aether__session_search tool — it searches the conversation and work history (commands run, errors hit, fixes applied, decisions made) across all past sessions.",
      "In the following situations, check the past with this tool before starting work:",
      "- Build/deploy/config/debugging or other tasks you've likely done before",
      '- Short procedure asks ("deploy it", "restart it") — it may be how this project did it before',
      "- When you hit a familiar error",
      '- When phrases like "last time", "previously", "originally", "like before", "similar" come up',
      "If there's a history of solving the same problem, reference that solution (command/fix) to work faster and more accurately. Search is read-only and uses almost no tokens. But don't call it habitually every turn — only in the situations above.",
    ].join("\n"),
  });
}

function roleLabel(role: string): string {
  const labels = pick<Record<string, string>>({
    ko: { user: "유저", assistant: "어시", tool: "도구" },
    en: { user: "user", assistant: "asst", tool: "tool" },
  });
  return labels[role] ?? role;
}

/** 서버 프로세스 지역 시간대의 날짜. YYYY-MM-DD. */
function localDay(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// 근거: past-search-diet-plan.md 7.0절. ANCHOR_PREVIEW는 7.4절(2026-10-21 재측정: 1,500 → 6,000에서 검색 정답이 14·13 → 15·15)
export const TOOL_RESULT_PREVIEW = 600;
export const ANCHOR_PREVIEW = 6_000;
export const ROW_MAX = 4_000;
export const RESPONSE_CAP = 20_000;

// 검색 결과 그리기는 같은 행을 여러 번 다시 그린다. 정규화는 행마다 한 번만 한다.
const bodyCache = new WeakMap<CtxRow, string>();
function rowBody(r: CtxRow): string {
  let body = bodyCache.get(r);
  if (body === undefined) {
    body = r.content.split(HL_OPEN).join("").split(HL_CLOSE).join("").replace(/\s+/g, " ").trim();
    bodyCache.set(r, body);
  }
  return body;
}

/** 머리말과 빈 결과 문구에 되찍는 모델 입력(검색어, 세션 id)의 길이. 응답 상한은 행 본문 기준이라 이 입력이 혼자 상한을 넘지 않게 한다. */
const ECHO_MAX = 200;
function clipEcho(s: string): string {
  return s.length > ECHO_MAX ? `${s.slice(0, ECHO_MAX)}…` : s;
}

function shortenBody(body: string, limit: number, id: number): string {
  if (body.length <= limit) return body;
  let end = Math.max(0, limit);
  // 서로게이트 쌍은 함께 남기거나 함께 뺀다.
  if (end > 0 && /[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end] ?? "")) end--;
  return body.slice(0, end) + pick({
    ko: ` … (나머지 ${body.length - end}자 생략 · #${id})`,
    en: ` … (${body.length - end} more chars omitted · #${id})`,
  });
}

function fmtRow(r: CtxRow, anchorId?: number, withDate = false, seen = new Map<string, number>(), full = false, limit?: number): string {
  const who = roleLabel(r.role);
  const body = rowBody(r);
  const toolResult = r.role === "tool" && body.startsWith("▸");
  const previous = seen.get(body);
  let c = body;
  if (!full) {
    if (toolResult && PAST_SEARCH_RESULT.test(body)) {
      c = pick({ ko: `▸ (예전 검색 결과 ${body.length}자 생략)`, en: `▸ (past search result, ${body.length} chars omitted)` });
    } else if (toolResult && previous !== undefined && previous !== r.id) {
      c = pick({ ko: `▸ (#${previous}와 같은 내용 ${body.length}자)`, en: `▸ (same as #${previous}, ${body.length} chars)` });
    } else {
      c = shortenBody(body, toolResult ? TOOL_RESULT_PREVIEW : ROW_MAX, r.id);
    }
  }
  if (limit !== undefined) c = shortenBody(body, limit, r.id);
  if (toolResult && previous === undefined) seen.set(body, r.id);
  const mark = anchorId != null && r.id === anchorId ? pick({ ko: "  ◀매칭", en: "  ◀match" }) : "";
  const stamp = withDate ? ` ${localDay(r.ts)}` : "";
  return `    [${who} #${r.id}${stamp}] ${c}${mark}`;
}

export function fmtBrowse(sessionId: string, rows: CtxRow[], project = false): string {
  if (!rows.length) return pick({ ko: `session=${clipEcho(sessionId)}에서 더 볼 원문이 없다.`, en: `No more raw messages in session=${clipEcho(sessionId)}.` });
  const lines: string[] = [];
  const seen = new Map<string, number>();
  const render = (body: string[], count: number) => {
    const last = rows[count - 1].id;
    const omitted = rows.length - count;
    const notice = omitted ? pick({
      ko: `(응답 상한 ${RESPONSE_CAP}자에 닿아 이 페이지의 ${omitted}행은 다음 페이지에서 이어진다)\n`,
      en: `(Hit the ${RESPONSE_CAP}-char response cap; ${omitted} rows on this page continue on the next page)\n`,
    }) : "";
    return pick({
      ko: `session=${sessionId} 원문:\n${body.join("\n")}\n\n${notice}다음 페이지: session_search(session_id="${sessionId}", after_id=${last}${project ? ', scope="project"' : ""})`,
      en: `Raw session=${sessionId}:\n${body.join("\n")}\n\n${notice}Next page: session_search(session_id="${sessionId}", after_id=${last}${project ? ', scope="project"' : ""})`,
    });
  };
  for (const r of rows) {
    const line = fmtRow(r, undefined, project, seen);
    if (render([...lines, line], lines.length + 1).length > RESPONSE_CAP) break;
    lines.push(line);
  }
  if (!lines.length) {
    const overhead = render([fmtRow(rows[0], undefined, project, new Map(), true, 0)], 1).length;
    let limit = Math.max(0, RESPONSE_CAP - overhead);
    let line = fmtRow(rows[0], undefined, project, new Map(), true, limit);
    while (render([line], 1).length > RESPONSE_CAP && limit > 0) line = fmtRow(rows[0], undefined, project, new Map(), true, --limit);
    lines.push(line);
  }
  return render(lines, lines.length);
}

export function fmtDiscovery(query: string, hits: SessionContextHit[], project = false): string {
  const shown = clipEcho(query);
  if (!hits.length)
    return pick({
      ko: `"${shown}" 검색 결과 없음. 다른 키워드(명령·에러 메시지·파일명 등)나 더 짧게 시도해보라.`,
      en: `No results for "${shown}". Try other keywords (command, error message, filename, etc.) or a shorter query.`,
    });
  const startLabel = pick({ ko: "  ┄세션 시작:", en: "  ┄session start:" });
  const matchLabel = pick({ ko: "  ┄매칭 맥락(요청→action→결과 시퀀스):", en: "  ┄match context (request→action→result sequence):" });
  const endLabel = pick({ ko: "  ┄세션 끝:", en: "  ┄session end:" });
  const header = pick({
    ko: `"${shown}" 검색 ${hits.length}건 — 각 세션의 매칭 전후 맥락(⚙=도구호출, ▸=도구결과):\n\n`,
    en: `${hits.length} result(s) for "${shown}" — match context per session (⚙=tool call, ▸=tool result):\n\n`,
  });
  const footer = pick({
    ko: project
      ? `\n\n더 파고들려면 session_search(session_id="…", around_id=<위 #숫자>, scope="project")로 SCROLL.`
      : `\n\n더 파고들려면 session_search(session_id="…", around_id=<위 #숫자>)로 SCROLL.`,
    en: project
      ? `\n\nTo dig deeper, SCROLL with session_search(session_id="…", around_id=<the #number above>, scope="project").`
      : `\n\nTo dig deeper, SCROLL with session_search(session_id="…", around_id=<the #number above>).`,
  });
  // 소문자로 바꿀 때 길이가 변하는 글자(예: İ)는 그대로 두어 위치가 원문과 맞게 한다. 검색어와 본문에 같은 규칙을 쓴다.
  const foldCase = (text: string) => Array.from(text, (ch) => {
    const low = ch.toLowerCase();
    return low.length === ch.length ? low : ch;
  }).join("");
  const words = [...new Set(query.split(/\s+/).map((word) => foldCase(word.replace(/^"|"$/g, ""))).filter((word) => word.length >= 2))];
  const previewAnchor = (row: CtxRow) => {
    const body = rowBody(row);
    if (body.length <= ANCHOR_PREVIEW) return body;
    const lower = foldCase(body);
    const occurrences: Array<{ word: string; position: number }> = [];
    for (const word of words) {
      let position = lower.indexOf(word);
      while (position >= 0 && occurrences.length < 200) {
        occurrences.push({ word, position });
        position = lower.indexOf(word, position + 1);
      }
      if (occurrences.length === 200) break;
    }
    let start = 0;
    let best = -1;
    for (const { position } of occurrences) {
      const s = Math.max(0, position - 200);
      const score = new Set(occurrences.filter((o) => o.position >= s && o.position + o.word.length <= s + ANCHOR_PREVIEW).map((o) => o.word)).size;
      if (score > best || (score === best && s < start)) {
        start = s;
        best = score;
      }
    }
    let end = Math.min(body.length, start + ANCHOR_PREVIEW);
    // 양쪽 경계를 발췌 안쪽으로 당겨 서로게이트 쌍을 나누지 않는다.
    if (start > 0 && /[\uD800-\uDBFF]/.test(body[start - 1]) && /[\uDC00-\uDFFF]/.test(body[start])) start++;
    if (end > 0 && /[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end] ?? "")) end--;
    const prefix = start > 0 ? (row.role === "tool" && body.startsWith("▸") ? "▸ " : "") + pick({
      ko: `(앞 ${start}자 생략) … `,
      en: `(${start} earlier chars omitted) … `,
    }) : "";
    const suffix = end < body.length ? pick({
      ko: ` … (나머지 ${body.length - end}자 생략 · #${row.id})`,
      en: ` … (${body.length - end} more chars omitted · #${row.id})`,
    }) : "";
    return prefix + body.slice(start, end) + suffix;
  };
  const blocks = hits.map((h, i) => {
    let anchor = h.window.findIndex((row) => row.id === h.anchor.id);
    if (anchor < 0) {
      for (let j = 0; j < h.window.length; j++) if (h.window[j].id <= h.anchor.id) anchor = j;
    }
    if (anchor < 0) anchor = 0;
    const when = localDay(h.anchor.ts);
    const sess = h.session.displayName || h.session.cwd || h.sessionId.slice(0, 8);
    return {
      title: `#${i + 1} [${when}] ${sess}  (session=${h.sessionId})`,
      anchor,
      preview: h.window[anchor] ? previewAnchor(h.window[anchor]) : "",
      sections: [h.bookendStart, h.window, h.bookendEnd],
      selected: [new Set<number>(), new Set<number>(), new Set<number>()],
    };
  });
  const render = () => {
    const seen = new Map<string, number>();
    const rendered: string[] = [];
    const refs: string[] = [];
    let omitted = 0;
    blocks.forEach((block, i) => {
      const missing = block.sections.reduce((sum, rows, section) => sum + rows.length - block.selected[section].size, 0);
      omitted += missing;
      if (missing) refs.push(`#${i + 1} session=${hits[i].sessionId} around_id=${hits[i].anchor.id}`);
      if (!block.selected[1].has(block.anchor)) return;
      const lines = [block.title];
      block.sections.forEach((rows, section) => {
        if (!block.selected[section].size) return;
        lines.push([startLabel, matchLabel, endLabel][section]);
        rows.forEach((row, j) => {
          if (!block.selected[section].has(j)) return;
          if (section !== 1 || j !== block.anchor) {
            lines.push(fmtRow(row, undefined, project, seen));
            return;
          }
          const body = rowBody(row);
          const previous = seen.get(body);
          const folded = row.role === "tool" && body.startsWith("▸") && (PAST_SEARCH_RESULT.test(body) || (previous !== undefined && previous !== row.id));
          // 먼저 원문으로 접기와 중복 기록을 판정하고, 매칭 행에만 발췌를 적용한다.
          const line = fmtRow(row, row.id, project, seen);
          const stamp = project ? ` ${localDay(row.ts)}` : "";
          lines.push(folded ? line : `    [${roleLabel(row.role)} #${row.id}${stamp}] ${block.preview}${pick({ ko: "  ◀매칭", en: "  ◀match" })}`);
        });
      });
      rendered.push(lines.join("\n"));
    });
    const body = rendered.join("\n\n");
    const notice = omitted ? pick({
      ko: `(응답 상한 ${RESPONSE_CAP}자에 닿아 ${omitted}줄을 뺐다. 다 보이지 못한 결과: ${refs.join(", ")})`,
      en: `(Hit the ${RESPONSE_CAP}-char response cap; omitted ${omitted} lines. Not fully shown: ${refs.join(", ")})`,
    }) : "";
    return header + body + (notice ? `${body ? "\n" : ""}${notice}` : "") + footer;
  };
  const tryRow = (block: typeof blocks[number], section: number, index: number) => {
    if (index < 0 || index >= block.sections[section].length) return;
    block.selected[section].add(index);
    if (render().length > RESPONSE_CAP) block.selected[section].delete(index);
  };
  // 핵심, 가까운 맥락, 가장자리 순서로 결과마다 고르게 담는다.
  for (const block of blocks) tryRow(block, 1, block.anchor);
  const windowDepth = Math.max(...hits.map((h) => h.window.length));
  for (let distance = 1; distance < windowDepth; distance++) {
    for (const block of blocks) {
      if (!block.selected[1].has(block.anchor)) continue;
      tryRow(block, 1, block.anchor - distance);
      tryRow(block, 1, block.anchor + distance);
    }
  }
  const edgeDepth = Math.max(...hits.flatMap((h) => [h.bookendStart.length, h.bookendEnd.length]));
  for (let r = 0; r < edgeDepth; r++) {
    for (const block of blocks) {
      if (!block.selected[1].has(block.anchor)) continue;
      tryRow(block, 0, r);
      tryRow(block, 2, r);
    }
  }
  return render();
}

function projectFolderReject(sessionId: string): string {
  return pick({
    ko: `session=${sessionId}는 같은 작업 폴더의 세션이 아니다.`,
    en: `session=${sessionId} is not a session in the same working folder.`,
  });
}

export function fmtScroll(sessionId: string, win: CtxRow[], project = false, aroundId?: number): string {
  if (!win.length) return pick({ ko: `session=${clipEcho(sessionId)}의 해당 위치를 찾지 못했다.`, en: `Could not find that position in session=${clipEcho(sessionId)}.` });
  const rows = [...win].sort((a, b) => a.id - b.id);
  let anchor = aroundId === undefined ? -1 : rows.findIndex((r) => r.id === aroundId);
  if (anchor < 0 && aroundId !== undefined) {
    for (let i = 0; i < rows.length; i++) if (rows[i].id <= aroundId) anchor = i;
  }
  if (anchor < 0) anchor = 0;
  const render = (first: number, last: number, limit?: number) => {
    const seen = new Map<string, number>();
    const lines = rows.slice(first, last + 1).map((r, i) => fmtRow(r, undefined, project, seen, first + i === anchor, first + i === anchor ? limit : undefined));
    const earlier = first;
    const later = rows.length - last - 1;
    const notice = earlier || later ? pick({
      ko: `(응답 상한 ${RESPONSE_CAP}자에 닿아 앞 ${earlier}행, 뒤 ${later}행을 뺐다)\n`,
      en: `(Hit the ${RESPONSE_CAP}-char response cap; omitted ${earlier} earlier and ${later} later rows)\n`,
    }) : "";
    return pick({
      ko:
        `session=${sessionId} 맥락:\n${lines.join("\n")}\n\n${notice}` +
        (project
          ? `이전으로: around_id=${rows[first].id} · 다음으로: around_id=${rows[last].id} (같은 session_id, scope="project"로 SCROLL)`
          : `이전으로: around_id=${rows[first].id} · 다음으로: around_id=${rows[last].id} (같은 session_id로 SCROLL)`),
      en:
        `session=${sessionId} context:\n${lines.join("\n")}\n\n${notice}` +
        (project
          ? `Earlier: around_id=${rows[first].id} · Later: around_id=${rows[last].id} (SCROLL with the same session_id and scope="project")`
          : `Earlier: around_id=${rows[first].id} · Later: around_id=${rows[last].id} (SCROLL with the same session_id)`),
    });
  };
  let first = anchor;
  let last = anchor;
  if (render(first, last).length > RESPONSE_CAP) {
    let limit = Math.max(0, RESPONSE_CAP - render(first, last, 0).length);
    let result = render(first, last, limit);
    while (result.length > RESPONSE_CAP && limit > 0) result = render(first, last, --limit);
    return result;
  }
  for (let distance = 1; distance < rows.length; distance++) {
    if (anchor - distance >= 0) {
      if (render(anchor - distance, last).length > RESPONSE_CAP) break;
      first = anchor - distance;
    }
    if (anchor + distance < rows.length) {
      if (render(first, anchor + distance).length > RESPONSE_CAP) break;
      last = anchor + distance;
    }
  }
  return render(first, last);
}

/**
 * Hermes식 검색결과 요약(기둥1 강화) — DISCOVERY 원문 블록을 배경 작업용 경량 모델로 압축해 토큰 평평·노이즈 제거.
 * SCROLL 앵커(session_id/around_id)는 요약 뒤 푸터로 보존 → 요약이 세션 참조를 삼켜도 원문 파고들기 가능.
 * 실패/무수확이면 null(호출부가 원문 블록으로 폴백). distill = 툴 deny-all 경량 보조 모델(세션 provider의 것 — D6).
 */
/** distill이 assistant텍스트+result(대개 동일)를 이어붙여 2배가 되는 경우 접는다. `A\nA` 패턴이면 A만. */
function collapseDoubled(s: string): string {
  const t = s.trim();
  for (let i = t.indexOf("\n"); i !== -1; i = t.indexOf("\n", i + 1)) {
    const a = t.slice(0, i).trim();
    const b = t.slice(i + 1).trim();
    if (a.length > 15 && a === b) return a;
  }
  return t;
}

async function summarizeHits(query: string, block: string, hits: SessionContextHit[], cwd: string, services: ProviderServices): Promise<string | null> {
  const prompt = pick({
    ko: [
      `아래는 "${query}"에 대한 과거 세션 검색 원문이다. 지금 작업에 실제로 쓸모 있는 것만 골라 요약하라.`,
      "규칙: ①핵심 결정·실행한 명령·발생한 에러·해결책만 뽑아 불릿 몇 줄로. ②관련 없어 보이면 과감히 버려라. ③추측 금지 — 원문에 있는 것만. ④한국어로 간결하게(최대 8줄).",
      "출력은 요약 불릿만(머리말·맺음말·코드펜스 금지). 쓸 만한 게 없으면 정확히 'NONE'만 출력하라.",
      "── 검색 원문 ──",
      block,
    ].join("\n"),
    en: [
      `Below is the raw past-session search output for "${query}". Pick only what's actually useful for the current work and summarize it.`,
      "Rules: (1) Extract only key decisions, commands run, errors hit, and fixes as a few bullets. (2) Drop anything that looks irrelevant. (3) No speculation — only what's in the source. (4) Be concise in English (max 8 lines).",
      "Output only the summary bullets (no preamble, no closing, no code fences). If there's nothing useful, output exactly 'NONE'.",
      "── search output ──",
      block,
    ].join("\n"),
  });
  let out = "";
  try {
    out = collapseDoubled(await backgroundDistill(services, "candidate", prompt, cwd));
  } catch (e) {
    void reportError(e, { component: "search", operation: "search.summary.run" }); console.error("[aether] search 요약 실패:", e);
    return null;
  }
  if (!out) return null;
  // 무수확 감지: NONE 센티널(프롬프트 지시) + 모델이 산문으로 "없음"이라 답하는 변형. distill의 assistant+result 이어붙임 탓에
  // 같은 줄이 2번 나올 수 있어(짧으면 collapseDoubled가 못 접음) 줄 단위로 전부 무수확이면 null → 호출부가 원문 블록 폴백.
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length || lines.every((l) => /^NONE$/i.test(l) || /쓸\s?만한 (게|것이) 없/.test(l))) return null;
  const refs = hits.map((h, i) => `#${i + 1} session=${h.sessionId} around_id=${h.anchor.id}`).join(" · ");
  return pick({
    ko: `"${query}" 과거 검색 요약:\n${out}\n\n원문 더 보기(SCROLL): ${refs}`,
    en: `Past-search summary for "${query}":\n${out}\n\nSee raw (SCROLL): ${refs}`,
  });
}

/**
 * session_search 서술자(D8.1). cwd·services는 모델이 아니라 서버가 세션에서 채워 핸들러에 넘긴다
 * (cwd = 결과 요약 보조 모델의 실행 컨텍스트, services = 그 보조 모델의 provider — D6).
 */
export function searchToolDef(): KnowledgeToolDefinition {
  return {
      name: "session_search",
      binding: "session",
      autoApprove: true,
      description: pick({
        ko:
          "과거 모든 Aether 세션의 대화+작업이력(action)을 전문검색한다(한국어 포함). " +
          "현재 컨텍스트에 없는 지난 작업을 회상할 때 사용: 어떤 명령을 실행했고, 어떤 에러가 났고, 어떤 패키지 설치·파일 수정으로 해결했는지까지 검색된다. " +
          "결과는 매칭 지점의 전후 시퀀스(요청→도구호출→결과)와 세션 시작/끝을 함께 준다. " +
          "DISCOVERY: query로 검색. SCROLL: session_id+around_id로 특정 지점을 더 파고들기. BROWSE: session_id와 선택적 after_id로 세션 전체를 페이지 단위로 읽기. " +
          "DISCOVERY는 글자가 겹쳐야 찾으므로, 요구에 쓰인 낱말뿐 아니라 정해야 할 대상(예: 환경, 기준 시각, 형식)으로도 따로 찾아라. " +
          'scope="project"면 지금 작업 폴더의 세션만 찾고, 요약 없이 행마다 날짜를 붙인 원문을 준다. 생략하거나 "all"이면 모든 세션을 찾는다.',
        en:
          "Full-text search over the conversation + work history (actions) across all past Aether sessions (Korean included). " +
          "Use it to recall past work not in the current context: what commands were run, what errors occurred, and how they were fixed (package installs, file edits). " +
          "Results include the surrounding sequence at the match (request→tool call→result) plus the session start/end. " +
          "DISCOVERY: search with query. SCROLL: dig deeper into a specific point with session_id+around_id. BROWSE: read a session page by page with session_id and optional after_id. " +
          "DISCOVERY matches shared words, so also search for what you need to decide (e.g. environment, cutoff time, format), not only the words in the request. " +
          'scope="project" searches only sessions in the current working folder and returns the raw text with a date on every row and no summary. Omit it or pass "all" to search every session.',
      }),
      parameters: {
        query: { kind: "string", optional: true, description: pick({ ko: "검색어(명령·에러 메시지·파일명·키워드 또는 \"정확한 구문\"). 한국어 가능.", en: "Search terms (command, error message, filename, keyword, or \"exact phrase\"). Korean supported." }) },
        session_id: { kind: "string", optional: true, description: pick({ ko: "SCROLL/BROWSE용 세션 id(DISCOVERY 결과의 session=… 값).", en: "Session id for SCROLL/BROWSE (the session=… value from DISCOVERY results)." }) },
        around_id: { kind: "integer", optional: true, description: pick({ ko: "SCROLL용 기준 행 id(결과의 #숫자).", en: "Anchor row id for SCROLL (the #number from results)." }) },
        after_id: { kind: "integer", optional: true, min: 0, description: pick({ ko: "BROWSE 다음 페이지 시작점. session_id만 주면 처음부터 본다.", en: "BROWSE page cursor. With session_id alone, starts at the beginning." }) },
        role: { kind: "enum", values: ["user", "assistant", "tool"], optional: true, description: pick({ ko: "선택 역할 필터.", en: "Optional role filter." }) },
        scope: {
          kind: "enum",
          values: ["project", "all"],
          optional: true,
          description: pick({
            ko: '검색 범위. "project"면 지금 작업 폴더의 세션만 찾고, "all"이나 생략이면 모든 세션을 찾는다.',
            en: 'Search scope. "project" searches only sessions in the current working folder. "all" or omitted searches every session.',
          }),
        },
        limit: { kind: "integer", optional: true, min: 1, max: 10, description: pick({ ko: "DISCOVERY 최대 세션 수(기본 4).", en: "Max number of sessions for DISCOVERY (default 4)." }) },
        from_ts: { kind: "integer", optional: true, description: pick({ ko: "시작 시각(ms).", en: "From timestamp (ms)." }) },
        to_ts: { kind: "integer", optional: true, description: pick({ ko: "끝 시각(ms).", en: "To timestamp (ms)." }) },
      },
      async handler(raw, ctx) {
        const args = raw as {
          query?: string;
          session_id?: string;
          around_id?: number;
          after_id?: number;
          limit?: number;
          role?: "user" | "assistant" | "tool";
          from_ts?: number;
          to_ts?: number;
          scope?: string;
        };
        const sid = ctx.sessionId ? ctx.sessionId.slice(0, 8) : "";
        console.error(`[aether] session_search${sid ? ` session=${sid}` : ""}`);
        const fromTs = typeof args.from_ts === "number" && Number.isFinite(args.from_ts) ? args.from_ts : undefined;
        const toTs = typeof args.to_ts === "number" && Number.isFinite(args.to_ts) ? args.to_ts : undefined;
        // "project"만 작업 폴더로 좁힌다. 생략과 "all"은 이 아래 기존 경로 그대로다.
        const scopeProject = args.scope === "project";
        if (!sessionLetterReady()) {
          return textResult(pick({ ko: "세션 글자 색인을 열지 못했다", en: "The session letter index is not open." }));
        }
        if (args.query && args.query.trim()) {
          const hits = await searchLettersWithContext(
            {
              query: args.query,
              limit: args.limit ?? 4,
              role: args.role,
              fromTs,
              toTs,
              ...(scopeProject ? { projectCwd: ctx.cwd } : {}),
              ...(scopeProject && typeof ctx.sessionId === "string" && ctx.sessionId.trim()
                ? { excludeSessionId: ctx.sessionId }
                : {}),
            },
            { window: 4, bookend: 2 },
          );
          try {
            await recordSearchAudit({
              actorId: "person",
              query: args.query,
              filters: {
                ...(fromTs !== undefined ? { fromTs } : {}),
                ...(toTs !== undefined ? { toTs } : {}),
                ...(args.role ? { role: args.role } : {}),
              },
              hits: hits.map((h) => ({ sessionId: h.sessionId, seq: h.anchor.seq, part: h.anchor.part })),
            });
          } catch (err) {
            void reportError(err, { component: "search", operation: "search.audit.append", session_id: ctx.sessionId }); console.error("[aether] session_search 감사 실패:", err);
          }
          const text = fmtDiscovery(args.query, hits as SessionContextHit[], scopeProject);
          // 같은 폴더 검색은 요약을 건너뛴다. 날짜가 붙은 원문이 근거다.
          if (!scopeProject && readSearchSummarize() && hits.length) {
            const summary = await summarizeHits(args.query, text, hits as SessionContextHit[], ctx.cwd, ctx.services);
            if (summary) return textResult(summary);
          }
          return textResult(text);
        }
        if (args.session_id && typeof args.around_id === "number") {
          if (scopeProject && !(await letterSessionInProject(args.session_id, ctx.cwd))) {
            return textResult(projectFolderReject(args.session_id));
          }
          const win = await getLetterContext(args.session_id, args.around_id, 8, 0);
          return textResult(fmtScroll(args.session_id, win.window as CtxRow[], scopeProject, args.around_id));
        }
        if (args.session_id) {
          if (scopeProject && !(await letterSessionInProject(args.session_id, ctx.cwd))) {
            return textResult(projectFolderReject(args.session_id));
          }
          const page = await getLetterSessionPage(args.session_id, args.after_id ?? 0, Math.min(args.limit ?? 40, 100), args.role);
          return textResult(fmtBrowse(args.session_id, page as CtxRow[], scopeProject));
        }
        return textResult(pick({ ko: "query(검색), session_id+around_id(스크롤), session_id(원문 탐색) 중 하나를 지정하라.", en: "Specify query (search), session_id+around_id (scroll), or session_id (browse raw)." }));
      },
  };
}
