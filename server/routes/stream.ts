import { reportError } from "../observability/report";
import { reportResponseError } from "../observability/http";
/**
 * SSE 스트림: GET /api/sessions/:id/stream?since=<seq>
 *  1) replaySince(since)로 끊긴 동안 놓친 이벤트 먼저 흘림(재접속 복원)
 *  2) subscribe로 실시간 합류
 *  3) heartbeat(: ping)로 연결 유지/끊김 감지
 * 각 이벤트는 SSE id에 seq를 실어 클라가 lastSeq를 추적하게 한다.
 *
 * 재시작 후 복원된 디스크 세션(아직 live 아님)은 과거 이벤트를 replay한다.
 *   실행기를 띄우지 않는다. 잠든 동안 새로 기록된 사건은 1초 확인에서 이어서 보낸다.
 *   사용자가 message로 resume하면 같은 연결이 살아 있는 세션으로 옮겨 간다.
 *
 * ⚠️ SSE 헤더의 `no-transform`은 load-bearing(프록시/compression이 스트림 변형/버퍼링 못하게) — 지우지 말 것.
 * ⚠️ 단일 상시 프로세스라 한 소켓 오류가 전체를 죽이면 안 됨 → res.on("error")·write try/catch로 격리.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { endIfRevoked } from "../middleware/auth";
import { sessionManager } from "../sessions/SessionManager";
import type { LiveSession } from "../sessions/LiveSession";
import * as store from "../sessions/persistence";
import type { AetherEvent } from "../types";
import { toWireEvent } from "../sessions/wireEvent";
import { st } from "../i18n";
import { AGENT_EVENT_CONTRACT_VERSION } from "../../shared/agentEvent";
import { isConversationContentEvent, isConversationSeedEvent } from "../sessions/eventSemantics";
import { isHiddenSeq } from "../sessions/rewind";

export const streamRouter = Router();

// 초기 진입(since=0) replay 상한 — 이보다 긴 백로그는 꼬리만 보내고, 이전 구간은 클라가
//   GET /:id/events(무한스크롤)로 페이징한다. 전량 replay는 긴 세션에서 전송+파싱이 수 초를 넘겨
//   클라 스켈레톤 fallback(6s)이 먼저 풀리며 '스크롤이 계속 내려가는' 증상의 원인이었다.
const INITIAL_TAIL_LIMIT = 300;
const INITIAL_CONVERSATION_SEED_LIMIT = 32;
const INITIAL_CONVERSATION_TOOL_LIMIT = 8;
// 꼬리 밖에서 모델·명령·계획·대화 씨앗을 찾으려고 훑는 사건 수의 상한. 찾는 종류는 provider마다 달라 저장소의 kind 칸으로는 거를 수 없다.
const INITIAL_SCAN_LIMIT = 5000;

/**
 * raw 꼬리 밖으로 밀려난 마지막 실제 대화 한 턴을 작은 복원 씨앗으로 고른다.
 * provider 원본 필드는 보지 않고 codec의 중립 사건만 사용한다. 상태 사건은 건너뛰고 도구 사건도 최근
 * 8개만 담으므로, 이전 페이지 cursor는 기존 raw 꼬리의 시작점을 그대로 유지하면서 응답이 비대해지지 않는다.
 * 사건을 최신부터 하나씩 먹이고, 사용자 글을 만나면 done이 된다.
 */
function createSeedPicker(codec: { normalize(ev: AetherEvent): { type: string }[] }) {
  const picked: AetherEvent[] = [];
  let foundConversation = false;
  let pickedTools = 0;
  let done = false;
  return {
    get done() {
      return done;
    },
    feed(ev: AetherEvent, normalized: { type: string }[]) {
      const isUser = normalized.some((item) => item.type === "user_text");
      if (isUser) {
        picked.push(ev); // 본문 상한에 닿아도 이 턴을 시작한 사용자 글은 함께 보낸다.
        foundConversation = true;
        done = true;
        return;
      }
      if (!isConversationSeedEvent(ev, codec) || picked.length >= INITIAL_CONVERSATION_SEED_LIMIT) return;
      const isTool = normalized.some((item) => item.type === "tool_call" || item.type === "tool_result");
      if (isTool && pickedTools >= INITIAL_CONVERSATION_TOOL_LIMIT) return;
      if (isTool) pickedTools += 1;
      foundConversation = true;
      picked.push(ev);
    },
    result: () => (foundConversation ? picked.reverse() : []),
  };
}

