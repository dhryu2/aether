import { failuresFor } from "../providers/failureTracking";
import { classifyError, isExpectedError } from "../observability/event";
import { reportError } from "../observability/report";
/**
 * SessionManager — Map<id, LiveSession> 싱글톤 + 디스크 세션 머지(재시작 후 과거 세션 복원).
 * 세션 생성 시 cwd를 작업 폴더 규칙(실재 폴더·보호 폴더 거부)으로 검증한다.
 * ⚠️ 이 검증은 편의적 차단이지 샌드박스가 아님 — 진짜 게이트는 권한 UI.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { LiveSession, SessionReadyTimeoutError, mergeCommands } from "./LiveSession";
import { readIdleSleepMs } from "./idleSleepSetting";
import { mergeModelList } from "../providers/modelCatalogMemory";
import { adoptEventLog, closeEventLog, eventLogFor as openEventLog } from "./eventLog";
import type { SessionEventLog } from "./eventLog";
import { resolveWorkFolder, samePath } from "./safePath";
import * as store from "./persistence";
import { ensureLettersBeforeDelete } from "../search/rebuildLetter";
import { codecFor, providerEntry, storedProviderId } from "../providers/registry";
import { HOLD_EVENT_KINDS, orphanHoldResolves, orphanHoldWaiting } from "./orphanHolds";
import { applyIsolatedWorkspace, discardIsolatedWorkspace, folderUncommittedChanges, prepareIsolatedWorkspace, workspaceCopyState } from "./isolatedWorkspace";
import { lastWorkPreview } from "./workPreview";
import type { ProviderEventCodec } from "./codec/types";
import type { ProviderId } from "../providers/types";
import { restoreIsolation, type Isolation } from "./isolation";
import type { AetherEvent, AetherEventBody, DerivedStatus, SessionEffort, SessionListItem, SessionMeta } from "../types";
import { PERMISSION_MODES, type SlashCommandInfo, type AutoResumePlan, type HandoffFields, type HandoffJob, type HandoffSource, type PermissionMode, type PresenceSession } from "../../shared/http";
import { computeAttention, isStickyAttentionKind } from "./attention";
import { changedFiles, handoffForceWriteText, handoffRequest, handoffTurnAwaitsWork, handoffTurnOutcome, HANDOFF_ASK_ROUNDS_MAX, HANDOFF_CLIENT_ID_PREFIX, latestTodoItems, limitResetsAt, pickHandoffText, recentUserTexts, skeletonHandoff, withHandoffFrame } from "./handoff";
import { autoResumeStoppedIntent, waitingFromPending, type NotifyIntent } from "../notify/worthNotifying";
import { AUTO_RESUME_MAX_ATTEMPTS, AUTO_RESUME_TEXT_MAX, nextAttemptAt, readAutoResumeSettings, takeRestartCut, writeRestartCut, type AutoResumeVerdict } from "./autoResume";
import { st } from "../i18n";
import { deriveWorkTitle, resolveWorkTitle } from "../../shared/workTitle";
import { forgetRewoundLetters, parseHiddenRanges, previewRewind, rewindDisk, RewindError, sessionWasRewound, type HiddenRange, type RewindOutcome } from "./rewind";

const NAME_MAX = 80;
/** 일하는 중이라 자동 재개를 미룰 때의 간격. */
const AUTO_RESUME_BUSY_DEFER_MS = 60_000;
/** 재시작 뒤 지난 예약을 보내기 시작하는 지연과 세션 사이 간격(동시에 프로세스를 띄우지 않게). */
const AUTO_RESUME_BOOT_DELAY_MS = 30_000;
const AUTO_RESUME_BOOT_STEP_MS = 10_000;

/** 목록·주의 통로에는 시각이 있거나 포기한 예약만 싣는다. */
function autoResumeField(plan: AutoResumePlan | undefined): { autoResume?: AutoResumePlan } {
  return plan && (plan.at !== undefined || plan.gaveUp) ? { autoResume: plan } : {};
}

/** 목록·방·주의 통로에 싣는 넘기기 연결 정보. 살아 있는 세션과 디스크 메타가 같은 이름을 쓴다. */
function handoffField(m: Pick<SessionMeta, "handoffFrom" | "handoffTo" | "handoffDraft" | "handoffJob">): HandoffFields {
  return {
    ...(m.handoffFrom ? { handoffFrom: m.handoffFrom } : {}),
    ...(m.handoffTo ? { handoffTo: m.handoffTo } : {}),
    ...(m.handoffJob ? { handoffState: m.handoffJob.state } : {}),
    ...(m.handoffDraft ? { handoffDraftPending: true as const } : {}),
  };
}

/** 넘기기를 시작하지 못한 이유. 라우트가 상태 코드로 바꾼다. */
export class HandoffError extends Error {
  constructor(readonly code: "archived" | "busy" | "already" | "push", message?: string) {
    super(message ?? code);
  }
}

/** git을 부르지 않는다. 반영 상태(needsApply·applyBlocked)는 listWithCopyState가 채운다. */
function copyListFields(workspaceSource: string | undefined): Pick<SessionListItem, "isolated" | "workspaceSource"> {
  if (!workspaceSource) return { isolated: false };
  return { isolated: true, workspaceSource };
}

function optionalName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().slice(0, NAME_MAX);
  return trimmed || undefined;
}

function adoptGeneratedName(id: string, meta: SessionMeta): SessionMeta {
  if (meta.name?.trim() || meta.generatedName?.trim()) return meta;
  const text = store.firstUserMessageText(id);
  const generatedName = text ? deriveWorkTitle(text) ?? undefined : undefined;
  if (!generatedName) return meta;
  const next = { ...meta, generatedName };
  try {
    store.saveMeta(next);
  } catch (e) {
    void reportError(e, { component: "session", operation: "session.name.generate_save", session_id: id }); console.error("[aether] 자동 제목 영속 실패:", e);
  }
  return next;
}

/** slept: 쉬는 시간이 지나 실행기만 내린 세션. 재시작으로 끊긴 것이 아니므로 깨울 때 "재시작 뒤 이어서" 안내를 남기지 않는다. */
type DiskEntry = { resumeError?: unknown; meta: Partial<SessionMeta> & { id: string }; status: DerivedStatus; lastActivityAt?: number; slept?: true };

/** 잠재우기 직전에 명령 목록을 받아 두는 상한(ms). */
const SLEEP_COMMANDS_TIMEOUT_MS = 3000;
/** 잠든 세션의 자식 프로세스가 내려가길 기다리는 상한(ms). 넘기면 겹침을 감수하고 깨운다. */
const SLEEP_SETTLE_TIMEOUT_MS = 10_000;

/**
 * provider가 "그런 모델 이름은 없다"고 답했다 (`createChecked`).
 *
 * 별도 클래스인 이유: 이 실패만 provider 원문을 사용자에게 그대로 보여줘야 한다. 오타를 고치려면
 * 어떤 이름이 거부됐는지 알아야 하기 때문이다. 반대로 작업 폴더 검증 실패 같은 다른 실패는 지금까지처럼
 * 일반 문구로 답해야 해서, 둘을 한 덩어리로 묶으면 안 된다.
 */
export class ModelRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRejectedError";
  }
}

