/**
 * 다음 작업으로 넘기기 — 인계서 요청 글, 집어내기, 턴 결과 판정, 뼈대 인계서.
 *
 * 공통 계층은 중립 사건 넷만 본다: 모델 글(text), 파일 변경 도구 호출(tool_call file_change),
 * 한도 막힘 알림(provider_notice rate_limit blocked), 턴 종료(turn_completed). provider 이름·원본 모양은 모른다.
 * 규칙 문장에도 특정 AI의 도구 이름을 쓰지 않는다.
 */
import { pick } from "../i18n";
import { isBlockedRateLimit, resetsAtMs } from "../notify/worthNotifying";
import type { TodoItem } from "../../shared/agentEvent";
import type { AetherEvent } from "../types";

export type HandoffPurpose = "continue" | "rediscuss" | "next";
export const HANDOFF_PURPOSES: readonly HandoffPurpose[] = ["continue", "rediscuss", "next"];
export const HANDOFF_FOCUS_MAX = 4000;
export const HANDOFF_TEXT_MAX = 60_000;
export const HANDOFF_FILES_MAX = 50;
const RECENT_USER_TEXTS = 3;
const RECENT_USER_TEXT_MAX = 4000;

const OPEN = "<aether-handoff>";
const CLOSE = "</aether-handoff>";
/** 이 접두를 가진 clientMessageId는 인계서 요청 글이다. */
export const HANDOFF_CLIENT_ID_PREFIX = "handoff-";

type Normalizer = { normalize(ev: AetherEvent): import("../../shared/agentEvent").AgentEvent[] };

const PURPOSE_LABEL = {
  continue: { ko: "이어서", en: "continue" },
  rediscuss: { ko: "다시 토의", en: "re-discuss" },
  next: { ko: "다음 작업", en: "next task" },
} as const;

const SECTIONS_KO: Record<HandoffPurpose, string> = {
  continue: "진행 상태 → 남은 일 → 정한 것 → 먼저 읽을 파일 → 일하는 방식 → 지킬 것",
  rediscuss: "미결 쟁점 → 정한 것 → 버린 안과 이유 → 먼저 읽을 파일 → 일하는 방식 → 지킬 것. 마지막 줄에 「새 세션은 작업 전에 위 쟁점을 사람에게 질문부터 한다」를 쓴다",
  next: "다음 작업 범위(사람이 준 초점 글 반영) → 이전에 정한 규칙 → 먼저 읽을 파일 → 일하는 방식 → 지킬 것",
};
const SECTIONS_EN: Record<HandoffPurpose, string> = {
  continue: "Progress → Remaining work → Decisions → Files to read first → How to work → Constraints",
  rediscuss: "Open issues → Decisions → Rejected options and why → Files to read first → How to work → Constraints. On the last line write \"The new session asks the person about the open issues above before any work\"",
  next: "Scope of the next task (reflect the focus text from the person) → Rules decided earlier → Files to read first → How to work → Constraints",
};

function rulesKo(purpose: HandoffPurpose, includeMethod: boolean): string {
  return [
    "사람이 이 대화를 다음 작업으로 넘기려 한다. 새 세션에게 줄 인계서를 쓴다.",
    "",
    "규칙",
    "- 파일을 만들거나 고치거나 지우지 않는다. 읽기와 상태를 바꾸지 않는 조회만 한다.",
    "- 새 세션은 이 대화를 볼 수 없다. 인계서만 읽고도 일할 수 있게 쓴다.",
    "- 파일은 경로와 줄 번호로 적는다.",
    "- 받는 AI가 지금과 다를 수 있으니 특정 AI의 도구 이름을 쓰지 않는다.",
    "- 할 일 목록이 있으면 남은 항목을 「남은 일」에 옮긴다.",
    `- 제목과 순서: ${SECTIONS_KO[purpose]}.`,
    ...(includeMethod ? [] : ["- 「일하는 방식」 절은 쓰지 않는다."]),
    "- 인계서 전문을 `<aether-handoff>`만 있는 줄과 `</aether-handoff>`만 있는 줄 사이에 쓴다. 그 앞뒤에는 아무것도 쓰지 않는다.",
    "- 이 규칙 본문은 인계서에 옮기지 않는다.",
  ].join("\n");
}