function* newestFirst(evs: AetherEvent[]): Generator<AetherEvent> {
  for (let i = evs.length - 1; i >= 0; i--) yield evs[i];
}

// 꼬리 절단 시에도 잘려나간 구간의 마지막 모델 이름·슬래시 명령 이름 관측은 포함.
//   살아 있는 세션은 GET /commands가 설명까지 주고, 잠든 세션은 이 관측으로 이름 목록이 비지 않는다.
export function sliceTail(
  evs: AetherEvent[],
  codec: { normalize(ev: AetherEvent): { type: string }[] },
): { evs: AetherEvent[]; oldestSeq: number; hasOlder: boolean } {
  return sliceTailFrom(newestFirst(evs), codec);
}

/**
 * 최신부터 넘어오는 사건에서 꼬리 300개를 고르고, 그보다 오래된 구간은 한 번만 훑는다.
 * 찾을 것을 다 찾으면 멈추므로 저장소는 필요한 만큼만 읽힌다.
 */
export function sliceTailFrom(
  source: Iterable<AetherEvent>,
  codec: { normalize(ev: AetherEvent): { type: string }[] },
): { evs: AetherEvent[]; oldestSeq: number; hasOlder: boolean } {
  const it = source[Symbol.iterator]();
  try {
    const tailRev: AetherEvent[] = [];
    for (let n = it.next(); !n.done; n = it.next()) {
      tailRev.push(n.value);
      if (tailRev.length > INITIAL_TAIL_LIMIT) break;
    }
    if (tailRev.length <= INITIAL_TAIL_LIMIT) {
      const evs = tailRev.reverse();
      return { evs, oldestSeq: evs[0]?.seq ?? 0, hasOlder: false };
    }
    const first = tailRev.pop()!; // 꼬리 밖 첫 사건(꼬리 바로 앞)
    const tail = tailRev.reverse();
    let lastModel: AetherEvent | null = null;
    let lastCmds: AetherEvent | null = null;
    // 할 일 목록은 마지막 사건 하나가 전체다. 꼬리 안에 더 나중 목록이 있으면 앞의 것은 싣지 않는다.
    let lastPlan: AetherEvent | null = null;
    // shortcut: 꼬리 밖 5,000건까지만 훑는다. 그보다 앞의 모델·명령·계획은 빠진다. 300건 넘는 한 턴이면 꼬리에 그 턴의 사용자 글이 없어 지난 목록이 이번 턴 것으로 보일 수 있다. 오표시가 보이면 사용자 글 동봉을 넣는다.
    const isPlan = (item: { type: string; subtaskOf?: string }) => item.type === "plan_update" && !item.subtaskOf;
    const needPlan = !tail.some((ev) => codec.normalize(ev).some(isPlan));
    const needSeed = !tail.some((ev) => isConversationContentEvent(ev, codec));
    const seed = createSeedPicker(codec);
    const extrasDone = () => !!lastModel && !!lastCmds && (!needPlan || !!lastPlan);
    for (let cur: AetherEvent | undefined = first, scanned = 0; cur && scanned < INITIAL_SCAN_LIMIT; scanned++) {
      const scanExtras = !extrasDone();
      const scanSeed = needSeed && !seed.done;
      if (!scanExtras && !scanSeed) break;
      const normalized = codec.normalize(cur);
      if (scanExtras) {
        for (const item of normalized) {
          if (item.type === "model_info" && !lastModel) lastModel = cur;
          if (item.type === "commands_available" && !lastCmds) lastCmds = cur;
          if (isPlan(item) && needPlan && !lastPlan) lastPlan = cur;
        }
      }
      if (scanSeed) seed.feed(cur, normalized);
      const n = it.next();
      cur = n.done ? undefined : n.value;
    }
    const extras: AetherEvent[] = needSeed ? seed.result() : [];
    const seen = new Set<number>();
    for (const extra of extras) seen.add(extra.seq);
    for (const extra of [lastModel, lastCmds, lastPlan]) {
      if (!extra || seen.has(extra.seq)) continue;
      seen.add(extra.seq);
      extras.push(extra);
    }
    extras.sort((a, b) => a.seq - b.seq);
    return { evs: [...extras, ...tail], oldestSeq: tail[0].seq, hasOlder: true };
  } finally {
    it.return?.();
  }
}

