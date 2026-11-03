/**
 * Claude codec (Phase 8d-1 · D2.6) — 흩어져 있던 Claude 규약 판정을 여기 한 곳에 모은다.
 *
 * 옮겨온 판정과 원래 위치:
 *   isLiveOnly     ← `types.isPartialSdkEvent`(msg.type === "stream_event")
 *   endsTurn       ← `LiveSession.run`·`persistence.tailInfo`의 msg.type === "result"
 *   persistFilter  ← `LiveSession.ingest`가 직접 호출하던 collectSecretToolUseIds + filterSdkForPersist
 *   normalize      ← `normalize/claude.ts`(8b에서 이미 중앙 모듈, 여기선 계약에 끼워넣기만)
 *
 * 판정 내용은 8d-1 이전과 동일하다(동작 변경 0).
 */
import { config } from "../../config";
import { isAuthError } from "../../auth/loginParse";
import type { AetherEvent } from "../../types";
import { collectSecretToolUseIds, filterSdkForPersist, stripPermissionInputForPersist } from "../../providers/claude/persistFilter";
import { normalizeClaude } from "../normalize/claude";
import type { EventShape, ProviderEventCodec, ProviderPersistFilter } from "./types";

/** Claude 원본 봉투. 코어는 kind를 닫지 않으므로 이 파일 안에서만 좁힌다. */
type ClaudeRaw = { kind: "sdk"; msg: { type?: unknown } };

function isClaudeRaw(ev: EventShape): ev is ClaudeRaw {
  return ev.kind === "sdk";
}

/** sdk 봉투일 때만 SDK 메시지 타입. 그 외(Aether 제어 이벤트)는 undefined. */
function sdkType(ev: EventShape): string | undefined {
  if (!isClaudeRaw(ev)) return undefined;
  const msg = ev.msg;
  return typeof msg?.type === "string" ? msg.type : undefined;
}

/**
 * assistant가 시크릿 경로를 읽은 tool_use id를 누적해 뒤따르는 tool_result를 디스크에서 가린다.
 * (assistant → tool_result는 분리 메시지·순서 보장이라 영속 시점 추적으로 충분 — 8d 이전과 동일.)
 */
class ClaudePersistFilter implements ProviderPersistFilter {
  private readonly secretToolUseIds = new Set<string>();

  restore(ev: AetherEvent): void {
    if (ev.kind !== "sdk") return;
    for (const id of collectSecretToolUseIds(ev.msg)) this.secretToolUseIds.add(id);
  }

  apply(ev: AetherEvent): AetherEvent {
    this.restore(ev);
    // 승인 카드에 실린 도구 인자의 콘텐츠 필드도 디스크에선 지운다(8e — 인자 이름이 Claude 스키마라 여기 있다).
    if (ev.kind === "permission_request") return stripPermissionInputForPersist(ev);
    if (ev.kind !== "sdk") return ev;
    return filterSdkForPersist(ev, config.persistMaxFieldChars, this.secretToolUseIds);
  }
}

export const claudeCodec: ProviderEventCodec = {
  provider: "claude",
  normalize: normalizeClaude,
  // SDK 계약: SDKPartialAssistantMessage.type === "stream_event"(토큰 미리보기).
  isLiveOnly: (ev) => sdkType(ev) === "stream_event",
  // SDK 계약: 정상·실패·중단 어느 쪽이든 한 턴은 result 메시지로 끝난다.
  endsTurn: (ev) => sdkType(ev) === "result",
  // 세션을 깨우면 CLI가 턴과 무관하게 슬래시 명령 목록 갱신(system/commands_changed)을 보낸다.
  isTurnNeutral: (ev) => {
    if (sdkType(ev) !== "system") return false;
    return (ev as { msg?: { subtype?: unknown } }).msg?.subtype === "commands_changed";
  },
  isAuthExpired: (ev) => {
    if (sdkType(ev) !== "result") return false;
    const m = (ev as { msg?: unknown }).msg as { subtype?: string; result?: string; is_error?: boolean; errors?: string[] };
    // 실패한 턴만 본다 — 성공한 턴의 본문에 우연히 401 같은 글자가 있어도 만료가 아니다.
    const failed = !!m.is_error || (m.subtype !== undefined && m.subtype !== "success");
    if (!failed) return false;
    return isAuthError([m.errors?.join(" "), m.result, m.subtype].filter(Boolean).join(" "));
  },
  persistFilter: () => new ClaudePersistFilter(),
};
