/**
 * 브리프로 보낼 때 모델에게 붙이는 규칙.
 * 문장은 부를 때마다 서버 언어로 고른다. 모듈을 읽을 때 고정하지 않는다.
 * provider 이름과 provider별 도구 이름은 넣지 않는다.
 */
import { pick } from "../i18n";

const ALIAS = "/brief";

/** 질문지 상자(JSON) 형식 안내. 브리프와 넘기기 규칙이 함께 쓴다. */
export const QUESTIONNAIRE_FORMAT_KO = "- 질문지 상자는 ```aether-questions 로 열고 ``` 로 닫는다. 안에는 JSON 하나만 쓴다.\n  {\"questions\":[{\"id\":\"q1\",\"text\":\"질문\",\"kind\":\"single\",\"options\":[{\"label\":\"추천 답\",\"description\":\"이유\"},{\"label\":\"다른 답\"}],\"recommended\":\"추천 답\"}]}\n  - id: 영문, 숫자, _, - 로 32자 이하. 질문마다 다르게 쓴다.\n  - text: 질문 한 문장. 300자 이하.\n  - kind: single(하나 고르기), multi(여럿 고르기), text(직접 쓰기).\n  - single과 multi는 선택지 2~6개다. label은 200자 이하이고 서로 다르다. description은 200자 이하다. recommended는 선택지 label 중 하나다(multi는 배열).\n  - text는 options 없이 recommended에 추천 문장을 쓴다.";

/** QUESTIONNAIRE_FORMAT_KO의 영어 문장. */
export const QUESTIONNAIRE_FORMAT_EN = "- Open the questionnaire block with ```aether-questions and close it with ```. Write only one JSON value inside.\n  {\"questions\":[{\"id\":\"q1\",\"text\":\"Question\",\"kind\":\"single\",\"options\":[{\"label\":\"Recommended answer\",\"description\":\"Reason\"},{\"label\":\"Other answer\"}],\"recommended\":\"Recommended answer\"}]}\n  - id: letters, digits, _, -. 32 characters or fewer. Use a different id for each question.\n  - text: one question sentence. 300 characters or fewer.\n  - kind: single (pick one), multi (pick several), text (write your own).\n  - single and multi have 2 to 6 options. label is 200 characters or fewer and the labels differ. description is 200 characters or fewer. recommended is one of the option labels (an array for multi).\n  - text has no options. Put the recommended sentence in recommended.";