// 숨긴 순번은 꼬리 보완 전에 뺀다. 잠든 세션은 최신 행부터 읽으며 여기서 거른다.
function* visibleNewestFirst(sessionId: string): Generator<AetherEvent> {
  const ranges = sessionManager.hiddenRangesOf(sessionId);
  for (const ev of store.eventsNewestFirst(sessionId)) if (!ranges.length || !isHiddenSeq(ev.seq, ranges)) yield ev;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform", // no-transform: 프록시/압축 변형 금지(load-bearing)
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // 프록시 버퍼링 방지
};

streamRouter.get("/:id/stream", (req: Request, res: Response) => {
  const id = String(req.params.id);
  // since 정규화: 음수/NaN/Infinity/소수 → 0(='처음부터', 계약상 의미). ?since=-1로 전량 replay 강제 차단.
  const raw = Number(req.query.since);
  const since = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;

  const liveNow = sessionManager.get(id);
  if (!liveNow && !sessionManager.hasDiskSession(id)) return res.status(404).json({ error: st("routes.common.sessionNotFound") });

  // 이 세션 이벤트의 수명주기 판정(라이브 전용 드롭·정규화)은 provider codec이 한다(D2.6).
  //   provider는 세션 lifecycle 동안 고정이라 연결 시작 시 1회 조회로 충분하다. 미등록 provider면 여기서
  //   throw되므로 SSE 헤더를 쓰기 *전에* 조회한다(헤더 전송 후 throw = 응답 불능).
  let codec;
  try {
    codec = sessionManager.codecOf(id);
  } catch (err) {
    void reportResponseError(res, err, { component: "routes", operation: "session.stream.codec", session_id: id });
    return res.status(500).json({ error: st("routes.common.sessionNotFound") });
  }

  let diskReplay: AetherEvent[] | null = null;
  // 처음 진입(since=0)은 전체를 올리지 않고 최신 행부터 꼬리와 보완 사건만 읽는다.
  let diskTail: ReturnType<typeof sliceTailFrom> | null = null;
  if (!liveNow) {
    try {
      if (since === 0) diskTail = sliceTailFrom(visibleNewestFirst(id), codec);
      else diskReplay = store.readEventsSince(id, since);
    } catch (err) {
      // 읽기에 실패하면 빈 재생으로 속이지 않고 원인을 남긴 뒤 503으로 답한다.
      void reportResponseError(res, err, { component: "routes", operation: "session.stream.replay", session_id: id });
      return res.status(503).json({ error: st("routes.sessions.diaryUnavailable") });
    }
  }

  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();

  let replayFailed = false;
  let attachFailed = false;
  let closed = false;
  let backpressured = false;
  let viewing = false;
  let lastSeq = since; // 마지막으로 흘려보낸 seq — 디스크→라이브 승격 시 gap replay 기준
  let unsub: (() => void) | null = null;
  let attached: LiveSession | null = null; // 현재 구독 중인 LiveSession 인스턴스(종료→재생성 감지용)
  let promotePoll: ReturnType<typeof setInterval> | null = null;

  // 역압(backpressure) 가드: 느린 클라에서 res.write가 false면 비필수 토큰 미리보기(partial)만 드롭하고
  // 필수 이벤트는 항상 전송. write 실패(EPIPE 등)는 try/catch로 격리해 프로세스를 죽이지 않는다.
  const write = (ev: AetherEvent) => {
    if (closed) return;
    if (ev.seq <= lastSeq) return;
    if (backpressured && codec.isLiveOnly(ev)) return;
    let ok = false;
    let encoding = true;
    try {
      // 클라이언트 봉투: 원본 msg 없이 정규화 events(+ 제어 사건). SSE id는 raw seq 유지(cursor 불변).
      const chunk = `id: ${ev.seq}\ndata: ${JSON.stringify(toWireEvent(ev, codec))}\n\n`;
      encoding = false;
      ok = res.write(chunk);
    } catch (error) {
      if (encoding) void reportError(error, { component: "routes", operation: "session.stream.encode", session_id: id });
      // 전송 중 연결 종료는 정상 정리다.
      cleanup();
      return;
    }
    if (ev.seq > lastSeq) lastSeq = ev.seq;
    if (!ok && !backpressured) {
      backpressured = true;
      res.once("drain", () => (backpressured = false));
    }
  };

  // 초기 진입(since=0) replay는 꼬리만 — 잘린 앞 구간 정보는 backlog_info로 클라에 알려 무한스크롤 페이징 유도.
  //   재연결(since>0)·재부착 gap replay는 전량(연속성 보장이 우선, 양도 작음).
  //   숨긴 순번은 꼬리 보완 전에 뺀다(살아 있는 세션은 replayNewestFirst, 잠든 세션은 visibleNewestFirst).
  let backlogInfo: { oldestSeq: number; hasOlder: boolean } | null = null;

  // 라이브 (재)부착 — 구독을 replay보다 먼저(동기 구간 gap 제거). lastSeq 이후 누락분은 replaySince로 보충한다.
  //   이미 보낸 순번은 write가 다시 보내지 않는다.
  //   재부착(인스턴스 교체) 시 옛 구독을 먼저 해제해 중복 fanout·구독 누수를 막는다.
  let firstAttach = true;
  const attachLive = (s: LiveSession) => {
    unsub?.();
    attached = s;
    unsub = s.subscribe(write);
    if (firstAttach && since === 0) {
      // 첫 진입은 잠든 세션과 같은 꼬리 규칙을 쓰되, 전체를 올리지 않고 최신부터 읽는다.
      const t = sliceTailFrom(s.replayNewestFirst(), codec);
      backlogInfo = { oldestSeq: t.oldestSeq, hasOlder: t.hasOlder };
      for (const ev of t.evs) write(ev);
    } else {
      for (const ev of s.replaySince(lastSeq)) write(ev);
    }
    firstAttach = false;
  };

  // ⚠️ no-transform·heartbeat: 클라가 *볼 수 있는* named 이벤트로 보낸다(':ping' 코멘트는 EventSource가 무시 → half-open
  //   워치독에 무용). AetherEvent는 default 'message'(event 필드 없음)라 분리됨. 역압/종료 시 skip.
  const hb = setInterval(() => {
    endIfRevoked(req, res, cleanup); // 역압 검사보다 앞 — 느린 연결이 자격 검사를 피하지 못하게
    if (closed || backpressured) return;
    try {
      res.write("event: ping\ndata: {}\n\n");
    } catch {
      // 끊긴 클라이언트 연결은 구독만 정리한다.
      cleanup();
    }
  }, config.heartbeatMs);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    if (promotePoll) clearInterval(promotePoll);
    unsub?.();
    if (viewing) {
      sessionManager.dropViewer(id);
      viewing = false;
    }
  }
  req.on("close", cleanup);
  res.on("error", cleanup); // 클라 RST/EPIPE 시 소켓 error → 정리(미처리 시 프로세스 크래시)

  if (liveNow) {
    attachLive(liveNow);
  } else {
    // 디스크 세션(재시작/재부팅 후 복원): 과거 read-only replay. 이후 message로 resume되면 아래 폴이 라이브로 승격.
    //   → 프론트 재연결 불필요·투명. 승격 전까지는 heartbeat로 연결 유지(워치독이 죽은 연결 감지).
    if (diskTail) {
      backlogInfo = { oldestSeq: diskTail.oldestSeq, hasOlder: diskTail.hasOlder };
      for (const ev of diskTail.evs) write(ev);
    } else {
      for (const ev of diskReplay ?? []) write(ev);
    }
    // 처음 재생은 여기서 끝난다. 깨어날 때 보낸 순번 뒤를 다시 자르지 않는다.
    firstAttach = false;
  }

  // 초기 백로그 절단 정보(named) — caught_up 전에 보내 클라가 페이징 상태(oldestSeq·hasOlder)를 세팅하게.
  if (!closed && backlogInfo) {
    try {
      res.write(`event: backlog_info\ndata: ${JSON.stringify(backlogInfo)}\n\n`);
    } catch {
      // 끊긴 클라이언트 연결은 구독만 정리한다.
      cleanup();
    }
  }

  // 초기 백로그 replay 완료 표지 — 클라가 로딩 오버레이를 해제하고 하단으로 점프(대량 replay 중 O(n²) 리렌더·버벅임 방지).
  //   named 이벤트(ping과 동형)라 AetherEvent 데이터평면·seq와 분리 + 비영속(이 연결 한정). SSE 순서 보장상 위
  //   replay message들이 모두 디스패치된 뒤 클라의 caught_up 리스너가 발화한다. 재부착(promotePoll)에선 재전송 안 함.
  //   이 표지는 최초 연결과 끊김 뒤 새 SSE 연결 모두 반드시 지나므로, 화면·서버 계약 버전을 알릴 유일한 공통 지점이다.
  if (!closed) {
    let markingViewer = false;
    try {
      res.write(`event: caught_up\ndata: ${JSON.stringify({ contractVersion: AGENT_EVENT_CONTRACT_VERSION })}\n\n`);
      if (!viewing) {
        markingViewer = true;
        sessionManager.addViewer(id);
        viewing = true;
      }
    } catch (error) {
      if (markingViewer) void reportError(error, { component: "routes", operation: "session.viewer.add", session_id: id });
      // 전송 중 끊긴 클라이언트 연결은 구독만 정리한다.
      cleanup();
    }
  }

  // 인스턴스-변경 폴(양 분기 공통): ① 디스크→live 승격 ② 크래시/종료된 live가 getOrResume로 *같은 id의 새 인스턴스*로
  //   재생성될 때 재부착. ②가 없으면 기존 SSE가 죽은 옛 session.subs에 묶여 새 이벤트를 못 받는 고아 구독이 된다
  //   (heartbeat는 옛 res로 계속 나가 클라 워치독도 안 깸 → 자동복구 불가, 새로고침해야 보임). gap은 attachLive가 보충.
  // 잠든 세션은 마지막으로 보낸 순번 뒤의 사건을 읽어 보낸다. 읽기 실패나 삭제는 연결을 끊지 않는다.
  promotePoll = setInterval(() => {
    if (closed) return;
    const live = sessionManager.get(id);
    if (live && live !== attached) {
      // 읽기 실패로 서버가 꺼지지 않게 한다. attached를 비워 다음 폴에서 다시 붙인다.
      try {
        attachLive(live);
        attachFailed = false;
      } catch (error) {
        attached = null;
        if (!attachFailed) void reportError(error, { component: "routes", operation: "session.stream.attach", session_id: id });
        attachFailed = true;
      }
      return;
    }
    if (live) return;
    try {
      for (const ev of store.readEventsSince(id, lastSeq)) write(ev);
      replayFailed = false;
    } catch (error) {
      if (!replayFailed) void reportError(error, { component: "routes", operation: "session.stream.poll", session_id: id });
      replayFailed = true;
      /* 읽기 실패는 연결을 유지한다 */
    }
  }, 1000);
});
