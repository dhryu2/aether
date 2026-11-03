/**
 * 브리프 질문지 상자를 읽고, 카드 답을 검사하고, 모델에게 보일 글로 바꾼다.
 * 순수 함수다. provider를 모른다.
 */
import { pick } from "../i18n";
import type { QuestionnaireAnswerValue, QuestionnaireQuestion } from "../../shared/http";

export const QUESTIONNAIRE_FENCE = "aether-questions";

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TEXT_MAX = 300;
const LABEL_MAX = 80;
const DESC_MAX = 200;
const RECOMMENDED_TEXT_MAX = 1000;
const ANSWER_MAX = 1000;

type QuestionsOk = { ok: true; questions: QuestionnaireQuestion[] };
type AnswersOk = { ok: true; answers: Record<string, QuestionnaireAnswerValue> };
type Fail = { ok: false; error: string };
type Option = { label: string; description?: string };

function fail(error: string): Fail {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isKind(value: unknown): value is QuestionnaireQuestion["kind"] {
  return value === "single" || value === "multi" || value === "text";
}

/** 글 안의 마지막 질문지 상자. 닫히지 않은 상자는 무시한다. */
export function findQuestionnaireBlock(text: string): string | null {
  if (!text) return null;
  const open = "```" + QUESTIONNAIRE_FENCE;
  const lines = text.split(/\r?\n/);
  let last: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== open) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "```") j++;
    if (j >= lines.length) continue;
    last = lines.slice(i + 1, j).join("\n");
    i = j;
  }
  return last;
}

function parseOptions(raw: unknown): { ok: true; options: Option[] } | Fail {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 6) return fail("선택지가 2~6개가 아니다");
  const options: Option[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return fail("선택지 모양이 아니다");
    const label = item.label;
    if (typeof label !== "string" || label.length < 1) return fail("선택지 label이 비어 있다");
    if (label.length > LABEL_MAX) return fail("선택지 label이 80자를 넘는다");
    if (seen.has(label)) return fail("선택지 label이 겹친다");
    seen.add(label);
    const option: Option = { label };
    if (Object.prototype.hasOwnProperty.call(item, "description") && item.description !== undefined) {
      if (typeof item.description !== "string") return fail("선택지 설명이 글이 아니다");
      if (item.description.length > DESC_MAX) return fail("선택지 설명이 200자를 넘는다");
      if (item.description.length > 0) option.description = item.description;
    }
    options.push(option);
  }
  return { ok: true, options };
}

/** 추천이 선택지에 없거나 모양이 틀리면 질문지 실패가 아니라 추천만 뺀다. */
function fitRecommended(
  kind: QuestionnaireQuestion["kind"],
  options: Option[] | undefined,
  value: unknown,
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (kind === "text") {
    if (typeof value !== "string" || value.length < 1 || value.length > RECOMMENDED_TEXT_MAX) return undefined;
    return value;
  }
  const labels = new Set((options ?? []).map((option) => option.label));
  if (kind === "single") return typeof value === "string" && labels.has(value) ? value : undefined;
  if (!Array.isArray(value) || value.length < 1) return undefined;
  const picked: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !labels.has(item) || picked.includes(item)) return undefined;
    picked.push(item);
  }
  return picked;
}

function parseQuestion(item: unknown, seen: Set<string>): { ok: true; question: QuestionnaireQuestion } | Fail {
  if (!isRecord(item)) return fail("질문 모양이 아니다");
  if (typeof item.id !== "string" || !ID_RE.test(item.id)) return fail("id 형식이 아니다");
  if (seen.has(item.id)) return fail("id가 겹친다");
  if (typeof item.text !== "string" || item.text.length < 1) return fail("질문이 비어 있다");
  if (item.text.length > TEXT_MAX) return fail("질문이 300자를 넘는다");
  if (!isKind(item.kind)) return fail("모르는 kind다");
  const question: QuestionnaireQuestion = { id: item.id, text: item.text, kind: item.kind };
  if (item.kind === "text") {
    const recommended = fitRecommended("text", undefined, item.recommended);
    if (recommended !== undefined) question.recommended = recommended;
    return { ok: true, question };
  }
  const options = parseOptions(item.options);
  if (!options.ok) return options;
  question.options = options.options;
  const recommended = fitRecommended(item.kind, options.options, item.recommended);
  if (recommended !== undefined) question.recommended = recommended;
  return { ok: true, question };
}

