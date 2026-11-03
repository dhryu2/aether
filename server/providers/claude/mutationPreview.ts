import { FailureTracker } from "../failureTracking";
/**
 * Claude 도구의 인자에서 권한 카드용 변경 미리보기를 만든다 (Phase 8e).
 *
 * 8d-2까지 이 코드는 공통 폴더(`sessions/mutationPreview.ts`)에 있었다. 내용은 전부 Claude 도구 이름
 * (`Write`·`Edit`·`NotebookEdit`·`MultiEdit`)과 그 인자 이름(`file_path`·`old_string`…)에 매여 있는데
 * 파일만 공통 자리에 있어서, 두 번째 provider가 오면 **카드에 diff가 안 뜨는데 에러도 안 나는** 자리였다.
 * 순수 이동이며 판정 내용은 그대로다. 파일을 읽고 diff를 만드는 공통 도구는 옮기지 않고 가져다 쓴다.
 */
import { resolveFileUnderCwd } from "../../sessions/safePath";
import { isSecretPath } from "../../sessions/secretPaths";
import { patch, previewFromDisk, readBefore, type MutationPreview } from "../../sessions/mutationPreview";
import { st } from "../../i18n";

const previewFailures = new FailureTracker();

/** 변이 툴 input의 콘텐츠 필드(시크릿 평문이 담길 수 있음). */
export const CLAUDE_CONTENT_FIELDS = ["content", "old_string", "new_string", "new_source"];

/** 변이 툴 input의 file_path/notebook_path가 시크릿 경로인가(raw 문자열 기준 — cwd 밖도 포착). */
export function isSecretToolInput(input: { file_path?: unknown; notebook_path?: unknown }): boolean {
  const fp = input?.file_path ?? input?.notebook_path;
  return typeof fp === "string" && isSecretPath(fp);
}

/** 시크릿 경로 변이 툴의 input 콘텐츠 필드를 마스킹한 복사본(화면·기록용 — 실행엔 원본을 쓴다). */
export function redactToolInputContent(input: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...input };
  for (const k of CLAUDE_CONTENT_FIELDS) if (k in masked) masked[k] = st("notice.mutation.redactedSecret");
  if (Array.isArray(masked.edits)) {
    masked.edits = (masked.edits as Array<Record<string, unknown>>).map((e) => ({ ...e, old_string: "[redacted]", new_string: "[redacted]" }));
  }
  return masked;
}

function previewNotebook(input: any, cwd: string): MutationPreview | undefined {
  const { real, rel } = resolveFileUnderCwd(cwd, input.notebook_path);
  if (isSecretPath(rel)) return { kind: "notebook", path: rel, redacted: true };
  const editMode: string = input.edit_mode ?? "replace";
  const newSource: string = input.new_source ?? "";
  if (editMode === "insert") {
    return { kind: "notebook", path: rel, before: null, after: newSource, isCreate: false, ...patch(rel, "", newSource) };
  }
  // replace/delete: 대상 셀 기존 source 필요
  let beforeCell = "";
  try {
    const nb = JSON.parse(readBefore(real).before ?? "{}");
    const cells: any[] = nb.cells ?? [];
    const cell = input.cell_id ? cells.find((c) => c.id === input.cell_id) : cells[0];
    const src = cell?.source;
    beforeCell = Array.isArray(src) ? src.join("") : (src ?? "");
    previewFailures.recoveredFile(real);
  } catch (error) {
    previewFailures.file(error, { component: "provider", operation: "provider.notebook.preview", severity: "warning" }, real);
    return undefined; // 파싱 실패 fail-closed
  }
  if (editMode === "delete") return { kind: "notebook", path: rel, before: beforeCell, after: undefined, ...patch(rel, beforeCell, "") };
  return { kind: "notebook", path: rel, before: beforeCell, after: newSource, ...patch(rel, beforeCell, newSource) };
}

function previewMultiEdit(input: any, cwd: string): MutationPreview | undefined {
  const { real, rel, isNew } = resolveFileUnderCwd(cwd, input.file_path);
  if (isSecretPath(rel)) return { kind: "multiedit", path: rel, redacted: true, isCreate: isNew };
  const b = readBefore(real);
  if (b.binary) return { kind: "multiedit", path: rel, binary: true, totalBytes: b.totalBytes, isCreate: b.isCreate };
  const finalBefore = b.before ?? "";
  let cur = finalBefore;
  let inexact = false;
  for (const e of input.edits as Array<{ old_string?: string; new_string?: string; replace_all?: boolean }>) {
    const oldS = e.old_string ?? "";
    const newS = e.new_string ?? "";
    // 순차 누적: later edit는 earlier 결과 위에서 동작(원본 독립 적용은 오도).
    if (e.replace_all) {
      cur = cur.split(oldS).join(newS);
    } else {
      // 실제 MultiEdit는 유일 매치 요구 — 0건/2건↑이면 실제로는 실패 → 미리보기 부정확 표기 후 중단.
      const cnt = oldS ? cur.split(oldS).length - 1 : 0;
      if (cnt !== 1) { inexact = true; break; }
      cur = cur.replace(oldS, newS);
    }
  }
  const result: MutationPreview = { kind: "multiedit", path: rel, before: finalBefore, after: cur, isCreate: b.isCreate, truncated: b.truncated, totalBytes: b.totalBytes, inexact: inexact || undefined };
  if (!b.truncated) Object.assign(result, patch(rel, finalBefore, cur));
  return result;
}

/** 진입점. 변이 툴이면 MutationPreview, 아니면 undefined(비변이/실패 모두). */
export function buildMutationPreview(toolName: string, input: any, cwd: string): MutationPreview | undefined {
  let failed = false;
  try {
    if (toolName === "Edit") {
      const { rel } = resolveFileUnderCwd(cwd, input.file_path); // cwd 경계 강제(밖이면 throw→catch→undefined)
      if (isSecretPath(rel)) return { kind: "edit", path: rel, redacted: true, replaceAll: !!input.replace_all };
      const before = input.old_string ?? "";
      const after = input.new_string ?? "";
      return { kind: "edit", path: rel, before, after, replaceAll: !!input.replace_all, ...patch(rel, before, after) };
    }
    if (toolName === "Write") return previewFromDisk("write", input.file_path, input.content ?? "", cwd);
    if (toolName === "NotebookEdit") return previewNotebook(input, cwd);
    if (toolName === "MultiEdit" && Array.isArray(input.edits)) return previewMultiEdit(input, cwd);
  } catch (error) {
    failed = true;
    previewFailures.report(error, { component: "provider", operation: "provider.mutation.preview", severity: "warning" }, cwd);
    /* fail-closed: mutation 생략(권한 흐름 비차단) */
  } finally {
    if (!failed) previewFailures.clear(cwd);
  }
  return undefined;
}