function rulesEn(purpose: HandoffPurpose, includeMethod: boolean): string {
  return [
    "The person wants to hand this conversation over to the next task. Write a handoff document for a new session.",
    "",
    "Rules",
    "- Do not create, edit, or delete files. Only read files and run lookups that do not change state.",
    "- The new session cannot see this conversation. Write so that the handoff alone is enough to work from.",
    "- Refer to files by path and line number.",
    "- The receiving AI may differ from the current one, so do not use any specific AI's tool names.",
    "- If there is a to-do list, move the remaining items into \"Remaining work\".",
    `- Headings and order: ${SECTIONS_EN[purpose]}.`,
    ...(includeMethod ? [] : ["- Do not write a \"How to work\" section."]),
    "- Write the whole handoff between a line containing only `<aether-handoff>` and a line containing only `</aether-handoff>`. Write nothing before or after them.",
    "- Do not copy the text of these rules into the handoff.",
  ].join("\n");
}

/** 요청 글. text는 대화에 남는 사람용 문장, modelText는 규칙을 앞에 붙인 모델 입력이다. */
export function handoffRequest(purpose: HandoffPurpose, focus: string | undefined, includeMethod: boolean): { text: string; modelText: string } {
  const label = pick({ ko: PURPOSE_LABEL[purpose].ko, en: PURPOSE_LABEL[purpose].en });
  const trimmed = focus?.trim();
  const text = pick({
    ko: `다음 작업으로 넘길 인계서를 써 줘. 목적: ${label}.${trimmed ? ` 초점: ${trimmed}.` : ""} 진행 방식도 넘기기: ${includeMethod ? "예" : "아니오"}`,
    en: `Write a handoff for the next task. Purpose: ${label}.${trimmed ? ` Focus: ${trimmed}.` : ""} Include how to work: ${includeMethod ? "yes" : "no"}`,
  });
  const rules = pick({ ko: rulesKo(purpose, includeMethod), en: rulesEn(purpose, includeMethod) });
  return { text, modelText: `<aether-handoff-request>\n${rules}\n</aether-handoff-request>\n\n${text}` };
}

const cut = (s: string) => (s.length > HANDOFF_TEXT_MAX ? s.slice(0, HANDOFF_TEXT_MAX) : s);

/**
 * 이번 턴 사건에서 인계서를 집어낸다. 모델 글을 이어 붙여 마지막으로 완전히 닫힌 표식 한 쌍의 안쪽을 쓴다.
 * 표식이 없으면 마지막 글 조각 전체. 글이 없으면 null.
 * 표식은 앞뒤 공백을 지운 한 줄이 정확히 같을 때만 인정한다(문장 속 언급·코드 상자 안의 글과 섞이지 않게).
 */
export function pickHandoffText(events: readonly AetherEvent[], codec: Normalizer): string | null {
  const parts: string[] = [];
  for (const ev of events) for (const a of codec.normalize(ev)) if (a.type === "text" && !a.subtaskOf && a.text.trim()) parts.push(a.text);
  if (!parts.length) return null;
  const lines = parts.join("\n").split("\n");
  let open = -1;
  let pair: [number, number] | null = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === OPEN) open = i;
    else if (t === CLOSE && open >= 0) {
      pair = [open, i];
      open = -1;
    }
  });
  const body = pair ? lines.slice(pair[0] + 1, pair[1]).join("\n") : parts[parts.length - 1];
  const out = cut(body.trim());
  return out || null;
}

export type HandoffOutcome = "ok" | "limit" | "interrupted" | "failed";

/** 턴 결과. 사람이 멈춘 턴이 먼저고, 실패한 턴에 한도 막힘 알림이 있으면 한도 대기다. */
export function handoffTurnOutcome(events: readonly AetherEvent[], codec: Normalizer): HandoffOutcome {
  let status: "ok" | "interrupted" | "failed" | undefined;
  let blocked = false;
  for (const ev of events) {
    for (const a of codec.normalize(ev)) {
      if (a.type === "turn_completed") status = a.status;
      else if (isBlockedRateLimit(a)) blocked = true;
    }
  }
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return blocked ? "limit" : "failed";
  return status === "ok" ? "ok" : "failed";
}

/** 이번 턴에서 본 한도 풀림 시각(ms). 모르면 undefined. */
export function limitResetsAt(events: readonly AetherEvent[], codec: Normalizer): number | undefined {
  let at: number | undefined;
  for (const ev of events) for (const a of codec.normalize(ev)) if (isBlockedRateLimit(a) && a.resetsAt) at = resetsAtMs(a.resetsAt);
  return at;
}