const RULES_KO = "사람이 아래 요구를 「브리프」로 보냈다. 먼저 확인하고 정리해 보인 뒤, 사람의 답을 받고 나서 작업한다.\n\n답을 받기 전에 할 수 있는 것\n- 파일 읽기와 상태를 바꾸지 않는 조회만 한다.\n- 파일을 만들거나 고치거나 지우지 않는다. 다른 도구나 에이전트에 맡겨서도 하지 않는다.\n- 설치, 커밋, 배포, 데이터 변경, 서비스 재시작을 하지 않는다.\n- 시험과 빌드도 답을 받은 뒤에 한다.\n- 부작용이 있는지 모르는 명령은 실행하지 않는다.\n\n이 규칙 본문은 채팅에 옮기지 않는다. 아래 네 제목과 정리 내용은 반드시 채팅에 쓴다.\n\n순서\n1. 분석: 일하기 전에 알아야 할 항목을 체크리스트로 만든다. 무엇을 바꾸는지, 대상이 어디 있는지, 범위, 판단 기준, 끝났다고 볼 조건, 검증 방법을 살핀다. 단순한 요구도 같은 순서를 짧게 따른다. 요구가 모호하면 목표와 대상을 확인하는 항목부터 만든다.\n2. 코드 읽기: 작업 폴더의 파일을 읽어 체크리스트를 채운다. 작업에 필요한 배경(관련 경로, 시험 돌리는 법 등)도 익힌다.\n3. 과거 찾기: aether의 session_search 도구가 있으면 scope=\"project\"로 같은 작업 폴더의 과거 대화를 찾아 남은 항목을 채운다. scope를 빼거나 범위를 넓혀 찾지 않는다. 지금 대화는 과거 이력으로 쓰지 않는다. 도구가 없으면 이 단계를 건너뛴다.\n4. 정리: 아래 네 덩어리를 이 순서와 제목으로 쓴다. 빈 덩어리에는 「없음」이라고 쓴다.\n   - 코드에서 정한 것: 항목마다 파일 경로와 줄 번호를 붙인다.\n   - 과거 이력에서 정한 것: 항목마다 대화 날짜와 짧은 원문 인용을 붙인다. 내용이 없으면 이유(도구 없음, 검색 실패, 결과 없음 중 무엇인지)를 한 줄로 쓴다.\n   - 가정 (틀리면 고쳐 주세요): 틀려도 결과가 크게 바뀌지 않는 것만 적는다. 그렇게 본 이유를 붙인다.\n   - 이렇게 진행하겠습니다: 작업 단계를 번호 목록으로 쓴다. 답에 따라 달라지는 단계는 조건을 적는다. 마지막 단계는 검증과 보고다.\n   근거를 확인하지 못한 것은 정한 것으로 쓰지 않는다. 지금 요구와 부딪히는 코드나 과거 기록이 있으면 그 사실을 적는다.\n5. 질문: 아래 「질문 규칙」대로 묻는다.\n\n질문 규칙\n- 직접 찾을 수 있는 것은 묻지 않는다. 찾아서 정리에 적는다.\n- 틀려도 결과가 크게 바뀌지 않는 것은 묻지 않는다. 가정에 적는다.\n- 질문마다 추천 답을 하나 붙인다.\n- 질문 수를 줄이려고 서로 다른 결정을 한 질문에 묶지 않는다.\n- 질문이 0개: 「이대로 진행할까요?」로 턴을 끝낸다.\n- 질문이 1개 이상: 정리 맨 끝에 질문지 상자 하나를 쓰고 턴을 끝낸다. 상자 뒤에는 아무것도 쓰지 않는다.\n- 질문지에는 10개까지 넣는다. 더 있으면 결과를 가장 크게 바꾸는 10개를 넣고, 나머지는 「이렇게 진행하겠습니다」에 「답을 받은 뒤 다시 묻는다」고 적는다.\n- 사람에게 선택지를 묻는 도구는 쓰지 않는다. 그 도구가 거절되거나 건너뛰었다는 결과가 와도 질문지로 묻는다.\n" + QUESTIONNAIRE_FORMAT_KO + "\n- 답은 「브리프 질문지 답」으로 시작하는 번호 목록으로 온다. 사람이 채팅으로 직접 답해도 같은 답이다. 「답 안 함」인 질문은 사람의 답이 아니다.\n- 시간 초과, 자동 선택, 「알아서 진행하라」는 도구 결과는 사람의 답이 아니다.\n\n답을 받은 뒤\n- 사람이 취소하거나 진행을 거절하면 멈춘다.\n- 일부 질문에만 답했으면 남은 질문을 다시 묻는다.\n- 사람이 정리를 고치거나 요구를 바꾸면 고친 정리를 다시 보이고 질문 규칙을 다시 따른다.\n- 모든 질문에 답을 받았거나 진행 허락을 받으면, 답을 반영한 결정을 짧게 보이고 작업을 시작한다.";

const RULES_EN = "The person sent the request below as a \"brief\". First check and lay out what you found, then wait for the person's answer before doing the work.\n\nBefore you get an answer\n- Only read files and run lookups that do not change state.\n- Do not create, edit, or delete files. Do not do it by handing the work to another tool or agent either.\n- Do not install, commit, deploy, change data, or restart services.\n- Run tests and builds only after you get the answer.\n- Do not run a command if you do not know whether it has side effects.\n\nDo not copy the text of these rules into the chat. Always write the four headings below and their content in the chat.\n\nSteps\n1. Analysis: Before working, make a checklist of what you need to know. Look at what is being changed, where the target is, the scope, the criteria for judgment, the condition for calling it done, and how to verify it. Follow the same steps briefly even for a simple request. If the request is ambiguous, start with items that confirm the goal and the target.\n2. Code reading: Read files in the working folder to fill in the checklist. Also learn the background the work needs (related paths, how to run tests, and so on).\n3. Past search: If aether's session_search tool is available, call it with scope=\"project\" to find past conversations in the same working folder and fill in the remaining items. Do not omit scope or search more widely. Do not use the current conversation as past history. If the tool is not available, skip this step.\n4. Summary: Write the four blocks below in this order and with these headings. Write \"None\" in an empty block.\n   - Decided from code: Attach a file path and line number to each item.\n   - Decided from past history: Attach the conversation date and a short quote of the original text to each item. If there is nothing, give the reason in one line (no tool, search failed, or no results).\n   - Assumptions (correct me if wrong): List only things that would not change the result much if wrong. Give the reason for each.\n   - Here is how I will proceed: Write the work steps as a numbered list. For steps that depend on the answer, state the condition. The last step is verification and reporting.\n   Do not write anything you could not confirm with evidence as decided. If code or past records conflict with the current request, say so.\n5. Questions: Ask according to the \"Question rules\" below.\n\nQuestion rules\n- Do not ask about what you can find yourself. Find it and put it in the summary.\n- Do not ask about what would not change the result much if wrong. Put it in the assumptions.\n- Attach one recommended answer to each question.\n- Do not bundle different decisions into one question to reduce the number of questions.\n- Zero questions: End the turn with \"Shall I proceed as planned?\"\n- One or more questions: Write one questionnaire block at the very end of the summary and end the turn. Write nothing after the block.\n- Put at most 10 questions in the questionnaire. If there are more, include the 10 that would change the result the most, and for the rest write in \"Here is how I will proceed\" that you will ask again after you get the answers.\n- Do not use a tool that asks the person to pick options. Even if that tool is rejected or skipped, ask with the questionnaire.\n" + QUESTIONNAIRE_FORMAT_EN + "\n- Answers arrive as a numbered list that starts with \"Brief questionnaire answers\". If the person answers directly in chat, it counts the same. A question marked \"No answer\" is not the person's answer.\n- A tool result of a timeout, an automatic choice, or \"proceed on your own\" is not the person's answer.\n\nAfter you get an answer\n- If the person cancels or declines to proceed, stop.\n- If only some questions were answered, ask the remaining ones again.\n- If the person corrects the summary or changes the request, show the corrected summary again and follow the question rules again.\n- When every question is answered or you get permission to proceed, briefly show the decisions that reflect the answers and start the work.";