/** 상자 안 JSON을 검사한다. 실패하면 첫 위반 하나만 돌려준다. */
export function parseQuestionnaire(raw: string): QuestionsOk | Fail {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // 모델이 쓴 질문지의 형식을 검사하는 정상 거절이다.
    return fail("질문지 JSON을 읽지 못했다");
  }
  if (!isRecord(data) || !Array.isArray(data.questions)) return fail("questions 배열이 없다");
  if (data.questions.length < 1) return fail("질문이 없다");
  if (data.questions.length > 10) return fail("질문이 10개를 넘는다");
  const seen = new Set<string>();
  const questions: QuestionnaireQuestion[] = [];
  for (const item of data.questions) {
    const one = parseQuestion(item, seen);
    if (!one.ok) return one;
    seen.add(one.question.id);
    questions.push(one.question);
  }
  return { ok: true, questions };
}

function readNote(raw: Record<string, unknown>): { ok: true; text?: string } | Fail {
  if (!Object.prototype.hasOwnProperty.call(raw, "note") || raw.note === undefined) return { ok: true };
  if (typeof raw.note !== "string") return fail("답 모양이 아니다");
  const text = raw.note.trim();
  if (text.length > ANSWER_MAX) return fail("답이 1000자를 넘는다");
  if (text.length < 1) return { ok: true };
  return { ok: true, text };
}

function readCustom(raw: Record<string, unknown>): { ok: true; text?: string } | Fail {
  if (!Object.prototype.hasOwnProperty.call(raw, "custom") || raw.custom === undefined) return { ok: true };
  if (typeof raw.custom !== "string") return fail("답 모양이 아니다");
  const text = raw.custom.trim();
  if (text.length < 1) return fail("답이 비어 있다");
  if (text.length > ANSWER_MAX) return fail("답이 1000자를 넘는다");
  return { ok: true, text };
}

function readChosen(raw: Record<string, unknown>): { ok: true; present: boolean; labels: string[] } | Fail {
  if (!Object.prototype.hasOwnProperty.call(raw, "chosen") || raw.chosen === undefined) {
    return { ok: true, present: false, labels: [] };
  }
  if (!Array.isArray(raw.chosen)) return fail("답 모양이 아니다");
  const labels: string[] = [];
  for (const item of raw.chosen) {
    if (typeof item !== "string") return fail("답 모양이 아니다");
    const label = item.trim();
    if (label.length < 1) return fail("답이 비어 있다");
    if (label.length > ANSWER_MAX) return fail("답이 1000자를 넘는다");
    labels.push(label);
  }
  return { ok: true, present: true, labels };
}

function matchLabel(question: QuestionnaireQuestion, label: string): string | null {
  const found = question.options?.find((option) => option.label === label);
  return found ? found.label : null;
}

function normalizeAnswer(question: QuestionnaireQuestion, raw: unknown): { ok: true; value: QuestionnaireAnswerValue } | Fail {
  if (!isRecord(raw)) return fail("답 모양이 아니다");
  if (raw.skipped === true) {
    const others = Object.keys(raw).filter((key) => key !== "skipped");
    if (others.length > 0) return fail("답 안 함은 다른 필드와 같이 쓸 수 없다");
    return { ok: true, value: { skipped: true } };
  }
  if (Object.prototype.hasOwnProperty.call(raw, "skipped")) return fail("답 모양이 아니다");

  const note = readNote(raw);
  if (!note.ok) return note;

  if (question.kind === "text") {
    if (Object.prototype.hasOwnProperty.call(raw, "chosen")) return fail("직접 쓰기에는 선택지를 쓸 수 없다");
    const custom = readCustom(raw);
    if (!custom.ok) return custom;
    if (custom.text === undefined) return fail("답이 비어 있다");
    const value: QuestionnaireAnswerValue = { custom: custom.text };
    if (note.text) value.note = note.text;
    return { ok: true, value };
  }

  const chosen = readChosen(raw);
  if (!chosen.ok) return chosen;
  const custom = readCustom(raw);
  if (!custom.ok) return custom;
  const picked = chosen.labels.length > 0;
  const wrote = custom.text !== undefined;

  if (question.kind === "single") {
    if (picked && wrote) return fail("선택과 직접 입력을 같이 쓸 수 없다");
    if (!picked && !wrote) return fail("하나 고르기에는 선택이나 직접 입력이 필요하다");
    if (picked && chosen.labels.length !== 1) return fail("하나 고르기는 선택지를 하나만 고른다");
    const value: QuestionnaireAnswerValue = {};
    if (picked) {
      const label = matchLabel(question, chosen.labels[0]);
      if (!label) return fail("선택지에 없는 답이다");
      value.chosen = [label];
    } else if (custom.text !== undefined) {
      value.custom = custom.text;
    }
    if (note.text) value.note = note.text;
    return { ok: true, value };
  }

  const labels: string[] = [];
  for (const label of chosen.labels) {
    const matched = matchLabel(question, label);
    if (!matched) return fail("선택지에 없는 답이다");
    labels.push(matched);
  }
  if (new Set(labels).size !== labels.length) return fail("고른 선택지가 겹친다");
  if (labels.length === 0 && !wrote) return fail("여러 고르기는 선택이나 직접 입력이 필요하다");
  const value: QuestionnaireAnswerValue = {};
  if (chosen.present) value.chosen = labels;
  if (custom.text !== undefined) value.custom = custom.text;
  if (note.text) value.note = note.text;
  return { ok: true, value };
}

