import { isExpectedError } from "../observability/event";
import { rejectRequest, reportResponseError } from '../observability/http';
import { reportError } from "../observability/report";
/**
 * 세션 액션 라우트 (SSE 스트림은 stream.ts에 분리).
 *   POST   /api/sessions                  세션 생성 {cwd?, model?, resume?, permissionMode?}
 *   GET    /api/sessions                  세션 목록
 *   POST   /api/sessions/:id/message      턴 입력 {text, brief?}
 *   POST   /api/sessions/:id/wake         잠든 세션 깨우기(대화 없음)
 *   POST   /api/sessions/:id/rewind      고른 사용자 말 뒤로 대화와 저장해 둔 파일 되돌리기 {seq}
 *   POST   /api/sessions/:id/interrupt    진행 중 턴 중단
 *   POST   /api/sessions/:id/background-tasks/:taskId/stop  백그라운드 작업 하나 중지
 *   POST   /api/sessions/:id/model        세션 모델 변경 {model}
 *   POST   /api/sessions/:id/effort       세션 effort 변경 {effort}
 *   POST   /api/sessions/:id/permissions  권한 모드 바꾸기 {permissionMode}
 *   GET    /api/sessions/:id/commands     실행 가능한 슬래시 명령 목록
 *   POST   /api/sessions/:id/commands     슬래시 명령 실행 {command, arguments}
 *   POST   /api/sessions/:id/permission   권한 결정 {permissionId, decision}
 *   GET    /api/sessions/:id/permissions  보류 중 권한요청 목록
 *   POST   /api/sessions/:id/question     질문(AskUserQuestion) 답변 {questionId, answers}
 *   GET    /api/sessions/:id/questions    보류 중 질문 목록
 *   POST   /api/sessions/:id/name         표시 이름 변경(rename) {name}
 *   POST   /api/sessions/:id/archive      보관·해제 {archived} — 일하는 중·대기 중이면 보관 409, 보관된 세션은 message·wake·commands 409
 *   PUT    /api/sessions/:id/auto-resume  자동 재개 예약의 시각·문장 바꾸기 {at?, text?} — 예약 없으면 404, 보관되면 409
 *   DELETE /api/sessions/:id/auto-resume  자동 재개 예약 취소
 *   POST   /api/sessions/:id/handoff      새 세션으로 넘기기 시작 {focus?, provider?, cwd?, copyOnly?} — 202 {state}, 일하는 중·이미 진행 중·보관·받을 곳 없음 409
 *   GET    /api/sessions/:id/handoff      새 세션의 인계서 초안 {incoming?} / 복사 결과 {result?}
 *   DELETE /api/sessions/:id/handoff      질문 대기·한도 대기 취소, 복사 결과 지우기 — 쓰는 중이면 409
 *   GET    /api/sessions/:id/events       이전 이벤트 페이지(무한스크롤) ?before=&limit=|from=
 *   DELETE /api/sessions/:id              세션 영구 삭제
 */
import { Router, type Request, type Response } from "express";
import { briefModelText, isBriefRequest, stripBriefAlias } from "../agent-brief/rules";
import { config } from "../config";
import { HandoffError, ModelRejectedError, sessionManager } from "../sessions/SessionManager";
import { HANDOFF_FOCUS_MAX } from "../sessions/handoff";
import { resolveWorkFolder } from "../sessions/safePath";
import { WorkspaceCopyError } from "../sessions/isolatedWorkspace";
import { PermissionModeConflictError, PermissionModeUnavailableError, SessionReadyTimeoutError, type LiveSession } from "../sessions/LiveSession";
import { dataDirBytes, diaryAcceptsInput, readEventsPage } from "../sessions/persistence";
import { toWireEvent } from "../sessions/wireEvent";
import { availableProviders, listProviders, providerAvailability } from "../providers/registry";
import type { QuestionAnswer } from "../providers/types";
import type { SessionEffort, ImageAttachment, DocAttachment, AetherQuestion } from "../types";
import { st } from "../i18n";
import { PERMISSION_MODES } from "../../shared/http";
import { isHiddenSeq, RewindError } from "../sessions/rewind";
import { AUTO_RESUME_TEXT_MAX } from "../sessions/autoResume";

export const sessionsRouter = Router();

/** provider가 준 거부 문구를 응답에 실을 때의 길이 상한 — 화면에 그대로 보이므로 한 문단을 넘기지 않는다. */
const PROVIDER_ERROR_MAX = 500;
const MAX_COMMAND_ARGUMENTS = 20_000;
/** provider 원본 오류 문구를 사용자에게 보여줄 형태로. 경로 정보가 없는 판정 문구라 그대로 내보낸다. */
function providerErrorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, PROVIDER_ERROR_MAX);
}

/**
 * 잠든 세션을 깨우다 실패했을 때의 응답 — message·wake 공용(둘 다 getOrResume을 쓴다).
 * 손상된 세션은 사용자가 고칠 수 없는 상태라 409로, 없는 세션은 404로 가른다. 상세는 서버 로그에만 남긴다
 * (경로 등 경계 정보를 응답에 싣지 않는다 — fs.ts와 동일 정책).
 */
function replyResumeFailure(res: Response, what: string, err: unknown, sessionId: string) {
  // 응답 문구와 상태 판정은 유지한다. 수집 여부는 생성 지점의 중립 원인만 따른다.
  const cause = !isExpectedError(err) && err instanceof Error ? err.cause ?? err : err;
  void reportResponseError(res, cause, { component: "session", operation: "session.resume", session_id: sessionId });
  const msg = String((err as Error).message ?? err);
  const corrupted = /손상/.test(msg);
  console.error(`[aether] ${what} getOrResume 실패:`, msg);
  return res.status(corrupted ? 409 : 404).json({ error: corrupted ? st("routes.sessions.cannotOpen") : st("routes.sessions.notFoundAlt") });
}

/**
 * 클라가 보낸 모델·effort 이름의 **형식만** 본다.
 *
 * 값이 실제로 있는 이름인지는 provider가 판정한다 — 서버가 목록을 들고 대조하면 계정마다 다른 실제
 * 목록과 조용히 어긋나고, 새 모델이 나올 때마다 서버를 고쳐야 한다. 여기서 막는 것은 셋뿐이다.
 *   ① 길이(1~64자) — 빈 값과 비정상적으로 긴 값
 *   ② 제어 문자 — 개행이 섞인 값이 프로세스 인자·로그로 흘러가는 것
 *   ③ `-`로 시작하는 값 — 명령줄 설정 항목(`--flag`)으로 오인될 수 있는 값
 */
