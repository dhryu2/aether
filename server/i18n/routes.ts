// API 에러/응답 문자열 — routes/*.ts에서 res.json({ error })로 프론트에 전달되는 사용자대상 메시지.
import type { Dict } from "./types";

export const routes: Dict = {
  // 공통(여러 라우트에서 재사용)
  "routes.common.sessionNotFound": { ko: "세션을 찾을 수 없어요", en: "Session not found" },
  "routes.common.nameRequired": { ko: "name(문자열) 필요", en: "name (string) required" },
  "routes.common.authRequired": { ko: "로그인이 필요해요", en: "Authentication required" },
  "routes.common.internalError": { ko: "서버 오류가 발생했어요", en: "Internal error" },
  "routes.common.apiNotFound": { ko: "API 경로 없음", en: "API route not found" },

  // 인증(비밀번호 모드)
  "routes.auth.failed": { ko: "로그인에 실패했어요", en: "Authentication failed" },
  "routes.auth.passwordInvalid": { ko: "새 비밀번호는 8자 이상, 72바이트 이하여야 해요", en: "The new password must be at least 8 characters and at most 72 bytes" },
  "routes.auth.currentWrong": { ko: "현재 비밀번호가 맞지 않아요", en: "The current password is incorrect" },
  "routes.auth.saveFailed": { ko: "비밀번호를 저장하지 못했어요", en: "Could not save the password" },
  "routes.auth.tooMany": { ko: "로그인 시도가 너무 많아요", en: "Too many login attempts" },

  // 시스템
  "routes.system.backupBusy": { ko: "백업이 이미 진행 중이에요", en: "A backup is already running" },
  "routes.system.backupFailed": { ko: "백업하지 못했어요", en: "Could not create the backup" },
  "routes.system.backupIdInvalid": { ko: "백업 id가 올바르지 않습니다", en: "Invalid backup id" },
  "routes.system.backupNotFound": { ko: "그 백업을 찾을 수 없어요", en: "Backup not found" },
  "routes.system.updateVersionChanged": { ko: "그 사이 새 버전이 나왔어요. 버전을 확인한 뒤 다시 업데이트해 주세요.", en: "A newer version came out in the meantime. Check the version and update again." },
  "routes.system.logQueryInvalid": { ko: "lines는 정수, level은 log·warn·error 중 하나여야 합니다", en: "lines must be an integer and level one of log, warn, error" },

  // 세션
  "routes.sessions.noProviderAvailable": { ko: "쓸 수 있는 AI 서비스가 없어요. 설정에서 로그인하거나 설치하세요", en: "No service is available. Sign in or install one in Settings" },
  "routes.sessions.providerRequired": { ko: "쓸 수 있는 서비스가 둘 이상입니다. provider를 지정하세요: {providers}", en: "More than one service is available. Specify a provider: {providers}" },
  "routes.sessions.createFailed": { ko: "세션을 생성할 수 없어요", en: "Could not create session" },
  "routes.providerAuth.unavailable.not_installed": { ko: "{provider} 프로그램이 이 컴퓨터에 없어 로그인할 수 없어요", en: "{provider} is not installed on this computer, so you cannot log in" },
  "routes.providerAuth.unavailable.requires": { ko: "{provider}에 로그인하려면 {requires} 프로그램이 필요해요. {requires}를 설치한 뒤 다시 시도하세요", en: "Logging in to {provider} needs the {requires} program. Install {requires} and try again" },
  "routes.sessions.providerUnavailable.not_installed": { ko: "{provider} 프로그램이 이 컴퓨터에 없어 세션을 만들 수 없어요", en: "{provider} is not installed on this computer, so a session cannot be created" },
  "routes.sessions.providerUnavailable.requires": { ko: "{provider}를 쓰려면 {requires} 프로그램이 필요해요. {requires}를 설치한 뒤 다시 시도하세요", en: "{provider} needs the {requires} program. Install {requires} and try again" },
  "routes.sessions.providerUnavailable.logged_out": { ko: "{provider}에 로그인돼 있지 않아 세션을 만들 수 없어요. 설정에서 로그인하세요", en: "{provider} is not logged in, so a session cannot be created. Log in from Settings" },
  "routes.sessions.providerUnavailable.unreachable": { ko: "{provider} 서버가 응답하지 않아 세션을 만들 수 없어요", en: "The {provider} server is not responding, so a session cannot be created" },
  "routes.sessions.providerUnavailable.no_models": { ko: "{provider}에 설치된 모델이 없어 세션을 만들 수 없어요", en: "{provider} has no downloaded models, so a session cannot be created" },
  "routes.sessions.providerUnavailable.check_failed": { ko: "{provider}를 쓸 수 있는지 확인하지 못해 세션을 만들 수 없어요", en: "Could not check whether {provider} is usable, so a session cannot be created" },
  "routes.sessions.providerUnavailable.sdk_unavailable": { ko: "{provider}에 필요한 구성 요소를 불러오지 못해 세션을 만들 수 없어요", en: "Could not load the components {provider} needs, so a session cannot be created" },
  "routes.sessions.beforeRequired": { ko: "before가 필요합니다", en: "before is required" },
  "routes.sessions.eventsReadFailed": { ko: "이벤트를 읽을 수 없어요", en: "Could not read events" },
  "routes.sessions.rewindBadSeq": { ko: "되돌릴 메시지의 번호가 올바르지 않아요", en: "That message number cannot be rewound" },
  "routes.sessions.rewind.busy": { ko: "작업 중에는 되돌릴 수 없어요", en: "Wait until the current turn finishes before rewinding" },
  "routes.sessions.rewind.missing": { ko: "세션을 찾을 수 없어요", en: "Session not found" },
  "routes.sessions.rewind.notfound": { ko: "되돌릴 메시지를 찾지 못했어요", en: "Could not find that message to rewind" },
  "routes.sessions.diaryBusy": {
    ko: "대화 저장 방식을 전환하는 중이라 지금은 메시지를 받지 않아요",
    en: "Session history is switching stores, so new input is paused",
  },
  "routes.sessions.questionnaire.shape": {
    ko: "질문지 답은 id와 answers가 있어야 합니다",
    en: "A questionnaire answer needs an id and answers",
  },
  "routes.sessions.questionnaire.answersInvalid": {
    ko: "질문지 답 모양이 맞지 않습니다",
    en: "The questionnaire answers are malformed",
  },
  "routes.sessions.questionnaire.withBrief": {
    ko: "질문지 답은 브리프와 함께 보낼 수 없습니다",
    en: "A questionnaire answer cannot be sent together with a brief",
  },
  "routes.sessions.questionnaire.withAttachments": {
    ko: "질문지 답에는 이미지나 문서를 함께 보낼 수 없습니다",
    en: "A questionnaire answer cannot include images or documents",
  },
  "routes.sessions.questionnaire.idRequired": {
    ko: "질문지 답에는 clientMessageId가 필요합니다",
    en: "A questionnaire answer needs a clientMessageId",
  },
  "routes.sessions.questionnaire.retryDiffers": {
    ko: "같은 전송 식별자로 이미 다른 답이 기록돼 있습니다",
    en: "A different answer was already recorded under this message id",
  },
  "routes.sessions.questionnaire.notOpen": {
    ko: "열려 있는 질문지가 아니에요",
    en: "That questionnaire is not open",
  },
  "routes.sessions.diaryUnavailable": {
    ko: "대화 저장 데이터베이스를 읽지 못했어요",
    en: "Could not read the session history database",
  },
  "routes.sessions.imagesMustBeArray": { ko: "images는 배열이어야 합니다", en: "images must be an array" },
  "routes.sessions.maxImages": { ko: "이미지는 최대 {max}개까지", en: "Up to {max} images allowed" },
  "routes.sessions.unsupportedImageFormat": {
    ko: "지원하지 않는 이미지 형식(png·jpeg·gif·webp만)",
    en: "Unsupported image format (png, jpeg, gif, webp only)",
  },
  "routes.sessions.imageDataEmpty": { ko: "이미지 데이터가 비어 있습니다", en: "Image data is empty" },
  "routes.sessions.imageTooLarge": { ko: "이미지가 너무 커요(개당 ~6MB 이하)", en: "Image is too large (max ~6MB each)" },
  "routes.sessions.documentsMustBeArray": { ko: "documents는 배열이어야 합니다", en: "documents must be an array" },
  "routes.sessions.maxDocuments": { ko: "문서는 최대 {max}개까지", en: "Up to {max} documents allowed" },
  "routes.sessions.unsupportedDocFormat": { ko: "지원하지 않는 문서 형식(PDF만)", en: "Unsupported document format (PDF only)" },
  "routes.sessions.docDataEmpty": { ko: "문서 데이터가 비어 있습니다", en: "Document data is empty" },
  "routes.sessions.pdfTooLarge": { ko: "PDF가 너무 커요(개당 ~10MB 이하)", en: "PDF is too large (max ~10MB each)" },
  "routes.sessions.textOrAttachmentRequired": {
    ko: "text 또는 첨부(images·documents) 필요",
    en: "text or an attachment (images/documents) is required",
  },
  "routes.sessions.cannotOpen": { ko: "세션을 열 수 없어요", en: "Could not open session" },
  "routes.sessions.archiveBodyInvalid": { ko: "archived(true/false) 필요", en: "archived (true/false) is required" },
  "routes.sessions.deletePurgeInvalid": { ko: "purge는 0 또는 1이어야 해요", en: "purge must be 0 or 1" },
  "routes.sessions.purgeFailed": {
    ko: "완전 삭제를 끝내지 못했어요. 다시 시도해 주세요.",
    en: "Could not finish deleting everything. Please try again.",
  },
  "routes.sessions.archiveBusy": {
    ko: "작업이 진행 중이거나 답을 기다리고 있어 보관할 수 없어요. 끝난 뒤에 보관하세요.",
    en: "This session is working or waiting for you, so it cannot be archived yet. Archive it after it settles.",
  },
  "routes.sessions.archivedReadOnly": {
    ko: "보관된 세션이에요. 보관을 해제한 뒤 이어서 대화하세요.",
    en: "This session is archived. Unarchive it to continue the conversation.",
  },
  "routes.sessions.notFoundAlt": { ko: "세션을 찾을 수 없어요", en: "Session not found" },
  "routes.sessions.modelRequired": { ko: "model(문자열) 필요", en: "model (string) required" },
  "routes.sessions.commandInvalid": {
    ko: "명령 이름의 형식이 올바르지 않습니다(1~64자, 제어 문자·앞의 '-' 불가)",
    en: "Malformed command name (1-64 characters, no control characters, cannot start with '-')",
  },
  "routes.sessions.commandArgumentsInvalid": {
    ko: "명령 인자는 문자열이어야 하며 {max}자를 넘을 수 없습니다.",
    en: "Command arguments must be a string no longer than {max} characters.",
  },
  // 어떤 값이 되는지는 모델마다 다르고 provider만 안다 → 목록을 문구에 박지 않는다.
  //   박아두면 Codex 세션이 자기 어휘로 보낸 값을 거부당하면서 Claude 목록을 안내받는다.
  "routes.sessions.effortInvalid": {
    ko: "effort 값의 형식이 올바르지 않습니다(1~64자, 제어 문자·앞의 '-' 불가)",
    en: "Malformed effort value (1-64 characters, no control characters, cannot start with '-')",
  },
  "routes.sessions.isolatedInvalid": {
    ko: "isolated는 true 또는 false여야 합니다",
    en: "isolated must be true or false",
  },
  "routes.sessions.mcpServersNeedIsolated": {
    ko: "mcpServers는 isolated가 true일 때만 쓸 수 있습니다",
    en: "mcpServers is only allowed when isolated is true",
  },
  "routes.sessions.mcpServersInvalid": {
    ko: "mcpServers는 이름(소문자로 시작, 영숫자·_·-, 32자 이내) → http://127.0.0.1 또는 http://localhost 주소의 객체여야 하며 8개까지입니다",
    en: "mcpServers must map names (lowercase start, alphanumerics/_/-, up to 32 chars) to http://127.0.0.1 or http://localhost URLs, at most 8",
  },
  "routes.sessions.isolatedClaudeOnly": {
    ko: "격리 세션(isolated)은 Claude 제공자에서만 지원합니다",
    en: "Isolated sessions are only supported by the Claude provider",
  },
  "routes.sessions.permissionModeInvalid": {
    ko: "permissionMode는 manual, edits, auto, full 중 하나여야 합니다",
    en: "permissionMode must be one of manual, edits, auto, full",
  },
  "routes.sessions.sessionGone": {
    ko: "세션이 방금 잠들어서 적용하지 않았어요. 다시 시도해 주세요",
    en: "The session just went to sleep, so this change was not applied. Please try again",
  },
  "routes.sessions.permissionModeConflict": {
    ko: "그 사이 권한 모드가 바뀌어서 적용하지 않았어요. 다시 골라 주세요",
    en: "The permission mode changed in the meantime, so this change was not applied. Please pick again",
  },
  "routes.sessions.permissionModeUnavailable": {
    ko: "이 세션에서는 쓸 수 없는 권한 모드입니다",
    en: "That permission mode is not available for this session",
  },
  // 모델 이름도 형식만 본다 — 실제로 있는 이름인지는 provider가 판정한다.
  "routes.sessions.modelMalformed": {
    ko: "모델 이름의 형식이 올바르지 않습니다(1~64자, 제어 문자·앞의 '-' 불가)",
    en: "Malformed model name (1-64 characters, no control characters, cannot start with '-')",
  },
  // 세션이 정해진 시간 안에 준비되지 않았다 — 사용자가 고칠 값이 없는 실패라 모델 오류와 분리한다.
  "routes.sessions.readyTimeout": {
    ko: "세션이 제때 준비되지 않았어요. 잠시 뒤 다시 시도해 주세요.",
    en: "The session did not become ready in time. Please try again in a moment.",
  },
  "routes.sessions.liveOnlyModels": {
    ko: "실행 중인 세션에서만 쓸 수 있어요",
    en: "Only live sessions are supported (disk sessions cannot query models)",
  },
  "routes.sessions.liveOnly": { ko: "실행 중인 세션에서만 쓸 수 있어요", en: "Only live sessions are supported" },
  "routes.sessions.notSupportedByProvider": {
    ko: "이 AI 서비스에서는 지원하지 않는 기능이에요",
    en: "This provider does not support that query",
  },
  "routes.sessions.backgroundTaskIdInvalid": { ko: "작업 id 형식이 맞지 않음", en: "Invalid background task id" },
  "routes.sessions.backgroundTaskNotFound": { ko: "그 백그라운드 작업이 없어요(이미 끝났을 수 있어요)", en: "No such background task (it may have already finished)" },
  "routes.sessions.decisionInvalid": { ko: "decision은 'allow' 또는 'deny'", en: "decision must be 'allow' or 'deny'" },
  "routes.sessions.permissionNotFound": {
    ko: "이미 처리됐거나 만료된 요청이에요",
    en: "Permission request not found (already handled or expired)",
  },
  "routes.sessions.questionParamsRequired": {
    ko: "questionId(문자열)·answers(배열) 필요",
    en: "questionId (string) and answers (array) required",
  },
  "routes.sessions.questionNotFound": {
    ko: "이미 처리됐거나 만료된 요청이에요",
    en: "Question not found (already answered or expired)",
  },
  "routes.sessions.planParamsRequired": {
    ko: "planId(문자열)·decision(approve|revise|cancel) 필요",
    en: "planId (string) and decision (approve|revise|cancel) required",
  },
  "routes.sessions.planReviseRequired": {
    ko: "수정 요청에는 메시지(message)가 필요합니다",
    en: "A revision request needs a message",
  },
  "routes.sessions.planNotFound": {
    ko: "이미 처리됐거나 만료된 요청이에요",
    en: "Plan review not found (already handled or expired)",
  },
  "routes.sessions.extraCapabilityMissing": {
    ko: "이 세션은 이 부가 기능이 없어요",
    en: "This session does not have that extra capability",
  },
  // 답변 형태 강제(8d-3 ⑥ⓒ) — 자유 입력은 custom으로만 받고, answers는 제시된 선택지여야 한다.
  "routes.sessions.answerCountMismatch": {
    ko: "답변 개수가 질문 개수({n})와 다릅니다",
    en: "Answer count does not match the number of questions ({n})",
  },
  "routes.sessions.customCountMismatch": {
    ko: "직접 입력 개수가 질문 개수({n})와 다릅니다",
    en: "Custom-answer count does not match the number of questions ({n})",
  },
  "routes.sessions.answerNotAString": { ko: "답변은 문자열이어야 합니다", en: "Answers must be strings" },
  "routes.sessions.answerNotAnOption": {
    ko: "제시되지 않은 선택지입니다: {value} (직접 입력은 custom으로 보내세요)",
    en: "Not one of the presented options: {value} (send free text as custom)",
  },
  "routes.sessions.answerDuplicate": { ko: "같은 선택지를 중복 제출할 수 없습니다", en: "The same option cannot be submitted twice" },
  "routes.sessions.singleAnswerOnly": {
    ko: "{n}번째 질문은 선택지 하나 또는 직접 입력 하나만 제출할 수 있습니다",
    en: "Question {n} accepts either one option or one custom answer",
  },
  "routes.sessions.answerEmpty": { ko: "{n}번째 질문에 답이 없습니다", en: "Question {n} has no answer" },

  // 원격 재인증 — provider 공통 라우트가 쓰는 문구(어느 provider의 로그인이든 여기를 지난다)
  // 어느 env로 껐는지 알려준다 — 구 이름으로 꺼둔 사용자가 존재하지 않는 변수를 뒤지지 않게.
  "routes.providerAuth.disabled": {
    ko: "원격 로그인이 비활성화되어 있어요 ({envVar})",
    en: "Remote re-authentication is disabled ({envVar})",
  },
  "routes.providerAuth.startFailed": { ko: "로그인을 시작하지 못했어요", en: "Failed to start login" },
  "routes.providerAuth.paramsRequired": {
    ko: "loginId(문자열)·code(비어있지 않은 문자열) 필요",
    en: "loginId (string) and code (non-empty string) required",
  },
  "routes.providerAuth.codeSubmitFailed": { ko: "코드를 제출하지 못했어요", en: "Failed to submit code" },
  "routes.providerAuth.codeNotSupported": {
    ko: "이 AI 서비스의 로그인은 코드를 되돌려 보내지 않아요 (화면에 표시된 코드를 그 주소에서 입력하세요)",
    en: "This service's login does not take a code back (enter the code shown on screen at that address)",
  },
  "routes.providerAuth.loginIdRequired": { ko: "loginId(비어있지 않은 문자열) 필요", en: "loginId (non-empty string) required" },
  "routes.providerAuth.pollFailed": { ko: "로그인 진행 상태를 확인하지 못했어요", en: "Could not check the login progress" },
  // 완료가 알림으로 오는 로그인(기기 코드 방식)의 결말 문구 — provider 이름을 박지 않는다.
  "routes.providerAuth.completed": { ko: "다시 로그인했어요.", en: "Re-authentication complete." },
  "routes.providerAuth.loginFailed": { ko: "로그인에 실패했어요. 다시 시작해 주세요.", en: "Login failed. Please start again." },
  "routes.providerAuth.cancelled": { ko: "로그인을 취소했어요.", en: "The login was cancelled." },
  "routes.providerAuth.replaced": { ko: "새 로그인을 시작해 이전 로그인을 취소했어요.", en: "A new login started, so the previous one was cancelled." },
  "routes.providerAuth.interrupted": {
    ko: "로그인이 중단됐어요(로그인 프로세스 종료). 다시 시작해 주세요.",
    en: "The login was interrupted (the authentication process ended). Please start again.",
  },
  "routes.providerAuth.expired": { ko: "로그인 대기 시간이 지났어요. 다시 시작해 주세요.", en: "The login timed out. Please start again." },
  "routes.providerAuth.unknownLogin": {
    ko: "진행 중인 로그인이 없어요 (만료됐을 수 있어요 — 다시 시작하세요)",
    en: "No login in progress (it may have expired — please start again)",
  },

  // Claude 로그인 구현(PTY) 전용 문구 — 아래는 claudeLogin.ts만 쓴다(다른 provider의 흐름엔 안 나온다)
  "routes.claudeAuth.urlFetchFailed": {
    ko: "로그인 URL을 가져오지 못했어요 (PTY 시작 실패 또는 CLI 출력 형식 변경)",
    en: "Could not get the login URL (PTY failed to start, or the CLI output format changed)",
  },
  "routes.claudeAuth.ptyUnavailable": {
    ko: "터미널 로그인에 필요한 구성 요소(node-pty)를 불러오지 못했어요. 서버 폴더에서 npm install을 다시 실행하세요.",
    en: "Could not load the component (node-pty) needed for terminal login. Run npm install again in the server folder.",
  },
  "routes.claudeAuth.noActiveSession": {
    ko: "진행 중인 로그인 세션이 없어요 (만료됐을 수 있어요 — 다시 시작하세요)",
    en: "No login session in progress (it may have expired — please start again)",
  },
  "routes.claudeAuth.notAwaitingCode": { ko: "코드를 받을 수 있는 상태가 아니에요", en: "Not currently accepting a code" },
  "routes.claudeAuth.verifyFailed": {
    ko: "로그인은 됐지만 적용 확인에 실패했어요(launchd Keychain 쓰기 가능성). 터미널에서 `claude auth login`을 실행하거나 다시 시도해 주세요.",
    en: "Login succeeded but verification failed (possible launchd Keychain write issue). Complete `claude auth login` via Termius on the Mac, or start again.",
  },
  "routes.claudeAuth.success": { ko: "다시 로그인했어요.", en: "Re-authentication complete." },
  "routes.claudeAuth.invalidCode": {
    ko: "코드가 올바르지 않아요. 전체 코드를 복사해 다시 시도하세요.",
    en: "The code is invalid. Copy the full code and try again.",
  },
  "routes.claudeAuth.exchangeFailed": {
    ko: "로그인 처리에 실패했어요. 다시 시작해 주세요.",
    en: "Authentication exchange failed. Please start again.",
  },

  // fs
  "routes.fs.readFailed": { ko: "경로를 읽을 수 없어요", en: "Could not read the path" },

  // push
  "routes.push.invalidSubscription": {
    ko: "유효한 구독(https 푸시서비스 endpoint + keys) 필요",
    en: "A valid subscription (https push service endpoint + keys) is required",
  },
  "routes.push.endpointRequired": { ko: "endpoint(문자열) 필요", en: "endpoint (string) required" },

  // 검색
  "routes.review.readFailed": { ko: "작업 검토 내용을 읽을 수 없어요", en: "Could not read the work review" },
  "routes.review.saveFailed": { ko: "검토 완료 위치를 저장할 수 없어요", en: "Could not save the review position" },
  "routes.review.undoConflict": { ko: "다른 기기에서 처리되어 되돌리지 못했어요", en: "Someone else changed this review, so it could not be undone" },
  "routes.review.pathInvalid": { ko: "이 세션에서 바뀐 파일이 아니에요", en: "That file was not changed in this session" },
  "routes.review.seqInvalid": { ko: "seq가 올바르지 않아요", en: "seq is invalid" },
  "routes.search.failed": { ko: "검색에 실패했어요", en: "Search failed" },

  // 로케일
  "routes.autoResume.atInvalid": { ko: "시간은 지금부터 31일 안이어야 해요", en: "The time must be within the next 31 days" },
  "routes.autoResume.textInvalid": { ko: "메시지는 1~2000자여야 해요", en: "The text must be 1 to 2000 characters" },
  "routes.autoResume.nothing": { ko: "바꿀 시간이나 메시지가 필요해요", en: "A time or text to change is required" },
  "routes.autoResume.notFound": { ko: "자동 재개 예약이 없어요", en: "There is no auto-resume reservation" },
  "routes.handoff.focusTooLong": { ko: "입력한 내용은 4000자 이하여야 해요", en: "The focus text must be 4000 characters or fewer" },
  "routes.handoff.bodyInvalid": { ko: "요청 값의 형식이 맞지 않습니다", en: "A request value has the wrong type" },
  "routes.handoff.busy": { ko: "작업 중이거나 응답을 기다리는 중이라 지금은 넘길 수 없어요", en: "This session is working or waiting for a reply, so it cannot be handed off now" },
  "routes.handoff.already": { ko: "이미 넘기는 중이에요", en: "A handoff is already in progress" },
  "routes.handoff.providerUnknown": { ko: "받을 AI를 찾을 수 없어요", en: "The receiving AI was not found" },
  "routes.handoff.folderMissing": { ko: "받을 폴더를 열 수 없어요", en: "The receiving folder cannot be opened" },
  "routes.handoff.writing": { ko: "인계서를 쓰는 중이라 지울 수 없어요. 멈추려면 멈추기 버튼을 누르세요", en: "The handoff is being written and cannot be removed. Use the stop button to stop it" },
  "routes.handoff.reasonFailed": { ko: "인계서를 쓰는 턴이 글 없이 끝났거나 실패했다", en: "The turn that was to write the handoff ended without text or failed" },
  "routes.handoff.reasonLimit": { ko: "사용 한도에 막혀 세 번 시도해도 인계서를 받지 못했다", en: "The usage limit blocked three attempts and no handoff was received" },
  "routes.handoff.createFailed": { ko: "새 세션을 만들지 못했어요. 아래 글을 복사해 쓰세요", en: "The new session could not be created. Copy the text below" },
  "routes.search.summarySettingInvalid": { ko: "enabled는 true/false여야 합니다", en: "enabled must be a boolean" },
  "routes.autoResume.settingsInvalid": { ko: "enabled는 true/false, text는 2000자 이하 문자열이어야 합니다", en: "enabled must be a boolean and text a string up to 2000 characters" },
  "routes.idleSleep.invalid": { ko: "minutes는 0, 15, 30, 60 중 하나여야 합니다", en: "minutes must be one of 0, 15, 30, 60" },
  "routes.locale.invalid": { ko: "locale은 'ko' 또는 'en'이어야 합니다", en: "locale must be 'ko' or 'en'" },
};
