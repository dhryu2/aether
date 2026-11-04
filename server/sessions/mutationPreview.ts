/**
 * 권한 카드에 붙는 "무엇이 바뀌는가" 미리보기 — **provider와 무관한 부분**.
 *
 * 카드가 보여주는 것은 셋이다: 어떤 파일인가, 어떤 줄이 지워지고 더해지는가, 몇 줄인가.
 * 그 형태(`MutationPreview`)와 그것을 만드는 두 가지 방법이 여기 있다.
 *   ① 디스크의 현재 내용과 바뀔 내용을 비교해 만든다(Claude처럼 "이 파일을 이렇게 쓰겠다"고 알려주는 경우).
 *   ② 이미 만들어진 unified diff 문자열을 읽어 만든다(Codex처럼 패치 자체를 알려주는 경우).
 *
 * 8e 분리: 8d-2까지 이 파일은 Claude 도구 이름(`Write`·`Edit`…)과 인자 이름(`file_path`·`old_string`…)으로
 *   분기하는 코드를 함께 들고 있었다. 그 부분은 Codex 도구엔 하나도 안 맞아서, 카드에 diff가 안 뜨는데
 *   에러도 안 나는 자리였다. 이제 provider별 조립은 각자의 폴더가 맡고(`providers/<이름>/mutationPreview.ts`),
 *   여기에는 두 provider가 함께 쓰는 형태와 도구만 남는다.
 *
 * 모든 예외는 삼켜 undefined를 돌려준다 — 미리보기를 못 만드는 것이 승인 흐름을 막으면 안 된다.
 * `before`/`after`는 화면·메모리 한정이고 디스크에는 남기지 않는다(LiveSession이 영속 직전에 걷어낸다).
 */
import fs from "node:fs";
import path from "node:path";
import { structuredPatch } from "diff";
import { config } from "../config";
import { resolveFileUnderCwd } from "./safePath";
import { isSecretPath } from "./secretPaths";
import type { MutationHunk, MutationPreview } from "../../shared/http";

export type { MutationHunk, MutationPreview };

/** 표시용 상대경로(읽기 안 함). cwd 밖/절대면 basename으로 축약(절대경로 미노출). */
export function relOf(filePath: string, cwd: string): string {
  const r = path.relative(cwd, path.resolve(cwd, filePath));
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : path.basename(filePath);
}

/** 검증된 real 경로에서 before 읽기 — 크기상한·바이너리 가드, ENOENT=신규. */
export function readBefore(real: string): { before: string | null; truncated?: boolean; totalBytes?: number; binary?: boolean; isCreate: boolean } {
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { before: null, isCreate: true };
    throw e;
  }
  // 일반 파일이 아니면(FIFO·디렉터리·장치) 열지 않는다 — FIFO open은 쓰는 쪽이 올 때까지 이벤트 루프를 막는다.
  const notFile = { before: null, binary: true, totalBytes: st.size, isCreate: false };
  if (!st.isFile()) return notFile;
  // 검증 직후 open → TOCTOU 완화. 검사와 열기 사이에 FIFO로 바뀌어도 막히지 않게 NONBLOCK으로 열고 다시 본다.
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) return notFile;
    const max = config.diffMaxBytes;
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, 0);
    if (buf.subarray(0, Math.min(len, 8192)).includes(0)) {
      return { before: null, binary: true, totalBytes: st.size, isCreate: false };
    }
    return { before: buf.toString("utf8"), truncated: st.size > max, totalBytes: st.size, isCreate: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** structuredPatch hunks + 추가/삭제 라인 수. (이 시그니처는 항상 반환하나 방어적으로 빈 결과 degrade.) */
export function patch(rel: string, before: string, after: string): { hunks?: MutationHunk[]; additions?: number; deletions?: number } {
  const p = structuredPatch(rel, rel, before, after, "", "", { context: 3 });
  const hunks = p?.hunks as MutationHunk[] | undefined;
  if (!hunks) return {};
  return { hunks, ...countLines(hunks) };
}

/** hunk 줄에서 더해진 줄·지워진 줄 수를 센다(카드 상단 배지의 출처). */
function countLines(hunks: MutationHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === "+") additions++; else if (l[0] === "-") deletions++; }
  return { additions, deletions };
}

