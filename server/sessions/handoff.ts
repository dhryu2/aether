/**
 * 새 세션으로 넘기기 — 인계서 요청 글, 집어내기, 턴 결과 판정, 뼈대 인계서.
 *
 * 공통 계층은 중립 사건 넷만 본다: 모델 글(text), 파일 변경 도구 호출(tool_call file_change),
 * 한도 막힘 알림(provider_notice rate_limit blocked), 턴 종료(turn_completed). provider 이름·원본 모양은 모른다.
 * 규칙 문장에도 특정 AI의 도구 이름을 쓰지 않는다.
 */
import { pick } from "../i18n";
import { QUESTIONNAIRE_FORMAT_EN, QUESTIONNAIRE_FORMAT_KO } from "../agent-brief/rules";
import { findQuestionnaireBlock } from "../agent-brief/questionnaire";
import { isBlockedRateLimit, resetsAtMs } from "../notify/worthNotifying";
import type { TodoItem } from "../../shared/agentEvent";
import type { AetherEvent } from "../types";

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

/** 질문은 모두 이 횟수까지다. 그 뒤 남은 결정만 인계서의 「확인하지 못한 것」에 적게 한다. */
export const HANDOFF_ASK_ROUNDS_MAX = 2;

function rulesKo(): string {
  return [
    "사람이 이 대화의 일을 새 세션으로 넘기려 한다. 새 세션의 첫 프롬프트(인계서)를 쓴다.",
    "",
    "규칙",
    "- 파일을 만들거나 고치거나 지우지 않는다. 읽기와 상태를 바꾸지 않는 조회만 한다.",
    "- 사람이 다음에 할 일을 적었으면 그것을 따른다. 적지 않았으면 대화를 보고 다음 일을 스스로 판단한다.",
    "- 사실은 코드와 기록에서 직접 찾아본다(파일 열기, 검색). 찾아도 없는 사실은 묻지 말고 「확인하지 못한 것」에 적는다.",
    "- 결정은 다르다. 사람만 정할 수 있고 다음 일의 범위나 방법을 바꾸는 결정이 남아 있으면 반드시 질문한다. 대화에서 아직 안 정했다고 한 것이 여기에 든다. 새 세션이 묻도록 넘기지 않는다. 그런 결정이 없을 때만 바로 쓴다.",
    `- 질문은 한 번에 모아서 묻는다. 답 때문에 새로 생긴 결정만 한 번 더 묻는다. 모두 ${HANDOFF_ASK_ROUNDS_MAX}회까지다. 「확인하지 못한 것」은 찾지 못한 사실을 쓰는 절이다. 결정은 이 횟수를 다 쓴 뒤 남은 것만 「아직 안 정함」이라고 표시해 적는다.`,
    "- 질문할 때는 질문지 상자만 쓰고 턴을 끝낸다. 인계서 표식을 함께 쓰지 않는다. 사람에게 선택지를 묻는 도구는 쓰지 않는다.",
    QUESTIONNAIRE_FORMAT_KO,
    "- 인계서는 새 세션이 이 대화를 볼 수 없다는 것을 전제로 쓴다. 파일이나 규칙 문서에서 읽을 수 있는 내용은 옮기지 않고 경로와 줄 번호만 적는다. 규칙 파일에 있는 지시는 요약도 옮기지 않는다. 규칙 파일 경로는 「먼저 읽을 파일」에 한 번만 적는다.",
    "- 대화에서만 나온 것을 쓴다: 정한 것과 이유, 안 된 시도, 확인하지 못한 것. 사람의 지시와 일하는 방식은 「정한 것과 이유」에 쓴다.",
    "- 숫자에는 무엇의 건수인지 함께 적는다. 다른 대상의 수가 같으면 구분이 드러나게 쓴다.",
    "- 「주의할 점」에는 파일을 읽지 않으면 놓치는 것만 쓴다.",
    "- 다음 일과 무관한 내용은 뺀다. 범위 밖의 남은 일은 한 줄씩만 쓴다. 추측은 미확인이라고 표시한다.",
    "- 할 일 목록이 있으면 남은 항목을 「다음 단계」에 옮긴다.",
    "- 받는 AI가 지금과 다를 수 있으니 특정 AI의 도구 이름을 쓰지 않는다.",
    "- 3,000자 안쪽을 권한다. 꼭 필요한 사실을 빠뜨리는 것보다는 넘는 편이 낫다.",
    "- 제목과 순서: 목표 → 지금 상태 → 정한 것과 이유 → 해 봤는데 안 된 것 → 주의할 점 → 다음 단계 → 먼저 읽을 파일 → 확인하지 못한 것. 쓸 내용이 없는 절은 뺀다.",
    "- 사람이 적은 글은 Aether가 인계서 맨 위에 그대로 붙이므로 다시 옮기지 않는다.",
    "- 인계서 전문을 `<aether-handoff>`만 있는 줄과 `</aether-handoff>`만 있는 줄 사이에 쓴다. 그 앞뒤에는 아무것도 쓰지 않는다.",
    "- 이 규칙 본문은 인계서에 옮기지 않는다.",
  ].join("\n");
}

