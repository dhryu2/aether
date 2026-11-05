/**
 * 파일 변경 조각(FileEdit) → 화면용 미리보기(MutationPreview). provider와 무관한 순수 함수다.
 * 조각의 모양(전·후 / 후만 / 패치)만 보고, 원본 도구 이름이나 인자 이름은 모른다 — 그건 각 codec의 몫이다.
 */
import type { MutationPreview } from "../../shared/http";
import type { FileEdit } from "./codec/types";
import { countLines, parseUnifiedDiff, patch } from "./mutationPreview";
import { isClampedString } from "./persistFilter";

/** rel은 화면에 보일 경로(작업 폴더 기준). 저장 때 잘린 내용은 부분 diff로 오도하지 않도록 truncated만 돌려준다. */
export function fileEditPreview(e: FileEdit, rel: string): MutationPreview {
  const kind = e.before !== undefined && e.after !== undefined ? "edit" : e.after !== undefined ? "write" : "edit";
  if ([e.before, e.after, e.diff].some((s) => typeof s === "string" && isClampedString(s))) return { kind, path: rel, truncated: true };
  if (e.diff !== undefined) {
    const { hunks, inexact } = parseUnifiedDiff(e.diff);
    if (!hunks.length) return { kind, path: rel };
    return { kind, path: rel, hunks, ...(inexact ? { inexact: true } : {}), ...(e.isCreate ? { isCreate: true } : {}), ...countLines(hunks) };
  }
  if (e.before !== undefined && e.after !== undefined) {
    return { kind, path: rel, fragment: true, ...(e.replaceAll ? { replaceAll: true } : {}), ...patch(rel, e.before, e.after) };
  }
  if (e.after !== undefined) {
    return { kind, path: rel, ...(e.isCreate ? { isCreate: true } : { beforeUnknown: true }), ...patch(rel, "", e.after) };
  }
  return { kind, path: rel, ...patch(rel, e.before ?? "", "") };
}