/** 디스크의 현재 내용을 읽어 "이렇게 바뀐다"를 만든다(파일 전체를 새로 쓰는 도구용). */
export function previewFromDisk(kind: "write" | "multiedit", filePath: string, after: string, cwd: string): MutationPreview {
  const { real, rel, isNew } = resolveFileUnderCwd(cwd, filePath);
  if (isSecretPath(rel)) return { kind, path: rel, redacted: true, isCreate: isNew }; // before/after 모두 생략(시크릿)
  const b = readBefore(real);
  if (b.binary) return { kind, path: rel, binary: true, totalBytes: b.totalBytes, isCreate: b.isCreate };
  const before = b.before;
  const result: MutationPreview = { kind, path: rel, before, after, isCreate: b.isCreate, truncated: b.truncated, totalBytes: b.totalBytes };
  if (!b.truncated) Object.assign(result, patch(rel, before ?? "", after)); // truncate면 hunks 생략(부분 diff 오도 방지)
  return result;
}

/**
 * unified diff 문자열 하나를 hunk 목록으로 읽는다.
 *
 * unified diff는 `@@ -지운쪽시작,줄수 +더한쪽시작,줄수 @@`로 시작하는 덩어리들이고, 그 아래 줄은
 * 맨 앞 한 글자가 뜻을 정한다(`-` 지움, `+` 더함, 공백 그대로).
 * 파일 이름 줄(`---`/`+++`)은 건너뛴다 — 우리는 경로를 따로 알고 있다.
 *
 * 덩어리 표시를 하나도 못 찾으면 빈 목록을 돌려준다. 억지로 한 덩어리로 만들면 줄 번호가 실제와 어긋나
 * 카드가 거짓말을 하게 되므로, 그럴 바엔 "미리보기 없음"이 낫다.
 */
export function parseUnifiedDiff(diff: string): MutationHunk[] {
  const hunks: MutationHunk[] = [];
  let current: MutationHunk | null = null;
  const lines = diff.split("\n");
  // 정상적인 diff는 줄바꿈으로 끝나므로 쪼개면 마지막에 빈 조각이 하나 남는다. 그걸 그대로 두면
  //   있지도 않은 빈 줄이 카드에 한 줄 더 그려진다(외부 검토 지적, 2026-08-18).
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // 덩어리 시작 전의 파일 이름 줄 등
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line === "" || line[0] === " " || line[0] === "+" || line[0] === "-") current.lines.push(line === "" ? " " : line);
    else current = null; // 덩어리가 끝나고 다른 내용이 시작됐다
  }
  return hunks;
}

/**
 * 이미 만들어진 unified diff로 미리보기를 만든다(패치 자체를 알려주는 provider용).
 *
 * 화면 경로는 아직 한 줄이다. 카드가 파일 하나를 전제하기 때문이다.
 * 복원 기록은 `files`로 파일마다 남긴다. 이전 본문은 여기 넣지 않고, 승인하는 순간에 디스크에서 읽는다.
 */
export function previewFromUnifiedDiff(
  changes: readonly { path: string; diff: string; isCreate?: boolean }[],
  cwd: string,
): MutationPreview | undefined {
  if (!changes.length) return undefined;
  const files = changes.map((change) => {
    const filePath = relOf(change.path, cwd);
    return change.isCreate ? { path: filePath, isCreate: true as const } : { path: filePath };
  });
  const kind = changes.length === 1 && changes[0].isCreate ? "write" : "edit";
  const shown = files.map((file) => file.path).join(", ");
  // 하나라도 비밀을 담은 파일이면 내용을 통째로 가린다 — 섞여 있을 때 일부만 가리면 어느 줄이 어느 파일인지
  //   화면에서 구분되지 않아 결국 비밀이 보인다. 파일 목록도 빼서 승인 때 본문을 읽지 않게 한다.
  if (changes.some((c) => isSecretPath(c.path))) return { kind, path: shown, redacted: true };
  const hunks = changes.flatMap((c) => parseUnifiedDiff(c.diff));
  const isCreate = changes.every((c) => c.isCreate) || undefined;
  if (!hunks.length) return { kind, path: shown, files, isCreate };
  return { kind, path: shown, files, hunks, isCreate, ...countLines(hunks) };
}
