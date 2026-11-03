import { FailureTracker } from "../../providers/failureTracking";
/**
 * Codex codec (Phase 8e · D2.6/D2.3) — Codex 이벤트의 수명주기 판정 일체.
 *
 * Claude codec과 같은 계약을 채운다. 네 가지를 답한다:
 *   normalize      화면·검색이 볼 형태로 바꾼다(`normalize/codex.ts`에 위임)
 *   isLiveOnly     화면에만 흘리고 디스크엔 안 남길 것인가(글자 단위 중간 조각·진행 스냅샷)
 *   endsTurn       이 이벤트로 한 턴이 끝나는가(`turn/completed`)
 *   persistFilter  디스크에 남길 때 어떻게 줄이는가(자르기·비밀 가리기·계정 알림 선별)
 *
 * ── 디스크에 남기는 정책(D2.3) ──
 * 라이브 화면에는 받은 그대로 흘리고, 디스크에는 줄인 것만 남긴다. 이 비대칭은 Claude 경로가 이미 쓰는
 * 규칙과 같다. 줄이는 대상은 셋이다.
 *   ① 커지는 값 — 명령 출력·파일 패치·MCP 인자와 결과. 상한을 넘으면 자르고 잘랐다는 표시를 남긴다.
 *   ② 비밀 파일 — 읽은 명령의 출력과 파일의 변경 내용은 통째로 지운다.
 *   ③ 세션 대화가 아닌 것 — 계정 알림은 세션 기록에 남기지 않는다. 단, 사용 한도 갱신은 대화 중 차단
 *      이유를 새로 고친 뒤에도 보여야 하므로 남긴다.
 *
 * Claude codec과 달리 이벤트 사이에 기억할 상태가 없다. Claude는 "비밀 파일을 읽은 도구 호출"과 "그 결과"가
 * 서로 다른 이벤트로 와서 앞 이벤트를 기억해야 하지만, Codex는 명령과 그 출력이 한 항목에 함께 온다.
 */
import { config } from "../../config";
import { isAuthError } from "../../auth/loginParse";
import { st } from "../../i18n";
import { isControlEvent, type AetherEvent } from "../../types";
import { clampString } from "../persistFilter";
import { commandTokens, isSecretPath } from "../secretPaths";
import { normalizeCodex } from "../normalize/codex";
import type { EventShape, ProviderEventCodec, ProviderPersistFilter } from "./types";
import type { Provider } from "../../../shared/agentEvent";
import type { ServerNotification } from "../../codex/protocol/ServerNotification";
import type { ThreadItem } from "../../codex/protocol/v2/ThreadItem";

const jsonFailures = new FailureTracker();

/** Codex 원본 봉투. 코어는 kind를 닫지 않으므로 이 파일 안에서만 좁힌다. */
type CodexRaw = { kind: "codex"; msg: { method?: unknown } };

function isCodexRaw(ev: EventShape): ev is CodexRaw {
  return ev.kind === "codex";
}

/** codex 봉투일 때만 알림 메서드 이름. 그 외(Aether 제어 이벤트)는 undefined. */
function methodOf(ev: EventShape): string | undefined {
  if (!isCodexRaw(ev)) return undefined;
  const msg = ev.msg;
  return typeof msg?.method === "string" ? msg.method : undefined;
}

/**
 * 화면에만 흘리고 디스크엔 안 남길 알림.
 *
 * 두 종류다. 하나는 **글자 단위 중간 조각**(모델이 답을 조금씩 뱉는 것) — 완성본이 곧 `item/completed`로
 * 오므로 남길 이유가 없고, 남기면 같은 내용이 두 벌로 쌓인다. 다른 하나는 **진행 스냅샷**(지금까지의 누적
 * 변경분 같은 것) — 매번 전체를 다시 보내므로 마지막 것만 의미가 있고, 그 마지막은 완료 항목에 들어 있다.
 */
const LIVE_ONLY_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "command/exec/outputDelta",
  "process/outputDelta",
  "turn/diff/updated",
]);

