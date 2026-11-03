/**
 * Claude 이벤트의 영속(events.jsonl) 직전 축소 — 라이브/SSE에는 full payload, 디스크 영속본에만 축소·마스킹.
 * `stripMutationForPersist`(권한 카드 전용·provider 무관)와 동형의 '영속본만 축소' 비대칭(이미 수용된 보안 trade-off).
 *
 *  ① 클램프: tool_result.content · tool_use.input(content/command/old_string 등)의 거대 문자열을
 *           상한(config.persistMaxFieldChars)으로 절단. tool_result 내 base64 이미지는 stub으로 치환(줄당 수십~수백 KB).
 *           assistant text(최종 답변)·thinking은 보존(스크롤백 가치).
 *           → events.jsonl 무한성장의 주동인(대용량 tool_result·base64 이미지, 실측 최대 275KB/줄) + per-line 폭탄 차단.
 *  ② 시크릿 redact: 시크릿 경로(.env/.key 등 SECRET_DENY)를 읽은 tool_use의 결과(tool_result)를 디스크에서 치환.
 *           (canUseTool은 Read/안전 Bash엔 발화 안 하므로 권한 카드 redact가 못 잡는 경로를 영속단에서 보강.)
 *
 * 8d-2 이동: 8d-1까지 이 코드는 `sessions/persistFilter.ts`에 있었다. 내용은 전부 Claude SDK 메시지 모양
 *   (`type:"assistant"`·`tool_use`·`tool_result`·`Bash` 도구 이름·`file_path` 인자)에 매여 있는데 파일만 공통
 *   폴더에 있어, 경계 검사가 "아직 남은 결합점"으로 세고 있었다. 순수 이동이며 동작은 그대로다.
 *   provider가 달라도 같아야 하는 조각(첨부 stub 표기·문자열 자르기·시크릿 경로 판정)은
 *   공통 파일에 두고 여기서 가져다 쓴다 — 두 벌이 되면 한쪽만 고치는 순간 다른 쪽이 비밀을 평문으로 남긴다.
 */
import { isControlEvent, type AetherEvent } from "../../types";
import { commandTokens, isSecretPath } from "../../sessions/secretPaths";
import { clampString, imageStub } from "../../sessions/persistFilter";
import { CLAUDE_CONTENT_FIELDS } from "./mutationPreview";
import { st } from "../../i18n";

const redactedResult = () => st("notice.persist.redactedResult");

/**
 * 영속 시 본문을 버리고 stub만 남길 휘발성 system subtype — 워크플로/추론 진행 스트림(고빈도·스크롤백 가치 0).
 * 실측: 한 세션 events.jsonl의 33~37%가 이 둘. 라이브 SSE는 full(실시간 진행표시), 디스크는 {type,subtype} 스텁만.
 * 완전 제외(미영속)는 seq 재사용 위험(미완 턴 크래시 시 lastSeqFromDisk 후퇴)을 들이므로 stub으로 seq/ts 보존.
 */
const EPHEMERAL_SYSTEM_SUBTYPES = new Set(["thinking_tokens", "task_progress"]);

/** tool_use.input에서 클램프할 거대 문자열 후보 필드(시크릿/대용량이 담길 수 있음). */
const BIG_INPUT_FIELDS = ["content", "new_string", "old_string", "new_source", "command"];

/** tool_result.content(문자열 또는 블록 배열)를 클램프. text는 절단, base64 이미지는 stub 치환(디스크만). 변경 없으면 동일 참조 반환(no-op). */
function clampResultContent(content: unknown, max: number): unknown {
  if (typeof content === "string") return clampString(content, max);
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((blk) => {
      if (!blk || typeof blk !== "object") return blk;
      const o = blk as { type?: unknown; text?: unknown; source?: { data?: unknown; media_type?: unknown } };
      // base64 이미지: 거대 payload → 디스크엔 stub만(라이브/SSE는 full). text clamp와 동형의 '디스크만 축소' 비대칭.
      if (o.type === "image" && o.source && typeof o.source.data === "string") {
        changed = true;
        return { ...(blk as object), source: { ...(o.source as object), data: imageStub((o.source.data as string).length, o.source.media_type) } };
      }
      if (typeof o.text === "string") {
        const t = clampString(o.text, max);
        if (t !== o.text) { changed = true; return { ...(blk as object), text: t }; }
      }
      return blk;
    });
    return changed ? next : content;
  }
  return content;
}

/** tool_use.input의 거대 문자열 클램프. 변경 없으면 동일 참조. */
function clampToolUseInput(input: unknown, max: number): unknown {
  if (!input || typeof input !== "object") return input;
  const src = input as Record<string, unknown>;
  let out = src;
  const ensure = () => { if (out === src) out = { ...src }; };
  for (const k of BIG_INPUT_FIELDS) {
    if (typeof src[k] !== "string") continue;
    let v = src[k] as string;
    v = clampString(v, max);
    if (v !== src[k]) { ensure(); out[k] = v; }
  }
  if (Array.isArray(src.edits)) {
    let editsChanged = false;
    const ne = (src.edits as Array<Record<string, unknown>>).map((e) => {
      let eo = e;
      for (const k of ["old_string", "new_string"]) {
        if (typeof e?.[k] === "string") {
          const v = clampString(e[k] as string, max);
          if (v !== e[k]) { if (eo === e) eo = { ...e }; eo[k] = v; }
        }
      }
      if (eo !== e) editsChanged = true;
      return eo;
    });
    if (editsChanged) { ensure(); out.edits = ne; }
  }
  return out;
}