/** 질문 id가 빠지거나 모르면 실패다. 글은 앞뒤 공백을 떼고, 빈 덧붙임은 뺀다. */
export function validateQuestionnaireAnswers(questions: QuestionnaireQuestion[], answers: unknown): AnswersOk | Fail {
  if (!isRecord(answers)) return fail("답 모양이 아니다");
  const known = new Set(questions.map((question) => question.id));
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(answers, question.id)) return fail("빠진 질문이 있다");
  }
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) return fail("모르는 질문 id가 있다");
  }
  const out: Record<string, QuestionnaireAnswerValue> = {};
  for (const question of questions) {
    const one = normalizeAnswer(question, answers[question.id]);
    if (!one.ok) return one;
    out[question.id] = one.value;
  }
  return { ok: true, answers: out };
}

function words() {
  return {
    heading: pick({ ko: "브리프 질문지 답", en: "Brief questionnaire answers" }),
    recommended: pick({ ko: " (추천)", en: " (recommended)" }),
    note: pick({ ko: "덧붙임", en: "Note" }),
    skipped: pick({ ko: "답 안 함", en: "No answer" }),
  };
}

function sameSet(left: string[], right: string[]): boolean {
  const want = new Set(right);
  const got = new Set(left);
  if (want.size !== got.size) return false;
  for (const item of got) if (!want.has(item)) return false;
  return true;
}

function matchesRecommendation(question: QuestionnaireQuestion, answer: QuestionnaireAnswerValue): boolean {
  if (answer.skipped || question.recommended === undefined) return false;
  if (question.kind === "text") return answer.custom === question.recommended;
  if (answer.custom) return false;
  const chosen = answer.chosen ?? [];
  if (question.kind === "single") {
    return typeof question.recommended === "string" && chosen.length === 1 && chosen[0] === question.recommended;
  }
  return Array.isArray(question.recommended) && sameSet(chosen, question.recommended);
}

function renderAnswer(question: QuestionnaireQuestion, answer: QuestionnaireAnswerValue | undefined, label: ReturnType<typeof words>): string {
  if (!answer || answer.skipped) return label.skipped;
  const parts: string[] = [];
  if (answer.chosen && answer.chosen.length > 0) parts.push(answer.chosen.join(", "));
  if (answer.custom) parts.push(answer.custom);
  let body = parts.join(", ");
  if (matchesRecommendation(question, answer)) body += label.recommended;
  if (answer.note) body += ` / ${label.note}: ${answer.note}`;
  return body;
}

/** 질문 순서대로 번호 목록을 만든다. 서버 언어로 고른다. */
export function buildQuestionnaireAnswerText(
  questions: QuestionnaireQuestion[],
  answers: Record<string, QuestionnaireAnswerValue>,
): string {
  const label = words();
  const lines = questions.map((question, index) => {
    return `${index + 1}. ${question.text}: ${renderAnswer(question, answers[question.id], label)}`;
  });
  return `${label.heading}\n${lines.join("\n")}`;
}

function canonAnswer(value: QuestionnaireAnswerValue | undefined): string {
  if (!value || typeof value !== "object") return "";
  if (value.skipped === true) return "skipped";
  const chosen = Array.isArray(value.chosen)
    ? value.chosen.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0).sort()
    : [];
  const custom = typeof value.custom === "string" ? value.custom.trim() : "";
  const note = typeof value.note === "string" ? value.note.trim() : "";
  return JSON.stringify({ chosen, custom, note });
}

function canonAnswers(answers: Record<string, QuestionnaireAnswerValue>): string {
  return Object.keys(answers)
    .sort()
    .map((id) => `${id}=${canonAnswer(answers[id])}`)
    .join("\n");
}

/** id와 정규화한 답이 같으면 same. 고른 순서와 빈 덧붙임은 무시한다. */
export function questionnaireRetryVerdict(
  prev: { id: string; answers: Record<string, QuestionnaireAnswerValue> } | undefined,
  next: { id: string; answers: Record<string, QuestionnaireAnswerValue> },
): "same" | "different" {
  if (!prev || prev.id !== next.id) return "different";
  return canonAnswers(prev.answers) === canonAnswers(next.answers) ? "same" : "different";
}