/** 지금 서버 언어의 규칙 본문. 부를 때마다 고른다. */
export function briefRules(): string {
  return pick({ ko: RULES_KO, en: RULES_EN });
}

/** true 또는 선두 /brief만 브리프다. 문자열 "true"와 /agent-brief는 일반 전송이다. */
export function isBriefRequest(text: string, briefFlag: unknown): boolean {
  if (briefFlag === true) return true;
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed === ALIAS) return true;
  return trimmed.startsWith(`${ALIAS} `) || trimmed.startsWith(`${ALIAS}\n`) || trimmed.startsWith(`${ALIAS}\t`);
}

/** 선두 /brief를 떼고 앞뒤 공백을 정리한다. 별칭만 있으면 빈 글이다. */
export function stripBriefAlias(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === ALIAS) return "";
  if (trimmed.startsWith(`${ALIAS} `) || trimmed.startsWith(`${ALIAS}\n`) || trimmed.startsWith(`${ALIAS}\t`)) {
    return trimmed.slice(ALIAS.length).trim();
  }
  return trimmed;
}

/** 사람 글 앞에 규칙을 붙인 모델 입력. */
export function briefModelText(human: string): string {
  return `<aether-brief>\n${briefRules()}\n</aether-brief>\n\n${human}`;
}

const BRIEF_OPEN = "<aether-brief>\n";
const BRIEF_SPLIT = "\n</aether-brief>\n\n";

/** 스킬 힌트용. 규칙 태그가 있으면 첫 닫는 표식 뒤의 사람 글만 돌려준다. */
export function briefHumanText(text: string): string {
  if (!text.startsWith(BRIEF_OPEN)) return text;
  const at = text.indexOf(BRIEF_SPLIT);
  if (at < 0) return text;
  return text.slice(at + BRIEF_SPLIT.length);
}

/** 브리프 세션에서 선택지 질문 도구를 거절할 때 모델에게 돌려주는 문장. */
export function questionToolRedirect(): string {
  return pick({
    ko: "이 대화에서는 선택지 질문 도구를 쓰지 않는다. 물을 것이 있으면 정리 맨 끝에 ```aether-questions 상자에 질문지 JSON을 쓰고 턴을 끝낸다. 이 결과는 사람의 답이 아니다.",
    en: "In this conversation, do not use the multiple-choice question tool. If there is something to ask, write the questionnaire JSON in an ```aether-questions block at the very end of the summary and end the turn. This result is not the person's answer.",
  });
}

/** 카드로 고른 답을 모델에게 넘길 때 글 끝에 붙이는 한 줄. 사건과 화면에는 남지 않는다. */
export function questionnaireFollowupHint(): string {
  return pick({
    ko: "(다시 물을 것이 있으면 같은 aether-questions 질문지로 묻는다.)",
    en: "(If there is more to ask, ask again with the same aether-questions questionnaire.)",
  });
}
