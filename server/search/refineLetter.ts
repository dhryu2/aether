/**
 * 검색용 표 정제기 — 검색용 표(session_letter)에 넣기 직전의 항목을 줄인다.
 *   - 예전 과거 검색 도구의 결과는 뺀다(검색 결과가 다시 검색에 걸리는 것을 막는다).
 *   - 같은 세션 안에서 앞서 본 것과 똑같은 긴 출력은 "앞의 #번호와 같은 출력" 한 줄로 접는다.
 *   - 셸 명령의 긴 출력은 머리·꼬리·오류 줄만 남기고 줄인다.
 * 원본(session_event)은 건드리지 않는다. 실시간 반영(LiveSession.indexLive)과 다시 만들기(rebuildLetter)가
 *   이 함수 하나를 같이 쓴다. extractIndexable 결과를 바꾸지 않으므로 기억·스킬 추출은 영향이 없다.
 * refiner 하나는 세션 하나의 상태(도구 id→종별, 출력 해시→처음 본 번호)를 가진다. 세션이 바뀌면 새로 만든다.
 * 종별은 provider 중립 어휘(ToolKind)만 본다.
 */
import { createHash } from "node:crypto";
import type { ToolKind } from "../../shared/agentEvent";
import type { IndexItem } from "./extract";
import { PAST_SEARCH_RESULT } from "./pastSearchResult";
import { letterDocId } from "../db/sessionLetter";

export type RefineRules = { dedupeMin: number; longMin: number; head: number; tail: number; errBudget: number; errLine: number };
export const REFINE_RULES: RefineRules = { dedupeMin: 500, longMin: 4000, head: 1200, tail: 1200, errBudget: 1400, errLine: 300 };
/**
 * 글자 색인 규칙 버전. 부팅 때 저장된 값과 같으면 그 세션의 재생성을 건너뛴다.
 * 정제 규칙 값(REFINE_RULES)은 해시로 자동 반영된다.
 * extract.ts, 이 파일의 로직, provider 해석기(codec)처럼 값이 아닌 추출 로직을 바꿀 때는 아래 상수를 사람이 올려야 한다.
 * 올리지 않으면 이미 만든 세션은 옛 규칙의 색인으로 남는다.
 */
export const LETTER_LOGIC_VERSION = 1;
export function letterRulesVersion(rules?: Partial<RefineRules>): string {
  const merged = { ...REFINE_RULES, ...rules };
  const body = JSON.stringify(Object.keys(merged).sort().map((key) => [key, merged[key as keyof RefineRules]]));
  return `${LETTER_LOGIC_VERSION}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}
export type LetterRefiner = { refine(seq: number, items: IndexItem[]): IndexItem[] };

const RESULT_PREFIX = "▸ ";
const ERR_RE = /error|fail(ed|ure)?|exception|traceback|fatal|panic|denied|cannot|not found|no such file|segmentation fault|killed|err!|conflict|rejected|refused|aborting|exit code [1-9]|undefined:|timed out|unable to|ENOENT|EPERM|EACCES|✗|✖|❌|오류|에러|실패/i;
/** "0 errors" 같은 숫자 0 문구는 오류 줄로 치지 않는다. */
const ZERO_COUNT_RE = /\b0\s+(errors?|failures?|failed|problems?)\b/gi;

export function createLetterRefiner(rules?: Partial<RefineRules>): LetterRefiner {
  const r: RefineRules = { ...REFINE_RULES, ...rules };
  const kinds = new Map<string, ToolKind>();
  const firstSeen = new Map<string, number>();

  return {
    refine(seq, items) {
      const out: IndexItem[] = [];
      for (const item of items) {
        if (item.role === "tool" && item.tool?.kind && item.content.startsWith("⚙")) {
          kinds.set(item.tool.id, item.tool.kind);
          out.push(item);
          continue;
        }
        if (item.role !== "tool" || !item.content.startsWith(RESULT_PREFIX)) {
          out.push(item);
          continue;
        }
        if (PAST_SEARCH_RESULT.test(item.content)) continue;
        const body = item.content.slice(RESULT_PREFIX.length);
        const id = letterDocId(seq, item.part);
        if (body.length >= r.dedupeMin) {
          const hash = createHash("sha256").update(item.content).digest("hex");
          const prev = firstSeen.get(hash);
          if (prev !== undefined && prev !== id) {
            out.push({ ...item, content: `${RESULT_PREFIX}(앞의 #${prev}와 같은 출력 ${body.length}자)` });
            continue;
          }
          firstSeen.set(hash, id);
        }
        const kind = item.tool ? kinds.get(item.tool.id) : undefined;
        if (body.length > r.longMin && kind === "bash") {
          const content = compress(body, r);
          out.push(content.length < item.content.length ? { ...item, content } : item);
          continue;
        }
        out.push(item);
      }
      return out;
    },
  };
}