/** 파일 변경 도구 호출의 대상 글을 중복 없이 모은다. 대상 글은 쪼개지 않는다(provider마다 모양이 다르다). */
export function changedFiles(events: readonly AetherEvent[], codec: Normalizer): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    for (const a of codec.normalize(ev)) {
      if (a.type === "tool_call" && a.toolKind === "file_change" && !a.subtaskOf && a.target?.trim()) seen.add(a.target.trim());
      if (seen.size >= HANDOFF_FILES_MAX) return [...seen];
    }
  }
  return [...seen];
}

/** 가장 나중의 최상위 할 일 목록. 없으면 null. */
export function latestTodoItems(events: readonly AetherEvent[], codec: Normalizer): TodoItem[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const plans = codec.normalize(events[i]).filter((a) => a.type === "plan_update" && !a.subtaskOf);
    const last = plans[plans.length - 1];
    if (last && last.type === "plan_update") return last.items;
  }
  return null;
}

/** 사람이 최근에 쓴 말 원문. 넘기기 요청과 Aether가 자동으로 보낸 글은 뺀다. */
export function recentUserTexts(events: readonly AetherEvent[]): string[] {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < RECENT_USER_TEXTS; i--) {
    const ev = events[i] as { kind: string; text?: string; clientMessageId?: string; sentBy?: string };
    if (ev.kind !== "user_msg" || !ev.text?.trim() || ev.sentBy || ev.clientMessageId?.startsWith(HANDOFF_CLIENT_ID_PREFIX)) continue;
    out.unshift(ev.text.slice(0, RECENT_USER_TEXT_MAX));
  }
  return out;
}

export type SkeletonInput = {
  name: string;
  id: string;
  cwd: string;
  purpose: HandoffPurpose;
  focus?: string;
  /** 모델이 쓰지 못한 이유 한 줄. */
  reason: string;
  userTexts: string[];
  todo: TodoItem[] | null;
  files: string[];
  /** 작업 폴더가 git 저장소일 때 커밋 안 된 변경. 아니면 null. */
  gitChanges: string[] | null;
};

const STATUS_MARK: Record<string, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };

/** 모델 없이 기록에서 모은 뼈대 인계서. */
export function skeletonHandoff(i: SkeletonInput): string {
  const label = pick({ ko: PURPOSE_LABEL[i.purpose].ko, en: PURPOSE_LABEL[i.purpose].en });
  const L = (ko: string, en: string) => pick({ ko, en });
  const out: string[] = [
    L("AI가 인계서를 쓰지 못해 Aether가 기록에서 모았다.", "The AI could not write the handoff, so Aether collected this from the record."),
    `${L("사유", "Reason")}: ${i.reason}`,
    "",
    `${L("이전 세션", "Previous session")}: ${i.name} (${i.id.slice(0, 8)})`,
    `${L("폴더", "Folder")}: ${i.cwd}`,
    L("과거 검색 도구(`session_search`)로 이전 세션을 찾아 읽고 시작하라.", "Start by finding and reading the previous session with the past-search tool (`session_search`)."),
    "",
    `${L("목적", "Purpose")}: ${label}`,
  ];
  if (i.focus?.trim()) out.push(`${L("초점", "Focus")}: ${i.focus.trim()}`);
  if (i.userTexts.length) {
    out.push("", L("사람의 최근 말 (원문)", "Recent messages from the person (verbatim)"));
    i.userTexts.forEach((t, n) => out.push(`${n + 1}. ${t}`));
  }
  if (i.todo?.length) {
    out.push("", L("할 일 목록", "To-do list"));
    for (const t of i.todo) out.push(`- ${STATUS_MARK[t.status] ?? "[ ]"} ${t.text}`);
  }
  if (i.files.length) out.push("", L("바뀐 파일 (세션 기록)", "Changed files (session record)"), ...i.files.map((f) => `- ${f}`));
  if (i.gitChanges?.length) out.push("", L("커밋 안 된 변경", "Uncommitted changes"), ...i.gitChanges.map((f) => `- ${f}`));
  out.push("", L("위 내용을 정한 것이라고 단정하지 말고 먼저 확인하라.", "Do not assume the above is settled. Verify it first."));
  return cut(out.join("\n"));
}
