// 알림(OS) 문자열 — 판정부(notify/). 제목은 대개 `{name} · <라벨>` 꼴.
import type { Dict } from "./types";

export const notify: Dict = {
  // 권한 요청
  "notify.permission.title": { ko: "{name} · 권한 요청", en: "{name} · Permission request" },
  "notify.permission.waiting": { ko: "{tool} 승인 대기", en: "{tool} awaiting approval" },

  // 질문
  "notify.question.title": { ko: "{name} · 질문", en: "{name} · Question" },
  "notify.question.waiting": { ko: "선택을 기다려요", en: "Waiting for your choice" },
  "notify.question.more": { ko: " (외 {n}개)", en: " (+{n} more)" },

  // 계획 검토 대기
  "notify.plan.title": { ko: "{name} · 계획 검토", en: "{name} · Plan review" },
  "notify.plan.waiting": { ko: "계획 승인을 기다려요", en: "Waiting for plan approval" },

  // 턴 완료
  "notify.done.title": { ko: "{name} · 완료", en: "{name} · Done" },
  "notify.done.generic": { ko: "응답이 끝났어요", en: "The response has finished" },

  // 턴 실패
  "notify.failed.title": { ko: "{name} · 실패", en: "{name} · Failed" },
  "notify.failed.overload": { ko: "서버 과부하(일시적) — 잠시 후 다시 시도하세요", en: "Server overloaded (temporary) — retry shortly" },
  "notify.failed.generic": { ko: "응답에 실패했어요", en: "The turn failed" },

  // 레이트리밋
  "notify.ratelimit.title": { ko: "{name} · 사용 한도 도달", en: "{name} · Rate limit reached" },
  "notify.ratelimit.body": {
    ko: "{type}에 도달했어요. 잠시 후 다시 시도하거나 더 가벼운 모델로 바꾸세요",
    en: "{type} limit — retry shortly or switch to a lighter model",
  },
  "notify.ratelimit.fallbackType": { ko: "사용 한도", en: "Usage" },

  // 자동 재개가 멈춤
  "notify.autoResume.gaveUp.title": { ko: "{name} · 자동 재개 멈춤", en: "{name} · Auto-resume stopped" },
  "notify.autoResume.gaveUp.body": { ko: "자동 재개를 3번 보냈지만 계속 막혔어요. 확인이 필요해요", en: "Auto-resume was sent 3 times but kept getting blocked. Please check" },
  "notify.autoResume.sendFailed.title": { ko: "{name} · 자동 재개 실패", en: "{name} · Auto-resume failed" },
  "notify.autoResume.sendFailed.body": { ko: "자동 재개를 보내지 못했어요. {detail}", en: "Could not send the auto-resume message. {detail}" },
  "autoResume.defaultText": { ko: "한도로 멈춘 곳부터 이어서 진행해", en: "Continue from where the limit stopped you" },
  "autoResume.restartText": { ko: "서버 재시작으로 끊긴 곳부터 이어서 진행해", en: "Continue from where the server restart cut you off" },
  "autoResume.restartCut": { ko: "서버 재시작으로 작업이 끊겼어요", en: "Cut off by a server restart" },

  // 비정상 종료
  "notify.crashed.title": { ko: "{name} · 비정상 종료", en: "{name} · Crashed" },
  "notify.crashed.generic": { ko: "세션이 비정상 종료됐어요", en: "The session crashed" },

  // 인증 만료
  "notify.auth.title": { ko: "{name} · {provider} 로그인 만료", en: "{name} · {provider} auth expired" },
  "notify.auth.body": {
    ko: "앱에서 {provider}에 다시 로그인하세요",
    en: "Re-authentication required — run 'Re-authenticate {provider}' in the app.",
  },

  // 컨텍스트 한계 임박
  "notify.ctx.title": { ko: "컨텍스트 한계 임박", en: "Context limit approaching" },
  "notify.ctx.body": {
    ko: "{name} 컨텍스트 {pct}% 사용 — /compact 또는 정리를 권해요",
    en: "{name} context {pct}% used — consider /compact or cleanup",
  },
  "notify.ctx.fallbackName": { ko: "세션", en: "Session" },
};
