// 메시지 스트림 렌더링 문자열 — components/stream/**, Markdown.tsx, UnifiedDiff.tsx.
import type { Dict } from './types'

export const stream: Dict = {
  'stream.contractRefresh.required': { ko: '화면과 서버 버전이 맞지 않아요. 새로고침해 주세요.', en: 'Refresh required. This screen is incompatible with the server.' },

  // 레이트리밋 타입 라벨
  'stream.rateLimit.fiveHour': { ko: '5시간 한도', en: '5-hour limit' },
  'stream.rateLimit.sevenDay': { ko: '7일 한도', en: '7-day limit' },
  'stream.rateLimit.sevenDayOpus': { ko: '7일 Opus 한도', en: '7-day Opus limit' },
  'stream.rateLimit.sevenDaySonnet': { ko: '7일 Sonnet 한도', en: '7-day Sonnet limit' },
  'stream.rateLimit.sevenDayOauthApps': { ko: '7일 연동 앱 한도', en: '7-day connected-apps limit' },
  'stream.rateLimit.overage': { ko: '추가 사용량', en: 'Overage' },
  'stream.rateLimit.default': { ko: '사용 한도', en: 'Usage limit' },
  // 이름 없이 길이만 알려주는 서비스의 창 라벨(8h) — "최근 7일 한도"처럼 부른다.
  'stream.rateLimit.lastDays': { ko: '최근 {n}일 한도', en: 'Last {n} days' },
  'stream.rateLimit.lastHours': { ko: '최근 {n}시간 한도', en: 'Last {n} hours' },
  'stream.rateLimit.lastMinutes': { ko: '최근 {n}분 한도', en: 'Last {n} minutes' },
  'stream.rateLimit.rejected': {
    ko: '사용 한도 도달 ({meta}). 잠시 후 다시 시도하거나 /model로 더 가벼운 모델로 바꾸세요.',
    en: 'Rate limit reached ({meta}). Retry shortly or switch to a lighter model with /model.',
  },

  // 리셋 시각
  'stream.reset.minutes': { ko: '~{min}분 후 초기화', en: 'Resets in ~{min}m' },
  'stream.reset.at': { ko: '{date} 초기화', en: 'Resets {date}' },

  // notice 배너
  'stream.notice.modelChanged': { ko: '모델을 {detail}(으)로 변경했어요. 다음 응답부터 적용돼요', en: 'Model changed to {detail}. Applies from the next response' },
  'stream.notice.effortChanged': { ko: 'Effort를 {detail}(으)로 변경했어요. 다음 응답부터 적용돼요', en: 'Effort changed to {detail}. Applies from the next response' },
  'stream.notice.permissionChanged': { ko: '권한 모드를 {mode}(으)로 바꿨어요', en: 'Permission mode set to {mode}' },
  'stream.notice.stopped': { ko: '응답을 중단했어요', en: 'Stopped. The in-progress turn was halted' },
  // provider 이름은 세션의 provider에서 온다(8d-3 ④). 서버가 보낸 detail이 있으면 그쪽이 우선이라 이건 폴백 문구다.
  'stream.notice.authExpired': { ko: '{provider} 로그인이 만료됐어요. 다시 로그인해 주세요.', en: '{provider} authentication has expired. Re-authentication is required.' },
  'stream.notice.resumed': { ko: '이전 대화를 이어서 재개했어요.', en: 'Resumed the previous conversation.' },
  'stream.notice.newSession': { ko: '새로 시작해요.', en: 'Starting a new session.' },
  'stream.notice.crashed': { ko: '세션이 비정상 종료됐어요.', en: 'The session terminated unexpectedly.' },
  'stream.notice.interrupted': {
    ko: '서버 재시작이나 오류로 응답이 중단됐어요. 메시지를 보내면 이어서 진행해요',
    en: 'The in-progress turn was interrupted (backend restart/crash). Send a message to continue.',
  },
  'stream.notice.compacted': { ko: '대화 기록을 압축했어요.', en: 'Compacted the conversation history.' },
  'stream.notice.modelFallback': {
    ko: '{original} 안전장치가 응답을 차단해 {fallback}(으)로 자동 전환됐어요{cat}. 일반 코딩이나 보안 작업도 잘못 차단될 수 있어요. 되돌리려면 모델 메뉴에서 다시 선택하세요.',
    en: '{original} safety guardrails blocked the response, so it auto-switched to {fallback}{cat}. The guardrails are still broad and may misfire on normal coding/security work. Reselect in the model chip to revert.',
  },
  'stream.notice.modelFallbackCategory': { ko: ' (분류: {cat})', en: ' (category: {cat})' },

  // 재시도 인디케이터
  'stream.retry.overloaded': { ko: '서버 과부하로 재시도 중', en: 'Retrying due to server overload' },
  'stream.retry.error': { ko: '재시도 중 ({error})', en: 'Retrying ({error})' },
  'stream.retry.progress': { ko: '{text} ({attempt}/{max})', en: '{text} ({attempt}/{max})' },

  // 빈 세션 히어로
  'stream.emptyHero.newName': { ko: '새 세션', en: 'New session' },

  // 맨 아래로 버튼
  'stream.scrollBottom': { ko: '맨 아래로', en: 'Scroll to bottom' },

  // 첨부(이미지·문서)
  'stream.attachment.imageEphemeral': { ko: '이 이미지는 저장되지 않아 보낸 화면에서만 볼 수 있어요', en: 'This image is not persisted to disk (shown live only at send time).' },
  'stream.attachment.imageLabel': { ko: '이미지 (저장 안 됨)', en: 'Image (not persisted)' },
  'stream.attachment.imageAlt': { ko: '첨부 이미지', en: 'Attached image' },
  'stream.attachment.docEphemeral': { ko: '이 문서는 저장되지 않아 보낸 화면에서만 볼 수 있어요', en: 'This document is not persisted to disk (shown live only at send time).' },
  'stream.attachment.docLabel': { ko: 'PDF (저장 안 됨)', en: 'PDF · not persisted' },
  'stream.attachment.pdf': { ko: 'PDF', en: 'PDF' },

  // 유저 버블
  'stream.userBubble.autoSent': { ko: 'Aether가 자동으로 보냄', en: 'Sent automatically by Aether' },
  'stream.userBubble.autoStop': { ko: '중단', en: 'Stop' },
  'stream.userBubble.resend': { ko: '수정해서 다시 보내기', en: 'Resend · edit' },
  'stream.userBubble.resendTitle': { ko: '입력창에 불러와 수정한 뒤 다시 보내기', en: 'Load into the composer to edit and resend' },
  'stream.userBubble.copy': { ko: '메시지 복사', en: 'Copy my message' },
  'stream.userBubble.rewind': { ko: '여기까지 되돌리기', en: 'Rewind to here' },
  'stream.userBubble.rewindTitle': { ko: '이 메시지 뒤의 대화와, 백업해 둔 파일 변경을 되돌려요', en: 'Rewind the later chat and saved file changes' },

  // 대기 큐 버블
  'stream.queued.cancel': { ko: '대기 취소', en: 'Cancel queued message' },
  'stream.queued.images': { ko: '사진 {count}장', en: 'Images: {count}' },
  'stream.queued.title': { ko: '대기 중: 현재 응답이 끝나면 자동으로 전송돼요', en: 'Queued — will send automatically once the current turn finishes' },
  'stream.queued.edit': { ko: '대기 메시지 수정', en: 'Edit queued message' },
  'stream.queued.sendNow': { ko: '지금 보내기', en: 'Send queued messages now' },

  // 도구런
  'stream.toolRun.failedCount': { ko: '{count}개 실패', en: '{count} failed' },
  'stream.toolRun.collapse': { ko: '도구 사용 {count}회 접기', en: 'Collapse {count} actions' },
  'stream.toolRun.expandTitle': { ko: '도구 사용 내역 펼치기', en: 'Expand actions' },
  'stream.toolRun.count': { ko: '도구 사용 {count}회', en: '{count} actions' },

  // 팀 작업 카드 (ToolKind task)
  'stream.team.role.explore': { ko: '탐색', en: 'Explore' },
  'stream.team.role.implement': { ko: '구현', en: 'Implement' },
  'stream.team.role.review': { ko: '리뷰', en: 'Review' },
  'stream.team.role.generic': { ko: '작업', en: 'Task' },
  'stream.team.status.running': { ko: '실행 중', en: 'Running' },
  'stream.team.status.waiting': { ko: '답변 대기', en: 'Waiting on you' },
  'stream.team.status.done': { ko: '완료', en: 'Done' },
  'stream.team.status.failed': { ko: '실패', en: 'Failed' },
  'stream.team.files': { ko: '수정한 파일', en: 'Files touched' },
  'stream.team.noSummary': { ko: '요약이 아직 없어요', en: 'No summary yet' },

  // 결과 푸터
  'stream.result.failed': { ko: '실패', en: 'Failed' },
  'stream.result.success': { ko: '완료', en: 'Done' },
  'stream.result.tokens': { ko: '{tok} 토큰', en: '{tok} tokens' },
  'stream.result.overloaded': { ko: '서버 과부하(일시적) · ', en: 'Server overload (temporary) · ' },

  // 인증 만료 배너
  'stream.reasoning.label': { ko: '생각 과정', en: 'Thinking' },
  'stream.plan.label': { ko: '계획', en: 'Plan' },
  'stream.todo.leftover': { ko: '남은 항목 {n}개', en: '{n} unchecked items' },
  'stream.authExpired.reauth': { ko: '다시 로그인', en: 'Re-authenticate' },

  // running 오브
  'stream.runningOrb.text': { ko: '생각하는 중…', en: 'running · thinking…' },
  'stream.runningOrb.workingText': { ko: '작업하는 중…', en: 'running · working…' },
  'stream.runningOrb.waitingText': { ko: '답을 기다리는 중…', en: 'waiting for your answer…' },
  'stream.runningOrb.goAnswer': { ko: '답하러 가기', en: 'Go to answer' },

  // 스켈레톤 · 이전 대화 로딩
  'stream.skeleton.loading': { ko: '대화 불러오는 중', en: 'Loading conversation' },
  'stream.loadingMask': { ko: '대화를 불러오는 중…', en: 'Loading conversation…' },
  'stream.olderLoading': { ko: '이전 대화 불러오는 중', en: 'Older messages' },

  // 코드블록 복사
  'stream.copyCode': { ko: '코드 복사', en: 'Copy code' },
  // 답변 전체 복사 — 답 아래 아이콘. 마우스를 올리면 copyHint가 검게 뜬다. 길게 누르거나 우클릭하면 보통 글로 옮긴다.
  'stream.copyResponse': { ko: '복사', en: 'Copy' },
  'stream.copyHint': { ko: '복사 · 길게 누르면 서식 없이', en: 'Copy · hold for plain text' },
  'stream.copied': { ko: '복사됨', en: 'Copied' },
  'stream.copiedPlain': { ko: '서식 없이 복사됨', en: 'Copied as plain text' },
  'stream.code.plain': { ko: '코드', en: 'Code' },
  'stream.code.wrap': { ko: '줄바꿈', en: 'Wrap lines' },
  'stream.code.unwrap': { ko: '한 줄로', en: 'Scroll long lines' },
  'stream.code.collapse': { ko: '접기', en: 'Collapse' },
  'stream.code.expand': { ko: '펼치기', en: 'Expand' },
  'stream.code.download': { ko: '파일로 저장', en: 'Download file' },

  // diff 미리보기
  'stream.diff.secretHidden': { ko: '비밀 정보가 있는 경로라 미리보기를 숨겼어요', en: 'Secret path, content preview hidden' },
  'stream.diff.binary': { ko: '바이너리 파일이라 미리보기가 없어요', en: 'Binary file, no preview' },
  'stream.diff.truncated': { ko: '파일이 커서 변경 내용을 생략했어요', en: 'File too large, diff omitted (truncated)' },
  'stream.diff.noPreview': { ko: '변경 미리보기 없음', en: 'No change preview' },
  'stream.diff.inexact': { ko: '미리보기가 실제 결과와 다를 수 있어요', en: 'Preview may differ from the actual result (inexact)' },
}
