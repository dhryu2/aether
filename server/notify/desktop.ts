import { reportError } from "../observability/report";
/**
 * 데스크톱 알림 출구 — 판정부가 만든 의도만 메모리 구독자에게 전달한다.
 * HTTP·pg·provider·판정 함수를 모른다.
 */
import type { NotifyIntent } from "./worthNotifying";

type Send = (intent: NotifyIntent) => void;

const subscribers = new Set<Send>();

/** 구독 등록. 반환은 해제. */
export function subscribeDesktopNotify(send: Send): () => void {
  subscribers.add(send);
  return () => {
    subscribers.delete(send);
  };
}

/** 구독자마다 try/catch. 한 명이 throw해도 나머지를 막지 않는다. 구독 0이면 no-op. */
export function emitDesktopNotify(intent: NotifyIntent): void {
  for (const send of subscribers) {
    try {
      send(intent);
    } catch (e) {
      void reportError(e, { component: "notify", operation: "notify.desktop.deliver", severity: "warning" });
      console.error("[aether] 데스크톱 알림 구독자 실패:", e);
    }
  }
}