function isWellFormedName(v: string): boolean {
  if (v.length < 1 || v.length > 64) return false;
  if (v.startsWith("-")) return false;
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false; // 제어 문자
  }
  return true;
}

/**
 * 질문 답변의 *형태*를 강제한다 (8d-3 ⑥ⓒ).
 *
 * 승인 쪽은 allow/deny 리터럴만 읽어 문법적으로 안전한데, 질문 쪽은 문자열이기만 하면 그대로 모델에게
 * "사용자가 고른 답"으로 전달됐다. 자유 입력은 질문 카드의 정당한 기능이므로 **금지하지 않고 형태를 나눈다**:
 * `answers[i]`의 값은 그 질문이 실제 제시한 선택지 이름이어야 하고, 직접 적은 문장은 `custom[i]`로만 온다.
 */
function parseQuestionAnswers(
  questions: AetherQuestion[],
  rawAnswers: unknown,
  rawCustom: unknown,
): { answers: QuestionAnswer[] } | { error: string } {
  if (!Array.isArray(rawAnswers)) return { error: st("routes.sessions.questionParamsRequired") };
  if (rawAnswers.length !== questions.length) return { error: st("routes.sessions.answerCountMismatch", { n: questions.length }) };
  if (rawCustom != null && !Array.isArray(rawCustom)) return { error: st("routes.sessions.questionParamsRequired") };
  const customs = Array.isArray(rawCustom) ? rawCustom : [];
  if (rawCustom != null && customs.length !== questions.length) {
    return { error: st("routes.sessions.customCountMismatch", { n: questions.length }) };
  }
  const out: QuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const labels = new Set((questions[i]?.options ?? []).map((o) => o?.label).filter((l): l is string => typeof l === "string"));
    const raw = rawAnswers[i];
    const picked = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const chosen: string[] = [];
    for (const p of picked) {
      if (typeof p !== "string") return { error: st("routes.sessions.answerNotAString") };
      if (!labels.has(p)) return { error: st("routes.sessions.answerNotAnOption", { value: p.slice(0, 60) }) };
      chosen.push(p);
    }
    if (new Set(chosen).size !== chosen.length) return { error: st("routes.sessions.answerDuplicate") };
    const c = customs[i];
    if (c != null && typeof c !== "string") return { error: st("routes.sessions.answerNotAString") };
    const custom = typeof c === "string" && c.trim() ? c.trim() : undefined;
    // 단일 선택 질문은 "선택지 하나 또는 자유 입력 하나"다. 클라이언트가 둘을 동시에 보내거나 선택지를
    // 여러 개 보내도 그대로 모델에 전달하면 UI가 표현하지 못하는 위조된 답 모양이 된다.
    if (!questions[i]?.multiSelect && (chosen.length > 1 || (chosen.length === 1 && custom))) {
      return { error: st("routes.sessions.singleAnswerOnly", { n: i + 1 }) };
    }
    if (!chosen.length && !custom) return { error: st("routes.sessions.answerEmpty", { n: i + 1 }) };
    out.push(custom ? { chosen, custom } : { chosen });
  }
  return { answers: out };
}

/**
 * 세션 생성.
 *
 * 모델 이름을 적어 보냈으면 그 이름이 실제로 있는 이름인지 **확인하고 나서** 답한다. 확인은 세션을 띄운
 * 뒤 모델을 바꿔보는 방식이라(SessionManager.createChecked 주석 참조) 응답이 1초쯤 늦는다.
 * 빈 값이면 확인할 것이 없으므로 예전처럼 기다리지 않고 바로 답한다.
 */
sessionsRouter.post("/", async (req: Request, res: Response) => {
  // provider(모델 제공자)는 세션을 만들 때 한 번만 정하고 그 세션이 끝날 때까지 바뀌지 않는다(§0.1-2).
  //   값 검증은 등록표가 한다 — 등록되지 않은 이름은 다른 provider로 넘기지 않고 명시적으로 거부한다(§0.1-4).
  const { cwd, provider, model, resume, permissionMode, isolateWorkspace, name } = req.body ?? {};
  const wanted = typeof model === "string" ? model.trim() : "";
  if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) return res.status(400).json({ error: st("routes.sessions.permissionModeInvalid") });

  // ── 형식 가드 — 프로세스를 띄우기 전에 걸러낸다(모양이 틀린 값은 물어볼 필요가 없다). ──
  if (wanted && !isWellFormedName(wanted)) return res.status(400).json({ error: st("routes.sessions.modelMalformed") });

  // 지금 쓸 수 없는 provider(프로그램 없음, 로그인 안 됨 등)면 세션을 만들지 않는다. 만들면 첫 메시지에서 바로 멈춘다.
  //   등록되지 않은 이름은 여기서 걸러지지 않고 아래 create가 거부한다.
  //   provider를 비웠으면 쓸 수 있는 서비스가 정확히 하나일 때만 그것으로 만든다. 둘 이상이면 조용히 고르지 않고 거부한다.
  let chosen: string | undefined = typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
  if (chosen) {
    const entry = listProviders().find((e) => e.id === chosen);
    if (entry) {
      const availability = await providerAvailability(entry);
      if (!availability.available) {
        const key = availability.requires ? "requires" : availability.reason;
        return res.status(409).json({ error: st(`routes.sessions.providerUnavailable.${key}`, { provider: entry.services.displayName, requires: availability.requires ?? "" }) });
      }
    }
  } else {
    const usable = await availableProviders();
    if (usable.length === 0) return res.status(409).json({ error: st("routes.sessions.noProviderAvailable") });
    if (usable.length > 1) {
      return res.status(400).json({ error: st("routes.sessions.providerRequired", { providers: usable.map((e) => e.id).join(", ") }), providers: usable.map((e) => e.id) });
    }
    chosen = usable[0].id;
  }

  // ── 모델 미지정 = 계정 기본 모델. 확인할 것이 없으니 기다리지 않는다. ──
  if (!wanted) {
    try {
      const s = sessionManager.create({ cwd, provider: chosen, model, resume, permissionMode, isolateWorkspace, name }); // create가 model/resume/cwd/name 타입 정규화
      return res.status(201).json({ id: s.id, cwd: s.cwd, provider: s.provider, model: s.model ?? "" });
    } catch (err) {
      if (err instanceof WorkspaceCopyError) return res.status(400).json({ error: err.message }); // 경로·git 출력이 없는 문구라 그대로 보여도 된다
      void reportError(err, { component: "routes", operation: "session.create.start" }); console.error("[aether] 세션 생성 실패:", err); // 상세는 서버에만(경로 경계 미노출 — fs.ts와 동일 정책)
      return res.status(400).json({ error: st("routes.sessions.createFailed") });
    }
  }


  // 응답을 보내기 전에 브라우저가 떠나면(새로고침·이탈) 방금 띄운 세션이 주인 없이 남는다.
  //   그러면 새로고침할 때마다 모델 프로세스가 하나씩 쌓인다 → 끊긴 사실을 기억해 두고 아래에서 지운다.
  // ⚠️ 요청(req) 쪽 close가 아니라 응답(res) 쪽 close를 본다. 요청 스트림은 본문을 다 읽은 정상 요청에서도
  //   곧바로 close를 내보내서(실측), 그걸 보면 멀쩡한 요청까지 전부 끊긴 것으로 오판한다.
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) clientGone = true; // 응답을 다 보낸 뒤의 정상 close와 구분
  });

  let s: LiveSession;
  try {
    s = await sessionManager.createChecked({ cwd, provider: chosen, resume, permissionMode, isolateWorkspace, name }, wanted);
  } catch (err) {
    if (err instanceof SessionReadyTimeoutError) {
      void reportResponseError(res, err, { component: "routes", operation: "session.create.wait" }); console.error("[aether] 세션 준비 대기 초과:", err.message);
      return res.status(504).json({ error: st("routes.sessions.readyTimeout") });
    }
    if (err instanceof WorkspaceCopyError) return res.status(400).json({ error: err.message });
    void reportError(err, { component: "routes", operation: "session.create.start" }); console.error("[aether] 세션 생성 실패:", err); // 상세는 서버에만(경로 경계 미노출 — fs.ts와 동일 정책)
    if (err instanceof ModelRejectedError) {
      // 모델 판정 문구만 그대로 돌려준다 — 사용자가 오타를 고치는 데 필요한 정보이고 서버 내부 정보를
      //   담지 않는다(예: `Model "sol5.6" is not a recognized model id. Run /model to see available models.`).
      return res.status(400).json({ error: providerErrorText(err) || st("routes.sessions.createFailed") });
    }
    return res.status(400).json({ error: st("routes.sessions.createFailed") });
  }

  if (clientGone) {
    sessionManager.delete(s.id);
    return;
  }
  res.status(201).json({ id: s.id, cwd: s.cwd, provider: s.provider, model: s.model ?? "" });
});

