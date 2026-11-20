// 앱 크롬(내비게이션) 문자열 — Sidebar.tsx, TopBar.tsx, UsageChip.tsx, ConnectionIndicator.tsx, App.tsx, EmptyHero.tsx, main.tsx.
import type { Dict } from './types'

export const nav: Dict = {
  // 세션 카드 상태 라벨(Sidebar.tsx metaText)
  'nav.session.status.unreachable': { ko: '열 수 없음', en: 'Unreadable' },
  'nav.session.status.waiting': { ko: '답변 필요', en: 'Awaiting response' },
  'nav.session.status.running': { ko: '작업 중', en: 'Working' },
  'nav.session.status.background': { ko: '백그라운드 작업 중 · {n}개', en: 'Working in background · {n}' },
  'nav.session.status.active': { ko: '활성', en: 'Active' },
  'nav.session.status.interrupted': { ko: '미재개', en: 'Not resumed' },
  'nav.session.status.crashed': { ko: '비정상 종료', en: 'Crashed' },
  'nav.session.status.ended': { ko: '종료됨', en: 'Ended' },
  'nav.session.status.idle': { ko: '쉬는 중', en: 'Idle' },
  'nav.session.status.broken': { ko: '끊김', en: 'Disconnected' },

  // 기다린 시간(WaitAge) — 상대 시간만
  'nav.wait.now': { ko: '방금', en: 'just now' },
  'nav.wait.minutes': { ko: '{n}분째', en: '{n} min' },
  'nav.wait.hours': { ko: '{n}시간째', en: '{n} hr' },
  'nav.wait.yesterday': { ko: '어제부터', en: 'since yesterday' },

  // 세션 카드 액션 버튼
  'nav.session.rename': { ko: '이름 바꾸기', en: 'Rename' },
  'nav.session.archive': { ko: '보관', en: 'Archive' },
  'nav.session.unarchive': { ko: '보관 해제', en: 'Unarchive' },
  'nav.session.archiveBusy': { ko: '작업이 끝난 뒤에 보관할 수 있어요', en: 'Available once the work finishes' },
  'nav.toast.archived': { ko: '세션을 보관했어요', en: 'Work archived' },
  'nav.toast.archivedHint': { ko: '「보관됨」에서 다시 볼 수 있어요', en: 'Find it under Archived' },
  'nav.toast.undo': { ko: '실행 취소', en: 'Undo' },
  'nav.toast.unarchived': { ko: '보관을 해제했어요', en: 'Unarchived' },
  'nav.session.archivedBanner': {
    ko: '보관된 세션이에요. 이어서 대화하려면 보관을 해제하세요.',
    en: 'This work is archived. Unarchive it to continue.',
  },
  'nav.session.reset': { ko: '세션 초기화', en: 'Reset work' },
  'nav.session.resetTitle': {
    ko: '세션 초기화 — 같은 폴더·설정으로 대화만 새로 시작',
    en: 'Reset work — start a new conversation with the same folder/settings',
  },
  'nav.session.delete': { ko: '세션 삭제', en: 'Delete work' },
  'nav.session.menu': { ko: '세션 메뉴', en: 'Work menu' },
  'nav.session.openBeside': { ko: '옆에 열기', en: 'Open beside' },
  'nav.topbar.openBeside': { ko: '옆에 열기', en: 'Open beside' },
  'nav.split.close': { ko: '패널 닫기', en: 'Close pane' },
  'nav.split.zoom': { ko: '이 패널 확대', en: 'Zoom this pane' },
  'nav.split.unzoom': { ko: '원래대로', en: 'Restore layout' },
  'nav.split.zoomedNote': { ko: '패널 확대됨', en: 'Pane zoomed' },
  'nav.split.unzoomedNote': { ko: '원래대로', en: 'Layout restored' },
  'nav.split.othersWaiting': { ko: '다른 패널 {n}개 대기', en: '{n} other panes waiting' },
  'nav.split.waitingSuffix': { ko: '대기', en: 'waiting' },
  'nav.split.paneLabel': { ko: '패널 {n}, {title}', en: 'Pane {n}, {title}' },
  'nav.split.paneLabelWaiting': { ko: '패널 {n}, {title}, {age} 대기', en: 'Pane {n}, {title}, waiting {age}' },
  'nav.split.menu': { ko: '패널 메뉴', en: 'Pane menu' },
  'nav.split.moveLeft': { ko: '왼쪽으로', en: 'Move left' },
  'nav.split.moveRight': { ko: '오른쪽으로', en: 'Move right' },
  'nav.split.swapWith': { ko: '{n}번 패널과 바꾸기', en: 'Swap with pane {n}' },
  'nav.split.replaceSession': { ko: '다른 세션으로 바꾸기', en: 'Replace with another session' },
  'nav.split.back': { ko: '뒤로', en: 'Back' },
  'nav.split.noOtherSession': { ko: '바꿀 수 있는 세션이 없어요', en: 'No other session to show' },
  'nav.split.hiddenChip': { ko: '패널 {n}개 숨김', en: '{n} panes hidden' },
  'nav.split.hiddenChipTitle': { ko: '화면이 좁아 숨겨진 패널이에요. 누르면 그 패널로 전환해요', en: 'Hidden because the window is narrow. Click to switch to it' },
  'nav.split.openedAt': { ko: '{n}번 패널에 열었어요', en: 'Opened in pane {n}' },
  'nav.split.movedTo': { ko: '{n}번 패널로 옮겼어요', en: 'Moved to pane {n}' },
  'nav.split.swapped': { ko: '{a}번 패널과 {b}번 패널을 바꿨어요', en: 'Swapped pane {a} and pane {b}' },
  'nav.split.replacedAt': { ko: '{n}번 패널을 다른 세션으로 바꿨어요', en: 'Replaced pane {n}' },
  'nav.split.replacingToast': { ko: '{n}번 패널을 바꿔 열었어요', en: 'Replaced pane {n}' },
  'nav.sidebar.openBeside': { ko: '옆에 열기', en: 'Open beside' },
  'nav.sidebar.openBesideReplace': { ko: '{n}번 패널을 바꿔 옆에 열기', en: 'Open beside, replacing pane {n}' },
  'nav.sidebar.rowTitle': { ko: '{mod}+클릭 또는 {mod}+Enter: 옆에 열기', en: '{mod}+click or {mod}+Enter: open beside' },
  'nav.sidebar.paneNo': { ko: '패널 {n}', en: 'Pane {n}' },
  'nav.session.namePlaceholder': { ko: '세션 이름', en: 'Work name' },
  'nav.session.new': { ko: '새 세션', en: 'New work' },
  'nav.session.untitled': { ko: '새 세션', en: 'New session' },
  'nav.session.isolated': { ko: '복사본', en: 'Copy' },
  'nav.session.needsApply': { ko: '반영 필요', en: 'Needs apply' },
  'nav.session.applyBlocked': { ko: '원본 폴더에 적용할 수 없음', en: 'Original not ready' },
  'nav.topbar.workspaceApply': { ko: '원본 폴더에 반영', en: 'Apply to original' },
  'nav.topbar.workspaceDiscard': { ko: '복사본 버리기', en: 'Discard copy' },
  'nav.topbar.workspaceApplyTitle': {
    ko: '복사본의 변경을 원래 고른 폴더에 적용해요. 원본 폴더에 다른 변경이 있으면 실패해요.',
    en: 'Apply the copy’s changes to the original folder. Fails if the original folder has other changes.',
  },
  'nav.topbar.workspaceDiscardTitle': {
    ko: '확인하면 복사본 폴더를 버려요. 반영하지 않은 변경도 사라지고, 원본 폴더는 바뀌지 않아요.',
    en: 'After confirmation, the copy folder is removed. Unapplied changes are discarded. The original folder is not changed.',
  },

  // 사이드바
  'nav.sidebar.closeList': { ko: '세션 목록 닫기', en: 'Close work list' },
  'nav.sidebar.collapse': { ko: '세션 목록 접기', en: 'Collapse session list' },
  'nav.sidebar.expand': { ko: '세션 목록 펼치기', en: 'Expand session list' },
  'nav.sidebar.waitingRail': { ko: '대기 중인 세션', en: 'Sessions waiting' },
  'nav.sidebar.railItem': { ko: '{title}, {status} {age}', en: '{title}, {status} {age}' },
  'nav.sidebar.railMore': { ko: '대기 세션 {n}개 더 보기', en: '{n} more waiting' },
  'nav.sidebar.loading': { ko: '불러오는 중…', en: 'Loading…' },
  'nav.sidebar.emptyTitle': { ko: '세션이 없어요.', en: 'No work yet.' },
  'nav.sidebar.emptyHint': { ko: '＋ 새 세션으로 시작하세요.', en: '＋ Start with a new work item.' },
  'nav.sidebar.unknownProject': { ko: '경로 없음', en: 'No folder' },
  'nav.sidebar.expandProject': { ko: '{name} 펼치기, 세션 {n}개', en: 'Expand {name}, {n} work items' },
  'nav.sidebar.collapseProject': { ko: '{name} 접기, 세션 {n}개', en: 'Collapse {name}, {n} work items' },
  'nav.sidebar.currentProject': { ko: '{name}, 세션 {n}개. 지금 보는 프로젝트', en: '{name}, {n} work items. Current project' },
  'nav.sidebar.addToProject': { ko: '{name}에 세션 추가', en: 'Add work to {name}' },
  'nav.sidebar.sessionCount': { ko: '세션 {n}개', en: '{n} work items' },
  'nav.sidebar.archived': { ko: '보관됨', en: 'Archived' },
  'nav.sidebar.archivedAria': { ko: '보관됨, 세션 {n}개', en: 'Archived, {n} items' },
  'nav.sidebar.archivedMeta': { ko: '{folder} · 보관 {when}', en: '{folder} · archived {when}' },
  'nav.sidebar.search': { ko: '세션 검색', en: 'Search work' },
  'nav.sidebar.searchEmpty': { ko: '검색된 세션이 없어요.', en: 'No matching work found.' },
  'nav.sidebar.bucket.source': { ko: '원본 폴더', en: 'Original folder' },
  'nav.sidebar.bucket.copy': { ko: '복사본', en: 'Copies' },
  'nav.sidebar.expandBucket': { ko: '{name} 펼치기, 세션 {n}개', en: 'Expand {name}, {n} work items' },
  'nav.sidebar.collapseBucket': { ko: '{name} 접기, 세션 {n}개', en: 'Collapse {name}, {n} work items' },
  'nav.sidebar.expandProjectCurrent': {
    ko: '{name} 펼치기, 세션 {n}개. 지금 보는 프로젝트',
    en: 'Expand {name}, {n} work items. Current project',
  },
  'nav.sidebar.collapseProjectCurrent': {
    ko: '{name} 접기, 세션 {n}개. 지금 보는 프로젝트',
    en: 'Collapse {name}, {n} work items. Current project',
  },
  'nav.sidebar.attention.waiting': { ko: '대기 {n}', en: 'Waiting {n}' },
  'nav.sidebar.attention.running': { ko: '일함 {n}', en: 'Working {n}' },
  'nav.sidebar.attention.done': { ko: '완료 {n}', en: 'Done {n}' },
  'nav.sidebar.attention.failed': { ko: '실패 {n}', en: 'Failed {n}' },

  // 상단바
  'nav.topbar.permissionsTitle': {
    ko: '이 세션은 권한을 모두 무시해요(승인 카드 없이 파일 쓰기·명령 실행). 권한 칩에서 다른 모드로 바꿀 수 있어요.',
    en: 'This session bypasses all permissions (file writes and commands run without approval cards). Switch to another mode from the permissions chip.',
  },
  // 작업 폴더 설정에 등록된 자동승인 목록 때문에 일부 도구가 카드 없이 실행되는 경우(8d-3 ⑥ⓕ).
  //   전면 우회(권한 칩의 모두 허용)와 달리 어느 폴더를 열었느냐로 정해진다.
  'nav.topbar.autoApproveLabel': { ko: '자동 승인 {count}', en: 'Auto-approve {count}' },
  'nav.topbar.autoApproveTitle': {
    ko: '이 작업 폴더의 설정에 자동 승인 규칙 {count}개가 있어요({scopes}). 해당하는 도구는 승인 카드 없이 실행돼요. 나머지 변경 작업은 여전히 카드로 물어봐요.',
    en: 'This working folder has {count} auto-approve rule(s) ({scopes}). Tools matching them run without an approval card. Everything else still asks.',
  },
  // 규칙 목록이 아니라 기본 동작 자체가 승인을 건너뛰게 설정된 경우(더 센 표시).
  'nav.topbar.autoApproveModeLabel': { ko: '자동 승인 {mode}', en: 'Auto-approve {mode}' },
  'nav.topbar.autoApproveModeTitle': {
    ko: '이 작업 폴더의 설정이 승인 기본 동작을 "{mode}"로 바꿨어요({scopes}). 규칙 목록과 무관하게 상당수 도구가 승인 카드 없이 실행돼요(등록된 규칙은 {count}개).',
    en: 'This working folder sets the default permission mode to "{mode}" ({scopes}). Many tools run without an approval card regardless of the rule list ({count} rules registered).',
  },
  'nav.topbar.policyScope.user': { ko: '전체 설정', en: 'global settings' },
  'nav.topbar.policyScope.project': { ko: '이 폴더 설정', en: 'this folder' },
  'nav.topbar.policyScope.local': { ko: '이 폴더 개인 설정', en: 'this folder (personal)' },
  'nav.topbar.attentionChip': { ko: '확인 필요 {n}건', en: 'Needs you {n}' },
  'nav.topbar.attentionChipTitle': {
    ko: '답변을 기다리는 세션 — 누르면 그 대화로 가요',
    en: 'Work waiting for you — tap to open that conversation',
  },
  'nav.topbar.brain': { ko: '워크스페이스', en: 'Workspace' },
  'nav.topbar.brainTitle': {
    ko: '워크스페이스 — 끝난 작업의 변경과 실패를 모아 보기',
    en: 'Workspace — review changes and failures from finished work',
  },
  'nav.sidebar.searchPast': { ko: '지난 대화 검색', en: 'Search past conversations' },
  'nav.topbar.openSessionList': { ko: '세션 목록 열기', en: 'Open work list' },
  'nav.topbar.findInSession': { ko: '이 세션에서 찾기', en: 'Find in this session' },
  'nav.topbar.findInSessionTitle': { ko: '이 세션에서 찾기 ({mod}+F)', en: 'Find in this session ({mod}+F)' },
  'nav.topbar.export': { ko: '대화 다운로드', en: 'Download conversation' },
  'nav.topbar.settings': { ko: '설정', en: 'Settings' },

  // 사용량 칩
  'nav.usage.loadingTitle': { ko: '컨텍스트 사용률 불러오는 중', en: 'Loading context usage' },
  'nav.usage.pctTitle': { ko: '컨텍스트 사용률 {pct}%', en: 'Context usage {pct}%' },
  'nav.usage.warnSuffix': {
    ko: ' — 한도에 가까워요. /compact를 권장해요',
    en: ' — approaching the limit (running /compact soon is recommended)',
  },
  'nav.usage.noDataTitle': { ko: '컨텍스트 사용률(첫 응답 후 표시)', en: 'Context usage (shown after a turn runs)' },

  // 할 일 칩 — 에이전트가 만든 할 일 목록의 진행 상황
  'nav.autoResume.at': { ko: '{time} 자동 재개', en: 'Auto-resume {time}' },
  'nav.autoResume.gaveUp': { ko: '확인 필요', en: 'Needs your check' },
  'nav.autoResume.restartCut': { ko: '재시작으로 끊김', en: 'Cut off by restart' },
  'nav.autoResume.restartCutAria': { ko: '서버 재시작으로 작업이 끊겼어요. 이어 가려면 여세요', en: 'The server restarted and this task was cut off. Open to continue' },
  'nav.autoResume.atAria': { ko: '한도가 풀리면 {time}에 자동으로 이어 가요', en: 'Resumes automatically at {time} when the limit lifts' },
  'nav.autoResume.gaveUpAria': { ko: '자동 재개가 3번 모두 막혀 멈췄어요. 확인이 필요해요', en: 'Auto-resume stopped after 3 blocked tries. Please check' },
  'nav.todo.progress': { ko: '체크리스트 {done}/{total}', en: 'To-do {done}/{total}' },
  'nav.todo.progressShort': { ko: '{done}/{total}', en: '{done}/{total}' },
  'nav.todo.left': { ko: '{n}개 남음', en: '{n} left' },
  'nav.todo.aria': { ko: '체크리스트 {total}개 중 {done}개 완료', en: '{done} of {total} to-dos done' },
  'nav.todo.title': { ko: '체크리스트', en: 'To-do' },
  'nav.todo.now': { ko: '진행 중', en: 'Working on' },
  'nav.todo.all': { ko: '전체 목록', en: 'All items' },
  'nav.todo.status.pending': { ko: '대기', en: 'Waiting' },
  'nav.todo.status.in_progress': { ko: '진행 중', en: 'In progress' },
  'nav.todo.status.completed': { ko: '완료', en: 'Done' },

  // 연결 인디케이터
  'nav.conn.connecting': { ko: '연결 중', en: 'Connecting' },
  'nav.conn.reconnecting': { ko: '재연결 중', en: 'Reconnecting' },
  'nav.conn.offline': { ko: '오프라인', en: 'Offline' },

  // 빈 세션 히어로
  'nav.emptyHero.title': { ko: '{name} 시작', en: 'Start {name}' },
  'nav.emptyHero.desc': { ko: '메시지를 입력해 대화를 시작하세요.', en: 'Type a message to start the conversation.' },

  // App.tsx — 로드마스크
  'nav.app.loadMask.reconnectingLabel': { ko: '재연결 중', en: 'Reconnecting' },
  'nav.app.loadMask.loadingLabel': { ko: '세션 불러오는 중', en: 'Loading session' },
  'nav.app.loadMask.reconnectingText': { ko: '재연결 중…', en: 'Reconnecting…' },
  'nav.app.loadMask.loadingText': { ko: '불러오는 중…', en: 'Loading…' },

  // App.tsx — 비활성 상태
  'nav.app.noActive.desc': { ko: '세션을 고르거나 새로 시작하세요.', en: 'Select a work item or start a new one.' },

  // AuthGate. 앱에 들어가기 전의 전체 화면
  'nav.auth.loginBody': {
    ko: 'Aether에 로그인하려면 비밀번호를 입력하세요.',
    en: 'Enter your password to open Aether.',
  },
  'nav.auth.passwordLabel': { ko: '비밀번호', en: 'Password' },
  'nav.auth.showPassword': { ko: '비밀번호 보이기', en: 'Show password' },
  'nav.auth.hidePassword': { ko: '비밀번호 숨기기', en: 'Hide password' },
  'nav.auth.forgot': { ko: '비밀번호를 잊었어요', en: 'Forgot your password?' },
  'nav.auth.forgotHelp': {
    ko: 'Aether를 설치한 컴퓨터에서 아래 파일을 실행해 새 비밀번호를 정하세요.\n맥: 홈 폴더의 Applications/Aether/bin/Reset Aether Password.command\n윈도우: %LOCALAPPDATA%\\Programs\\Aether\\bin\\reset-password.cmd',
    en: 'On the computer where Aether is installed, run this file to set a new password.\nMac: Applications/Aether/bin/Reset Aether Password.command in your home folder\nWindows: %LOCALAPPDATA%\\Programs\\Aether\\bin\\reset-password.cmd',
  },
  'nav.auth.loginSubmit': { ko: '로그인', en: 'Continue' },
  'nav.auth.loginBusy': { ko: '확인하는 중', en: 'Checking' },
  'nav.auth.loginFailed': { ko: '비밀번호가 맞지 않아요.', en: 'That password is not right.' },
  'nav.auth.capsLock': { ko: 'Caps Lock이 켜져 있어요.', en: 'Caps Lock is on.' },
  'nav.auth.tooManyAttempts': {
    ko: '너무 많이 틀렸어요. 잠시 뒤에 다시 해 주세요.',
    en: 'Too many tries. Please wait a while and try again.',
  },
  'nav.auth.needTailnetTitle': { ko: 'Tailscale에 연결한 뒤 열어 주세요', en: 'Open on your Tailscale network' },
  'nav.auth.needTailnetBody': {
    ko: '이 서버는 Tailscale로 연결한 기기에서만 열려요.',
    en: 'This server opens only on a device connected through Tailscale.',
  },
  'nav.auth.blockedTitle': { ko: '접속할 수 없어요', en: 'You cannot get in' },
  'nav.auth.blockedBody': {
    ko: '서버가 접속을 거부했어요.',
    en: 'This server refused entry.',
  },
  'nav.auth.retry': { ko: '다시 확인', en: 'Check again' },

  // 2a addressing·보고 카드

  'nav.inbox.plan': { ko: '계획 승인', en: 'Approve plan' },
  'nav.inbox.permission': { ko: '권한', en: 'Permission' },
  'nav.inbox.question': { ko: '질문', en: 'Question' },
  'nav.inbox.waiting': { ko: '대기', en: 'Waiting' },
  'nav.inbox.done': { ko: '완료', en: 'Done' },
  'nav.inbox.failed': { ko: '실패', en: 'Failed' },
}
