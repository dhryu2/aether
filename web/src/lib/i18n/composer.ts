// 입력(컴포저) 문자열 — Composer.tsx, FindBar.tsx, lib/drafts.ts.
import type { Dict } from './types'

export const composer: Dict = {
  // 첨부 안내
  'composer.attachNote.rejected': { ko: '일부 파일을 첨부하지 못했어요. 이미지, PDF, 텍스트 파일만 가능하고 크기 제한이 있어요', en: 'Some files excluded (images/PDF/text-code only · size limit)' },
  'composer.attachNote.overflow': { ko: '첨부는 최대 {max}개까지 가능해요', en: 'Up to {max} attachments' },

  // 뒤 작업 띠(BackgroundTasksStrip.tsx)
  'composer.autoResume.next': { ko: '다음 시도 {time}', en: 'Next try {time}' },
  'composer.autoResume.gaveUp': { ko: '자동 재개를 3번 시도했지만 실패했어요. 확인이 필요해요', en: 'Auto-resume was blocked 3 times, needs your check' },
  'composer.autoResume.sendNow': { ko: '지금 보내기', en: 'Send now' },
  'composer.autoResume.edit': { ko: '시간과 메시지 변경', en: 'Change time · text' },
  'composer.autoResume.restartCut': { ko: '서버 재시작으로 작업이 끊겼어요', en: 'The server restarted and this task was cut off' },
  'composer.autoResume.continue': { ko: '이어 가기', en: 'Continue' },
  'composer.autoResume.cancel': { ko: '취소', en: 'Cancel' },
  'composer.autoResume.save': { ko: '저장', en: 'Save' },
  'composer.autoResume.close': { ko: '닫기', en: 'Close' },
  'composer.autoResume.timeLabel': { ko: '시간', en: 'Time' },
  'composer.autoResume.textLabel': { ko: '보낼 메시지', en: 'Message to send' },
  'composer.autoResume.handoffAction': { ko: '인계서 쓰기', en: 'Write handoff' },
  'composer.autoResume.editTime': { ko: '시간 변경', en: 'Change time' },
  'composer.autoResume.failed': { ko: '저장하지 못했어요', en: 'Could not save' },
  'composer.background.summary': { ko: '백그라운드 작업 {n}개 진행 중', en: '{n} tasks running in background' },
  'composer.background.running': { ko: '진행 중', en: 'Running' },
  'composer.background.kind.agent': { ko: '서브에이전트', en: 'Sub-agent' },
  'composer.background.kind.command': { ko: '명령', en: 'Command' },
  'composer.background.kind.other': { ko: '작업', en: 'Task' },
  'composer.background.stopAll': { ko: '모두 중지', en: 'Stop all' },
  'composer.background.stopAllLabel': { ko: '백그라운드 작업 모두 중지', en: 'Stop all background tasks' },
  'composer.background.stopOne': { ko: '중지', en: 'Stop' },
  'composer.background.stopOneLabel': { ko: '이 작업 중지: {desc}', en: 'Stop this task: {desc}' },
  'composer.background.announce.more': { ko: '백그라운드 작업 {n}개가 진행 중이에요.', en: '{n} tasks are running in the background.' },
  'composer.background.announce.less': { ko: '백그라운드 작업 하나가 끝났어요. 남은 작업은 {n}개예요.', en: 'A background task finished. {n} remaining.' },
  'composer.background.announce.none': { ko: '백그라운드 작업이 모두 끝났어요.', en: 'All background tasks have finished.' },

  // 승인 Y/N 퀵바
  'composer.permission.waiting': { ko: '승인 대기', en: 'Awaiting approval' },
  'composer.permission.deny': { ko: '거부', en: 'Deny' },
  'composer.permission.review': { ko: '카드 보기', en: 'View card' },

  // 첨부 미리보기
  'composer.attach.previewAlt': { ko: '첨부 미리보기', en: 'Attachment preview' },
  'composer.attach.remove': { ko: '첨부 제거', en: 'Remove attachment' },
  'composer.attach.text': { ko: '텍스트', en: 'Text' },
  'composer.attach.inlinePrefix': { ko: '첨부: {name}', en: 'Attachment: {name}' },

  // 중단(Stop) 버튼
  'composer.interrupt.aria': { ko: '중단', en: 'Stop' },
  // Esc를 한 번 눌러 무장된 상태 — 버튼이 "ESC"로 바뀌어 다음 한 번이 무엇을 할지 알린다.
  'composer.interrupt.armedAria': { ko: 'Esc를 한 번 더 누르면 중단돼요', en: 'Press Esc again to stop' },

  // ＋ 메뉴 — 파일 첨부
  'composer.plus.aria': { ko: '첨부 메뉴', en: 'Attachment menu' },
  'composer.plus.title': { ko: '파일 첨부', en: 'Attach a file' },
  'composer.attachButton.aria': { ko: '파일 첨부', en: 'Attach file' },
  'composer.plus.attachHint': { ko: '이미지, PDF, 텍스트 파일', en: 'Images, PDF, text files' },
  'composer.plus.browseLabel': { ko: '파일 보기', en: 'View Files' },
  'composer.plus.browseHint': { ko: '작업 폴더의 파일을 읽기 전용으로 열어요', en: 'Open files in the working folder, read-only' },

  // 전송 버튼
  'composer.queue.add': { ko: '대기열에 넣기', en: 'Add to Queue' },
  'composer.queue.textOnly': { ko: '대기열에는 글만 넣을 수 있어요', en: 'Only text can be queued' },
  'composer.queue.added': { ko: '대기열 {n}번째에 넣었어요', en: 'Added as #{n} in the queue' },
  'composer.queue.note': { ko: '이 세션은 작업 대기열에 들어 있어요', en: 'This session is in the task queue' },
  'composer.queue.view': { ko: '대기열 보기', en: 'View Queue' },
  'composer.send.aria': { ko: '전송', en: 'Send' },
  'composer.send.branch': { ko: '보내는 방법', en: 'How to send' },
  'composer.send.plain': { ko: '보내기', en: 'Send' },
  'composer.send.brief': { ko: '브리프로 보내기', en: 'Send as a brief' },
  'composer.send.briefSub': { ko: '확인할 내용을 정리해 묻고 진행해요', en: 'Lists what to confirm, asks, then proceeds' },
  'composer.send.more': { ko: '길게 누르거나 우클릭하면 브리프로 보낼 수 있어요', en: 'Press and hold, or right-click, to send as a brief' },
  'composer.slash.brief': { ko: '브리프 만들기', en: 'Make a brief' },

  // placeholder
  'composer.placeholder.loading': { ko: '대화를 불러오는 중…', en: 'Loading conversation…' },
  'composer.placeholder.queueShort': { ko: '대기열에 추가…', en: 'Add to queue…' },
  'composer.placeholder.messageShort': { ko: '메시지를 입력하세요', en: 'Type a message…' },
  'composer.placeholder.requiresAction': { ko: '위 카드에 답하세요. 메시지를 입력하면 대기열에 추가돼요', en: 'Respond to the card above, or type to queue…' },
  'composer.placeholder.running': { ko: '메시지를 입력하세요. 지금 응답이 끝나면 자동으로 전송돼요', en: 'Type a message. Sending queues it and it goes out after this turn' },
  'composer.placeholder.operation': { ko: '명령 실행 중이에요. 보낸 메시지는 끝난 뒤 자동으로 전송돼요', en: 'A command is running. Sending queues it and it goes out when the command finishes' },
  'composer.placeholder.idle': {
    ko: '메시지를 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈 · ``` 코드 블록 · / 명령)',
    en: 'Type a message…  (Enter to send · Shift+Enter for newline · code box · / for commands)',
  },
  'composer.mic.aria': { ko: '음성 입력', en: 'Dictate' },
  'composer.mic.title': {
    ko: '음성으로 입력해요. Chrome은 음성을 Google 서버로 보낼 수 있어요. Aether 서버로는 보내지 않아요.',
    en: 'Dictate into the box. Chrome may send audio to Google. It is not sent to this server.',
  },
  'composer.mic.stop': { ko: '음성 입력 중지', en: 'Stop dictation' },

  // 입력창 안의 코드 상자. plain은 언어를 안 적었을 때의 표시라 번역하지 않는다.
  'composer.code.collapse': { ko: '접기', en: 'Collapse' },
  'composer.code.expand': { ko: '펼치기', en: 'Expand' },
  'composer.code.copy': { ko: '복사', en: 'Copy' },
  'composer.code.copied': { ko: '복사됨', en: 'Copied' },

  // FindBar(세션 내 찾기)
  'composer.findBar.placeholder': { ko: '이 세션에서 찾기…', en: 'Find in this session…' },
  'composer.findBar.noResults': { ko: '결과 없음', en: 'No results' },
  'composer.findBar.prev': { ko: '이전', en: 'Previous' },
  'composer.findBar.next': { ko: '다음', en: 'Next' },
  'composer.findBar.close': { ko: '닫기', en: 'Close' },
}
