// 새 세션으로 넘기기 문자열 — HandoffSheet.tsx, WorkMenu.tsx, PaneMenu.tsx, UsageHandoff.tsx, Sidebar.tsx, Composer.tsx, Bubbles.tsx, store.ts.
import type { Dict } from './types'

export const handoff: Dict = {
  // 메뉴
  'handoff.usage.action': { ko: '넘기기', en: 'Hand off' },
  'handoff.menu.item': { ko: '새 세션으로 넘기기…', en: 'Hand off to a new session…' },
  'handoff.menu.busy': { ko: '작업 중이라 지금은 넘길 수 없어요', en: 'Working now, so it cannot be handed off yet' },
  'handoff.menu.inProgress': { ko: '이미 넘기는 중이에요', en: 'A handoff is already in progress' },
  'handoff.menu.cancel': { ko: '넘기기 취소', en: 'Cancel handoff' },
  'handoff.menu.showResult': { ko: '넘기기 결과 열기', en: 'Open handoff result' },
  'handoff.menu.openPrev': { ko: '이전 세션 열기', en: 'Open previous session' },
  'handoff.menu.openNext': { ko: '다음 세션 열기', en: 'Open next session' },

  // 창
  'handoff.title': { ko: '새 세션으로 넘기기', en: 'Hand off to a new session' },
  'handoff.focus.label': { ko: '다음에 할 일 (선택)', en: 'What to do next (optional)' },
  'handoff.focus.placeholder': { ko: '비워 두면 AI가 대화를 보고 정해요. 결정할 것이 있으면 대화에서 먼저 물어봐요', en: 'Leave it empty and the AI decides from the conversation. If something needs your decision, it asks in the conversation first' },
  'handoff.to.label': { ko: '넘길 곳', en: 'Receiver' },
  'handoff.to.same': { ko: '같은 AI · 같은 폴더', en: 'Same AI · same folder' },
  'handoff.to.copyOnly': { ko: '다른 컴퓨터에서 쓰기 (복사만)', en: 'Use on another computer (copy only)' },
  'handoff.to.copyOnlyNote': { ko: '새 세션을 만들지 않고 인계서 글만 보여 드려요', en: 'No new session is made. You only get the handoff text' },
  'handoff.to.ai': { ko: 'AI', en: 'AI' },
  'handoff.to.sameAi': { ko: '같은 AI', en: 'Same AI' },
  'handoff.to.folder': { ko: '폴더', en: 'Folder' },
  'handoff.to.originalFolder': { ko: '원본 폴더에서 이어 가요', en: 'Continues in the original folder' },
  'handoff.copyDirty': {
    ko: '이 세션의 복사본에 원본 폴더에 반영하지 않은 변경이 있어요. 새 세션은 원본 폴더에서 시작하므로 먼저 반영하세요. 넘기기는 막지 않아요.',
    en: 'This session’s copy has changes not yet applied to the original folder. The new session starts in the original folder, so apply them first. The handoff is not blocked.',
  },
  'handoff.cancel': { ko: '취소', en: 'Cancel' },
  'handoff.submit': { ko: '넘기기', en: 'Hand off' },
  'handoff.submitting': { ko: '넘기는 중', en: 'Handing off' },
  'handoff.error': { ko: '넘기지 못했어요: {error}', en: 'Could not hand off: {error}' },

  // 한도 대기
  'handoff.waiting.title': { ko: '한도가 풀리면 인계서를 써요', en: 'The handoff will be written when the limit lifts' },
  'handoff.waiting.body': { ko: '지금은 사용 한도에 막혀 있어요. 풀리는 시간에 자동으로 이어서 새 세션을 만들어요. 입력창 위 막대에서 시간을 바꾸거나 취소할 수 있어요.', en: 'The usage limit is blocking right now. At the reset time it continues automatically and makes the new session. You can change the time or cancel from the bar above the input.' },
  'handoff.waiting.ok': { ko: '확인', en: 'OK' },

  // 결과(복사)
  'handoff.result.title': { ko: '인계서', en: 'Handoff' },
  'handoff.result.label': { ko: '인계서 글', en: 'Handoff text' },
  'handoff.result.copy': { ko: '복사', en: 'Copy' },
  'handoff.result.copied': { ko: '복사됨', en: 'Copied' },
  'handoff.result.copyFailed': { ko: '복사하지 못했어요. 글을 직접 선택해 복사하세요', en: 'Could not copy. Select the text and copy it yourself' },
  'handoff.result.close': { ko: '닫기', en: 'Close' },
  'handoff.result.loading': { ko: '불러오는 중', en: 'Loading' },
  'handoff.result.failed': { ko: '불러오지 못했어요: {error}', en: 'Could not load: {error}' },
  'handoff.result.skeleton': { ko: 'AI가 인계서를 쓰지 못해 Aether가 대화 기록으로 초안을 만들었어요', en: 'The AI could not write it, so Aether built an outline from the record' },

  // 알림
  'handoff.toast.waiting': { ko: '한도가 풀리면 인계서를 써요', en: 'The handoff will be written when the limit lifts' },
  'handoff.toast.asking': { ko: '넘기기 전에 확인할 것이 있어요', en: 'There is something to confirm before the handoff' },
  'handoff.toast.stopped': { ko: '넘기기를 취소했어요. 새 세션은 만들지 않았어요', en: 'Handoff stopped. No new session was made' },
  'handoff.toast.swapped': { ko: '새 세션으로 넘겼어요. 인계서를 확인하고 보내세요', en: 'Handed off to a new session. Check the handoff and send it' },
  'handoff.toast.ready': { ko: '새 세션이 준비됐어요', en: 'The new session is ready' },
  'handoff.toast.open': { ko: '열기', en: 'Open' },

  // 입력창 위 안내 줄
  'handoff.note.model': { ko: '이전 세션에서 쓴 인계서예요. 확인하고 보내세요', en: 'This handoff was written in the previous session. Check it, then send' },
  'handoff.note.skeleton': { ko: 'AI가 인계서를 쓰지 못해 Aether가 대화 기록으로 초안을 만들었어요. 확인하고 보내 주세요', en: 'The AI could not write it, so Aether made an outline. Check it, then send' },
  'handoff.note.open': { ko: '이전 세션 열기', en: 'Open previous session' },

  // 대화 속 접힌 카드
  'handoff.card.title': { ko: '이전 세션에서 넘겨받음', en: 'Handed over from the previous session' },
  'handoff.card.open': { ko: '이전 세션 열기', en: 'Open previous session' },
}