function rulesEn(): string {
  return [
    "The person wants to hand the work of this conversation over to a new session. Write the first prompt (the handoff) for the new session.",
    "",
    "Rules",
    "- Do not create, edit, or delete files. Only read files and run lookups that do not change state.",
    "- If the person wrote what to do next, follow it. If not, read the conversation and decide the next task yourself.",
    "- Look up facts yourself in the code and records (open files, search). If you still cannot find a fact, do not ask; write it under \"Not confirmed\".",
    "- Decisions are different. If a decision remains that only the person can make and that changes the scope or method of the next task, you must ask. Anything the conversation says is not decided yet counts. Do not leave it for the new session to ask. Write right away only when no such decision remains.",
    `- Ask everything in one batch. Ask once more only about decisions that the answers newly created. Ask at most ${HANDOFF_ASK_ROUNDS_MAX} times in total. \"Not confirmed\" is for facts you could not find. For decisions, write only what remains after these rounds, marked \"not decided yet\".`,
    "- When you ask, write only the questionnaire block and end the turn. Do not write the handoff markers with it. Do not use a tool that asks the person to pick options.",
    QUESTIONNAIRE_FORMAT_EN,
    "- Write the handoff on the premise that the new session cannot see this conversation. Do not copy what it can read from files or rule documents; give only the path and line number. Do not copy or summarize instructions that are in a rule file. Give a rule file path once, under \"Files to read first\".",
    "- Write what appeared only in the conversation: decisions and their reasons, attempts that failed, and what is not confirmed. Put the person's instructions and way of working under \"Decisions and reasons\".",
    "- Say what each number counts. If counts of different things are equal, write them so the difference is clear.",
    "- Under \"Watch out\", write only what would be missed without reading the files.",
    "- Leave out anything unrelated to the next task. Give remaining work outside its scope one line each. Mark guesses as unconfirmed.",
    "- If there is a to-do list, move the remaining items into \"Next steps\".",
    "- The receiving AI may differ from the current one, so do not use any specific AI's tool names.",
    "- Aim for about 3,000 characters or fewer. It is better to go over than to leave out a fact that is truly needed.",
    "- Headings and order: Goal → Current state → Decisions and reasons → Tried and failed → Watch out → Next steps → Files to read first → Not confirmed. Leave out a section with nothing to write.",
    "- Aether puts the text the person wrote at the very top of the handoff as it is, so do not copy it again.",
    "- Write the whole handoff between a line containing only `<aether-handoff>` and a line containing only `</aether-handoff>`. Write nothing before or after them.",
    "- Do not copy the text of these rules into the handoff.",
  ].join("\n");
}

/** 요청 글. text는 대화에 남는 사람용 문장, modelText는 규칙을 앞에 붙인 모델 입력이다. */
export function handoffRequest(focus: string | undefined, forced = false): { text: string; modelText: string } {
  const trimmed = focus?.trim();
  const text = pick({
    ko: `새 세션으로 넘길 프롬프트를 써 줘.${trimmed ? ` 다음에 할 일: ${trimmed}` : ""}`,
    en: `Write the prompt to hand off to a new session.${trimmed ? ` What to do next: ${trimmed}` : ""}`,
  });
  const rules = pick({ ko: rulesKo(), en: rulesEn() });
  // 더 묻지 않는 재개(forced)는 규칙이 "물어도 된다"고 하므로 끝에 강제 문장을 붙인다.
  return { text, modelText: `<aether-handoff-request>\n${rules}\n</aether-handoff-request>\n\n${text}${forced ? `\n\n${handoffForceWriteText()}` : ""}` };
}

