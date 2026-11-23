/**
 * 작업 검토함 "지운 이름이 남은 곳" — 지운 파일 이름과 지운 정의 이름을 순수하게 뽑는다.
 * AI도 git도 부르지 않는다. 입력은 중립 모양(codec.fileEdits의 FileEdit, 경로, 명령 글)뿐이다.
 */
import path from "node:path";
import type { FileEdit } from "./codec/types";
import { fileEditPreview } from "./fileEdits";

const MIN_NAME = 4;
const MAX_DEFINITIONS = 30;
const COMMON_FILE_NAMES = new Set(["index", "main", "mod", "init", "utils", "types", "test", "readme", "config", "package"]);
// 줄 맨 앞(들여쓰기 없음)에서 시작하는 정의만 본다. shortcut: 최상위 정의만 보고 들여쓴 메서드·중첩은 놓친다, 필요해지면 언어별로 넓힌다.
const DEFINITION_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|fn|func|struct|trait|const|let|var)\s+([A-Za-z_$][\w$]*)/;

export type RemovedDefinition = { name: string; seq?: number };

function definitionName(line: string): string | undefined {
  const name = DEFINITION_RE.exec(line)?.[1];
  return name && name.length >= MIN_NAME ? name : undefined;
}

/**
 * 성공한 수정에서 지워진 정의 이름. 같은 세션이 더한 줄에 같은 이름이 있으면(코드를 옮긴 경우) 뺀다.
 * 실패한 호출은 호출자가 미리 거른다. 잘려 저장된 내용은 hunk가 없어 저절로 빠진다.
 */
export function removedDefinitions(edits: readonly (FileEdit & { seq?: number })[]): RemovedDefinition[] {
  const removed = new Map<string, number | undefined>();
  const added = new Set<string>();
  for (const e of edits) {
    for (const h of fileEditPreview(e, e.path).hunks ?? []) {
      for (const l of h.lines) {
        const name = definitionName(l.slice(1));
        if (!name) continue;
        if (l[0] === "+") added.add(name);
        else if (l[0] === "-" && !removed.has(name)) removed.set(name, e.seq);
      }
    }
  }
  return [...removed].filter(([name]) => !added.has(name)).slice(0, MAX_DEFINITIONS).map(([name, seq]) => ({ name, ...(seq !== undefined ? { seq } : {}) }));
}

/**
 * 지워졌거나 이름이 바뀐 파일(절대 경로) 중 이 세션이 지운 것의 이름(확장자 뗀 것).
 * 세션이 지운 것 = 기록의 바뀐 파일에 들었거나, 이 세션의 셸 명령 글에 파일 이름이 나온 것.
 */
export function deletedFileStems(deleted: readonly string[], changed: readonly string[], commands: readonly string[]): string[] {
  const own = new Set(changed);
  const stems = new Set<string>();
  for (const p of deleted) {
    const base = path.basename(p);
    if (!own.has(p) && !commands.some((c) => c.includes(base))) continue;
    const stem = path.parse(base).name;
    if (stem.length < MIN_NAME || COMMON_FILE_NAMES.has(stem.toLowerCase())) continue;
    stems.add(stem);
  }
  return [...stems];
}