sessionsRouter.get("/", async (_req: Request, res: Response) => {
  const { AGENT_EVENT_CONTRACT_VERSION } = await import("../../shared/agentEvent");
  try {
    const sessions = await sessionManager.listWithCopyState();
    // 디스크 세션 → dm 방 투영.
    const rooms = sessions.map((item) => ({
      id: `dm:${item.id}`,
      kind: "dm" as const,
      title: item.displayName, // 비면 화면이 번역 문구(새 세션)로 채운다
      sourceSessionId: item.id,
      cwd: item.cwd,
      provider: item.provider,
      status: item.status,
      attention: item.attention,
      attentionKind: item.attentionKind,
      attentionPreview: item.attentionPreview,
      attentionSince: item.attentionSince,
      backgroundTasks: item.backgroundTasks,
      backgroundCanStop: item.backgroundCanStop,
      lastViewedAt: item.lastViewedAt,
      archivedAt: item.archivedAt,
      autoResume: item.autoResume,
      lastActivityAt: item.lastActivityAt,
      lastInputAt: item.lastInputAt,
      preview: item.preview,
      asleep: !sessionManager.get(item.id),
    }));

    res.json({
      contractVersion: AGENT_EVENT_CONTRACT_VERSION,
      rooms,
      sessions,
    });
  } catch (e) {
    void reportResponseError(res, e, { component: "routes", operation: "session.list.load" }); console.error("[aether] GET /api/sessions 목록 실패:", e);
    return res.status(503).json({ error: st("routes.sessions.createFailed") });
  }
});

// 이전 이벤트 페이지(무한스크롤) — 초기 replay가 꼬리만 보낸 세션에서 위로 스크롤(limit) 또는 검색 점프(from) 시 과거 구간 취득.
sessionsRouter.get("/:id/events", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!sessionManager.get(id) && !sessionManager.hasDiskSession(id)) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  const before = Number(req.query.before);
  if (!Number.isFinite(before) || before <= 0) return res.status(400).json({ error: st("routes.sessions.beforeRequired") });
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 1000) : 300;
  const rawFrom = Number(req.query.from);
  const from = Number.isFinite(rawFrom) && rawFrom >= 0 ? Math.floor(rawFrom) : undefined;
  try {
    // 무한스크롤/검색점프로 불러오는 과거 이벤트도 SSE와 같은 클라이언트 봉투(원본 msg 없음).
    //   정규화 방식은 그 세션 provider의 codec이 정한다.
    const codec = sessionManager.codecOf(id);
    const beforeSeq = Math.floor(before);
    const page = readEventsPage(id, beforeSeq, limit, from);
    // 숨긴 순번은 응답 전에 뺀다.
    const ranges = sessionManager.hiddenRangesOf(id);
    const shown = (seq: number) => !ranges.length || !isHiddenSeq(seq, ranges);
    const visiblePage = ranges.length ? page.events.filter((ev) => shown(ev.seq)) : page.events;
    // 다음 조회 위치는 덧붙이기 전의 첫 순번이다. 빈 페이지는 요청 before.
    const oldestSeq = page.events[0]?.seq ?? beforeSeq;
    const wired = visiblePage.map((ev) => toWireEvent(ev, codec));

    const events = ranges.length
      ? wired.filter((event) => shown(typeof event.seq === "number" ? event.seq : -1))
      : wired;
    res.json({ events, hasOlder: page.hasOlder, oldestSeq });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.events.read", session_id: req.params.id as string });
    res.status(500).json({ error: st("routes.sessions.eventsReadFailed") });
  }
});

// 운영 진단(인증 뒤) — data/ 총 크기 + 세션 수. 설정 패널 표시용. dataDirBytes는 fs 재귀라 자주 호출 금물(패널 오픈 시 1회).
sessionsRouter.get("/stats", (_req: Request, res: Response) => {
  res.json({ dataBytes: dataDirBytes(), sessions: sessionManager.list().length });
});

// 이미지 첨부(vision) 검증 상수 — 허용 타입·개수·크기(base64 문자열 길이 기준).
//   정합: 5장 × 7MB = 35MB < config.imageBodyLimit(40mb) → 개당·개수 통과분이 body단 413로 안 떨어짐. 프론트(Composer)와 동일.
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
const MAX_IMAGE_B64 = 7 * 1024 * 1024; // 개당 base64 ~7MB(원본 파일 ~5MB → base64 약 4/3배)

