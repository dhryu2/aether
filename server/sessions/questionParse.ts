/**
 * 구조화 질문 입력을 공통 AetherQuestion으로 고른다.
 * GUI는 이 파일을 모른다. runtime이 매핑한 결과만 질문 카드로 간다.
 */
import type { AetherQuestion } from "../../shared/http";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 마크다운만 통과. HTML 조각은 그리지 않는다. */
export function sanitizePreview(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (/<!DOCTYPE|<\/?script|<\/?style/i.test(s)) return undefined;
  return s;
}

export function mapQuestionOption(o: unknown): AetherQuestion["options"][number] | null {
  if (typeof o === "string") {
    const label = o.trim();
    return label ? { label } : null;
  }
  const r = asRecord(o);
  if (!r) return null;
  const label = String(r.label ?? r.id ?? r.value ?? "").trim();
  if (!label) return null;
  const description = typeof r.description === "string" && r.description.trim() ? r.description : undefined;
  const preview = sanitizePreview(r.preview);
  return { label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) };
}

export function parseAskQuestions(raw: unknown): AetherQuestion[] {
  const rec = asRecord(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(rec?.questions) ? rec!.questions : [];
  const out: AetherQuestion[] = [];
  for (const item of list) {
    const q = asRecord(item) ?? { question: String(item) };
    const question = String(q.question ?? q.prompt ?? q.text ?? "").trim();
    const header = typeof q.header === "string" ? q.header.trim() : "";
    if (!question && !header) continue;
    const options = (Array.isArray(q.options) ? q.options : []).map(mapQuestionOption).filter((o): o is NonNullable<typeof o> => !!o);
    out.push({
      question: question || header,
      ...(header ? { header } : {}),
      ...(q.multiSelect === true || q.allow_multiple === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}