/**
 * 세션 기록에 남기지 않는 알림 — 대화가 아니라 계정 상태다.
 * `account/rateLimits/updated`만은 현재 세션이 왜 차단됐는지 복원할 수 있어야 해서 남긴다. Claude도 같은
 * 성격의 알림을 남기므로, 이 예외가 없으면 provider마다 새로 고침 뒤의 배너가 달라진다.
 */
const NEVER_PERSIST_METHODS = new Set(["account/updated", "account/login/completed"]);

const redactedResult = () => st("notice.persist.redactedResult");

/**
 * 이 이벤트가 실패를 말한다면 그 사유 문구. 실패가 아니면 빈 문자열.
 * Codex는 실패를 두 곳으로 알린다 — 재시도 불가 오류 알림(`error`)과 실패로 끝난 턴(`turn/completed`).
 * 인증 만료 판정이 이 문구를 읽는다. 성공한 턴의 본문에 우연히 같은 낱말이 있어도 여기 걸리지 않는다.
 */
function failureText(ev: EventShape): string {
  const method = methodOf(ev);
  const msg = (ev as { msg?: unknown }).msg as ServerNotification | undefined;
  if (!msg) return "";
  if (method === "error") {
    const p = (msg as Extract<ServerNotification, { method: "error" }>).params;
    return [p.error?.message, p.error?.additionalDetails].filter(Boolean).join(" ");
  }
  if (method === "turn/completed") {
    const { turn } = (msg as Extract<ServerNotification, { method: "turn/completed" }>).params;
    return turn.status === "failed" ? (turn.error?.message ?? "") : "";
  }
  return "";
}

/** 명령줄을 토큰으로 쪼개 비밀 파일 경로가 섞였는지 본다(Claude의 Bash 검사와 같은 규칙). */
function commandTouchesSecret(command: string): boolean {
  for (const tok of commandTokens(command)) if (isSecretPath(tok)) return true;
  return false;
}

/**
 * JSON 값을 상한 안으로. 직렬화 길이가 상한을 넘으면 잘린 문자열 하나로 바꾼다
 * (문자열도 올바른 JSON 값이라 구조를 깨지 않는다). 상한 이하면 원본을 그대로 돌려준다.
 */
function clampJson(value: unknown, max: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return clampString(value, max);
  let text: string;
  try {
    text = JSON.stringify(value);
    jsonFailures.clear("session.json.encode");
  } catch (error) {
    jsonFailures.report(error, { component: "session", operation: "session.json.encode", severity: "warning" });
    return value; // 직렬화할 수 없는 값은 건드리지 않는다(어차피 디스크에도 그대로 안 나간다)
  }
  return text.length > max ? clampString(text, max) : value;
}

