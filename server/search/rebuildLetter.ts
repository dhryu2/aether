import { FailureTracker } from "../providers/failureTracking";
import { reportError } from "../observability/report";
/**
 * 세션 사건 표에서 글자 색인을 다시 만든다.
 * 한 세션을 통째로 갈아끼우는 쪽이 정본이다. 라이브 반영이 빠뜨린 줄도 여기서 맞춘다.
 * 최대 순번과 규칙 버전이 저장된 기록과 같은 세션은 건너뛴다. 기록은 재생성이 성공한 뒤에만 쓰고, 실시간 색인이 지운다.
 * 줄 하나의 해석·추출 실패는 결정적이라 기록을 쓴다(매 부팅 다시 읽지 않는다. 규칙 버전이 오르면 재시도). 재생성이 예외로 끝나면 기록이 없어 다음 부팅에 다시 한다.
 * 비교용 검색 파일은 열지 않는다. 일기 파일은 읽지 않는다.
 * 실행기는 등록표의 codecFor만 고른다.
 */
import { codecFor, storedProviderId } from "../providers/registry";
import { diaryMaxSeq, forEachDiaryRow, listDiarySessionIds } from "../db/sessionDiary";
import { deleteLetterRanges, hasLetterSession, readLetterProgress, replaceSessionLetter, sessionLetterReady, touchLetterSession, type LetterSessionMeta } from "../db/sessionLetter";
import { loadMeta } from "../sessions/persistence";
import { isHiddenSeq, parseHiddenRanges } from "../sessions/rewind";
import { applyRecover, buildLetterDocs, checkLetters, detectCodec, type RowSource } from "./letterBuild";
import { database } from "../db/sqlite";
import { letterRulesVersion, type RefineRules } from "./refineLetter";

const failures = new FailureTracker();

export async function rebuildSessionLetters(options?: { refine?: Partial<RefineRules> }): Promise<{ sessions: number; docs: number; rebuilt: number }> {
  const ids = await listDiarySessionIds();
  let docs = 0, rebuilt = 0;
  for (const id of ids) {
    try {
      const n = await rebuildOne(id, options?.refine);
      if (n >= 0) { docs += n; rebuilt++; }
    } catch (err) {
      void reportError(err, { component: "search", operation: "search.session_letter.rebuild", session_id: id }); console.error("[aether] 세션 글자 색인 재생성 실패:", id, err instanceof Error ? err.message : "unknown");
    }
  }
  // 사건 원본이 없는 세션의 글자는 지우지 않는다. 기록만 남기고 지운 세션의 검색 글자가 여기 남는다.
  //   완전 삭제는 삭제 때 글자를 직접 지운다.
  return { sessions: ids.length, docs, rebuilt };
}

async function rebuildOne(sessionId: string, rules?: Partial<RefineRules>): Promise<number> {
  // 건너뛰면 -1, 다시 만들었으면 넣은 글 수.
  const meta = loadMeta(sessionId);
  // 세션 폴더가 없으면(지운 세션) 이미 있는 색인을 그대로 둔다. provider와 이름·폴더를 알 길이 없어
  //   다시 만들면 다른 provider 형식으로 읽거나 폴더를 빈 값으로 덮는다.
  if (!meta && (await hasLetterSession(sessionId))) return -1;
  // 원본도 폴더도 없으면 만들 재료가 없다. 있는 글자는 그대로 두고, 완전 삭제된 세션을 빈 채로 되살리지도 않는다.
  if (!meta && diaryMaxSeq(sessionId) === 0) return -1;
  const version = letterRulesVersion(rules);
  const hidden = parseHiddenRanges(meta?.hiddenRanges);
  const done = await readLetterProgress(sessionId);
  const highSeq = diaryMaxSeq(sessionId);
  if (meta && done && done.rulesVersion === version && done.highSeq === highSeq) {
    // 이전 버전이 만든 색인에 남은 숨긴 글을 지운다. 지울 것이 없으면 DELETE 한 번이다.
    await deleteLetterRanges(sessionId, hidden);
    // 이름·폴더는 일기와 따로 바뀔 수 있어 가볍게 맞춘다.
    await touchLetterSession({ sessionId, ...metaOf(sessionId, meta) });
    return -1;
  }
  // 세션 정보가 없으면(지운 세션) 기본 해석기로 읽으면 다른 provider 사건이 빠진다. 어댑터가 직접 사건을 해석해 고른다.
  const source: RowSource = (visit) => forEachDiaryRow(sessionId, visit);
  const codec = meta ? codecFor(storedProviderId(meta.provider)) : detectCodec(source);
  const built = buildLetterDocs(source, codec, rules, (kind, error) => {
    if (kind === "parse") failures.report(error, { component: "search", operation: "search.diary.parse", session_id: sessionId }, `search.diary.parse:${sessionId}`);
    else failures.report(error, { component: "search", operation: "search.event.extract", session_id: sessionId }, `search.event.extract:${sessionId}`);
  }, (seq) => isHiddenSeq(seq, hidden));
  if (!built.parseFailed) failures.clear(`search.diary.parse:${sessionId}`);
  if (!built.extractFailed) failures.clear(`search.event.extract:${sessionId}`);
  const { docs, turnSeqs, seen } = built;
  // 세션 정보가 없으면 해석기를 추정해 만든 것이다. 정보가 돌아오면 다시 만들도록 기록을 남기지 않는다.
  return replaceSessionLetter(sessionId, docs, turnSeqs, metaOf(sessionId, meta), meta ? { highSeq: seen, rulesVersion: version } : undefined);
}

export function metaOf(sessionId: string, meta: ReturnType<typeof loadMeta>): LetterSessionMeta {
  const display = meta?.name?.trim() || meta?.generatedName?.trim() || null;
  return {
    displayName: display || null,
    cwd: meta?.cwd ?? null,
    model: meta?.model ?? null,
    createdAt: typeof meta?.createdAt === "number" ? meta.createdAt : null,
    lineageId: meta?.resumeKey || sessionId,
  };
}

/**
 * 세션을 지우기 전에 원본을 지워도 되는지 본다. 검색 글자가 원본과 같으면 true, 모자라면 채운 뒤 true.
 * 글자 색인이 닫혀 있거나 채울 수 없으면 false이고, 이때는 원본을 남겨야 한다.
 * 세션 정보가 있으므로 그 세션 provider의 해석기를 쓴다.
 */
// shortcut: scripts/purge-deleted-session-events.ts는 메타를 몰라 숨긴 구간을 모른다. keepEvents로 남긴 드문 세션을 그 도구로 정리하면 숨긴 글이 다시 채워질 수 있다. 일회용 도구라 두고, 다시 쓸 일이 생기면 고친다.
export function ensureLettersBeforeDelete(sessionId: string, meta: ReturnType<typeof loadMeta>): boolean {
  if (!sessionLetterReady()) return false;
  if (diaryMaxSeq(sessionId) === 0) return true;
  const db = database();
  const source: RowSource = (visit) => forEachDiaryRow(sessionId, visit);
  const codec = meta ? codecFor(storedProviderId(meta.provider)) : detectCodec(source);
  const hidden = parseHiddenRanges(meta?.hiddenRanges);
  const check = checkLetters(db, sessionId, source, codec, (seq) => isHiddenSeq(seq, hidden));
  if (check.state === "keep") return false;
  return check.state === "match" || applyRecover(db, sessionId, check, metaOf(sessionId, meta));
}