/** req.body.images 검증 → 정상 ImageAttachment[] 또는 에러 문자열. 미첨부(undefined)면 []. */
function parseImages(raw: unknown): ImageAttachment[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: st("routes.sessions.imagesMustBeArray") };
  if (raw.length > MAX_IMAGES) return { error: st("routes.sessions.maxImages", { max: MAX_IMAGES }) };
  const out: ImageAttachment[] = [];
  for (const it of raw) {
    const mt = (it as { media_type?: unknown })?.media_type;
    const data = (it as { data?: unknown })?.data;
    if (typeof mt !== "string" || !ALLOWED_IMAGE_TYPES.has(mt)) return { error: st("routes.sessions.unsupportedImageFormat") };
    if (typeof data !== "string" || !data) return { error: st("routes.sessions.imageDataEmpty") };
    if (data.length > MAX_IMAGE_B64) return { error: st("routes.sessions.imageTooLarge") };
    out.push({ media_type: mt, data });
  }
  return out;
}

const MAX_DOC_B64 = 14 * 1024 * 1024; // PDF base64 개당 ~14MB(원본 ~10MB)
/** req.body.documents 검증(PDF만) → DocAttachment[] 또는 에러. */
function parseDocs(raw: unknown): DocAttachment[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: st("routes.sessions.documentsMustBeArray") };
  if (raw.length > MAX_IMAGES) return { error: st("routes.sessions.maxDocuments", { max: MAX_IMAGES }) };
  const out: DocAttachment[] = [];
  for (const it of raw) {
    const mt = (it as { media_type?: unknown })?.media_type;
    const data = (it as { data?: unknown })?.data;
    const name = (it as { name?: unknown })?.name;
    if (mt !== "application/pdf") return { error: st("routes.sessions.unsupportedDocFormat") };
    if (typeof data !== "string" || !data) return { error: st("routes.sessions.docDataEmpty") };
    if (data.length > MAX_DOC_B64) return { error: st("routes.sessions.pdfTooLarge") };
    out.push({ name: typeof name === "string" && name ? name.slice(0, 200) : "document.pdf", media_type: mt, data });
  }
  return out;
}

sessionsRouter.post("/:id/message", async (req: Request, res: Response) => {
  // 입력 검증 먼저 — getOrResume(디스크 세션 lazy resume = claude spawn 부수효과) 전에 차단(불필요 spawn 방지).
  const rawText = typeof req.body?.text === "string" ? req.body.text : "";
  const images = parseImages(req.body?.images);
  if (!Array.isArray(images)) return res.status(400).json({ error: images.error });
  const documents = parseDocs(req.body?.documents);
  if (!Array.isArray(documents)) return res.status(400).json({ error: documents.error });
  // 질문지 카드 답은 글이 비어도 된다. 빈 글 검사보다 먼저 가른다.
  const rawQuestionnaire = req.body?.questionnaire;
  const questionnaire =
    rawQuestionnaire !== undefined && rawQuestionnaire !== null && typeof rawQuestionnaire === "object" && !Array.isArray(rawQuestionnaire)
      ? (rawQuestionnaire as { id?: unknown; answers?: unknown })
      : undefined;
  if (rawQuestionnaire !== undefined && rawQuestionnaire !== null && !questionnaire) {
    return res.status(400).json({ error: st("routes.sessions.questionnaire.shape") });
  }
  if (questionnaire && (typeof questionnaire.id !== "string" || !questionnaire.id.trim())) {
    return res.status(400).json({ error: st("routes.sessions.questionnaire.shape") });
  }
  // 텍스트·첨부 모두 없으면 거부(빈 턴 방지).
  if (!questionnaire && !rawText.trim() && images.length === 0 && documents.length === 0) return res.status(400).json({ error: st("routes.sessions.textOrAttachmentRequired") });
  // idempotency 키 — 모델에 안 가고 서버 조회에만 쓴다(trust_boundary 표는 허용 목록 밖이라 지역 변수로 읽는다).
  const messageBody = req.body ?? {};
  const clientMessageId =
    typeof messageBody.clientMessageId === "string" ? messageBody.clientMessageId.trim() : "";
  // true 또는 선두 /brief만 브리프다. 문자열 "true"와 /agent-brief는 일반 전송이다.
  // 브리프면 별칭을 뗀 사람 글을 사건에 남기고, 규칙은 모델 입력에만 붙인다.
  const brief = isBriefRequest(rawText, req.body?.brief);
  if (questionnaire && brief) return res.status(400).json({ error: st("routes.sessions.questionnaire.withBrief") });
  // 카드 답은 첨부를 싣지 않는다. 조용히 버리지 않고 거절한다.
  if (questionnaire && (images.length > 0 || documents.length > 0)) return res.status(400).json({ error: st("routes.sessions.questionnaire.withAttachments") });
  if (questionnaire && !clientMessageId) return res.status(400).json({ error: st("routes.sessions.questionnaire.idRequired") });
  let text = rawText;
  let modelText: string | undefined;
  if (brief) {
    text = stripBriefAlias(rawText);
    if (!text.trim() && images.length === 0 && documents.length === 0) {
      return res.status(400).json({ error: st("routes.sessions.textOrAttachmentRequired") });
    }
    modelText = briefModelText(text);
  }

  const id = String(req.params.id);
  if (sessionManager.isArchived(id)) return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
  if (!diaryAcceptsInput(id)) {
    return res.status(503).json({ error: st("routes.sessions.diaryBusy") });
  }
  let s;
  try {
    await sessionManager.settledSleep(id); // 방금 잠든 세션이면 옛 실행기가 내려간 뒤에 띄운다
    s = sessionManager.getOrResume(id);
  } catch (err) {
    return replyResumeFailure(res, "message", err, id);
  }
  try {
    if (questionnaire) {
      const outcome = await s.submitQuestionnaireAnswer({
        questionnaireId: String(questionnaire.id).trim(),
        answers: questionnaire.answers,
        clientMessageId,
        resendOnDuplicate: true,
      });
      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
      return res.json({ ok: true });
    }
    if (brief) {
      await s.push(
        text,
        images.length ? images : undefined,
        documents.length ? documents : undefined,
        clientMessageId || undefined,
        { modelText, brief: true },
      );
    } else {
      await s.push(
        text,
        images.length ? images : undefined,
        documents.length ? documents : undefined,
        clientMessageId || undefined,
      );
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof RewindError) {
      const status = err.code === "busy" ? 409 : err.code === "missing" ? 404 : 400;
      return res.status(status).json({ error: st(`routes.sessions.rewind.${err.code}`) });
    }
    void reportError(err, { component: "routes", operation: "session.message.push", session_id: id });
    res.status(409).json({ error: providerErrorText(err) });
  }
});