/** ThreadItem을 디스크용으로 줄인다. 바뀐 게 없으면 원본 참조를 그대로 돌려준다(불필요한 복사 방지). */
function shrinkItem(item: ThreadItem, max: number): ThreadItem {
  switch (item.type) {
    case "commandExecution": {
      const command = clampString(item.command, max);
      // 비밀 파일을 읽은 명령의 출력은 그 파일 내용 자체다 — 자르는 것으로는 부족해 통째로 가린다.
      const output =
        item.aggregatedOutput == null
          ? item.aggregatedOutput
          : commandTouchesSecret(item.command)
            ? redactedResult()
            : clampString(item.aggregatedOutput, max);
      // 같은 항목에 명령을 쪼개 놓은 사본이 함께 오므로 같은 길이 상한을 적용한다.
      let actionsChanged = false;
      const commandActions = item.commandActions.map((a) => {
        const masked = clampString(a.command, max);
        if (masked === a.command) return a;
        actionsChanged = true;
        return { ...a, command: masked };
      });
      if (command === item.command && output === item.aggregatedOutput && !actionsChanged) return item;
      return { ...item, command, aggregatedOutput: output, commandActions };
    }
    case "fileChange": {
      let changed = false;
      const changes = item.changes.map((c) => {
        // 비밀을 담은 파일의 변경 내용은 그대로가 곧 비밀이다 — 자르지 않고 지운다.
        const diff = isSecretPath(c.path) ? redactedResult() : clampString(c.diff ?? "", max);
        if (diff === c.diff) return c;
        changed = true;
        return { ...c, diff };
      });
      return changed ? { ...item, changes } : item;
    }
    case "mcpToolCall": {
      const args = clampJson(item.arguments, max);
      const result = clampJson(item.result, max) as typeof item.result;
      if (args === item.arguments && result === item.result) return item;
      return { ...item, arguments: args as typeof item.arguments, result };
    }
    case "dynamicToolCall": {
      const args = clampJson(item.arguments, max);
      const contentItems = clampJson(item.contentItems, max) as typeof item.contentItems;
      if (args === item.arguments && contentItems === item.contentItems) return item;
      return { ...item, arguments: args as typeof item.arguments, contentItems };
    }
    case "webSearch": {
      const results = clampJson(item.results, max) as typeof item.results;
      return results === item.results ? item : { ...item, results };
    }
    default:
      // agentMessage(최종 답변)·reasoning·plan·userMessage는 그대로 남긴다 — 스크롤백에서 읽을 값이다.
      return item;
  }
}

/**
 * Codex 영속 축소기 — 이벤트 사이에 기억할 상태가 없다.
 * 그래서 `restore`는 할 일이 없다(계약상 존재해야 하므로 비워둔다).
 */
class CodexPersistFilter implements ProviderPersistFilter {
  restore(): void {
    /* 이벤트 간 상태 없음 — 명령과 그 출력이 한 항목에 함께 오므로 앞 이벤트를 기억할 필요가 없다. */
  }

  apply(ev: AetherEvent): AetherEvent | null {
    // 승인 카드에 실린 명령도 디스크에서는 줄인다 — 카드 payload는 원본 명령을 그대로 담는다.
    if (isControlEvent(ev, "permission_request")) {
      const cmd = ev.req.input?.command;
      if (typeof cmd !== "string") return ev;
      const safe = clampString(cmd, config.persistMaxFieldChars);
      return safe === cmd ? ev : { ...ev, req: { ...ev.req, input: { ...ev.req.input, command: safe } } };
    }
    if (ev.kind !== "codex") return ev;
    const msg = ev.msg as ServerNotification;
    if (NEVER_PERSIST_METHODS.has(msg.method)) return null;
    if (msg.method !== "item/started" && msg.method !== "item/completed") return ev;
    const max = config.persistMaxFieldChars;
    const item = shrinkItem(msg.params.item, max);
    if (item === msg.params.item) return ev;
    return { ...ev, msg: { ...msg, params: { ...msg.params, item } } } as AetherEvent;
  }
}

/**
 * Codex 원본 이벤트를 해석하는 codec. Codex 실행기를 빌려 쓰는 provider(Ollama)는 자기 이름으로 하나 만든다.
 * 판정 규칙은 원본 모양에만 달려 있어 같고, 정리된 이벤트에 찍히는 provider 이름만 다르다.
 */
export function codexCodecFor(provider: Provider): ProviderEventCodec {
  return { ...codexCodec, provider, normalize: (ev) => normalizeCodex(ev, provider) };
}

export const codexCodec: ProviderEventCodec = {
  provider: "codex",
  normalize: (ev) => normalizeCodex(ev),
  isLiveOnly: (ev) => {
    const m = methodOf(ev);
    return m !== undefined && LIVE_ONLY_METHODS.has(m);
  },
  // app-server 계약: 정상·실패·중단 어느 쪽이든 한 턴은 turn/completed로 끝난다(8a 실측).
  endsTurn: (ev) => methodOf(ev) === "turn/completed",
  isAuthExpired: (ev) => isAuthError(failureText(ev)),
  persistFilter: () => new CodexPersistFilter(),
};