// 세션 id는 Aether가 randomUUID로 발급 — provider와 무관한 우리 형식이라 여기서 검증한다.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SessionManager {
  private sessions = new Map<string, LiveSession>();
  private disk = new Map<string, DiskEntry>(); // 재시작 후 메타만 로드(lazy resume — message 시 live화)
  /** 세션이 live가 된 직후. 채널을 모른다 — 조립부가 알림 판정부를 붙일 때 쓴다. */
  private onLive: ((session: LiveSession) => void) | undefined;
  private readonly onTitleChange = (live: LiveSession) => {
    if (this.sessions.get(live.id) === live) this.emitPresence(this.toPresenceFromLive(live));
  };
  /** 되돌리기가 진행 중인 세션. 실행기가 끝난 뒤에도 끝날 때까지 이 세션의 입력을 막는다. */
  private rewindsInFlight = new Set<string>();
  private presenceSubs = new Set<(update: PresenceSession) => void>();
  private lastPresence = new Map<string, string>();
  private bgHoldTimers = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private attnHoldTimers = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private autoResumeTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  /** 자동 재개가 멈췄을 때 사람을 부르는 출구. 조립부가 넘긴다. */
  private notifyOut: ((intent: NotifyIntent) => void) | undefined;
  /** 인계서를 쓰는 턴을 지켜보는 구독의 해제 함수. 세션마다 하나다. */
  private handoffWatch = new Map<string, () => void>();
  /** 글 없이 실패한 턴 뒤 한도 알림이 늦게 오는지 기다리는 시간(ms). 시험에서 줄인다. */
  handoffLimitGraceMs = 2000;
  private viewers = new Map<string, number>();
  /** 방금 잠든 세션의 실행기가 내려가기를 기다리는 약속. 같은 세션을 다시 띄우기 전에 기다려 프로세스가 둘 뜨지 않게 한다. */
  private sleepSettling = new Map<string, Promise<void>>();
  private sweeping = false;

  setNotifyOut(fn: ((intent: NotifyIntent) => void) | undefined): void {
    this.notifyOut = fn;
  }

  setOnLive(fn: ((session: LiveSession) => void) | undefined): void {
    this.onLive = fn;
  }

  create(opts: { cwd?: string; provider: string; model?: string; resume?: string; permissionMode?: PermissionMode; isolateWorkspace?: boolean; name?: string; effort?: SessionEffort; isolation?: Isolation }): LiveSession {
    // 입력 정규화(단일 chokepoint): 빈문자열/비문자열 model·resume·cwd가 runtime options로 새지 않게.
    // (빈 model이 ?? 폴백을 우회하던 결함 + 비문자열 무검증 통과 차단.)
    const cwd = resolveWorkFolder(typeof opts.cwd === "string" ? opts.cwd : undefined); // 작업 폴더 검증(공용 — fs/list와 동일 의미론)
    // provider는 필수다 — 기본값이 없다. 비었으면 거부하고, 미등록 이름은 providerEntry가 명시 거부한다(§0.1-4).
    const wantedProvider = typeof opts.provider === "string" ? opts.provider.trim() : "";
    if (!wantedProvider) throw new Error(st("notice.session.providerRequired"));
    const entry = providerEntry(wantedProvider);
    const provider = entry.id;
    // 기본 모델은 provider별로 따로 읽는다 — 모델 이름 어휘가 provider마다 달라서, 하나를 공유하면
    //   Claude 이름이 설정된 서버에서 Codex 세션이 없는 이름으로 시작한다.
    const model = typeof opts.model === "string" && opts.model.trim() ? opts.model : entry.defaultModel;
    const resume = typeof opts.resume === "string" && opts.resume.trim() ? opts.resume.trim() : undefined;
    // 클라가 임의 문자열을 이어가기 식별자로 주입하지 못하게 형식 검증 — 형식은 provider마다 다르므로
    //   코어가 아니라 provider가 판정한다(D12: 코어는 이 문자열의 의미를 모른다).
    if (resume && !entry.isValidResumeKey(resume)) throw new Error(st("notice.session.resumeInvalid"));
    // 정해진 네 값만 받는다. 미지정이면 어댑터가 새 세션의 시작 모드를 정한다.
    const permissionMode = PERMISSION_MODES.find((m) => m === opts.permissionMode);
    const isolateWorkspace = opts.isolateWorkspace === true;
    const id = randomUUID();
    let workCwd = cwd;
    let workspaceSource: string | undefined;
    if (isolateWorkspace) {
      const iso = prepareIsolatedWorkspace(cwd, id, optionalName(opts.name));
      workCwd = iso.cwd;
      workspaceSource = iso.workspaceSource;
    }
    const session = new LiveSession({ id, cwd: workCwd, name: optionalName(opts.name), provider, model, resume, permissionMode, workspaceSource, effort: opts.effort, isolation: opts.isolation, eventLog: adoptEventLog(id), onTitleChange: this.onTitleChange });
    this.sessions.set(session.id, session);
    this.disk.delete(session.id);
    this.onLive?.(session);
    return session;
  }

  /** 이 세션의 사건 기록기. 없으면 만들고, 닫힌 뒤면 거절한다. */
  eventLogFor(id: string): SessionEventLog {
    return openEventLog(id);
  }

  /** 잠든 세션에 사건을 쓴다. 실행기는 띄우지 않는다. */
  appendDetached(id: string, body: AetherEventBody): AetherEvent {
    const ev = openEventLog(id).write(body, (ev) => ev);
    if (!ev) throw new Error("세션 사건 기록기를 닫았다");
    return ev;
  }

  /** 잠든 세션에 저장이 먼저인 사건을 쓴다. 실행기는 띄우지 않는다. */
  appendDetachedDurable(id: string, body: AetherEventBody): Promise<AetherEvent> {
    return openEventLog(id).writeDurable(body, (ev) => ev);
  }

  /**
   * 모델 이름을 **확인하면서** 세션을 만든다. 성공하면 그 이름이 실제로 있는 이름이었다는 뜻이다.
   *
   * 왜 이렇게 도나:
   *   ① 모델 이름을 주고 띄우면 CLI가 그 이름을 자기 모델 목록에 그대로 넣어버린다(실측). 그래서
   *      "띄운 다음 목록에 있나 보기"로는 잘못된 이름을 절대 못 잡는다 — 자기가 넣은 값을 자기가 확인하는 꼴이다.
   *   ② 모델 없이 띄운 뒤 `setModel`로 바꾸면 없는 이름만 정확히 거부된다(실측 1~3ms). 그래서 이 순서다.
   *   ③ 첫 턴을 보내기 전에 부른 `setModel`은 첫 턴부터 적용된다(실측) — 뒤늦게 바꿔서 생기는 손실이 없다.
   *
   * 실패하면 만들던 세션을 지우고 원인을 그대로 던진다. 안 지우면 화면에 안 보이는 유령 세션과
   * 주인 없는 모델 프로세스가 요청마다 쌓인다.
   *
   * resume(잠든 세션 복원)은 이 경로를 쓰지 않는다 — 저장된 모델은 저장될 때 이미 확인됐다.
   */
  async createChecked(opts: { cwd?: string; provider: string; resume?: string; permissionMode?: PermissionMode; isolateWorkspace?: boolean; name?: string; isolation?: Isolation }, model: string): Promise<LiveSession> {
    // ★ 구성 시 model을 넘기지 않는다(위 ①). create가 config.claudeDefaultModel을 채울 수는 있는데,
    //   그건 운영자가 설정한 값이라 확인 대상이 아니고 아래 setModel이 곧바로 덮어쓴다.
    const session = this.create({ ...opts, model: undefined });
    // 상한은 두 걸음 전체에 하나로 건다. 첫걸음만 재면, 통과한 뒤 두 번째 명령에 응답이 안 오는 상태에서
    //   HTTP 요청이 영원히 매달리고 화면은 "만드는 중"에 갇힌다(첫걸음에 상한을 둔 이유가 그대로 적용된다).
    const deadline = Date.now() + config.sessionReadyTimeoutMs;
    try {
      await session.waitHandshake(config.sessionReadyTimeoutMs);
      await session.setModelWithin(model, Math.max(1, deadline - Date.now()));
    } catch (err) {
      try {
        this.delete(session.id);
      } catch (cleanupErr) {
        void reportError(cleanupErr, { component: "session", operation: "session.create.cleanup", session_id: session.id }); console.error("[aether] 생성 실패 뒤 복사본 정리 실패:", cleanupErr);
      }
      // 준비/응답 지연은 호출부가 모델 오류와 갈라서 답해야 하므로 종류를 보존한다.
      if (err instanceof SessionReadyTimeoutError) throw err;
      throw new ModelRejectedError(String((err as Error)?.message ?? err));
    }
    return session;
  }

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id);
  }

  /** 복사본 반영·폐기에 쓸 경로. 잠든 작업도 디스크 메타만으로 고른다 — 실행기를 깨우지 않는다. */
  workspaceTarget(id: string): { cwd: string; workspaceSource: string } | null {
    const live = this.sessions.get(id);
    if (live?.workspaceSource) return { cwd: live.cwd, workspaceSource: live.workspaceSource };
    const disk = this.disk.get(id);
    const source = disk?.meta.workspaceSource?.trim();
    const cwd = disk?.meta.cwd?.trim();
    if (source && cwd) return { cwd, workspaceSource: source };
    return null;
  }

  applyWorkspace(id: string): void {
    const target = this.workspaceTarget(id);
    if (!target) throw new Error(st("notice.workspace.missing"));
    applyIsolatedWorkspace(target.cwd, target.workspaceSource);
  }

  discardWorkspace(id: string, force = false): void {
    const target = this.workspaceTarget(id);
    if (!target) throw new Error(st("notice.workspace.missing"));
    discardIsolatedWorkspace(target.cwd, target.workspaceSource, { force });
  }

  /** 재시작 후 디스크에서 복원된(아직 live 아닌) 세션인가 — stream read-only replay 판정용(H2). */
  hasDiskSession(id: string): boolean {
    return this.disk.has(id);
  }

  /** 외부 클라이언트가 API로 만든 격리(isolation) 세션인가. Aether 화면·알림·검색에서 숨기는 기준 — API 자체는 그대로 쓴다. */
  isExternal(id: string): boolean {
    const live = this.sessions.get(id);
    if (live) return !!live.isolation;
    const e = this.disk.get(id);
    return !!e && !!restoreIsolation(e.meta.isolation);
  }

  /**
   * 이 세션의 이벤트를 해석할 codec(D2.6) — SSE 봉투·페이징처럼 세션 밖에서 이벤트를 읽는 경로가 쓴다.
   * live면 그 세션이 들고 있는 것, 잠든 디스크 세션이면 meta의 provider로 고른다(값 없는 옛 세션은 storedProviderId가 해석).
   * provider는 세션 lifecycle 동안 고정이므로(§0.1-2) 도중에 바뀌지 않는다 — 연결 시작 시 1회 조회로 충분.
   * 미등록 provider면 throw(조용한 오독 금지 §0.1-4).
   */
  codecOf(id: string): ProviderEventCodec {
    const live = this.sessions.get(id);
    return live ? live.codec : codecFor(storedProviderId(this.disk.get(id)?.meta.provider));
  }

  /**
   * 이 세션의 provider 이름 — live면 그 세션 것, 잠든 디스크 세션이면 meta 영속본(없으면 undefined).
   * effort 검증처럼 "세션을 깨우지 않고 그 세션 규칙을 알아야 하는" 경로가 쓴다(D12).
   */
  providerOf(id: string): ProviderId | undefined {
    return this.sessions.get(id)?.provider ?? this.disk.get(id)?.meta.provider;
  }

  /**
   * 디스크(아직 live 아닌) 세션의 model/effort 메타 갱신 — 다음 resume 시 적용(claude spawn 없이).
   * live 세션은 LiveSession.setModel/setEffort(SDK 컨트롤)로 처리하므로 이건 디스크 세션 전용.
   * 손상/불완전 메타(corrupted·cwd 없음)엔 쓰지 않는다 → false.
   */
  updateDiskMeta(id: string, patch: Partial<Pick<SessionMeta, "model" | "effort" | "permissionMode" | "name" | "generatedName" | "archivedAt" | "autoResume" | "handoffFrom" | "handoffTo" | "handoffDraft" | "handoffJob">>): boolean {
    const entry = this.disk.get(id);
    if (!entry || entry.status === "corrupted" || !entry.meta.cwd) return false;
    const meta = { ...entry.meta, ...patch } as SessionMeta;
    // 잠든 세션은 모델 목록이 없다. 모델을 바꾸면 이전 응답에서 본 값과 그 표시 이름을 지운다.
    if ("model" in patch && patch.model !== entry.meta.model) {
      delete meta.observedModel;
      delete meta.modelLabel;
    }
    if ("model" in patch || "effort" in patch) delete meta.observedEffort;
    store.saveMeta(meta);
    entry.meta = meta;
    return true;
  }

  /** 잠든 세션의 권한 모드와 마지막으로 받은 목록. 목록을 받은 적 없으면 가장 좁은 둘(수동·권한 무시)만 준다. 없거나 손상이면 undefined. */
  diskPermissionModes(id: string): { modes: PermissionMode[]; current: PermissionMode } | undefined {
    const entry = this.disk.get(id);
    if (!entry || entry.status === "corrupted" || !entry.meta.cwd) return undefined;
    return { modes: entry.meta.permissionModes ?? ["manual", "full"], current: entry.meta.permissionMode ?? "manual" };
  }

  /**
   * 세션 표시 이름 변경(rename). live면 LiveSession.setName(메모리+meta), 잠든 디스크 세션이면 updateDiskMeta.
   * name이 빈값/공백이면 undefined로 저장 → list()에서 generatedName 또는 빈 문자열. 미존재/손상이면 false.
   */
  setName(id: string, name: string): boolean {
    const trimmed = name.trim() || undefined;
    const live = this.sessions.get(id);
    if (live) {
      live.setName(trimmed);
      return true;
    }
    return this.updateDiskMeta(id, { name: trimmed });
  }

  /**
   * 세션 보관·해제. 삭제가 아니다 — 대화·폴더는 그대로이고 meta의 archivedAt만 바뀐다.
   * 반환: "notFound" | "busy"(일하는 중·요구 행동 대기·뒤 작업 중이라 보관 불가) | { archivedAt }(해제면 undefined).
   * 이미 보관된 세션을 다시 보관하거나 이미 풀린 세션을 해제하면 아무것도 바꾸지 않는다(멱등).
   */
  setArchived(id: string, archived: boolean): "notFound" | "busy" | { archivedAt?: number } {
    const live = this.sessions.get(id);
    const entry = live ? undefined : this.disk.get(id);
    if (!live && (!entry || entry.status === "corrupted" || !entry.meta.cwd)) return "notFound";
    const cur = live ? live.archivedAt : entry!.meta.archivedAt;
    if (!!cur === archived) return { archivedAt: cur };
    if (archived) {
      // 보관 전이라 attention이 덮어써지지 않은 실제 값이다.
      //   hold(한도 막힘·끊긴 요청)는 보관을 막지 않는다 — 실제 열린 카드·진행 중 턴만 본다. 끝 시각 없는 hold는 새 턴까지 안 풀린다.
      const att = (live ? this.attentionFieldsForLive(live, false) : this.attentionFieldsForDisk(entry!, false)).attention;
      if (att === "running" || att === "waiting" || att === "background") return "busy";
      if (live?.hasPendingInput) return "busy"; // 대기열에 입력이 남은 채 표시만 꺼진 틈
    }
    const next = archived ? Date.now() : undefined;
    if (archived) this.cancelAutoResume(id); // 보관하면 예약을 지운다. 풀어도 되살리지 않는다
    if (live) {
      live.setArchived(next);
      this.emitPresence(this.toPresenceFromLive(live));
      // 보관한 세션은 쉬는 시간 설정과 상관없이 실행기를 바로 내린다. 목록을 새로 받는 대기가 있어 라우트는 기다리지 않는다.
      if (archived) {
        void this.sleepIfIdle(live, Date.now(), 0).catch((e) => {
          void reportError(e, { component: "session", operation: "session.archive.sleep", session_id: id });
        });
      }
    } else {
      this.updateDiskMeta(id, { archivedAt: next });
      this.emitPresence(this.toPresenceFromDisk(id, entry!));
    }
    return { archivedAt: next };
  }

  /** 보관된 세션인가. 알림·대화 재개 차단이 쓴다. */
  isArchived(id: string): boolean {
    return !!(this.sessions.get(id)?.archivedAt ?? this.disk.get(id)?.meta.archivedAt);
  }

  /**
   * 디스크 세션 메타만 로드(lazy — eager resume 금지: 다수 claude 동시 spawn 자원폭발 회피).
   * live 세션은 skip(우선), 손상 meta는 corrupted로 격리(per-id try/catch — 한 세션 손상이 전체 부팅 실패 X).
   * 반환=복원된 디스크 세션 수.
   */
  restoreFromDisk(): number {
    let n = 0;
    store.purgeTrash(); // 이전 삭제의 .trash-* 잔재 청소(부활 방지 — listSessionIds가 dot-dir 제외하므로 보조)
    let ids: string[] = [];
    try {
      ids = store.listSessionIds();
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.ids.load" }); console.error("[aether] listSessionIds 실패(복원 건너뜀):", e);
      return 0;
    }
    for (const id of ids) {
      store.tightenSessionPerms(id); // 기존 0644 영속물을 0600/0700로 교정(같은 맥 타유저 차단 — 부팅 1회 스윕)
      if (this.sessions.has(id)) continue; // live 우선
      let meta: SessionMeta | null = null;
      try {
        meta = store.loadMeta(id, true);
        if (!meta || !meta.cwd) {
          // 폴더가 없어도 이름 등 남은 정보는 목록에 둔다. id만 남기면 화면이 세션 코드를 제목으로 보여 준다.
          this.disk.set(id, { meta: meta ?? { id }, status: "corrupted" });
          continue;
        }
        // 복구 불가능한 유령 세션 스킵 — 생성만 하고 메시지를 한 번도 안 보낸 세션(events 0개 + 이어가기 식별자 없음).
        //   이어갈 대화도, replay할 이벤트도 없어 재시작마다 'ended'로 목록에 부활해 어지럽힌다(사용자 관측 버그).
        //   dir은 지우지 않고(자동삭제 리스크 회피) 복원 목록에서만 제외 → 재시작해도 다시 안 뜸.
        if (!meta.resumeKey && store.lastSeqFromDisk(id) === 0) {
          continue;
        }
        // cwd 존재·보호 폴더 재검증을 restore 시점에(getOrResume과 대칭). 삭제·보호 폴더 cwd 세션을
        // 'ended'로 위장하지 않고 즉시 corrupted 격리 → list()와 use 시점 일관(진단 지연 제거). meta는 보존(displayName 표시).
        // 분리된 작업 폴더는 원 폴더 밖에 있을 수 있다. 원 폴더만 작업 폴더 규칙으로 보고, 분리 폴더가 없으면
        // 원 폴더에 붙이지 않고 손상으로 남긴다.
        try {
          if (meta.workspaceSource) {
            resolveWorkFolder(meta.workspaceSource);
            if (!fs.existsSync(meta.cwd) || !fs.statSync(meta.cwd).isDirectory()) throw classifyError(new Error("isolated missing"), "user_action");
          } else {
            resolveWorkFolder(meta.cwd);
          }
        } catch (resumeError) {
          void reportError(resumeError, { component: "session", operation: "session.cwd.restore", session_id: id });
          this.disk.set(id, { meta, status: "corrupted", resumeError });
          continue;
        }
        // codec은 meta의 provider로 고른다(D2.6) — 세션 인스턴스가 없는 복원 경로라 이 방법뿐이다.
        //   등록되지 않은 provider면 providerEntry가 throw → 아래 catch가 corrupted로 격리(조용한 오독 방지).
        const codec = providerEntry(storedProviderId(meta.provider)).codec;
        const info = store.tailInfo(id, codec);
        // 미완 턴(백엔드 재시작/크래시로 종료 이벤트 없이 끊김) → 합성 status:interrupted를 1회 영속.
        //   재연결 클라가 이 status를 받아 'running' 고착을 자동 해제한다(프론트 ingest가 kind:"status"면 pendingSend 해제).
        //   멱등: 영속 후 꼬리가 status가 되어 다음 부팅엔 turnOpen=false → 중복 발행 없음.
        if (info.turnOpen) {
          try {
            store.appendEvent(id, { seq: info.lastSeq + 1, ts: Date.now(), kind: "status", status: "interrupted" });
          } catch (e) {
            void reportError(e, { component: "session", operation: "session.interrupted.save", session_id: id, session_seq: info.lastSeq + 1 }); console.error("[aether] 미완 턴 interrupted 영속 실패:", e);
          }
        }
        // 실행기가 죽은 뒤에 남은 질문·권한·계획 카드. wake 전 디스크 replay에도 닫혀 있어야 한다.
        //   *_resolved를 꼬리에 두면 다음 부팅이 미완 턴으로 오판하므로, 정리한 뒤에는 턴을 다시 닫는다.
        try {
          const events = store.readEventsOfKinds(id, HOLD_EVENT_KINDS);
          let seq = store.lastSeqFromDisk(id);
          const ts = Date.now();
          const orphans = orphanHoldResolves(events);
          // 끊긴 요청은 화면에서 '중단된 요청'으로 남긴다. 닫기 전 기록에서 미리보기와 처음 뜬 시각을 읽는다.
          const interrupted = orphanHoldWaiting(events);
          if (orphans.length && interrupted) {
            meta = { ...meta, attentionHold: { kind: "interrupted_request", preview: interrupted.preview, since: interrupted.since } };
            store.saveMeta(meta);
          }
          for (const body of orphans) {
            seq += 1;
            store.appendEvent(id, { seq, ts, ...body });
          }
          if (orphans.length) {
            const close = info.turnOpen ? "interrupted" : info.lastStatus === "crashed" ? "crashed" : "completed";
            seq += 1;
            store.appendEvent(id, { seq, ts, kind: "status", status: close });
          }
        } catch (e) {
          void reportError(e, { component: "session", operation: "session.pending_cards.clear", session_id: id }); console.error("[aether] 미해결 카드 정리 실패:", e);
        }
        // 재부팅 후 디스크 세션은 live가 아니므로 active 위장 금지.
        //   turnOpen=true(미완 턴)면 위에서 interrupted 합성 → interrupted. crashed면 crashed.
        //   그 외(정상 result/ctx 꼬리로 끝난 idle 세션, lastStatus 없음)는 'ended'(완료 후 idle) — 'interrupted'로 오분류 금지.
        const status: DerivedStatus =
          info.turnOpen ? "interrupted" : info.lastStatus === "crashed" ? "crashed" : "ended";
        const titled = adoptGeneratedName(id, meta);
        const restored = { ...titled, lastInputAt: titled.lastInputAt ?? store.lastUserInputTs(id) ?? titled.createdAt };
        this.disk.set(id, { meta: restored, status, lastActivityAt: titled.lastActivityAt ?? info.lastTs ?? titled.createdAt });
        n++;
      } catch (error) {
        void reportError(error, { component: "session", operation: "session.restore", session_id: id });
        // 일기 읽기가 실패해도 이미 읽은 이름과 폴더는 목록에 남긴다.
        this.disk.set(id, { meta: meta ?? { id }, status: "corrupted", resumeError: error });
      }
    }
    this.restoreAutoResumes();
    this.restoreRestartCuts(takeRestartCut());
    // 인계서를 쓰던 턴은 재시작으로 끊겼다. 한도 대기와 복사 결과만 남긴다.
    for (const [id, e] of this.disk) {
      if (e.meta.handoffJob?.state !== "writing") continue;
      try {
        this.updateDiskMeta(id, { handoffJob: undefined });
      } catch (error) {
        void reportError(error, { component: "session", operation: "session.handoff.restore", session_id: id });
      }
    }
    return n;
  }

  /**
   * 재시작 뒤 자동 재개 예약을 되살린다. 시각이 남은 것은 타이머를 다시 걸고, 이미 지난 것은 부팅 30초 뒤부터
   * 10초 간격으로 미룬다. 보내고 결과를 기다리던 예약은 그 턴이 재시작으로 끊겼으므로 버린다(다시 보내지 않는다).
   */
  private restoreAutoResumes() {
    const now = Date.now();
    let order = 0;
    for (const [id, e] of [...this.disk]) {
      const plan = e.meta.autoResume;
      if (!plan) continue;
      try {
        if (e.meta.archivedAt || (plan.at === undefined && !plan.gaveUp)) {
          this.writeAutoResume(id, undefined);
          continue;
        }
        if (plan.at === undefined) continue; // gaveUp: 표시용으로 남긴다
        const earliest = now + AUTO_RESUME_BOOT_DELAY_MS + AUTO_RESUME_BOOT_STEP_MS * order;
        if (plan.at < earliest) {
          order += 1;
          this.writeAutoResume(id, { ...plan, at: earliest });
        } else this.armAutoResume(id);
      } catch (error) {
        // 세션 하나의 저장 실패가 일기 복원 전체를 막지 않는다. 그 세션은 예약을 다시 걸지 않고 넘어간다.
        void reportError(error, { component: "session", operation: "session.auto_resume.restore", session_id: id });
      }
    }
  }

  /** 종료 직전에 턴이 열린 세션 id를 남긴다. 정상 종료는 턴 종료가 기록돼 부팅 때 끊긴 줄 알 수 없기 때문이다. */
  noteRestartCut() {
    try {
      writeRestartCut(this.all().filter((s) => s.isTurnOpen).map((s) => s.id));
    } catch (error) {
      void reportError(error, { component: "session", operation: "session.restart_cut.note" });
    }
  }

  /** 재시작으로 끊긴 세션에 "사람이 누르면 이어 간다"는 예약을 둔다. 저절로 보내지 않는다(gaveUp). */
  private restoreRestartCuts(marked: Set<string>) {
    for (const [id, e] of [...this.disk]) {
      if (e.status === "corrupted" || e.meta.archivedAt || e.meta.autoResume || e.meta.handoffJob?.state === "writing") continue;
      if (e.status !== "interrupted" && !marked.has(id)) continue;
      try {
        this.writeAutoResume(id, { action: { type: "send", text: st("autoResume.restartText") }, attempts: 0, gaveUp: true, restartCutAt: e.lastActivityAt ?? Date.now() });
      } catch (error) {
        void reportError(error, { component: "session", operation: "session.restart_cut.restore", session_id: id });
      }
    }
  }

  /** 재시작으로 끊긴 예약이면 그 표시를 주의 상태로 바꾼다. 승인 카드 보류(attentionHold)가 있으면 그쪽이 먼저다. */
  private restartHold(plan: AutoResumePlan | undefined): SessionMeta["attentionHold"] {
    return plan?.restartCutAt ? { kind: "interrupted_request", preview: st("autoResume.restartCut"), since: plan.restartCutAt } : undefined;
  }

  /**
   * live면 그대로, 아니면 디스크 메타로 resume하여 live화(message 진입점에서 호출).
   * ⚠️ 불변식: 이 메서드는 *완전 동기*여야 한다(내부 await 금지). 그래야 동시 두 message 요청이
   *   get-miss와 sessions.set 사이에 인터리브하지 못해 같은 id 더블-spawn(자원폭발)이 안 난다.
   */
  getOrResume(id: string): LiveSession {
    // 실행기가 끝난 뒤 되돌리기가 끝나기 전에 새 객체를 만들면 옛 숨김 범위와 키로 시작해 메타를 덮는다.
    if (this.rewindsInFlight.has(id)) throw new RewindError("busy");
    if (!store.diaryAcceptsInput(id)) throw classifyError(new Error(st("routes.sessions.diaryBusy")), "user_action");
    const live = this.sessions.get(id);
    if (live && !live.isEnded) return live;
    if (live && live.isEnded) {
      // 종료(완료/크래시)된 live 세션에 새 입력 → 죽은 query 큐에 좀비로 쌓이지 않게 resume 키로 재생성.
      const rewound = sessionWasRewound(live);
      if (!live.resumeKey && !rewound) throw new Error(st("notice.session.corruptedNoContext"));
      if (live.workspaceSource && (!fs.existsSync(live.cwd) || !fs.statSync(live.cwd).isDirectory())) {
        throw classifyError(new Error(st("notice.session.isolatedWorkspaceMissing")), "user_action");
      }
      const session = new LiveSession({
        onTitleChange: this.onTitleChange,
        id,
        cwd: live.cwd, // 이미 검증된 real 경로
        name: live.name, // rename 표시 이름 유지(재생성 후에도 동일) — metaSnapshot drift 방지
        archivedAt: live.archivedAt, // 보관 상태 유지 — metaSnapshot drift 방지
        generatedName: live.generatedName,
        provider: live.provider, // 세션 lifecycle 동안 provider 고정(§0.1-2) — 재생성에서도 같은 provider
        model: live.model,
        accountDefaultModel: live.accountDefaultModel,
        observedModel: live.observedModel,
        observedEffort: live.observedEffort,
        modelLabel: live.modelLabel,
        // 되돌릴 때 이 칸을 비운다. 남아 있는 값은 그 뒤에 새 프로세스가 발급한 키다.
        resume: live.resumeKey,
        hiddenRanges: live.hiddenRanges,
        reseedText: live.reseedText,
        rewound,
        createdAt: live.createdAt, // 원본 생성시각 보존
        permissionMode: live.permissionMode, // 권한 모드 유지(재생성 후에도 동일 정책)
        permissionModes: live.permissionModes,
        effort: live.effort, // /effort 설정 유지(재생성 후에도 동일)
        lastActivityAt: live.lastActivityAt, // 깨우기만 한 이벤트를 제외한 마지막 실제 활동시각 유지
        lastInputAt: live.lastInputAt,
        workspaceSource: live.workspaceSource,
        isolation: live.isolation,
        lastViewedAt: live.lastViewedAt,
        reviewedSeq: live.reviewedSeq,
        attentionSticky: live.attentionSticky,
        commandCatalog: live.commandCatalog,
        eventLog: adoptEventLog(id),
      });
      this.sessions.set(id, session); // 종료 세션 교체
      this.onLive?.(session);
      this.armAttentionHold(session); // 복원된 hold의 끝 시각 타이머
      this.rearmHandoffAsk(session);
      if (!rewound) session.noticeResumed(st("notice.session.resumedAfterEnd"));
      return session;
    }
    const entry = this.disk.get(id);
    if (!entry) throw classifyError(new Error(st("notice.session.notFound")), "user_action");
    if (entry.status === "corrupted" || !entry.meta.cwd) {
      const error = new Error(st("notice.session.corruptedCannotOpen"), { cause: entry.resumeError });
      throw isExpectedError(entry.resumeError) ? classifyError(error, "user_action") : error;
    }
    // provider 재확인 — meta에 값이 없으면 storedProviderId가 옛 세션 값으로 해석하고, 등록되지 않은 값이면 여기서 명시 거부한다.
    //   다른 provider로 조용히 넘겨 실행하면 사용자가 모르는 모델이 그 세션을 이어받는다(§0.1-4 위반).
    const providerImpl = providerEntry(storedProviderId(entry.meta.provider));
    const provider = providerImpl.id;
    // resume 경로도 cwd를 재검증(create와 대칭) — meta 변조·cwd 삭제·보호 폴더 지정 차단.
    // 분리된 작업 폴더는 원 폴더 아래에 있지 않을 수 있다. 원 폴더만 작업 폴더 규칙으로 확인하고,
    // 분리된 폴더가 없으면 원 폴더에 조용히 붙이지 않는다(D10).
    const workspaceSource = typeof entry.meta.workspaceSource === "string" && entry.meta.workspaceSource.trim()
      ? entry.meta.workspaceSource
      : undefined;
    let cwd: string;
    if (workspaceSource) {
      try {
        resolveWorkFolder(workspaceSource);
      } catch (cause) {
        const error = new Error(st("notice.session.corruptedCwdMissing"), { cause });
        throw isExpectedError(cause) ? classifyError(error, "user_action") : error;
      }
      if (!entry.meta.cwd || !fs.existsSync(entry.meta.cwd) || !fs.statSync(entry.meta.cwd).isDirectory()) {
        throw classifyError(new Error(st("notice.session.isolatedWorkspaceMissing")), "user_action");
      }
      cwd = fs.realpathSync(entry.meta.cwd);
    } else {
      try {
        cwd = resolveWorkFolder(entry.meta.cwd);
      } catch (cause) {
        const error = new Error(st("notice.session.corruptedCwdMissing"), { cause });
        throw isExpectedError(cause) ? classifyError(error, "user_action") : error;
      }
    }
    const rewound = sessionWasRewound(entry.meta);
    const session = new LiveSession({
      onTitleChange: this.onTitleChange,
      id, // 사건 순번 연속
      cwd, // 재검증된 real 경로(심볼릭 탈출 차단)
      name: entry.meta.name, // rename 표시 이름 복원(meta 영속본) — metaSnapshot drift 방지
      archivedAt: entry.meta.archivedAt, // 보관 상태 복원(meta 영속본) — metaSnapshot drift 방지
      generatedName: entry.meta.generatedName,
      provider, // meta 영속본(부재 시 claude)
      model: entry.meta.model ?? providerImpl.defaultModel,
      accountDefaultModel: entry.meta.accountDefaultModel,
      observedModel: entry.meta.observedModel,
      observedEffort: entry.meta.observedEffort,
      modelLabel: entry.meta.modelLabel,
      // 되돌릴 때 이 칸을 비운다. 남아 있는 값은 그 뒤에 새 프로세스가 발급한 키다.
      resume: entry.meta.resumeKey,
      hiddenRanges: entry.meta.hiddenRanges,
      reseedText: entry.meta.reseedText,
      rewound,
      createdAt: entry.meta.createdAt, // 원본 생성시각 보존(resume 시각 덮어쓰기 방지)
      permissionMode: entry.meta.permissionMode ?? "manual", // 저장된 모드를 resume 후에도 유지. 없으면 가장 좁은 쪽
      permissionModes: entry.meta.permissionModes,
      effort: entry.meta.effort, // /effort 설정 복원(meta 영속본)
      lastActivityAt: entry.meta.lastActivityAt, // 디스크 꼬리의 깨우기 훅보다 영속된 실제 활동시각 우선
      lastInputAt: entry.meta.lastInputAt,
      workspaceSource,
      isolation: restoreIsolation(entry.meta.isolation),
      lastViewedAt: entry.meta.lastViewedAt,
      reviewedSeq: entry.meta.reviewedSeq,
      attentionSticky: entry.meta.attentionSticky,
      commandCatalog: entry.meta.commandCatalog,
      eventLog: adoptEventLog(id),
    });
    this.sessions.set(id, session);
    this.disk.delete(id);
    this.onLive?.(session);
    this.armAttentionHold(session);
    this.rearmHandoffAsk(session);
    // 깨어난 것을 알린다. 안 알리면 잠듦 → 깨움 → 다시 잠듦에서 두 번째 잠듦 알림이 같은 내용이라 걸러져 탭이 '활성'에 머문다.
    this.emitPresence(this.toPresenceFromLive(session));
    // 진행 중이던 턴은 복원 불가 — 정직 표기. 되돌린 세션은 식별자가 없어도 빈 대화가 아니다.
    if (rewound) return session;
    // 쉬어서 내려간 세션은 끊긴 것이 아니다. 재시작 뒤라는 안내도, 문맥이 없다는 안내도 남기지 않는다.
    if (entry.slept || entry.meta.slept) return session;
    // 직전이 같은 알림이면(깨우고 대화 없이 또 재시작) 같은 줄을 또 쌓지 않는다.
    const tailNotice = store.tailInfo(id, providerImpl.codec).lastNotice;
    if (entry.meta.resumeKey) {
      if (tailNotice !== "resumed") session.noticeResumed(st("notice.session.resumedRestart"));
    } else if (tailNotice !== "no_context") session.noticeNoContext(st("notice.session.noContext"));
    return session;
  }

  /** 화면이 다시 그릴 때 숨길 순번. 살아있는 세션이 있으면 그 값을, 없으면 디스크 메타를 본다. */
  hiddenRangesOf(id: string): HiddenRange[] {
    const live = this.sessions.get(id);
    if (live) return live.hiddenRanges;
    const meta = this.disk.get(id)?.meta ?? store.loadMeta(id);
    return parseHiddenRanges(meta?.hiddenRanges);
  }

  rewindInFlight(id: string): boolean {
    return this.rewindsInFlight.has(id);
  }

  /** 되돌리기 확인창이 보여 줄 파일 목록. */
  rewindPreview(id: string, seq: number): ReturnType<typeof previewRewind> {
    if (!UUID_RE.test(id)) throw new RewindError("missing");
    const meta = store.loadMeta(id);
    if (!meta) throw new RewindError("missing");
    return previewRewind(meta, seq);
  }

  /** 고른 사용자 말부터 대화를 숨기고, restoreFiles면 저장해 둔 파일도 되돌린다. 진행 중이면 거절한다. */
  async rewind(id: string, seq: number, restoreFiles = true): Promise<RewindOutcome> {
    if (!UUID_RE.test(id)) throw new RewindError("missing");
    // 먼저 검사해야 두 번째 요청의 finally가 첫 요청의 표시를 지우지 않는다.
    if (this.rewindsInFlight.has(id)) throw new RewindError("busy");
    this.rewindsInFlight.add(id);
    try {
      return await this.rewindInner(id, seq, restoreFiles);
    } finally {
      this.rewindsInFlight.delete(id);
    }
  }

  private async rewindInner(id: string, seq: number, restoreFiles: boolean): Promise<RewindOutcome> {
    const live = this.sessions.get(id);
    if (live && !live.isDisposed) {
      const out = await live.rewind(seq, restoreFiles);
      await forgetRewoundLetters(id, out);
      if (this.handoffMeta(id)?.handoffJob?.state === "asking") this.dropAskingHandoff(id); // 요청이나 질문 카드가 숨겨졌을 수 있다
      return out;
    }
    const meta = this.disk.get(id)?.meta ?? store.loadMeta(id);
    if (!meta?.cwd) throw new RewindError("missing");
    const codec = providerEntry(storedProviderId(meta.provider)).codec;
    // 디스크 칸은 깨진 세션을 { id }만 담으려고 Partial이다. cwd가 있으면 저장된 메타 전체를 되돌린다.
    const result = rewindDisk(meta as SessionMeta, seq, (event) => codec.normalize(event), restoreFiles);
    await forgetRewoundLetters(id, result);
    const saved = store.loadMeta(id);
    const entry = this.disk.get(id);
    if (entry && saved) entry.meta = saved;
    if (this.handoffMeta(id)?.handoffJob?.state === "asking") this.dropAskingHandoff(id);
    return result;
  }

  /** 전체 live 세션(graceful shutdown 순회용). */
  all(): LiveSession[] {
    return [...this.sessions.values()];
  }

  /**
   * 세션 영구 삭제(되돌릴 수 없음). 라이브면 dispose로 종료 후 디스크 디렉터리까지 제거. 멱등.
   * id는 UUID만 허용 — 비-UUID는 즉시 거부(경로 traversal·실수 차단). 무언가 제거됐으면 true.
   * 삭제는 복사본에 반영하지 않은 변경이 있어도 그 복사본을 버린다. 복사본 폴더를 지우지 못하면
   * 세션 기록은 남기고 던진다. 폴더만 사라지고 목록에서 지워지면 다음 실행에 다시 나타난다.
   */
  delete(id: string, opts?: { purge?: boolean }): boolean {
    if (!UUID_RE.test(id)) return false;
    const target = this.workspaceTarget(id);
    if (target) discardIsolatedWorkspace(target.cwd, target.workspaceSource, { force: true });
    const live = this.sessions.get(id);
    if (live) {
      try {
        live.dispose();
      } catch (e) {
        void reportError(e, { component: "session", operation: "session.dispose.run", session_id: id }); console.error("[aether] 세션 dispose 실패:", e);
      }
      this.sessions.delete(id);
    }
    closeEventLog(id);
    this.viewers.delete(id);
    this.lastPresence.delete(id);
    const holdTimer = this.bgHoldTimers.get(id);
    if (holdTimer) clearTimeout(holdTimer.timer);
    this.bgHoldTimers.delete(id);
    const attnTimer = this.attnHoldTimers.get(id);
    if (attnTimer) clearTimeout(attnTimer.timer);
    this.attnHoldTimers.delete(id);
    const resumeTimer = this.autoResumeTimers.get(id);
    if (resumeTimer) clearTimeout(resumeTimer.timer);
    this.autoResumeTimers.delete(id);
    this.handoffWatch.get(id)?.();
    this.handoffWatch.delete(id);
    const purge = opts?.purge === true;
    // 기록만 남기고 지우려면 원본을 지우기 전에 검색 글자가 원본과 같은지 본다. 모자라면 채우고, 못 채우면 원본을 남긴다.
    const meta = this.disk.get(id)?.meta ?? store.loadMeta(id);
    let keepEvents = false;
    if (!purge) {
      try {
        keepEvents = !ensureLettersBeforeDelete(id, (meta as SessionMeta | undefined) ?? null);
      } catch (e) {
        keepEvents = true;
        void reportError(e, { component: "session", operation: "session.letter.ensure", session_id: id });
      }
      if (keepEvents) console.error(`[aether] 세션 ${id} 검색 글자를 원본과 맞추지 못해 원본 사건을 남긴다.`);
    }
    const hadDisk = this.disk.delete(id);
    const removedDir = store.deleteSession(id);
    // 메모리 맵엔 dir가 있었는데(live이거나 disk엔트리였음) deleteSession이 false면 폴백 rm까지 미완 →
    //   목록엔 이미 사라졌지만 디렉터리가 남아 다음 재시작 때 부활할 위험(2026-06-18 버그). 가시화.
    //   (원자 rename 성공 시엔 removedDir=true라 여기 안 옴 — 부활 불가.)
    if ((!!live || hadDisk) && !removedDir) {
      void reportError(new Error("세션 디스크 제거 미완"), { component: "session", operation: "session.directory.delete", session_id: id });
      console.error(`[aether] 세션 ${id} 디스크 제거 미완(rename·rm 모두 실패) — data/${id} 수동 확인 필요.`);
    }
    // 폴더를 지운 뒤에만 DB 기록을 지운다. 기본은 사건 원본만 지우고 검색 글자는 남겨 과거 검색에 계속 나온다.
    //   완전 삭제(purge)는 실패를 사용자에게 던진다. 다시 요청하면 남은 것이 지워진다.
    try {
      store.purgeSessionRecord(id, purge, !keepEvents);
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.record.purge", session_id: id });
      if (purge) throw new Error(st("routes.sessions.purgeFailed"));
    }
    return !!live || hadDisk || removedDir;
  }

  /** 서버가 아는 세션(살아 있는 것·디스크의 것)이 이 폴더를 cwd나 분리 원본으로 쓰는가. real은 실제 경로. */
  usesFolder(real: string): boolean {
    const hit = (cwd: string | undefined, source: string | undefined) => (!!cwd && samePath(cwd, real)) || (!!source && samePath(source, real));
    for (const s of this.sessions.values()) if (hit(s.cwd, s.workspaceSource)) return true;
    for (const e of this.disk.values()) if (hit(e.meta.cwd, e.meta.workspaceSource)) return true;
    return false;
  }

  /** list()에 복사본의 반영 상태를 더한다. git을 비동기로, 하나씩 돌려 프로세스가 몰리지 않게 한다. */
  async listWithCopyState(): Promise<SessionListItem[]> {
    const states = new Map<string, Awaited<ReturnType<typeof workspaceCopyState>>>();
    for (const row of this.list()) {
      if (row.isolated) states.set(row.id, await workspaceCopyState(row.cwd ?? "", row.workspaceSource!));
    }
    // 조회 중 지운 세션이 남지 않게, 상태를 모은 뒤 목록을 다시 읽어 합친다.
    const rows = this.list();
    for (const row of rows) {
      const state = states.get(row.id);
      if (state) Object.assign(row, state);
    }
    return rows;
  }

  list(): SessionListItem[] {
    // 목록 제목 = 사람이 붙인 이름, 없으면 첫 말에서 뽑은 제목. 폴더 이름은 그룹 헤더가 맡는다.
    const live = [...this.sessions.values()].filter((s) => !s.isolation).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      displayName: resolveWorkTitle(s.name, s.generatedName),
      named: !!s.name?.trim(),
      // 8d-3 ④: 프론트가 "이 세션이 따라야 할 카탈로그"를 고르려면 세션의 provider를 알아야 한다.
      //   지금까지는 등록된 첫 provider를 무조건 썼는데, provider가 둘이 되는 순간 어긋난다.
      provider: s.provider,
      model: s.model ?? "", // 미지정(계정 기본)이면 빈 문자열
      accountDefaultModel: s.accountDefaultModel, // 표시 전용 — 고른 모델과 관측 모델이 없을 때 목록 카드가 쓴다
      observedModel: s.observedModel, // 스트림에서 본 실제 모델. 있으면 목록 카드가 우선한다
      modelLabel: s.modelLabel, // 목록 카드용 표시 이름. 없으면 화면이 직접 번역한다
      effort: s.effort, // /effort 설정(미지정이면 undefined → 칩 미표시)
      observedEffort: s.observedEffort,
      permissionMode: s.permissionMode, // 권한 모드(프론트 칩 표시용)
      status: (s.isEnded ? "ended" : "active") as DerivedStatus,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt, // 마지막 활동시각(사이드바 '마지막 사용')
      lastInputAt: s.lastInputAt,
      ...copyListFields(s.workspaceSource),
      preview: s.lastWorkPreview(),
      archivedAt: s.archivedAt,
      ...autoResumeField(s.autoResume),
      ...handoffField(s),
      ...this.attentionFieldsForLive(s),
    }));
    const disk = [...this.disk.entries()]
      .filter(([id, e]) => !this.sessions.has(id) && !restoreIsolation(e.meta.isolation))
      .map(([id, e]) => ({
        id,
        cwd: e.meta.cwd ?? "",
        displayName: resolveWorkTitle(e.meta.name, e.meta.generatedName),
        named: !!e.meta.name?.trim(),
        provider: storedProviderId(e.meta.provider), // 값 없는 기존 meta는 storedProviderId가 해석(D12)
        model: e.meta.model ?? "",
        accountDefaultModel: e.meta.accountDefaultModel,
        observedModel: e.meta.observedModel,
        modelLabel: e.meta.modelLabel,
        effort: e.meta.effort, // /effort 설정(meta 영속본)
        observedEffort: e.meta.observedEffort,
        permissionMode: e.meta.permissionMode ?? ("manual" as const),
        status: e.status,
        createdAt: e.meta.createdAt ?? 0,
        lastActivityAt: e.lastActivityAt ?? e.meta.createdAt ?? 0, // 디스크 꼬리 활동시각(tailInfo)
        lastInputAt: e.meta.lastInputAt ?? e.meta.createdAt ?? 0,
        ...copyListFields(e.meta.workspaceSource),
        preview: (() => {
          try {
            const preview = lastWorkPreview(store.readRecentEvents(id), this.codecOf(id), id);
            failuresFor(this).clear(`preview:${id}`);
            return preview;
          } catch (error) {
            failuresFor(this).report(error, { component: "session", operation: "session.preview.read", severity: "error", session_id: id }, `preview:${id}`);
            return "";
          }
        })(),
        archivedAt: e.meta.archivedAt,
        ...autoResumeField(e.meta.autoResume),
        ...handoffField(e.meta),
        ...this.attentionFieldsForDisk(e),
      }));
    return [...live, ...disk];
  }

  /** 알림과 같은 구독에서 부른다. 잠든 세션은 live가 아니라 여기서 빠진다. */
  applyAttentionEvent(id: string, ev: AetherEvent, intent?: NotifyIntent, verdict?: AutoResumeVerdict): boolean {
    const live = this.sessions.get(id);
    if (!live) return false;
    // 사람이 보낸 글은 예약을 지운다([지금 보내기]도 여기). Aether가 자동으로 보낸 글은 지우지 않는다.
    if (ev.kind === "user_msg" && !(ev as { sentBy?: string }).sentBy) this.cancelAutoResume(id);
    else if (verdict?.type === "settled") this.cancelAutoResume(id);
    else if (verdict?.type === "blocked") this.onBlockedTurn(live, verdict.until);
    const kind = intent?.kind;
    // 보관된 세션은 완료·실패 표시를 쌓지 않는다(해제 때 뒤늦게 켜지지 않게).
    if (intent && kind && isStickyAttentionKind(kind) && !live.archivedAt) {
      live.setAttentionSticky({ kind, preview: intent.body, at: ev.ts });
      if (this.hasViewer(id)) live.markViewed(ev.ts);
    }
    if (intent && kind === "rate_limit" && !live.archivedAt) {
      live.setAttentionHold({ kind: "rate_limit", preview: intent.body, since: ev.ts, until: intent.until });
    }
    this.emitPresence(this.toPresenceFromLive(live));
    this.armBackgroundHold(live);
    this.armAttentionHold(live);
    // 알림을 줄일지 정하는 데 쓴다: 다음 시도가 걸렸거나, 이 사건으로 막 포기해 포기 알림이 따로 나간다.
    const plan = live.autoResume;
    return plan?.at !== undefined || (verdict?.type === "blocked" && !!plan?.gaveUp);
  }

  // ── 한도가 풀리면 이어 가기 ──

  /** 예약 읽기. 살아 있는 세션이든 잠든 디스크 세션이든 같다. */
  getAutoResume(id: string): AutoResumePlan | undefined {
    const live = this.sessions.get(id);
    return live ? live.autoResume : this.disk.get(id)?.meta.autoResume;
  }

  /** 예약 쓰기 + 타이머·화면 갱신. 없는 세션이면 아무것도 하지 않는다. */
  private writeAutoResume(id: string, plan: AutoResumePlan | undefined) {
    const live = this.sessions.get(id);
    if (live) {
      live.setAutoResume(plan);
      this.armAutoResume(id);
      this.emitPresence(this.toPresenceFromLive(live));
      return;
    }
    const entry = this.disk.get(id);
    if (!entry || !this.updateDiskMeta(id, { autoResume: plan })) return;
    this.armAutoResume(id);
    this.emitPresence(this.toPresenceFromDisk(id, entry));
  }

  /** 막혀서 멈춘 턴이 끝났다. 예약을 만들거나 다음 시도 시각을 정한다. 세 번을 다 썼으면 포기하고 사람을 부른다. */
  private onBlockedTurn(live: LiveSession, until: number | undefined) {
    if (live.archivedAt) return;
    let plan = live.autoResume;
    // 설정이 꺼져 있으면 진행 중 예약도 지우고 더 걸지 않는다(알림 판정과 같은 기준). 사람이 직접 청한 넘기기는 설정과 상관없이 기다린다.
    const settings = readAutoResumeSettings();
    const handoffWaiting = live.handoffJob?.state === "writing" || live.handoffJob?.state === "waiting_limit";
    if (!settings.enabled && !handoffWaiting) {
      this.cancelAutoResume(live.id);
      return;
    }
    // 인계서를 쓰던 턴이 한도에 막혔다. 한도 판정은 이 한 곳이 맡고, 쓰는 중 작업을 대기로 바꾼다.
    const job = live.handoffJob;
    if (job?.state === "writing") this.writeHandoff(live.id, { handoffJob: { ...job, state: "waiting_limit" } });
    if (plan?.gaveUp || plan?.at !== undefined) return;
    if (!plan) {
      plan = { action: handoffWaiting ? { type: "handoff" } : { type: "send", text: settings.text }, attempts: 0 };
    }
    if (plan.attempts >= AUTO_RESUME_MAX_ATTEMPTS) {
      if (plan.action.type === "handoff") {
        this.handoffGiveUp(live.id); // 인계서를 못 받았다. 사람이 손에 쥘 것이 없게 두지 않고 뼈대로 넘긴다
        return;
      }
      this.writeAutoResume(live.id, { ...plan, gaveUp: true });
      this.notifyOut?.(autoResumeStoppedIntent(this.autoResumeNameOf(live.id), "gave_up"));
      return;
    }
    this.writeAutoResume(live.id, { ...plan, at: nextAttemptAt(plan.attempts, until) });
  }

  /** 알림에 쓸 이름. 살아 있는 세션이든 잠든 디스크 세션이든 같은 규칙으로 만든다. */
  private autoResumeNameOf(id: string): { id: string; name: string } {
    const live = this.sessions.get(id);
    const m = live ?? this.disk.get(id)?.meta;
    const name = m ? resolveWorkTitle(m.name, m.generatedName) || path.basename(m.cwd ?? "") : "";
    return { id, name: name || id.slice(0, 8) };
  }

  /** 시각이 됐다. 일하는 중이면 미루고, 아니면 횟수를 올려 저장한 뒤 보낸다(보내다 죽어도 두 번 가지 않게 먼저 저장). */
  async fireAutoResume(id: string): Promise<void> {
    const plan = this.getAutoResume(id);
    if (!plan || plan.at === undefined || this.isArchived(id)) return;
    if (!readAutoResumeSettings().enabled && plan.action.type !== "handoff") {
      this.cancelAutoResume(id);
      return;
    }
    const live = this.sessions.get(id);
    // shortcut: 일하는 중 미루기는 60초 고정이다. 계속 바쁘면 무한히 미룬다. 문제가 보이면 상한을 둔다.
    const busy =
      !store.diaryAcceptsInput(id) ||
      (!!live && (live.isTurnOpen || live.hasPendingInput || live.isRewinding || live.hasBlockingCommand || ["running", "waiting", "background"].includes(this.attentionFieldsForLive(live, false).attention ?? "")));
    if (busy) {
      this.writeAutoResume(id, { ...plan, at: Date.now() + AUTO_RESUME_BUSY_DEFER_MS });
      return;
    }
    this.writeAutoResume(id, { ...plan, attempts: plan.attempts + 1, at: undefined });
    if (plan.action.type === "handoff") {
      try {
        await this.resumeHandoff(id);
      } catch (e) {
        void reportError(e, { component: "session", operation: "session.handoff.resume", session_id: id });
        this.handoffGiveUp(id);
      }
      return;
    }
    try {
      await this.settledSleep(id);
      const target = this.getOrResume(id);
      await target.push(plan.action.text, undefined, undefined, undefined, { sentBy: "aether" });
    } catch (e) {
      const cur = this.getAutoResume(id);
      if (cur) this.writeAutoResume(id, { ...cur, at: undefined, gaveUp: true });
      this.notifyOut?.(autoResumeStoppedIntent(this.autoResumeNameOf(id), "send_failed", String((e as Error)?.message ?? e)));
    }
  }

  /** 사람이 시각이나 문장을 바꾼다. 시각을 주면 횟수를 0으로 되돌리고 포기 표시를 푼다. */
  editAutoResume(id: string, patch: { at?: number; text?: string }): "notFound" | "archived" | AutoResumePlan {
    if (this.isArchived(id)) return "archived";
    const plan = this.getAutoResume(id);
    if (!plan) return "notFound";
    // 인계서 쓰기 예약은 문장이 없다. 시각만 바꿀 수 있다.
    const text = patch.text !== undefined && plan.action.type === "send" ? patch.text.trim().slice(0, AUTO_RESUME_TEXT_MAX) : plan.action.type === "send" ? plan.action.text : "";
    const next: AutoResumePlan = { action: plan.action.type === "handoff" ? plan.action : { type: "send", text }, at: plan.at, attempts: plan.attempts, ...(plan.gaveUp ? { gaveUp: true as const } : {}), ...(plan.restartCutAt ? { restartCutAt: plan.restartCutAt } : {}) };
    if (patch.at !== undefined) {
      next.at = patch.at;
      next.attempts = 0;
      delete next.gaveUp;
      delete next.restartCutAt;
    }
    this.writeAutoResume(id, next);
    return next;
  }

  cancelAutoResume(id: string) {
    if (this.getAutoResume(id)) this.writeAutoResume(id, undefined);
    // 한도 대기 중인 넘기기는 예약과 함께 끝난다(사람의 취소·사람 메시지·보관). 쓰는 중인 턴은 건드리지 않는다.
    if (this.handoffMeta(id)?.handoffJob?.state === "waiting_limit") this.writeHandoff(id, { handoffJob: undefined });
  }

  // ── 다음 작업으로 넘기기 ──
  //   인계서 요청 → 턴 끝에서 집어내기 → 새 세션 만들기 → 두 세션 연결 저장. 모델 호출은 push 하나뿐이다.

  /** 넘기기 연결·초안·작업. 살아 있는 세션이든 잠든 디스크 세션이든 같다. */
  private handoffMeta(id: string): Pick<SessionMeta, "handoffFrom" | "handoffTo" | "handoffDraft" | "handoffJob"> | undefined {
    return this.sessions.get(id) ?? this.disk.get(id)?.meta;
  }

  /** 넘기기 필드 쓰기 + 화면 갱신. 없는 세션이면 아무것도 하지 않는다. */
  private writeHandoff(id: string, patch: Parameters<LiveSession["setHandoff"]>[0]) {
    const live = this.sessions.get(id);
    if (live) {
      live.setHandoff(patch);
      this.emitPresence(this.toPresenceFromLive(live));
      return;
    }
    const entry = this.disk.get(id);
    if (entry && this.updateDiskMeta(id, patch)) this.emitPresence(this.toPresenceFromDisk(id, entry));
  }

  /** 받을 폴더의 기본값. 복사본에서 일하던 세션은 원 폴더로 간다(복사본은 이전 세션과 함께 사라진다). */
  handoffDefaultCwd(id: string): string | undefined {
    return this.workspaceTarget(id)?.workspaceSource ?? this.sessions.get(id)?.cwd ?? this.disk.get(id)?.meta.cwd;
  }

  /** 새 대화를 받을 수 없을 만큼 바쁜가. 보관 판정과 같은 기준이다. */
  private isBusyLive(live: LiveSession): boolean {
    return (
      !store.diaryAcceptsInput(live.id) ||
      live.isTurnOpen || live.hasPendingInput || live.isRewinding || live.hasBlockingCommand ||
      ["running", "waiting", "background"].includes(this.attentionFieldsForLive(live, false).attention ?? "")
    );
  }

  // ── 쉬는 세션 잠재우기 ──
  //   실행기(자식 프로세스)만 내리고 세션은 디스크 세션으로 옮긴다. 사건 기록기와 SSE는 그대로 두므로 대화 통로는 끊기지 않고,
  //   다음 입력 때 재시작 뒤 복원과 같은 경로(getOrResume)로 깨어난다.

  /** 잠재워도 되는가. 하나라도 일하거나 사람을 기다리면 안 된다. 화면을 보고 있는지는 보지 않는다(열린 탭이 실행기를 영구히 붙잡는다). */
  private canSleep(live: LiveSession, now: number, idleMs: number): boolean {
    if (live.isEnded || live.isDisposed || now - live.idleSince < idleMs) return false;
    // 이어갈 식별자가 없으면 깨워도 이어 갈 수 없다. 되돌린 세션만 식별자 없이 깨울 수 있다.
    if (!live.resumeKey && !sessionWasRewound(live)) return false;
    if (this.isBusyLive(live)) return false;
    if (live.pendingPermissions().length || live.pendingQuestionList().length || live.pendingPlanList().length) return false;
    if (live.backgroundTasks.length) return false; // 막 끝난 직후의 보류 시간도 포함한다
    // 인계서를 쓰는 중이거나, 자동 재개를 보내고 결과를 기다리는 중(시각 없이 포기도 아닌 예약)이다.
    // 사람의 답을 기다리는 중(asking)에는 지켜보기만 걸려 있으므로 잠들어도 된다. 깨어날 때 다시 건다.
    if ((this.handoffWatch.has(live.id) && live.handoffJob?.state !== "asking") || live.handoffJob?.state === "writing") return false;
    const plan = live.autoResume;
    if (plan && plan.at === undefined && !plan.gaveUp) return false;
    return true;
  }

  /**
   * 쉬는 시간이 지난 세션을 잠재운다. 60초마다 서버가 부른다. 잠재운 수를 돌려준다.
   * 대기 시간은 부를 때마다 설정에서 읽으므로 바꾼 값이 다음 훑기부터 적용된다. 0이면 아무것도 하지 않는다.
   */
  async sweepIdle(now: number): Promise<number> {
    const idleMs = readIdleSleepMs();
    if (idleMs <= 0 || this.sweeping) return 0;
    this.sweeping = true;
    let slept = 0;
    try {
      for (const live of [...this.sessions.values()]) {
        if (await this.sleepIfIdle(live, now, idleMs)) slept += 1;
      }
    } finally {
      this.sweeping = false;
    }
    return slept;
  }

  /** 세션 하나가 잠재워도 되는 상태면 목록을 받아 두고 잠재운다. 잠들었으면 참. */
  private async sleepIfIdle(live: LiveSession, now: number, idleMs: number): Promise<boolean> {
    if (!this.canSleep(live, now, idleMs)) return false;
    const before = live.idleSince;
    await Promise.all([live.refreshCommandCatalog(SLEEP_COMMANDS_TIMEOUT_MS), live.refreshPolicyForSleep(SLEEP_COMMANDS_TIMEOUT_MS)]);
    // 목록을 받는 사이 입력이 들어오거나 세션이 바뀌었을 수 있다. 여기서부터 끝까지는 동기라 끼어들 틈이 없다.
    if (this.sessions.get(live.id) !== live || live.idleSince !== before || !this.canSleep(live, now, idleMs)) return false;
    return this.sleep(live);
  }

  /** 완전 동기. 메타를 먼저 저장하고(실패하면 그대로 둔다) 디스크 세션으로 옮긴 뒤 실행기를 내린다. */
  private sleep(live: LiveSession): boolean {
    const id = live.id;
    let meta: SessionMeta;
    try {
      meta = live.metaForSleep();
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.sleep.save", session_id: id }); console.error("[aether] 잠재우기 전 메타 저장 실패(그대로 둔다):", e);
      return false;
    }
    this.sessions.delete(id);
    const entry: DiskEntry = { meta, status: "ended", lastActivityAt: live.lastActivityAt, slept: true };
    this.disk.set(id, entry);
    let closing: Promise<void> = Promise.resolve();
    try {
      closing = live.dispose();
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.sleep.dispose", session_id: id }); console.error("[aether] 잠재우기 dispose 실패:", e);
    }
    // 같은 세션을 곧바로 깨우는 요청은 runtime 정리와 사건 흐름 종료가 끝난 뒤에 시작한다(상한을 넘기면 겹침을 감수한다).
    // shortcut: 실측상 Claude CLI는 이 약속이 끝난 뒤에도 약 2~3초 더 남아 있다(정리 중인 옛 프로세스와 새 프로세스가 잠깐 겹친다). 문제가 보이면 runtime 계약에 프로세스 종료 확인을 더한다.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SLEEP_SETTLE_TIMEOUT_MS);
      timer.unref();
    });
    const settled: Promise<void> = Promise.race([closing, limit]).then(() => {
      clearTimeout(timer);
      if (this.sleepSettling.get(id) === settled) this.sleepSettling.delete(id);
    });
    this.sleepSettling.set(id, settled);
    this.emitPresence(this.toPresenceFromDisk(id, entry));
    return true;
  }

  /** 방금 잠든 세션의 실행기가 내려갈 때까지 기다린다. 깨우기 직전(getOrResume 앞)에 부른다. 잠든 적 없으면 바로 끝난다. */
  async settledSleep(id: string): Promise<void> {
    await this.sleepSettling.get(id);
  }

  /** 잠든(live 아닌) 세션이 답할 명령 목록. provider 명령 마지막 기억에 공통 명령을 합친다. 디스크 세션이 아니면 undefined. */
  diskCommands(id: string): SlashCommandInfo[] | undefined {
    const entry = this.disk.get(id);
    if (!entry || entry.status === "corrupted" || !entry.meta.cwd) return undefined;
    // 기억이 없으면 공통 명령만으로 답하지 않는다. 화면이 404를 받아 깨워서 전체 목록을 채운다.
    return entry.meta.commandCatalog ? mergeCommands(entry.meta.commandCatalog) : undefined;
  }

  /** 잠들 때 기억한 승인 정책 요약. 디스크 세션이 아니거나 기억이 없으면 undefined. */
  diskPermissionPolicy(id: string) {
    const entry = this.disk.get(id);
    return entry && entry.status !== "corrupted" ? entry.meta.permissionPolicy : undefined;
  }

  /** 잠든 세션이 답할 모델 목록. 허브가 기억한 그 provider의 목록이다. 디스크 세션이 아니면 undefined, 기억이 없으면 빈 배열. */
  diskModels(id: string) {
    const entry = this.disk.get(id);
    if (!entry || entry.status === "corrupted" || !entry.meta.cwd) return undefined;
    return mergeModelList(storedProviderId(entry.meta.provider), []);
  }

  /**
   * 넘기기를 시작한다. 이미 한도에 막혀 있으면 모델을 부르지 않고 풀릴 때까지 기다린다.
   * 반환은 작업 상태. 시작하지 못하면 HandoffError(또는 깨우기 실패)를 던진다.
   */
  async startHandoff(id: string, req: Pick<HandoffJob, "focus" | "provider" | "cwd" | "copyOnly">): Promise<"writing" | "waiting_limit"> {
    if (this.isArchived(id)) throw new HandoffError("archived");
    await this.settledSleep(id);
    const live = this.getOrResume(id);
    const prev = live.handoffJob;
    if (prev && prev.state !== "copy_ready") throw new HandoffError("already");
    if (this.isBusyLive(live)) throw new HandoffError("busy");
    const job: HandoffJob = { ...req, state: "writing", requestedAt: Date.now() };
    const hold = live.attentionHold;
    if (hold?.kind === "rate_limit" && (hold.until === undefined || hold.until > Date.now())) {
      this.writeHandoff(id, { handoffJob: { ...job, state: "waiting_limit" } });
      this.scheduleHandoffWait(id, hold.until);
      return "waiting_limit";
    }
    try {
      await this.askHandoff(live, job, false);
    } catch (e) {
      this.writeHandoff(id, { handoffJob: prev });
      throw new HandoffError("push", String((e as Error)?.message ?? e).slice(0, 500));
    }
    return "writing";
  }

  /** 인계서 요청을 보내고 그 턴이 끝나기를 지켜본다. auto는 한도 대기 뒤 Aether가 보내는 경우다. */
  private async askHandoff(live: LiveSession, job: HandoffJob, auto: boolean): Promise<void> {
    const id = live.id;
    this.writeHandoff(id, { handoffJob: { ...job, state: "writing" } });
    this.watchHandoffTurn(live);
    const { text, modelText } = handoffRequest(job.focus, job.forced === true);
    try {
      // brief: 물을 것이 있으면 선택지 질문 도구 대신 질문지 상자로 묻게 하고, 턴 끝에서 질문지 사건을 만든다. 더 묻지 않는 재개(forced)는 켜지 않는다.
      await live.push(text, undefined, undefined, `${HANDOFF_CLIENT_ID_PREFIX}${randomUUID()}`, { modelText, ...(job.forced ? {} : { brief: true }), ...(auto ? { sentBy: "aether" as const } : {}) });
    } catch (e) {
      this.unwatchHandoff(id);
      throw e;
    }
  }

  private unwatchHandoff(id: string) {
    this.handoffWatch.get(id)?.();
    this.handoffWatch.delete(id);
  }

  /**
   * 세션을 새로 띄웠을 때 사람의 답을 기다리던 넘기기가 있으면 지켜보기를 다시 건다.
   * 지켜보기는 메모리에만 있어서 재시작·잠들기로 사라진다.
   */
  private rearmHandoffAsk(live: LiveSession) {
    // 옛 실행기의 구독이 지워지지 않고 남아 있을 수 있으므로 감시가 있어도 새 실행기에 다시 건다(옛 구독은 먼저 풀린다).
    if (live.handoffJob?.state === "asking") this.watchHandoffTurn(live);
  }

  /**
   * 인계서 턴을 지켜본다. 질문 대기(asking) 중에는 사람의 글(카드 답이든 채팅이든)이 와야 새 턴으로 보고 쓰기(writing)로 바꾼다.
   * 질문 대기 중 세션이 잠들거나 끝나는 상태 사건은 무시한다. 쓰는 중에는 턴 끝(또는 세션 종료)에서 닫고 정리한다.
   * chat은 이번 턴을 연 글이 사람이 채팅으로 쓴 말(요청·카드 답·Aether 글이 아님)이라는 뜻이다.
   */
  private watchHandoffTurn(live: LiveSession) {
    const id = live.id;
    this.unwatchHandoff(id);
    let events: AetherEvent[] = [];
    let chat = false;
    let waiting = false;
    const unsub = live.subscribe((ev) => {
      const job = this.handoffMeta(id)?.handoffJob;
      const kind = (ev as { kind?: string }).kind;
      if (job?.state === "asking") {
        if (kind === "user_msg") {
          const u = ev as { clientMessageId?: string; sentBy?: string; questionnaireAnswer?: unknown };
          events = [ev];
          chat = !u.questionnaireAnswer && !u.sentBy && !u.clientMessageId?.startsWith(HANDOFF_CLIENT_ID_PREFIX);
          live.setBriefOpen(true); // 이 답 뒤에도 물을 수 있게 질문지 판독을 켜 둔다
          this.writeHandoff(id, { handoffJob: { ...job, state: "writing" } });
          return;
        }
        // 같은 식별자로 재전송된 답은 user_msg 없이 턴이 돈다. 그 턴 끝에서 표식 있는 글만 받고, 아니면 질문 대기를 유지한다.
        events.push(ev);
        if (!live.codec.endsTurn(ev)) return;
        unsub();
        this.handoffWatch.delete(id);
        const turn = events;
        queueMicrotask(() => this.settleAskingStray(live, turn));
        return;
      }
      events.push(ev);
      // 구독 뒤 첫 턴 끝까지가 이번 턴이다(작업을 기다리며 멈춘 턴은 빼고 센다). 세션 종료 사건이 먼저 오면 턴 끝 없이 닫는다.
      const turnEnd = live.codec.endsTurn(ev);
      if (!turnEnd && kind !== "status") return;
      if (turnEnd && !chat && handoffTurnAwaitsWork(events, live.codec, live.hasRunningBackground, waiting)) {
        events = [];
        waiting = true;
        return;
      }
      unsub();
      this.handoffWatch.delete(id);
      queueMicrotask(() => void this.settleHandoff(live, events, turnEnd, chat));
    });
    this.handoffWatch.set(id, unsub);
  }

  /** 질문 대기 중 user_msg 없이 턴이 끝났다. 표식 있는 인계서가 있으면 넘기고, 없으면 질문 대기를 이어 간다. */
  private settleAskingStray(live: LiveSession, events: AetherEvent[]) {
    const job = this.handoffMeta(live.id)?.handoffJob;
    if (!job || job.state !== "asking") return;
    const picked = handoffTurnOutcome(events, live.codec) === "ok" ? pickHandoffText(events, live.codec, true) : null;
    if (picked) return this.finishHandoff(live, job, picked, "model");
    this.watchHandoffTurn(live);
  }

  /** 인계서를 쓴 턴이 끝났다. 멈춘 턴이면 접고, 글이 있으면 넘기고, 물을 게 있으면 묻고, 한도면 기다리고, 아니면 뼈대로 넘긴다. */
  private async settleHandoff(live: LiveSession, events: AetherEvent[], turnEnd: boolean, chat: boolean) {
    const id = live.id;
    const job = this.handoffMeta(id)?.handoffJob;
    if (!job || job.state === "copy_ready") return; // 그 사이 지워졌거나 포기 처리됐다
    const outcome = turnEnd ? handoffTurnOutcome(events, live.codec) : "failed";
    // 사람이 멈췄다 = 넘기기를 그만둔다. provider가 멈춘 턴을 어떻게 끝내든(성공·실패·멈춤) 멈춤 요청 표시가 먼저다.
    if (live.interruptRequested || outcome === "interrupted") return this.endHandoffJob(id, undefined);
    // 사람이 채팅으로 딴말을 한 턴의 답은 표식이 있을 때만 인계서로 받는다(딴말에 대한 답을 인계서로 쓰지 않는다).
    const picked = pickHandoffText(events, live.codec, chat);
    // 한도 대기로 바뀐 작업은 글이 온전히 끝난 턴(ok)의 글만 받는다. 한도로 끊긴 턴의 글은 쓰지 않는다.
    if (picked && (job.state === "writing" || outcome === "ok")) return this.finishHandoff(live, job, picked, "model");
    if (job.state === "waiting_limit") return;
    if (outcome === "limit") {
      this.writeHandoff(id, { handoffJob: { ...job, state: "waiting_limit" } });
      this.scheduleHandoffWait(id, limitResetsAt(events, live.codec));
      return;
    }
    if (outcome === "ok") {
      // 질문지는 턴 끝 사건보다 먼저 기록되므로 여기서 읽을 수 있다. 깨진 질문지는 null이라 아래 실패 흐름으로 간다.
      const open = job.forced ? null : await live.openQuestionnaire();
      const now = this.handoffMeta(id)?.handoffJob;
      if (!now || now.state !== "writing") return; // 기다리는 사이 지워졌다
      if (live.interruptRequested) return this.endHandoffJob(id, undefined);
      if (open) {
        const rounds = now.askRounds ?? 0;
        if (rounds < HANDOFF_ASK_ROUNDS_MAX) {
          this.writeHandoff(id, { handoffJob: { ...now, state: "asking", askRounds: rounds + 1 } });
          this.watchHandoffTurn(live);
          return;
        }
        // 물을 횟수를 다 썼다. 더 묻지 말고 쓰게 한다. 그 뒤에도 또 물으면 위의 forced 때문에 뼈대로 넘어간다.
        this.writeHandoff(id, { handoffJob: { ...now, forced: true } });
        this.watchHandoffTurn(live);
        try {
          await live.push(handoffForceWriteText(), undefined, undefined, `${HANDOFF_CLIENT_ID_PREFIX}${randomUUID()}`, { sentBy: "aether" });
        } catch (e) {
          this.unwatchHandoff(id);
          void reportError(e, { component: "session", operation: "session.handoff.force", session_id: id });
          this.finishHandoff(live, now, this.buildSkeleton(live, now, st("routes.handoff.reasonFailed")), "skeleton");
        }
        return;
      }
    }
    if (chat) {
      // 사람의 딴말에 모델이 답한 턴이다(결과가 실패여도). 뼈대로 넘기지 않고 질문 대기로 돌아가 다음 글을 기다린다.
      const now = this.handoffMeta(id)?.handoffJob;
      if (!now || now.state !== "writing") return;
      live.setBriefOpen(true); // 턴 끝에서 꺼진 질문지 판독을 다시 켠다
      this.writeHandoff(id, { handoffJob: { ...now, state: "asking" } });
      this.watchHandoffTurn(live);
      return;
    }
    // 한도 알림이 실패한 턴보다 늦게 올 수 있다. 판정은 A1 한 곳이 하므로 잠깐 기다려 그 사이 대기로 바뀌었는지 본다.
    await new Promise<void>((r) => setTimeout(r, this.handoffLimitGraceMs));
    const now = this.handoffMeta(id)?.handoffJob;
    if (!now || now.state !== "writing") return;
    if (live.interruptRequested) return this.endHandoffJob(id, undefined);
    this.finishHandoff(live, now, this.buildSkeleton(live, now, st("routes.handoff.reasonFailed")), "skeleton");
  }

  /** 한도가 풀리면 인계서를 쓰도록 예약에 얹는다. 이미 시각이 있는 예약이면 그 시각과 횟수를 그대로 쓴다. */
  private scheduleHandoffWait(id: string, until: number | undefined) {
    const plan = this.getAutoResume(id);
    const attempts = plan?.attempts ?? 0;
    if (plan?.action.type === "handoff" && plan.at !== undefined) return;
    this.writeAutoResume(id, { action: { type: "handoff" }, attempts, at: plan?.at ?? nextAttemptAt(attempts, until) });
  }

  private buildSkeleton(live: LiveSession, job: HandoffJob, reason: string): string {
    const events = live.replaySince(0);
    return skeletonHandoff({
      name: this.autoResumeNameOf(live.id).name,
      id: live.id,
      cwd: live.workspaceSource ?? live.cwd,
      focus: job.focus,
      reason,
      userTexts: recentUserTexts(events),
      todo: latestTodoItems(events, live.codec),
      files: changedFiles(events, live.codec),
      gitChanges: folderUncommittedChanges(live.cwd),
    });
  }

  /** 작업을 끝낸다(남길 결과가 있으면 그 상태로). 인계서 쓰기 예약도 함께 지운다. */
  private endHandoffJob(id: string, job: HandoffJob | undefined, extra?: { handoffTo?: string }) {
    this.writeHandoff(id, { handoffJob: job, ...extra });
    if (this.getAutoResume(id)?.action.type === "handoff") this.writeAutoResume(id, undefined);
  }

  /** 글이 정해졌다. 복사만이면 결과로 남기고, 아니면 새 세션을 만들어 초안으로 넣는다. 만들지 못하면 글을 잃지 않게 결과로 남긴다. */
  private finishHandoff(live: LiveSession, job: HandoffJob, rawText: string, source: HandoffSource) {
    const id = live.id;
    // 모델이 쓴 글에만 사람이 적은 글 원문과 이전 세션 표시를 붙인다. 뼈대는 이미 둘 다 담고 있다.
    const text = source === "model" ? withHandoffFrame(rawText, { focus: job.focus, name: this.autoResumeNameOf(id).name, id }) : rawText;
    if (job.copyOnly) return this.endHandoffJob(id, { ...job, state: "copy_ready", result: { text, source } });
    try {
      const sameAi = !job.provider || job.provider === live.provider;
      const next = this.create({
        cwd: job.cwd ?? this.handoffDefaultCwd(id),
        provider: sameAi ? live.provider : job.provider!,
        model: sameAi ? live.model : undefined,
        effort: sameAi ? live.effort : undefined,
        // 넘기기로 권한이 넓어지지 않게 한다. 수동·편집 자동 수락만 물려주고, 자동·권한 무시는 새 세션 기본값을 쓴다.
        permissionMode: live.permissionMode === "manual" || live.permissionMode === "edits" ? live.permissionMode : undefined,
      });
      next.setHandoff({ handoffFrom: id, handoffDraft: { text, source } });
      this.endHandoffJob(id, undefined, { handoffTo: next.id });
      this.emitPresence(this.toPresenceFromLive(next));
    } catch (e) {
      void reportError(e, { component: "session", operation: "session.handoff.create", session_id: id });
      this.endHandoffJob(id, { ...job, state: "copy_ready", result: { text, source, error: st("routes.handoff.createFailed") } });
    }
  }

  /**
   * 다른 AI에게 검토 맡기기. 같은 폴더에 수동 권한 새 세션을 열고 검토 요청 글을 입력창 초안으로 넣는다. 모델은 부르지 않는다.
   * workspaceSource를 넘기지 않는다(검토 세션을 지울 때 원래 세션의 복사본이 함께 버려진다). 원래 세션의 handoffTo도 건드리지 않는다.
   */
  createReviewSession(fromId: string, o: { provider: string; cwd: string; name: string; text: string }): LiveSession {
    const next = this.create({ cwd: o.cwd, provider: o.provider, name: o.name, permissionMode: "manual" });
    next.setHandoff({ handoffFrom: fromId, handoffDraft: { text: o.text, source: "review" } });
    this.emitPresence(this.toPresenceFromLive(next));
    return next;
  }

  /** 한도 대기 끝에 예약이 실행됐다. 인계서 요청을 다시 보낸다(Aether가 보낸 글로 표시). */
  async resumeHandoff(id: string): Promise<void> {
    const job = this.handoffMeta(id)?.handoffJob;
    if (job?.state !== "waiting_limit") return;
    await this.settledSleep(id);
    await this.askHandoff(this.getOrResume(id), job, true);
  }

  /** 자동 재개가 포기했다. 인계서를 받지 못했으니 모델 없이 뼈대 인계서로 넘긴다. */
  handoffGiveUp(id: string) {
    const job = this.handoffMeta(id)?.handoffJob;
    if (!job) return;
    this.handoffWatch.get(id)?.();
    this.handoffWatch.delete(id);
    queueMicrotask(() => {
      try {
        const live = this.getOrResume(id);
        this.finishHandoff(live, job, this.buildSkeleton(live, job, st("routes.handoff.reasonLimit")), "skeleton");
      } catch (e) {
        void reportError(e, { component: "session", operation: "session.handoff.giveup", session_id: id });
        this.endHandoffJob(id, undefined);
      }
    });
  }

  /** 새 세션 쪽 초안과 이전 세션 쪽 결과. 둘 다 없으면 빈 객체. 세션이 없으면 null. */
  handoffInfo(id: string): { incoming?: { fromSessionId: string; fromName: string; text: string; source: HandoffSource }; result?: NonNullable<HandoffJob["result"]> } | null {
    const m = this.handoffMeta(id);
    if (!m) return null;
    return {
      ...(m.handoffDraft && m.handoffFrom
        ? { incoming: { fromSessionId: m.handoffFrom, fromName: this.autoResumeNameOf(m.handoffFrom).name, text: m.handoffDraft.text, source: m.handoffDraft.source } }
        : {}),
      ...(m.handoffJob?.result ? { result: m.handoffJob.result } : {}),
    };
  }

  /** 질문 대기 작업을 버린다. 열려 있던 질문지에는 더 답할 수 없게 닫는다. */
  private dropAskingHandoff(id: string) {
    this.unwatchHandoff(id);
    this.writeHandoff(id, { handoffJob: undefined });
    this.sessions.get(id)?.dismissQuestionnaire();
  }

  /** 질문 대기나 한도 대기를 취소하거나 복사 결과를 지운다. 쓰는 중이면 "busy"(멈추려면 멈추기 버튼). */
  clearHandoff(id: string): "none" | "busy" | "ok" {
    const job = this.handoffMeta(id)?.handoffJob;
    if (!job) return "none";
    if (job.state === "writing") return "busy";
    if (job.state === "asking") {
      this.dropAskingHandoff(id);
    } else if (job.state === "waiting_limit") this.cancelAutoResume(id);
    else this.writeHandoff(id, { handoffJob: undefined });
    return "ok";
  }

  /** 예약 시각에 한 번 깨는 타이머. armAttentionHold와 같은 방식(unref, 상한 자르기, 일찍 깨면 다시 건다). */
  private armAutoResume(id: string) {
    const at = this.getAutoResume(id)?.at;
    const cur = this.autoResumeTimers.get(id);
    if (cur && cur.at === at) return;
    if (cur) {
      clearTimeout(cur.timer);
      this.autoResumeTimers.delete(id);
    }
    if (at === undefined) return;
    const timer = setTimeout(() => {
      this.autoResumeTimers.delete(id);
      if (Date.now() < at - 1000) {
        this.armAutoResume(id);
        return;
      }
      void this.fireAutoResume(id);
    }, Math.min(Math.max(at - Date.now(), 0), 2 ** 31 - 1));
    timer.unref();
    this.autoResumeTimers.set(id, { at, timer });
  }

  /**
   * 한도 막힘이 풀리는 시각에 주의 상태를 한 번 더 내보낸다. 세션마다 타이머는 하나다.
   * shortcut: 잠든 세션은 타이머가 없다 — until이 지나도 다음 목록 갱신 때에야 내려간다. 푸시가 필요해지면 디스크 항목에도 건다.
   */
  private armAttentionHold(live: LiveSession) {
    const id = live.id;
    const until = live.attentionHold?.until;
    const cur = this.attnHoldTimers.get(id);
    if (cur && cur.until === until) return;
    if (cur) {
      clearTimeout(cur.timer);
      this.attnHoldTimers.delete(id);
    }
    if (until === undefined || until <= Date.now()) return;
    const timer = setTimeout(() => {
      this.attnHoldTimers.delete(id);
      if (this.sessions.get(id) === live) this.emitPresence(this.toPresenceFromLive(live));
      else this.emitDiskPresence(id); // 그 사이 잠들었으면 디스크 세션 기준으로 알린다
    }, Math.min(until - Date.now() + 5, 2 ** 31 - 1)); // 5ms 여유. setTimeout 상한(약 24.8일)을 넘기면 즉시 발화하므로 자른다
    timer.unref();
    this.attnHoldTimers.set(id, { until, timer });
  }

  /**
   * 뒤 작업이 막 모두 끝나 보류 중이면, 보류가 끝나는 시각에 주의 상태를 한 번 더 내보낸다.
   * 그 안에 새 턴이 열리지 않으면 이때 '백그라운드 작업 중'이 '쉼'으로 바뀐다. 세션마다 타이머는 하나다.
   */
  private armBackgroundHold(live: LiveSession) {
    const id = live.id;
    const until = live.backgroundHoldUntil;
    const cur = this.bgHoldTimers.get(id);
    if (cur && cur.until === until) return;
    if (cur) {
      clearTimeout(cur.timer);
      this.bgHoldTimers.delete(id);
    }
    if (until === undefined || until <= Date.now()) return;
    const timer = setTimeout(() => {
      this.bgHoldTimers.delete(id);
      if (this.sessions.get(id) === live) this.emitPresence(this.toPresenceFromLive(live));
      else this.emitDiskPresence(id);
    }, until - Date.now() + 5); // 5ms 여유: 타이머가 마감 직전에 깨어도 만료로 읽히게
    timer.unref();
    this.bgHoldTimers.set(id, { until, timer });
  }

  /** 디스크 세션이면 그 기준으로 주의 상태를 한 번 더 내보낸다. 살아 있거나 없으면 아무것도 하지 않는다. */
  private emitDiskPresence(id: string) {
    const entry = this.disk.get(id);
    if (entry && !this.sessions.has(id)) this.emitPresence(this.toPresenceFromDisk(id, entry));
  }

  markViewed(id: string, at = Date.now()) {
    const live = this.sessions.get(id);
    if (live) {
      live.markViewed(at);
      this.emitPresence(this.toPresenceFromLive(live));
      return;
    }
    const entry = this.disk.get(id);
    if (!entry || entry.status === "corrupted" || !entry.meta.cwd) return;
    const meta = { ...entry.meta, lastViewedAt: at } as SessionMeta;
    store.saveMeta(meta);
    entry.meta = meta;
    this.emitPresence(this.toPresenceFromDisk(id, entry));
  }

  /** 작업 검토함의 검토 완료 위치. 살아 있으면 세션이, 잠들었으면 메타 파일이 들고 있다. */
  reviewedSeqOf(id: string): number | undefined {
    const live = this.sessions.get(id);
    return live ? live.reviewedSeq : this.disk.get(id)?.meta.reviewedSeq;
  }

  /** 검토 완료 위치를 저장한다(undefined면 지움). 저장할 수 없는 세션이면 false. */
  setReviewedSeq(id: string, seq: number | undefined): boolean {
    const live = this.sessions.get(id);
    if (live) {
      live.setReviewedSeq(seq);
      return true;
    }
    const entry = this.disk.get(id);
    if (!entry || entry.status === "corrupted" || !entry.meta.cwd) return false;
    const meta = { ...entry.meta, reviewedSeq: seq } as SessionMeta;
    store.saveMeta(meta);
    entry.meta = meta;
    return true;
  }

  addViewer(id: string) {
    this.viewers.set(id, (this.viewers.get(id) ?? 0) + 1);
    this.markViewed(id);
  }

  dropViewer(id: string) {
    const n = (this.viewers.get(id) ?? 0) - 1;
    if (n <= 0) this.viewers.delete(id);
    else this.viewers.set(id, n);
  }

  hasViewer(id: string): boolean {
    return (this.viewers.get(id) ?? 0) > 0;
  }

  subscribePresence(fn: (update: PresenceSession) => void): () => void {
    this.presenceSubs.add(fn);
    return () => this.presenceSubs.delete(fn);
  }

  presenceSnapshot(): PresenceSession[] {
    return this.list().map((item) => this.toPresence(item));
  }

  private attentionFieldsForLive(s: LiveSession, withHold = true): Pick<SessionListItem, "attention" | "attentionKind" | "attentionPreview" | "attentionSince" | "lastViewedAt" | "backgroundTasks" | "backgroundCanStop"> {
    // 보관된 세션은 주의 표시를 내지 않는다. 보관 판정(setArchived)은 보관 전에 하므로 이 값과 겹치지 않는다.
    if (s.archivedAt) return { attention: "idle", lastViewedAt: s.lastViewedAt };
    const waiting = waitingFromPending({
      permissions: s.pendingPermissions(),
      questions: s.pendingQuestionList(),
      plans: s.pendingPlanList(),
    });
    const backgroundTasks = s.backgroundTasks;
    const computed = computeAttention({
      waitingKind: waiting?.kind,
      waitingPreview: waiting?.preview,
      waitingSince: waiting?.since,
      turnOpen: s.isTurnOpen,
      hold: withHold ? s.attentionHold ?? this.restartHold(s.autoResume) : undefined,
      backgroundCount: backgroundTasks.length,
      lastViewedAt: s.lastViewedAt,
      sticky: s.attentionSticky,
    });
    return { ...computed, lastViewedAt: s.lastViewedAt, ...(backgroundTasks.length > 0 ? { backgroundTasks, backgroundCanStop: s.canStopBackgroundNow } : {}) };
  }

  private attentionFieldsForDisk(e: DiskEntry, withHold = true): Pick<SessionListItem, "attention" | "attentionKind" | "attentionPreview" | "attentionSince" | "lastViewedAt"> {
    if (e.meta.archivedAt) return { attention: "idle", lastViewedAt: e.meta.lastViewedAt };
    const computed = computeAttention({
      turnOpen: false,
      hold: withHold ? e.meta.attentionHold ?? this.restartHold(e.meta.autoResume) : undefined,
      lastViewedAt: e.meta.lastViewedAt,
      sticky: e.meta.attentionSticky,
    });
    return { ...computed, lastViewedAt: e.meta.lastViewedAt };
  }

  private toPresence(item: SessionListItem): PresenceSession {
    return {
      id: item.id,
      attention: item.attention ?? "idle",
      attentionKind: item.attentionKind,
      attentionPreview: item.attentionPreview,
      attentionSince: item.attentionSince,
      lastActivityAt: item.lastActivityAt,
      lastInputAt: item.lastInputAt,
      preview: item.preview,
      status: item.status,
      lastViewedAt: item.lastViewedAt,
      observedEffort: item.observedEffort,
      archivedAt: item.archivedAt,
      ...autoResumeField(item.autoResume),
      ...handoffField(item),
      ...(item.backgroundTasks ? { backgroundTasks: item.backgroundTasks, backgroundCanStop: item.backgroundCanStop } : {}),
    };
  }

  private toPresenceFromLive(s: LiveSession): PresenceSession {
    const att = this.attentionFieldsForLive(s);
    return {
      id: s.id,
      displayName: resolveWorkTitle(s.name, s.generatedName),
      attention: att.attention ?? "idle",
      attentionKind: att.attentionKind,
      attentionPreview: att.attentionPreview,
      attentionSince: att.attentionSince,
      lastActivityAt: s.lastActivityAt,
      lastInputAt: s.lastInputAt,
      preview: s.lastWorkPreview(),
      status: s.isEnded ? "ended" : "active",
      lastViewedAt: s.lastViewedAt,
      observedEffort: s.observedEffort,
      archivedAt: s.archivedAt,
      ...autoResumeField(s.autoResume),
      ...handoffField(s),
      ...(att.backgroundTasks ? { backgroundTasks: att.backgroundTasks, backgroundCanStop: att.backgroundCanStop } : {}),
    };
  }

  private toPresenceFromDisk(id: string, e: DiskEntry): PresenceSession {
    const att = this.attentionFieldsForDisk(e);
    let preview = "";
    try {
      preview = lastWorkPreview(store.readRecentEvents(id), this.codecOf(id), id);
      failuresFor(this).clear(`preview:${id}`);
    } catch (error) {
      failuresFor(this).report(error, { component: "session", operation: "session.preview.read", severity: "error", session_id: id }, `preview:${id}`);
      preview = "";
    }
    return {
      id,
      displayName: resolveWorkTitle(e.meta.name, e.meta.generatedName),
      attention: att.attention ?? "idle",
      attentionKind: att.attentionKind,
      attentionPreview: att.attentionPreview,
      attentionSince: att.attentionSince,
      lastActivityAt: e.lastActivityAt ?? e.meta.createdAt,
      lastInputAt: e.meta.lastInputAt ?? e.meta.createdAt,
      preview,
      status: e.status,
      lastViewedAt: e.meta.lastViewedAt,
      observedEffort: e.meta.observedEffort,
      archivedAt: e.meta.archivedAt,
      ...autoResumeField(e.meta.autoResume),
      ...handoffField(e.meta),
    };
  }

  private emitPresence(update: PresenceSession) {
    if (this.isExternal(update.id)) return;
    const key = JSON.stringify(update);
    if (this.lastPresence.get(update.id) === key) return;
    this.lastPresence.set(update.id, key);
    for (const fn of this.presenceSubs) {
      try {
        fn(update);
      } catch (e) {
        void reportError(e, { component: "session", operation: "session.attention.notify" }); console.error("[aether] 주의 통로 구독 실패:", e);
      }
    }
  }
}

export const sessionManager = new SessionManager();