/**
 * 잠든 세션 깨우기 — **모델에게는 아무것도 묻지 않는다.**
 *
 * 서버를 재시작하면 저장된 세션들은 프로세스 없이 메타만 복원된다(SessionManager.restoreFromDisk).
 * 그 상태에서는 모델 목록·슬래시 명령·승인 정책 조회가 전부 404다. 지금까지는 사용자가 메시지를 한 번
 * 보내야 세션이 깨어났는데, 그러려고 보내는 메시지는 대화 기록에 남고 토큰도 쓴다.
 *
 * 여기서 하는 일은 `getOrResume` 한 번이 전부다. 프로세스만 뜨고 턴은 소비되지 않으므로 토큰이 0이고,
 * 대화에도 아무것도 안 쌓인다(이어가기 안내 notice는 기존 resume 경로가 원래 남기던 것 그대로).
 * 이미 깨어 있으면 아무것도 하지 않고 성공으로 답한다(멱등).
 */
sessionsRouter.post("/:id/wake", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (sessionManager.isArchived(id)) return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
  const live = sessionManager.get(id);
  if (live && !live.isEnded) return res.json({ ok: true, alreadyAwake: true });
  try {
    await sessionManager.settledSleep(id);
    sessionManager.getOrResume(id);
  } catch (err) {
    return replyResumeFailure(res, "wake", err, id);
  }
  res.json({ ok: true, alreadyAwake: false });
});

sessionsRouter.post("/:id/rewind", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (sessionManager.isArchived(id)) return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
  const seq = Number(req.body?.seq);
  if (!Number.isInteger(seq) || seq <= 0) return res.status(400).json({ error: st("routes.sessions.rewindBadSeq") });
  try {
    const result = await sessionManager.rewind(id, seq);
    res.json(result);
  } catch (err) {
    if (err instanceof RewindError) {
      const status = err.code === "busy" ? 409 : err.code === "missing" ? 404 : 400;
      return res.status(status).json({ error: st(`routes.sessions.rewind.${err.code}`) });
    }
    void reportResponseError(res, err, { component: "routes", operation: "session.rewind.run", session_id: req.params.id as string }); console.error("[aether] 대화 되돌리기 실패:", err);
    return res.status(500).json({ error: st("routes.common.internalError") });
  }
});

sessionsRouter.post("/:id/interrupt", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const s = sessionManager.get(id);
  // 디스크 세션(재시작 후 복원, 아직 live 아님)은 진행 중 턴이 없음 → 멱등하게 '이미 멈춤'으로 ok 반환(404 노이즈 제거).
  if (!s) {
    if (sessionManager.hasDiskSession(id)) return res.json({ ok: true, alreadyStopped: true });
    return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  }
  try {
    await s.interrupt();
    res.json({ ok: true });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.interrupt", session_id: req.params.id as string });
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

// 뒤 작업 하나 중지. 메인 턴 중단(interrupt)과 별개다. 작업 id는 provider가 만든 문자열이라 길이·문자 종류를 먼저 거른다.
// 실제 관측된 id는 `bok4sjiv7` 같은 9자 영숫자다(스파이크 실측). 그 모양을 넉넉히 받는 범위로 둔다.
const BACKGROUND_TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
sessionsRouter.post("/:id/background-tasks/:taskId/stop", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const taskId = String(req.params.taskId);
  if (!BACKGROUND_TASK_ID_RE.test(taskId)) return rejectRequest(res, 400, { error: st("routes.sessions.backgroundTaskIdInvalid") });
  const s = sessionManager.get(id);
  if (!s) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  if (!s.canStopBackground) return rejectRequest(res, 501, { error: st("routes.sessions.notSupportedByProvider") });
  try {
    const stopped = await s.stopBackgroundTask(taskId);
    if (!stopped) return rejectRequest(res, 404, { error: st("routes.sessions.backgroundTaskNotFound") });
    res.json({ ok: true });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.background_task.stop", session_id: id });
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/**
 * 세션 모델 변경(`/model` 슬래시 명령).
 *
 * 이름이 실제로 있는지는 **provider가 판정한다** — 라이브 세션이면 그냥 바꿔보고, 거부하면 그 문구를
 * 그대로 돌려준다. 서버가 목록을 들고 대조하던 방식은 계정마다 다른 실제 목록과 조용히 어긋났다.
 * 잠든 디스크 세션은 물어볼 상대가 없으므로 형식만 보고 메타에 적어둔다(다음에 깨어날 때 적용).
 */
sessionsRouter.post("/:id/model", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const model = req.body?.model;
  if (typeof model !== "string" || !model.trim()) return res.status(400).json({ error: st("routes.sessions.modelRequired") });
  const wanted = model.trim();
  if (!isWellFormedName(wanted)) return res.status(400).json({ error: st("routes.sessions.modelMalformed") });
  const s = sessionManager.get(id);
  if (s) {
    try {
      // 끝난 세션(크래시 등)은 값만 남는다 — 잠든 디스크 세션과 같아서 다음에 깨어날 때 적용된다.
      const { deferred } = await s.setModel(wanted);
      return res.json({ ok: true, model: wanted, ...(deferred ? { deferred: true } : {}) });
    } catch (err) {
      void reportError(err, { component: "routes", operation: "session.model.set", session_id: id });
      // provider의 판정 문구를 그대로(예: `Model "sol5.6" is not a recognized model id.`) — 오타를 고치는 데 필요하다.
      return res.status(400).json({ error: providerErrorText(err) });
    }
  }
  // 잠든 디스크 세션: 메타에 저장 → 다음 resume 시 적용(claude spawn 없이). 손상/없음이면 404.
  if (sessionManager.updateDiskMeta(id, { model: wanted })) return res.json({ ok: true, model: wanted, deferred: true });
  return res.status(404).json({ error: st("routes.common.sessionNotFound") });
});

/**
 * 세션 추론 강도 변경(`/effort` 슬래시 명령). 모델 변경과 같은 원칙이다.
 * 받는 값은 모델마다 다르므로(`supportedEffortLevels`) 서버가 목록을 들고 있지 않고 provider에 맡긴다.
 */
sessionsRouter.post("/:id/effort", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const effort = req.body?.effort;
  if (typeof effort !== "string" || !isWellFormedName(effort.trim())) {
    return res.status(400).json({ error: st("routes.sessions.effortInvalid") });
  }
  const wanted = effort.trim();
  const s = sessionManager.get(id);
  if (s) {
    try {
      const { deferred } = await s.setEffort(wanted as SessionEffort);
      return res.json({ ok: true, effort: wanted, ...(deferred ? { deferred: true } : {}) });
    } catch (err) {
      void reportError(err, { component: "routes", operation: "session.effort.set", session_id: id });
      return res.status(400).json({ error: providerErrorText(err) });
    }
  }
  // 잠든 디스크 세션: 메타에 저장 → 다음 resume 시 적용. 손상/없음이면 404.
  if (sessionManager.updateDiskMeta(id, { effort: wanted as SessionEffort })) return res.json({ ok: true, effort: wanted, deferred: true });
  return res.status(404).json({ error: st("routes.common.sessionNotFound") });
});

/**
 * 권한 모드 바꾸기. 화면의 권한 칩이 쓴다. 모델·강도 변경과 같은 원칙이다.
 * 어느 모드가 가능한지와 바꾸는 수단(SDK 모드·턴 정책·프로세스 재시작)은 provider가 정한다.
 * 살아 있는 세션은 provider가 알려 준 목록, 잠든 세션은 마지막으로 저장된 목록에 있는 값만 받는다.
 */
sessionsRouter.post("/:id/permissions", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const mode = req.body?.permissionMode;
  if (!PERMISSION_MODES.includes(mode)) return res.status(400).json({ error: st("routes.sessions.permissionModeInvalid") });
  const s = sessionManager.get(id);
  if (s) {
    try {
      const { deferred } = await s.changePermissionMode(mode, config.sessionReadyTimeoutMs);
      return res.json({ ok: true, permissionMode: mode, ...(deferred ? { deferred: true } : {}) });
    } catch (err) {
      if (err instanceof PermissionModeUnavailableError) return res.status(400).json({ error: err.message });
      if (err instanceof PermissionModeConflictError) return res.status(409).json({ error: err.message });
      void reportError(err, { component: "routes", operation: "session.permissions.set", session_id: id });
      if (err instanceof SessionReadyTimeoutError) return res.status(504).json({ error: st("routes.sessions.readyTimeout") });
      return res.status(400).json({ error: providerErrorText(err) });
    }
  }
  // 잠든 디스크 세션: 저장된 목록에 있는 값만 메타에 저장 → 다음 resume 시 적용. 손상/없음이면 404.
  const stored = sessionManager.diskPermissionModes(id);
  if (stored) {
    if (!stored.modes.includes(mode)) return res.status(400).json({ error: st("routes.sessions.permissionModeUnavailable") });
    if (sessionManager.updateDiskMeta(id, { permissionMode: mode })) return res.json({ ok: true, permissionMode: mode, deferred: true });
  }
  return res.status(404).json({ error: st("routes.common.sessionNotFound") });
});

/**
 * 이 세션에서 고를 수 있는 권한 모드와 지금 모드. 살아 있는 세션은 provider에게 묻고(모델에 따라 달라질 수 있다),
 * 잠든 세션은 깨우지 않고 마지막으로 저장된 목록을 답한다.
 */
sessionsRouter.get("/:id/permission-modes", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const s = sessionManager.get(id);
  if (s) {
    try {
      return res.json(await s.listPermissionModes(config.sessionReadyTimeoutMs));
    } catch (err) {
      void reportResponseError(res, err, { component: "routes", operation: "session.permission_modes.list", session_id: id });
      if (err instanceof SessionReadyTimeoutError) return res.status(504).json({ error: st("routes.sessions.readyTimeout") });
      return res.status(500).json({ error: providerErrorText(err) });
    }
  }
  const stored = sessionManager.diskPermissionModes(id);
  if (stored) return res.json(stored);
  return res.status(404).json({ error: st("routes.common.sessionNotFound") });
});