/**
 * 머리·꼬리·가운데 오류 줄만 남긴다. 위치는 글자 단위로 잡는다. 줄 하나가 예산보다 길어도 머리는 그 줄의 앞, 꼬리는 그 줄의 뒤를 남기고,
 * 머리와 꼬리가 자른 가운데(긴 줄의 남은 부분 포함)에서 오류 줄을 찾는다. 줄바꿈은 \n으로 맞춘다(\r만 쓰는 진행 표시 출력 대비).
 */
function compress(rawBody: string, r: RefineRules): string {
  const body = rawBody.replace(/\r\n?/g, "\n");
  // 머리: 앞 head자 안에서 가장 가까운 줄 끝까지. 그 줄 끝이 head의 절반보다 앞이면(긴 줄이 걸린 경우) 줄 중간에서 head자를 자른다.
  let headEnd = body.lastIndexOf("\n", r.head);
  if (headEnd < r.head / 2) headEnd = Math.min(r.head, body.length);
  // 꼬리: 뒤 tail자 안에서 가장 가까운 줄 시작부터. 그 줄 시작이 tail의 절반보다 뒤면(끝 줄바꿈 앞에 긴 줄이 있는 경우 포함) 줄 중간에서 tail자를 자른다.
  let tailStart = body.indexOf("\n", body.length - r.tail - 1) + 1;
  if (tailStart === 0 || body.length - tailStart < r.tail / 2) tailStart = Math.max(0, body.length - r.tail);
  if (headEnd >= tailStart) return RESULT_PREFIX + rawBody; // 줄일 가운데가 없다. 호출한 쪽이 길이를 비교해 원래 항목을 쓴다.

  const middle = body.slice(headEnd, tailStart);
  const pieces: string[] = [body.slice(0, headEnd)];
  let omitted = 0; // 마지막으로 남긴 조각 뒤에 건너뛴 줄 수
  let errUsed = 0;
  const mark = () => {
    if (omitted > 0) pieces.push(`… (${omitted}줄 생략) …`);
    omitted = 0;
  };
  // 가운데의 첫 줄과 끝 줄은 머리·꼬리가 자른 줄의 나머지일 수 있다. 그래도 한 줄로 보고 검사한다.
  const mid = middle.split("\n");
  // 머리가 줄 끝에서 끝났으면 가운데는 개행으로 시작하므로 빈 첫 조각이 생긴다. 줄 수에 넣지 않는다.
  const midLines = middle.startsWith("\n") ? mid.slice(1) : mid;
  const trimmed = middle.endsWith("\n") ? midLines.slice(0, -1) : midLines;
  for (const line of trimmed) {
    // 0 문구는 같은 길이의 공백으로 지운다. 맞은 위치(hit.index)를 원문 줄에서 그대로 쓰기 위해서다.
    const hit = ERR_RE.exec(line.replace(ZERO_COUNT_RE, (m) => " ".repeat(m.length)));
    if (!hit || errUsed >= r.errBudget) {
      omitted++;
      continue;
    }
    // 오류 낱말이 줄 뒤쪽에 있어도 보이게, 낱말 주위 errLine자를 남긴다.
    const from = Math.max(0, Math.min(hit.index - 100, line.length - r.errLine));
    const text = line.slice(from, from + r.errLine);
    if (errUsed + text.length > r.errBudget) {
      omitted++;
      continue;
    }
    errUsed += text.length;
    mark();
    pieces.push(text);
  }
  mark();
  pieces.push(body.slice(tailStart));
  const keptText = pieces.filter((x) => !/^… \(\d+줄 생략\) …$/.test(x)).join("\n");
  return `${RESULT_PREFIX}${pieces.join("\n")}\n… (원래 ${rawBody.length}자 중 ${keptText.length}자만 색인 · 중간 출력은 검색표에 없음)`;
}
