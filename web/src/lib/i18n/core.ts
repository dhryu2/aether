// 비-컴포넌트(코어) 문자열 — lib/store.ts, lib/sse.ts, lib/api.ts, lib/hooks.ts, lib/format.ts, lib/types.ts.
//   이들은 React 밖이라 import한 t()를 사용(useT 훅 아님).
import type { Dict } from './types'

export const core: Dict = {
  // 상대시각(format.relTime)
  'core.relTime.now': { ko: '방금', en: 'just now' },
  'core.relTime.minutes': { ko: '{n}분 전', en: '{n}m ago' },
  'core.relTime.hours': { ko: '{n}시간 전', en: '{n}h ago' },
  'core.relTime.days': { ko: '{n}일 전', en: '{n}d ago' },
  'core.relTime.weeks': { ko: '{n}주 전', en: '{n}w ago' },
  'core.relTime.months': { ko: '{n}개월 전', en: '{n}mo ago' },
  'core.relTime.years': { ko: '{n}년 전', en: '{n}y ago' },

  // 도구 결과 메타(format.toolResultMeta)
  'core.toolResult.failed': { ko: '실패', en: 'Failed' },
  'core.toolResult.done': { ko: '완료', en: 'Done' },
  'core.toolResult.lines': { ko: '{n}줄', en: '{n} lines' },
  'core.toolResult.chars': { ko: '{n}자', en: '{n} chars' },

  // store 액션 문자열
  'core.sw.notReady': { ko: '알림 기능을 준비하지 못했어요', en: 'Service worker not ready' },
  // 고를 수 있는 단계는 모델마다 다르므로 목록을 문구에 박지 않고 지금 모델이 알려준 것을 채워 넣는다.
  'core.effort.unknown': {
    ko: '알 수 없는 Effort: "{arg}" — 이 모델이 지원하는 값: {list}',
    en: 'Unknown thinking effort: "{arg}" — supported by this model: {list}',
  },
  'core.notice.stopped': { ko: '응답을 중단했어요', en: 'Stopped' },
  'core.push.unsupported': { ko: '이 브라우저는 알림을 지원하지 않아요', en: 'This browser does not support push' },
  'core.push.noVapid': { ko: '이 서버는 알림을 보낼 준비가 안 돼 있어요', en: 'Push (VAPID) is not configured on the server' },
  'core.push.denied': { ko: '알림 권한이 거부됐어요', en: 'Notification permission was denied' },
  'core.push.enableFailed': { ko: '알림을 켜지 못했어요: ', en: 'Failed to enable push: ' },
  'core.push.disableFailed': { ko: '알림을 끄지 못했어요: ', en: 'Failed to disable push: ' },
}