/**
 * 이 계정에서 고를 수 있는 모델 목록. live 세션만 지원(잠든 세션은 404 — 물어볼 프로세스가 없다).
 *
 * 응답 항목은 `value`·`displayName`·`description`·`isDefault`·`resolvedModel`·`supportedEffortLevels`다.
 *   - `isDefault`: 모델을 고르지 않은 세션이 쓰는 계정 기본 모델 표시. provider가 모르면 생략한다.
 *   - `resolvedModel`: 별칭이 가리키는 정식 id. 대화 스트림이 싣는 이름이 이쪽이라, 화면이 "지금 이 모델"을
 *     목록에서 찾으려면 이 값이 있어야 한다.
 *   - `supportedEffortLevels`: 추론 강도 목록이 모델마다 다르므로 여기서 함께 준다.
 */
sessionsRouter.get("/:id/models", async (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) {
    // 잠든 세션은 허브가 기억한 목록으로 답한다. 기억이 없으면 지금처럼 404다.
    const remembered = sessionManager.diskModels(String(req.params.id));
    if (remembered?.length) return res.json({ models: remembered });
    return res.status(404).json({ error: st("routes.sessions.liveOnlyModels") });
  }
  if (!s.capabilities.supportedModels) return rejectRequest(res, 501, { error: st("routes.sessions.notSupportedByProvider") });
  try {
    // 짧은 목록이 와도 최근에 받은 긴 목록을 합쳐 준다(배경 작업 모델 측정 계획 7절).
    const models = await s.listModels(config.sessionReadyTimeoutMs);
    res.json({ models });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.models.list", session_id: req.params.id as string });
    if (err instanceof SessionReadyTimeoutError) return res.status(504).json({ error: st("routes.sessions.readyTimeout") });
    res.status(500).json({ error: providerErrorText(err) });
  }
});

