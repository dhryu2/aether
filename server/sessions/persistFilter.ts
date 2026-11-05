/**
 * 영속(events.jsonl) 직전 축소 중 **provider와 무관한 부분** — 유저 메시지에 딸린 첨부.
 * 라이브/SSE에는 full payload(base64 그대로), 디스크 영속본에만 크기/타입 stub으로 줄인다.
 *
 * 8d-2 분리: 8d-1까지 이 파일은 Claude SDK 메시지 축소(tool_use·tool_result 클램프, 시크릿 redact)까지
 *   같이 들고 있었다. 그 부분은 전부 Claude 메시지 모양에 매여 있어 `providers/claude/persistFilter.ts`로
 *   옮겼다. 여기 남은 것은 Aether가 직접 만드는 `user_msg` 이벤트의 축소뿐이라 어느 provider에서나 같다.
 */
import { isControlEvent, type AetherEvent } from "../types";
import { st } from "../i18n";
import { notice } from "../i18n/notice";

/**
 * base64 이미지(스크린샷 등)는 줄당 수십~수백 KB → 디스크엔 크기/타입만 남긴 stub. 라이브/SSE는 full(이미지 그대로).
 * provider 축소기도 도구 결과 안의 이미지에 같은 표기를 써야 하므로 여기서 내보낸다(표기 이중화 방지).
 */
export const imageStub = (dataLen: number, mediaType: unknown) =>
  st("notice.persist.imageStub", { mediaType: typeof mediaType === "string" ? mediaType + " " : "", sizeKB: Math.round(dataLen / 1024) });

/** 잘라낸 자리에 남기는 표시 — 원래 길이와 남긴 길이를 함께 적어 나중에 "왜 짧지"를 알 수 있게 한다. */
const clampMark = (origLen: number, keptLen: number) => st("notice.persist.clampMark", { origLen, keptK: Math.floor(keptLen / 1024) });

/** 사전의 표식 문구(양쪽 언어)에서 만든 판별식 — 문구가 바뀌어도 사전만 고치면 된다. */
const CLAMP_MARK_RE = new RegExp(
  Object.values(notice["notice.persist.clampMark"])
    .map((t) => t.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{origLen\}|\{keptK\}/g, "\\d+"))
    .map((r) => `(?:${r})$`)
    .join("|"),
);

/** 잘라낸 표식으로 끝나는 문자열인가 — 저장 때 잘린 내용인지 가린다(언어와 무관). 표식은 항상 끝에 붙으므로 본문 중간의 같은 글은 잡지 않는다. */
export const isClampedString = (s: string) => CLAMP_MARK_RE.test(s);

/**
 * 긴 문자열을 상한까지 자른다. 상한 이하면 원본을 그대로 돌려준다(같은 참조 — 불필요한 복사 방지).
 * 8e에서 공용으로 올렸다: 명령 출력·파일 패치를 줄이는 규칙이 provider마다 따로 있으면 한쪽만 고치게 된다.
 */
export function clampString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + clampMark(s.length, max) : s;
}

/**
 * user_msg 첨부 이미지를 디스크 영속본에서 stub 치환(base64 → 크기/타입 마커). 라이브/SSE는 full.
 * 도구 결과 이미지 축소와 동일한 '디스크만 축소' 비대칭 — events.jsonl 비대화 방지.
 */
export function filterUserMsgForPersist(ev: AetherEvent): AetherEvent {
  if (!isControlEvent(ev, "user_msg")) return ev;
  const hasImg = ev.images && ev.images.length;
  const hasDoc = ev.documents && ev.documents.length;
  if (!hasImg && !hasDoc) return ev;
  return {
    ...ev,
    ...(hasImg && {
      images: ev.images!.map((im) => (typeof im.data === "string" && im.data.length > 256 ? { ...im, data: imageStub(im.data.length, im.media_type) } : im)),
    }),
    ...(hasDoc && {
      documents: ev.documents!.map((d) => (typeof d.data === "string" && d.data.length > 256 ? { ...d, data: imageStub(d.data.length, d.media_type) } : d)),
    }),
  };
}
