// 스트림 notice 문자열 — LiveSession/SessionManager가 ingest하는 notice.detail(resume 안내 등).
//   생성 시점의 서버 로케일로 영속(과거 notice는 소급 번역 안 됨 — 새 notice만 현재 언어).
import type { Dict } from "./types";

export const notice: Dict = {
  // 배경 작업(검색 요약 등)이 쓰는 경량 모델을 새로 골랐을 때.
  //   이 알림은 모델이 바뀔 때만 나간다 — 매 실행마다 알리면 시끄럽고, 아예 안 알리면 조용히 바뀐다.
  "notice.distill.modelPicked": {
    ko: "⚙️ 백그라운드 작업(검색 요약 등)에 쓰는 모델을 {model}(으)로 정했어요",
    en: "⚙️ Background work (such as search summaries) now uses {model}",
  },

  // 모델을 바꾼 뒤 지금 권한 모드를 쓸 수 없어 수동으로 내렸을 때. 넓은 권한을 몰래 유지하지 않고 알린다.
  "notice.permission.lowered": {
    ko: "이 모델에서는 지금 권한 모드를 쓸 수 없어 수동으로 바꿨어요",
    en: "The current permission mode is not available for this model, so it was switched to Manual",
  },

  // 어댑터가 지금 못 쓰는 권한 모드를 거부할 때.
  "notice.permission.unavailable": {
    ko: "이 세션에서는 쓸 수 없는 권한 모드예요",
    en: "That permission mode is not available for this session",
  },

  // 인증 만료(스트림 notice — 푸시는 notify.auth.*)
  // provider 이름은 세션이 채운다 — 이 안내는 provider 공통 경로(LiveSession.emitAuthExpired)에서 나간다.
  "notice.auth.expired": { ko: "{provider} 로그인이 만료됐어요. 다시 로그인해 주세요.", en: "{provider} authentication expired — re-authentication required." },

  // 세션 resume/에러
  "notice.session.resumeInvalid": { ko: "resume는 유효한 세션 id(UUID)여야 합니다", en: "resume must be a valid session id (UUID)" },
  "notice.session.corruptedNoContext": { ko: "세션이 손상되어 이어갈 수 없어요", en: "Session corrupted (no context to continue)" },
  "notice.session.resumedAfterEnd": { ko: "이전 대화를 이어서 진행해요. 중단된 응답은 복구되지 않아요", en: "Continuing the previous conversation (an interrupted prior response won't be auto-recovered)." },
  "notice.session.notFound": { ko: "세션을 찾을 수 없어요", en: "Session not found" },
  "notice.session.corruptedCannotOpen": { ko: "세션이 손상되어 열 수 없어요", en: "Session corrupted (cannot open)" },
  "notice.session.corruptedCwdMissing": { ko: "세션이 손상됐어요. 작업 폴더가 없거나 허용되지 않은 위치예요", en: "Session corrupted (cwd outside whitelist or missing)" },
  "notice.session.isolatedWorkspaceMissing": {
    ko: "작업 복사본이 없어 이어갈 수 없어요. 원본 폴더에 조용히 붙이지 않아요.",
    en: "The work copy is gone, so this session cannot resume. It will not silently attach to the original folder.",
  },
  "notice.session.isolationUnsupported": {
    ko: "이 세션은 작업 폴더 분리를 지원하지 않아요.",
    en: "This session does not support workspace isolation.",
  },
  "notice.session.planUnsupported": {
    ko: "이 세션은 계획 검토를 지원하지 않아요.",
    en: "This session does not support plan review.",
  },
  "notice.workspace.notGit": {
    ko: "이 폴더는 git 저장소가 아니라 복사본을 만들 수 없어요. 복사본 사용을 끄면 원본 폴더에서 시작해요.",
    en: "This folder is not a git repository, so a copy cannot be made. Turn the toggle off to start in the original folder.",
  },
  "notice.workspace.gitMissing": {
    ko: "이 컴퓨터에 git이 없어 복사본을 만들 수 없어요. git을 설치하거나 복사본 사용을 끄세요.",
    en: "git is not installed on this computer, so a copy cannot be made. Install git or turn the toggle off.",
  },
  "notice.workspace.gitCheckFailed": {
    ko: "git으로 폴더 상태를 확인하지 못해 진행하지 않았어요.",
    en: "Could not check the folder state with git, so nothing was done.",
  },
  "notice.workspace.createFailed": { ko: "작업 폴더 분리에 실패했어요.", en: "Failed to isolate the workspace." },
  "notice.workspace.sourceDirty": {
    ko: "원본 폴더에 다른 변경이 있어 적용할 수 없어요.",
    en: "The original folder has other changes, so apply was refused.",
  },
  "notice.workspace.applyFailed": { ko: "원본 폴더에 적용하지 못했어요.", en: "Failed to apply changes to the original folder." },
  "notice.workspace.discardDirty": {
    ko: "복사본에 반영하지 않은 변경이 있어 버리지 않아요.",
    en: "The copy has unapplied changes, so discard was refused.",
  },
  "notice.workspace.discardFailed": {
    ko: "복사본을 버리지 못했어요.",
    en: "Failed to discard the copy.",
  },
  "notice.workspace.missing": { ko: "작업 복사본이 없어요.", en: "The work copy is missing." },
  "notice.session.resumedRestart": { ko: "이전 대화를 이어서 진행해요. 서버 재시작으로 중단된 응답은 복구되지 않아요", en: "Restored the previous conversation context (a response halted by a backend restart won't be auto-recovered)." },
  "notice.session.noContext": { ko: "이전 세션 맥락이 없어 새로 시작해요.", en: "No previous session context found — starting fresh." },
  // provider(모델 제공자) 미등록 — 다른 provider로 조용히 넘어가지 않고 명시적으로 거부한다(Phase 8 §0.1-4).
  "notice.session.providerRequired": { ko: "provider를 지정해야 세션을 만들 수 있습니다", en: "A provider is required to create a session" },
  "notice.session.providerUnsupported": { ko: "지원하지 않는 provider입니다: {provider}", en: "Unsupported provider: {provider}" },
  // 세션이 정해진 시간 안에 "준비됐다"고 답하지 못했다 — 모델 이름 오류와 구분되는 실패다.
  "notice.session.readyTimeout": {
    ko: "세션이 {ms}ms 안에 준비되지 않았어요",
    en: "The session was not ready within {ms}ms",
  },

  // provider 중립 슬래시 명령 계약
  "notice.command.unsupported": { ko: "지원하지 않는 명령이에요: /{command}", en: "Unsupported command: /{command}" },
  "notice.command.busy": { ko: "진행 중인 작업이 끝난 뒤 명령을 실행해 주세요.", en: "Run the command after the current work finishes." },
  "notice.command.noArguments": { ko: "/{command} 명령은 인자를 받지 않아요.", en: "/{command} does not accept arguments." },
  "notice.command.compact.started": { ko: "대화 기록을 압축하는 중이에요.", en: "Compacting the conversation history." },
  "notice.command.compact.completed": { ko: "대화 기록을 압축했어요.", en: "Compacted the conversation history." },
  "notice.command.compact.failed": { ko: "대화 기록 압축에 실패했어요.", en: "Could not compact the conversation history." },

  // Claude 실행 구성 요소
  "notice.claude.binaryMissing": {
    ko: "Claude 실행 프로그램을 찾지 못했어요. 설치한 뒤 다시 시도하세요.",
    en: "Could not find the Claude program. Install it and try again.",
  },
  "notice.claude.sdkUnavailable": {
    ko: "Claude 실행에 필요한 구성 요소를 불러오지 못했어요. 서버 폴더에서 npm install을 다시 실행하세요.",
    en: "Could not load the components Claude needs to run. Run npm install again in the server folder.",
  },

  // Codex 세션(Phase 8e)
  "notice.codex.modelUnknown": {
    ko: '"{model}"은(는) 이 세션에서 쓸 수 있는 {provider} 모델 이름이 아니에요.',
    en: '"{model}" is not a {provider} model available to this session.',
  },
  "notice.codex.effortUnsupported": {
    ko: '"{model}" 모델은 Effort "{effort}"를 지원하지 않아요(가능: {allowed}).',
    en: 'Model "{model}" does not accept reasoning effort "{effort}" (available: {allowed}).',
  },
  "notice.codex.effortUnavailable": {
    ko: '"{model}" 모델은 Effort를 지원하지 않아요.',
    en: 'Model "{model}" does not support reasoning effort.',
  },
  "notice.codex.windowMismatch": {
    ko: '"{model}" 모델은 컨텍스트가 {to} 토큰이라 이 세션({from} 토큰)에서 바꿀 수 없어요. 새 세션에서 골라 주세요.',
    en: 'Model "{model}" has a {to}-token context, so it cannot replace this session\'s {from}-token context. Pick it in a new session.',
  },
  "notice.codex.notReady": { ko: "{provider} 세션이 아직 준비되지 않았어요.", en: "The {provider} session is not ready yet." },
  "notice.codex.noUsageYet": { ko: "아직 사용량 정보를 받지 못했어요(첫 응답 이후에 확인돼요).", en: "No usage information yet (available after the first turn)." },
  "notice.codex.unsupportedQuery": { ko: "이 AI 서비스에서는 지원하지 않는 기능이에요: {what}", en: "Codex sessions do not support this query: {what}" },
  // 기기 코드 로그인(8f) — 계정에서 그 방식이 꺼져 있으면 시작 자체가 거부된다(8a 실측).
  "notice.codex.deviceCodeUnavailable": {
    ko: "기기 코드 로그인을 시작하지 못했어요. ChatGPT 설정에서 기기 코드 로그인을 켜야 할 수 있어요: {error}",
    en: "Could not start device-code login. You may need to enable device-code login in your ChatGPT settings: {error}",
  },
  "notice.codex.deviceCodeUnexpected": {
    ko: '기기 코드 로그인을 요청했는데 다른 방식("{type}")으로 응답했어요.',
    en: 'Requested device-code login but the response used a different method ("{type}").',
  },
  // 배경 작업은 격리된 설정 폴더에 인증 파일만 복제해 띄운다(D6) — 그 파일이 없으면 시작조차 못 한다.
  "notice.codex.distillNoAuth": {
    ko: "Codex 로그인 정보가 없어 백그라운드 작업을 시작할 수 없어요. 설정에서 Codex에 다시 로그인해 주세요.",
    en: "Cannot start Codex background work because there are no Codex credentials. Please sign in to Codex again from settings.",
  },
  // 배경 작업이 끝나지 않았는데 결과를 돌려주면, 호출측이 빈 결과를 정상 완료로 받아들이고 그 대화 구간을
  //   다시 안 본다(기억 하나가 통째로 유실). 그래서 아래 셋은 전부 오류로 올린다.
  "notice.codex.distillTimeout": {
    ko: "Codex 백그라운드 작업이 {ms}ms를 넘겨 중단했어요.",
    en: "Codex background work was stopped after exceeding {ms}ms.",
  },
  "notice.codex.distillProcessGone": {
    ko: "Codex 백그라운드 작업 프로세스가 끝나기 전에 종료됐어요.",
    en: "The Codex background work process ended before finishing.",
  },
  "notice.codex.distillTurnFailed": {
    ko: 'Codex 백그라운드 작업이 정상 종료되지 않았어요(상태: "{status}").',
    en: 'Codex background work did not finish normally (status: "{status}").',
  },
  // 첨부 문서(PDF 등)는 Codex 입력 형식에 자리가 없어 파일 경로로 넘긴다 — 이 안내는 모델 입력에만 붙고 대화 기록엔 안 남는다.
  "notice.codex.attachedDocs": {
    ko: "[첨부 문서] 아래 파일이 이 메시지에 딸려 있습니다. 필요하면 경로를 직접 열어 읽으세요.\n{list}",
    en: "[Attached documents] The files below came with this message. Open the paths directly if you need them.\n{list}",
  },
  // 전송 실패는 "이 메시지가 상대에게 안 갔다"는 뜻이다 — 그 사실을 문구로 밝혀야 사용자가 다시 보낼지 판단한다.
  "notice.codex.turnFailed": {
    ko: "이 메시지를 {provider}에 전달하지 못했어요(대화에 반영되지 않았어요): {error}",
    en: "This message could not be delivered to {provider} (it is not part of the conversation): {error}",
  },
  // 승인 카드 제목 — Codex는 도구 이름 대신 요청 종류로 온다.
  "notice.codex.tool.command": { ko: "명령 실행", en: "Run command" },
  "notice.codex.tool.fileChange": { ko: "파일 변경", en: "Change files" },
  // 지식툴(과거검색) 승인 카드의 제목. 사용자가 쓰기 승인을 켠 경우에만 뜬다.
  "notice.codex.tool.knowledge": { ko: "지식 도구 ({name})", en: "Knowledge tool ({name})" },
  // 턴을 보내기 직전에 사용자가 중단한 경우 — 그 메시지는 모델에게 가지 않았다.
  "notice.codex.turnCanceled": { ko: "보내기 전에 중단해서 이 메시지는 전달되지 않았다.", en: "Stopped before sending — this message was not delivered." },
  // 턴이 없는데 도구가 사용자에게 물어보려 한 경우(정상 흐름에서는 안 생긴다).
  "notice.codex.askUserNoTurn": { ko: "진행 중인 턴이 없어 질문을 띄우지 않았다.", en: "No active turn — the question was not shown." },

  // Ollama 세션 — 실행기는 Codex이고 모델만 로컬 Ollama다. 아래는 Ollama 서버와 직접 주고받을 때의 오류다.
  "notice.ollama.unreachable": {
    ko: "Ollama 서버({url})에 연결하지 못했어요. Ollama가 켜져 있는지 확인해 주세요: {error}",
    en: "Could not reach the Ollama server ({url}). Check that Ollama is running: {error}",
  },
  "notice.ollama.listFailed": { ko: "Ollama 모델 목록을 받지 못했어요(HTTP {status}).", en: "Could not get the Ollama model list (HTTP {status})." },
  "notice.ollama.noModels": {
    ko: "Ollama에 도구 호출을 지원하는 모델이 없어요. `ollama pull`로 모델을 설치해 주세요.",
    en: "Ollama has no model that supports tool calls. Pull one with `ollama pull`.",
  },
  "notice.ollama.distillFailed": { ko: "Ollama 백그라운드 작업이 실패했어요({model}): {error}", en: "Ollama background work failed ({model}): {error}" },
  "notice.ollama.distillIncomplete": {
    ko: 'Ollama 백그라운드 작업이 정상 종료되지 않았어요(이유: "{reason}").',
    en: 'Ollama background work did not finish normally (reason: "{reason}").',
  },

  // Grok 세션(Phase 10c)
  "notice.grok.modelUnknown": {
    ko: '"{model}"은(는) 이 계정에서 쓸 수 있는 Grok 모델 이름이 아니에요.',
    en: '"{model}" is not a Grok model available on this account.',
  },
  "notice.grok.effortUnsupported": {
    ko: '"{model}" 모델은 Effort "{effort}"를 지원하지 않아요(가능: {allowed}).',
    en: 'Model "{model}" does not accept reasoning effort "{effort}" (available: {allowed}).',
  },
  "notice.grok.effortUnavailable": {
    ko: '"{model}" 모델은 Effort를 지원하지 않아요.',
    en: 'Model "{model}" does not support reasoning effort.',
  },
  "notice.grok.notReady": { ko: "Grok 세션이 아직 준비되지 않았어요.", en: "The Grok session is not ready yet." },
  "notice.grok.noUsageYet": { ko: "아직 사용량 정보를 받지 못했어요(첫 응답 이후에 확인돼요).", en: "No usage information yet (available after the first turn)." },
  "notice.grok.unsupportedQuery": { ko: "이 AI 서비스에서는 지원하지 않는 기능이에요: {what}", en: "Grok sessions do not support this query: {what}" },
  "notice.grok.noSessionId": { ko: "Grok가 세션 식별자를 돌려주지 않았어요.", en: "Grok did not return a session id." },
  "notice.grok.turnFailed": {
    ko: "이 메시지를 Grok에 전달하지 못했어요(대화에 반영되지 않았어요): {error}",
    en: "This message could not be delivered to Grok (it is not part of the conversation): {error}",
  },
  "notice.grok.distillUnavailable": {
    ko: "Grok 세션의 백그라운드 작업(기억 정리·검색 요약·스킬 생성)은 아직 지원하지 않아요.",
    en: "Background work (memory upkeep, search summary, skill creation) is not available for Grok sessions yet.",
  },
  "notice.grok.distillNoAuth": {
    ko: "Grok 로그인 정보가 없어 백그라운드 작업을 시작할 수 없어요. 설정에서 Grok에 다시 로그인해 주세요.",
    en: "Cannot start Grok background work because there are no Grok credentials. Please sign in to Grok again from settings.",
  },
  "notice.grok.distillTimeout": {
    ko: "Grok 백그라운드 작업이 {ms}ms를 넘겨 중단했어요.",
    en: "Grok background work was stopped after exceeding {ms}ms.",
  },
  "notice.grok.distillProcessGone": {
    ko: "Grok 백그라운드 작업 프로세스가 끝나기 전에 종료됐어요.",
    en: "The Grok background work process ended before finishing.",
  },
  "notice.grok.distillEmpty": {
    ko: "Grok 백그라운드 작업이 빈 결과를 돌려줬어요.",
    en: "Grok background work returned an empty result.",
  },
  "notice.grok.distillFailed": {
    ko: "Grok 백그라운드 작업이 실패했어요(종료 코드 {code}).",
    en: "Grok background work failed (exit code {code}).",
  },
  "notice.grok.loginOutputMissing": {
    ko: "기기 코드 로그인을 시작했지만 주소와 코드를 읽지 못했어요.",
    en: "Device-code login started but the URL and code could not be read.",
  },
  "notice.grok.loginStartFailed": {
    ko: "Grok 로그인을 시작하지 못했어요: {error}",
    en: "Could not start Grok login: {error}",
  },
  "notice.grok.questionNeedsExplanation": {
    ko: "사용자에게 보일 설명을 먼저 쓴 다음 다시 물어라. 설명 없는 질문 카드는 열지 않는다.",
    en: "Write the explanation the user will see, then ask again. A question card is not opened without that explanation.",
  },
  "notice.grok.tool.generic": { ko: "도구 실행", en: "Run tool" },
  "notice.grok.tool.knowledge": { ko: "지식 도구 ({name})", en: "Knowledge tool ({name})" },

  // 영속단 축소/redact(디스크 전용 — 라이브/SSE는 원본)
  "notice.persist.redactedResult": { ko: "[비밀 정보라 저장하지 않음]", en: "[redacted: secret-path result — shown live only]" },
  "notice.persist.clampMark": { ko: "…[Aether: {origLen}자 중 {keptK}K자만 저장]", en: "…[Aether: kept {keptK}K of {origLen} chars]" },
  "notice.persist.imageStub": { ko: "[Aether: {mediaType}{sizeKB}KB 이미지 저장 안 됨 — 보낸 화면에서만 표시]", en: "[Aether: {mediaType}{sizeKB}KB image not persisted — shown live only]" },

  // 변이 툴 미리보기 redact
  "notice.mutation.redactedSecret": { ko: "[비밀 정보]", en: "[redacted: secret]" },

  // 모델 전달용 protocol 메시지(canUseTool deny message·질문 답변 — 영어 세션이면 영어로 모델에 전달)
  "notice.proto.questionFallback": { ko: "질문{n}", en: "Question {n}" },
  "notice.proto.noAnswer": { ko: "(무응답)", en: "(no answer)" },
  // 제시한 선택지가 아니라 사용자가 직접 적은 문장임을 모델에게 명시(8d-3 ⑥ⓒ).
  "notice.proto.customAnswer": { ko: "직접 입력: \"{text}\"", en: 'free text: "{text}"' },
  "notice.proto.userResponse": { ko: "[사용자 응답] {parts}. 이 선택으로 계속 진행하세요.", en: "[User response] {parts}. Proceed with this choice." },
  "notice.proto.interrupted": { ko: "중단됨", en: "Interrupted" },
  "notice.proto.userDenied": { ko: "사용자가 거부함", en: "User denied" },
  "notice.proto.sessionDeleted": { ko: "세션 삭제됨", en: "Session deleted" },
  "notice.proto.sessionEnded": { ko: "세션 종료", en: "Session ended" },
  "notice.proto.serverShutdown": { ko: "서버 종료", en: "Server shutting down" },

  // 경로 검증 에러
  "notice.path.notFound": { ko: "경로를 찾을 수 없어요", en: "Path not found" },
  "notice.path.accessDenied": { ko: "접근할 수 없어요", en: "Access denied" },
  "notice.path.notDirectory": { ko: "폴더가 아니에요", en: "Not a directory" },
  "notice.path.outsideCwd": { ko: "작업 폴더 밖이에요", en: "Outside cwd boundary" },
  "notice.path.invalid": { ko: "잘못된 경로", en: "Invalid path" },
  "notice.path.absoluteOnly": { ko: "전체 경로를 적어 주세요", en: "Enter a full path" },
};