// 구독 사용량·rate-limit — provider-native 조회. live 세션만.
sessionsRouter.get("/:id/usage", async (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: st("routes.sessions.liveOnly") });
  if (!s.capabilities.usage) return rejectRequest(res, 501, { error: st("routes.sessions.notSupportedByProvider") });
  try {
    res.json(await s.getUsage());
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.usage", session_id: req.params.id as string });
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

// 세션 지원 슬래시 명령 — 모든 provider가 구현하는 핵심 계약. live 세션만.
sessionsRouter.get("/:id/commands", async (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) {
    // 잠든 세션은 마지막으로 기억한 목록에 공통 명령을 합쳐 답한다.
    const remembered = sessionManager.diskCommands(String(req.params.id));
    if (remembered) return res.json({ commands: remembered });
    return res.status(404).json({ error: st("routes.sessions.liveOnly") });
  }
  try {
    res.json({ commands: await s.listCommands() });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.commands.list", session_id: req.params.id as string });
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

/**
 * 슬래시 명령 단일 실행 경로. 클라이언트는 provider RPC 이름을 보낼 수 없고, 명령 이름·인자만 보낸다.
 * 실제 지원 판정과 프로토콜 변환은 runtime adapter가 한다. 모르는 명령은 일반 메시지로 폴백하지 않는다.
 */
sessionsRouter.post("/:id/commands", async (req: Request, res: Response) => {
  const command = req.body?.command;
  const args = req.body?.arguments ?? "";
  if (typeof command !== "string" || !isWellFormedName(command.trim())) {
    return res.status(400).json({ error: st("routes.sessions.commandInvalid") });
  }
  if (typeof args !== "string" || args.length > MAX_COMMAND_ARGUMENTS) {
    return res.status(400).json({ error: st("routes.sessions.commandArgumentsInvalid", { max: MAX_COMMAND_ARGUMENTS }) });
  }
  if (sessionManager.isArchived(String(req.params.id))) return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
  const s = sessionManager.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: st("routes.sessions.liveOnly") });
  try {
    const result = await s.executeCommand({ name: command.trim(), arguments: args });
    if (!result.accepted) return res.status(400).json({ error: result.error.slice(0, PROVIDER_ERROR_MAX) });
    res.json({ ok: true, ...result });
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.command.execute", session_id: req.params.id as string });
    res.status(500).json({ error: providerErrorText(err) });
  }
});

/**
 * 이 세션에 실제로 적용 중인 승인 정책 요약 (8d-3 ⑥ⓕ). live 세션만.
 *
 * live 전용이 맞는 이유: 도구는 턴 중에만 실행되고 턴이 돌면 세션은 이미 live다. 즉 카드 없이 뭔가
 * 실행될 수 있는 모든 순간에 이 값이 존재한다.
 */
sessionsRouter.get("/:id/permission-policy", async (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) {
    const remembered = sessionManager.diskPermissionPolicy(String(req.params.id));
    if (remembered) return res.json(remembered);
    return res.status(404).json({ error: st("routes.sessions.liveOnly") });
  }
  try {
    res.json(await s.permissionPolicy());
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.permission_policy", session_id: req.params.id as string });
    res.status(500).json({ error: String((err as Error).message ?? err) });
  }
});

sessionsRouter.post("/:id/permission", (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  const { permissionId, decision } = req.body ?? {};
  if (decision !== "allow" && decision !== "deny") {
    return res.status(400).json({ error: st("routes.sessions.decisionInvalid") });
  }
  // ★ H1: "인자 수정"(updatedInput) 통로 폐쇄 — 승인은 항상 Claude 원본을 실행한다(resolvePermission).
  const ok = s.resolvePermission(permissionId, decision);
  if (!ok) return res.status(404).json({ error: st("routes.sessions.permissionNotFound") });
  res.json({ ok: true });
});

sessionsRouter.get("/:id/permissions", (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  res.json({ pending: s.pendingPermissions() });
});

/**
 * AskUserQuestion 답변.
 *   answers[i] = i번째 질문에서 **고른 선택지 이름** 배열(multiSelect 대비)
 *   custom[i]  = 그 질문에 사용자가 **직접 적은 문장**(선택지 밖 입력 — 없으면 null)
 *
 * 8d-3 ⑥ⓒ 이전엔 문자열이기만 하면 그대로 "사용자가 고른 답"으로 모델에 전달됐다(선택지 대조 없음).
 * 이제 `answers`는 제시된 선택지와 대조하고, 자유 입력은 `custom`으로만 받아 모델에게도 구분해 알린다.
 */
sessionsRouter.post("/:id/question", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { questionId, answers, custom } = req.body ?? {};
  const s = sessionManager.get(id);
  if (!s) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  if (typeof questionId !== "string") return res.status(400).json({ error: st("routes.sessions.questionParamsRequired") });
  // 대조하려면 원본 질문이 필요하다 → 보류 목록을 먼저 찾는다(없으면 이미 처리됐거나 만료).
  const pending = s.pendingQuestion(questionId);
  if (!pending) return res.status(404).json({ error: st("routes.sessions.questionNotFound") });
  const parsed = parseQuestionAnswers(pending.questions, answers, custom);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  const ok = s.resolveQuestion(questionId, parsed.answers);
  if (!ok) return res.status(404).json({ error: st("routes.sessions.questionNotFound") });
  res.json({ ok: true });
});

sessionsRouter.post("/:id/plan", (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  if (!s.capabilities.planReview) return rejectRequest(res, 501, { error: st("routes.sessions.extraCapabilityMissing") });
  const { planId, decision, message } = req.body ?? {};
  if (typeof planId !== "string") return res.status(400).json({ error: st("routes.sessions.planParamsRequired") });
  if (decision !== "approve" && decision !== "revise" && decision !== "cancel") {
    return res.status(400).json({ error: st("routes.sessions.planParamsRequired") });
  }
  if (decision === "revise" && (typeof message !== "string" || !message.trim())) {
    return res.status(400).json({ error: st("routes.sessions.planReviseRequired") });
  }
  const outcome =
    decision === "approve" ? { decision: "approve" as const }
    : decision === "cancel" ? { decision: "cancel" as const }
    : { decision: "revise" as const, message: String(message).trim() };
  const ok = s.resolvePlan(planId, outcome);
  if (!ok) return res.status(404).json({ error: st("routes.sessions.planNotFound") });
  res.json({ ok: true });
});

sessionsRouter.get("/:id/plans", (req: Request, res: Response) => {
  const s = sessionManager.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  if (!s.capabilities.planReview) return rejectRequest(res, 501, { error: st("routes.sessions.extraCapabilityMissing") });
  res.json({ pending: s.pendingPlanList() });
});

sessionsRouter.post("/:id/workspace/apply", (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!sessionManager.get(id) && !sessionManager.hasDiskSession(id)) {
    return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  }
  try {
    sessionManager.applyWorkspace(id);
    res.json({ ok: true });
  } catch (err) {
    void reportError(err, { component: "routes", operation: "session.workspace.apply", session_id: id });
    res.status(400).json({ error: providerErrorText(err) });
  }
});

sessionsRouter.post("/:id/workspace/discard", (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!sessionManager.get(id) && !sessionManager.hasDiskSession(id)) {
    return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  }
  try {
    // force는 확인 창을 통과한 요청만 보낸다. 본문 없는 호출은 더러운 복사본을 그대로 거절한다.
    sessionManager.discardWorkspace(id, req.body?.force === true);
    res.json({ ok: true });
  } catch (err) {
    void reportError(err, { component: "routes", operation: "session.workspace.discard", session_id: id });
    res.status(400).json({ error: providerErrorText(err) });
  }
});