/** tool_use input에서 시크릿 판정 대상 문자열(경로/명령 토큰) 추출. */
function toolTargets(name: unknown, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const src = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "notebook_path", "path"]) if (typeof src[k] === "string") out.push(src[k] as string);
  // Bash: command를 토큰화해 각 토큰을 시크릿 경로로 검사(.env·id_rsa·*.key·credentials 등).
  if (name === "Bash" && typeof src.command === "string") {
    for (const tok of commandTokens(src.command as string)) out.push(tok);
  }
  return out;
}

/** assistant 메시지의 tool_use 중 '시크릿 경로를 읽는' 것의 id 목록(그 tool_result를 영속단에서 redact하기 위함). */
export function collectSecretToolUseIds(msg: unknown): string[] {
  const m = msg as { type?: string; message?: { content?: unknown } };
  if (m?.type !== "assistant" || !Array.isArray(m.message?.content)) return [];
  const ids: string[] = [];
  for (const b of m.message.content as Array<Record<string, unknown>>) {
    if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
    if (toolTargets(b.name, b.input).some(isSecretPath)) ids.push(b.id);
  }
  return ids;
}

/**
 * sdk 이벤트를 디스크 영속본으로 변환(클램프 + 시크릿 redact). 비-sdk·변경불요는 동일 참조 반환(no-op).
 * msg는 copy-on-write로 얕게 복제(바뀐 블록만 새로, 나머지는 참조 유지) — 거대 객체 deep clone 회피 + 원본 ev 불변.
 */
/**
 * 승인 카드에 실린 도구 인자에서 콘텐츠 필드를 지운다(8e — 예전엔 공통 `stripMutationForPersist`에 있었다).
 * 이름이 Claude 인자 스키마라 공통 자리에 두면 다른 provider의 인자가 마스킹 없이 남는다.
 * 실제 기록은 도구 결과 이벤트에 있으므로 여기서 지워도 잃는 정보가 없다.
 */
export function stripPermissionInputForPersist(ev: AetherEvent): AetherEvent {
  if (!isControlEvent(ev, "permission_request")) return ev;
  const req = ev.req;
  let input: Record<string, unknown> = req.input;
  let changed = false;
  const ensure = () => { if (!changed) { input = { ...input }; changed = true; } };
  for (const k of CLAUDE_CONTENT_FIELDS) {
    if (input && k in input) {
      ensure();
      delete input[k];
    }
  }
  if (input && Array.isArray(input.edits)) {
    ensure();
    input.edits = (input.edits as Array<Record<string, unknown>>).map((e) => {
      const { old_string: _o, new_string: _n, ...rest } = e;
      return rest;
    });
  }
  return changed ? { ...ev, req: { ...req, input } } : ev;
}

export function filterSdkForPersist(ev: AetherEvent, max: number, secretIds: ReadonlySet<string>): AetherEvent {
  if (ev.kind !== "sdk") return ev;
  const msg = ev.msg as { type?: string; subtype?: string; message?: { content?: unknown } };
  // 휘발성 진행 system 메시지(thinking_tokens·task_progress)는 디스크에 stub만 — 무거운 payload 제거(seq/ts 보존).
  if (msg?.type === "system" && typeof msg.subtype === "string" && EPHEMERAL_SYSTEM_SUBTYPES.has(msg.subtype)) {
    return { seq: ev.seq, ts: ev.ts, kind: "sdk", msg: { type: "system", subtype: msg.subtype } } as unknown as AetherEvent;
  }
  const t = msg?.type;
  if (t !== "assistant" && t !== "user") return ev;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return ev;
  let changed = false;
  const next = (content as Array<Record<string, unknown>>).map((b) => {
    if (t === "user" && b?.type === "tool_result") {
      if (typeof b.tool_use_id === "string" && secretIds.has(b.tool_use_id)) { changed = true; return { ...b, content: redactedResult() }; }
      const c = clampResultContent(b.content, max);
      if (c !== b.content) { changed = true; return { ...b, content: c }; }
      return b;
    }
    if (t === "assistant" && b?.type === "tool_use") {
      const ni = clampToolUseInput(b.input, max);
      if (ni !== b.input) { changed = true; return { ...b, input: ni }; }
      return b;
    }
    return b; // text·thinking·image 등 보존
  });
  if (!changed) return ev;
  return { ...ev, msg: { ...msg, message: { ...msg.message, content: next } } } as unknown as AetherEvent;
}