/** 질문을 더 받지 않고 지금 쓰게 하는 마지막 요청 글. */
export function handoffForceWriteText(): string {
  return pick({
    ko: "더 묻지 말고 지금 프롬프트를 쓴다. 남은 결정은 「확인하지 못한 것」에 적는다.",
    en: "Do not ask any more. Write the prompt now. Put the decisions still open under \"Not confirmed\".",
  });
}

/** 모델이 쓴 인계서에 사람이 적은 글 원문(맨 위)과 이전 세션 표시(맨 끝)를 붙인다. */
export function withHandoffFrame(text: string, i: { focus?: string; name: string; id: string }): string {
  const focus = i.focus?.trim();
  const head = focus ? pick({ ko: "사람이 적은 요청 (원문)", en: "Request written by the person (verbatim)" }) + "\n" + focus + "\n\n" : "";
  const tail = pick({
    ko: "\n\n이전 세션: " + i.name + " (" + i.id + ")\n과거 검색 도구가 있으면 세부 내용은 이 세션을 찾아 읽는다.",
    en: "\n\nPrevious session: " + i.name + " (" + i.id + ")\nIf a past-search tool is available, find and read this session for details.",
  });
  // 상한은 본문에만 건다. 끝의 이전 세션 id가 잘리지 않게 머리와 꼬리 길이를 뺀다.
  return head + text.slice(0, Math.max(0, HANDOFF_TEXT_MAX - head.length - tail.length)) + tail;
}

const cut = (s: string) => (s.length > HANDOFF_TEXT_MAX ? s.slice(0, HANDOFF_TEXT_MAX) : s);

/**
 * 이번 턴 사건에서 인계서를 집어낸다. 모델 글을 이어 붙여 마지막으로 완전히 닫힌 표식 한 쌍의 안쪽을 쓴다.
 * 표식이 없으면 마지막 글 조각 전체. 글이 없으면 null.
 * 표식 쌍이 없고 이어 붙인 글에 질문지 상자가 있으면 질문 턴이므로 null이다. markerOnly면 표식 쌍이 없을 때 항상 null이다.
 * 표식은 앞뒤 공백을 지운 한 줄이 정확히 같을 때만 인정한다(문장 속 언급·코드 상자 안의 글과 섞이지 않게).
 */
export function pickHandoffText(events: readonly AetherEvent[], codec: Normalizer, markerOnly = false): string | null {
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
  if (!pair && (markerOnly || findQuestionnaireBlock(parts.join("\n")) !== null)) return null;
  const body = pair ? lines.slice(pair[0] + 1, pair[1]).join("\n") : parts[parts.length - 1];
  const out = cut(body.trim());
  return out || null;
}

/**
 * 뒤에서 도는 작업을 기다리며 멈춘 턴인가. 인계서도 질문도 없이 정상으로 끝났고, 작업이 돌고 있거나
 * 이미 기다리는 중에 글 없이 끝난 턴이면 그렇다. 이런 턴의 글은 인계서가 아니므로 다음 턴을 본다.
 */
export function handoffTurnAwaitsWork(events: readonly AetherEvent[], codec: Normalizer, running: boolean, waiting: boolean): boolean {
  if (handoffTurnOutcome(events, codec) !== "ok" || pickHandoffText(events, codec, true) !== null) return false;
  const hasText = events.some((ev) => codec.normalize(ev).some((a) => a.type === "text" && !a.subtaskOf && a.text.trim()));
  if (hasText && pickHandoffText(events, codec) === null) return false; // 질문 턴이다
  return running || (waiting && !hasText);
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
  const L = (ko: string, en: string) => pick({ ko, en });
  const out: string[] = [
    L("AI가 인계서를 쓰지 못해 Aether가 기록에서 모았다.", "The AI could not write the handoff, so Aether collected this from the record."),
    `${L("사유", "Reason")}: ${i.reason}`,
    "",
    `${L("이전 세션", "Previous session")}: ${i.name} (${i.id.slice(0, 8)})`,
    `${L("폴더", "Folder")}: ${i.cwd}`,
    L("과거 검색 도구(`session_search`)로 이전 세션을 찾아 읽고 시작하라.", "Start by finding and reading the previous session with the past-search tool (`session_search`)."),
  ];
  if (i.focus?.trim()) out.push("", `${L("다음에 할 일", "What to do next")}: ${i.focus.trim()}`);
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