// 세션 표시 이름 변경(rename). live·디스크 세션 모두 메타에 영속(resume 후에도 유지). 빈값이면 자동 제목으로 복귀.
sessionsRouter.post("/:id/name", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const name = req.body?.name;
  if (typeof name !== "string") return res.status(400).json({ error: st("routes.common.nameRequired") });
  const trimmed = name.trim().slice(0, 80); // 길이 상한(사이드바 표시 보호)
  if (!sessionManager.setName(id, trimmed)) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  res.json({ ok: true, name: trimmed });
});

// 세션 보관·해제. 삭제가 아니다 — 목록에서 「보관됨」으로만 간다. 멱등. 일하는 중·대기 중이면 보관 409.
sessionsRouter.post("/:id/archive", (req: Request, res: Response) => {
  const archived = req.body?.archived;
  if (typeof archived !== "boolean") return res.status(400).json({ error: st("routes.sessions.archiveBodyInvalid") });
  const r = sessionManager.setArchived(String(req.params.id), archived);
  if (r === "notFound") return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  if (r === "busy") return res.status(409).json({ error: st("routes.sessions.archiveBusy") });
  res.json({ ok: true, ...(r.archivedAt !== undefined ? { archivedAt: r.archivedAt } : {}) });
});

// 세션 영구 삭제(라이브 종료 + 디스크 제거). 멱등 — 이미 없으면 existed:false로 ok 반환.
// 복사본에 변경이 있어도 삭제면 그 복사본을 버린다. 폴더를 지우지 못하면 세션은 남기고 이유를 돌려준다.
// ?purge=1이면 검색 글자까지 지운다. 인자가 없거나 0이면 대화 기록(검색 글자)을 남긴다. 그 밖의 값은 400.
sessionsRouter.delete("/:id", (req: Request, res: Response) => {
  const raw = req.query.purge;
  if (raw !== undefined && raw !== "0" && raw !== "1") return res.status(400).json({ error: st("routes.sessions.deletePurgeInvalid") });
  try {
    const existed = sessionManager.delete(String(req.params.id), { purge: raw === "1" });
    res.json({ ok: true, existed });
  } catch (err) {
    void reportError(err, { component: "routes", operation: "session.delete.request", session_id: String(req.params.id) });
    res.status(400).json({ error: providerErrorText(err) });
  }
});

// 자동 재개 예약 편집. at은 지금-1초 ~ 31일 뒤, text는 1~2000자.
const AUTO_RESUME_MAX_AHEAD_MS = 31 * 24 * 3600_000;
sessionsRouter.put("/:id/auto-resume", (req: Request, res: Response) => {
  const { at, text } = (req.body ?? {}) as { at?: unknown; text?: unknown };
  const now = Date.now();
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at) || at < now - 1000 || at > now + AUTO_RESUME_MAX_AHEAD_MS)) {
    return res.status(400).json({ error: st("routes.autoResume.atInvalid") });
  }
  if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > AUTO_RESUME_TEXT_MAX)) {
    return res.status(400).json({ error: st("routes.autoResume.textInvalid") });
  }
  if (at === undefined && text === undefined) return res.status(400).json({ error: st("routes.autoResume.nothing") });
  const r = sessionManager.editAutoResume(String(req.params.id), { at: at as number | undefined, text: text as string | undefined });
  if (r === "notFound") return res.status(404).json({ error: st("routes.autoResume.notFound") });
  if (r === "archived") return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
  res.json({ autoResume: r });
});

sessionsRouter.delete("/:id/auto-resume", (req: Request, res: Response) => {
  sessionManager.cancelAutoResume(String(req.params.id));
  res.json({ ok: true });
});

// 새 세션으로 넘기기. 형식 → 존재·보관 → 받을 곳 확인 순으로 거르고, 모델은 마지막에 한 번 부른다.
sessionsRouter.post("/:id/handoff", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { focus: rawFocus, provider: rawProvider, cwd: rawCwd, copyOnly: rawCopyOnly } = req.body ?? {};
  const bad = (key: string) => res.status(400).json({ error: st(`routes.handoff.${key}`) });
  for (const v of [rawFocus, rawProvider, rawCwd]) if (v !== undefined && typeof v !== "string") return bad("bodyInvalid");
  if (rawCopyOnly !== undefined && typeof rawCopyOnly !== "boolean") return bad("bodyInvalid");
  const focus = typeof rawFocus === "string" ? rawFocus.trim() : "";
  if (focus.length > HANDOFF_FOCUS_MAX) return bad("focusTooLong");
  const provider = typeof rawProvider === "string" && rawProvider.trim() ? rawProvider.trim() : undefined;
  const cwd = typeof rawCwd === "string" && rawCwd.trim() ? rawCwd.trim() : undefined;
  const copyOnly = rawCopyOnly === true;

  if (!sessionManager.get(id) && !sessionManager.hasDiskSession(id)) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  if (sessionManager.isArchived(id)) return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
  if (!diaryAcceptsInput(id)) return res.status(503).json({ error: st("routes.sessions.diaryBusy") });
  if (!copyOnly) {
    if (provider) {
      const entry = listProviders().find((e) => e.id === provider);
      if (!entry) return res.status(409).json({ error: st("routes.handoff.providerUnknown") });
      const availability = await providerAvailability(entry);
      if (!availability.available) {
        const key = availability.requires ? "requires" : availability.reason;
        return res.status(409).json({ error: st(`routes.sessions.providerUnavailable.${key}`, { provider: entry.services.displayName, requires: availability.requires ?? "" }) });
      }
    }
    try {
      resolveWorkFolder(cwd ?? sessionManager.handoffDefaultCwd(id));
    } catch {
      return res.status(409).json({ error: st("routes.handoff.folderMissing") });
    }
  }
  try {
    const state = await sessionManager.startHandoff(id, { ...(focus ? { focus } : {}), provider, cwd, copyOnly: copyOnly || undefined });
    res.status(202).json({ state });
  } catch (err) {
    if (err instanceof HandoffError) {
      if (err.code === "archived") return res.status(409).json({ error: st("routes.sessions.archivedReadOnly") });
      if (err.code === "push") return res.status(409).json({ error: err.message });
      return res.status(409).json({ error: st(`routes.handoff.${err.code}`) });
    }
    return replyResumeFailure(res, "handoff", err, id);
  }
});

sessionsRouter.get("/:id/handoff", (req: Request, res: Response) => {
  const info = sessionManager.handoffInfo(String(req.params.id));
  if (!info) return res.status(404).json({ error: st("routes.common.sessionNotFound") });
  res.json(info);
});

sessionsRouter.delete("/:id/handoff", (req: Request, res: Response) => {
  if (sessionManager.clearHandoff(String(req.params.id)) === "busy") return res.status(409).json({ error: st("routes.handoff.writing") });
  res.json({ ok: true });
});
