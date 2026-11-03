/**
 * 질문지 상자를 읽고 카드 답을 글로 만든다.
 * 모델은 부르지 않는다. 로케일 파일은 임시 폴더에만 쓴다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QuestionnaireAnswerValue, QuestionnaireQuestion } from "../../shared/http";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-q1a-"));
process.env.AETHER_DATA_DIR = dataDir;
delete process.env.AETHER_DATABASE_URL;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  const shown = cond || extra === undefined ? "" : ` — ${JSON.stringify(extra).slice(0, 300)}`;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${shown}`);
  cond ? pass++ : fail++;
}

const FENCE = "```aether-questions";
function boxed(inner: string): string {
  return `${FENCE}\n${inner}\n\`\`\``;
}

const SAMPLE = {
  questions: [
    {
      id: "q1",
      text: "재시도할 오류 종류",
      kind: "single",
      options: [
        { label: "GATEWAY_TIMEOUT만", description: "일시 오류만 재시도" },
        { label: "모든 결제 오류" },
      ],
      recommended: "GATEWAY_TIMEOUT만",
    },
    {
      id: "q2",
      text: "재시도할 단계",
      kind: "multi",
      options: [{ label: "승인" }, { label: "취소" }, { label: "환불" }],
      recommended: ["승인"],
    },
    {
      id: "q3",
      text: "재시도 횟수와 간격",
      kind: "text",
      recommended: "2회, 100ms/300ms",
    },
  ],
};

function textQuestion(id: string, text = "한 줄"): Record<string, unknown> {
  return { id, text, kind: "text", recommended: "추천" };
}

type Parsed = { ok: true; questions: QuestionnaireQuestion[] } | { ok: false; error: string };
type Checked = { ok: true; answers: Record<string, QuestionnaireAnswerValue> } | { ok: false; error: string };

function mustFail(result: { ok: boolean; error?: string }, name: string, part: string) {
  check(result.ok === false && typeof result.error === "string" && result.error.includes(part), name, result);
}

async function main(): Promise<void> {
  const { config } = await import("../config");
  if (path.resolve(config.dataDir) !== path.resolve(dataDir)) {
    throw new Error("데이터 폴더가 임시 폴더가 아니다");
  }
  const { setLocale } = await import("../i18n");
  const {
    QUESTIONNAIRE_FENCE,
    findQuestionnaireBlock,
    parseQuestionnaire,
    validateQuestionnaireAnswers,
    buildQuestionnaireAnswerText,
    questionnaireRetryVerdict,
  } = await import("../agent-brief/questionnaire");
  const { briefRules, questionToolRedirect, questionnaireFollowupHint } = await import("../agent-brief/rules");

  setLocale("ko");
  check(QUESTIONNAIRE_FENCE === "aether-questions", "상자 이름 상수");

  console.log("\n읽기");
  check(findQuestionnaireBlock("질문지 없이 정리만 있다") === null, "상자 없음");
  check(findQuestionnaireBlock("") === null, "빈 글에는 상자가 없다");

  const sampleRaw = JSON.stringify(SAMPLE);
  const found = findQuestionnaireBlock(`정리\n${boxed(sampleRaw)}\n끝`);
  check(found === sampleRaw, "정상 셋 상자의 안쪽만 꺼낸다", found);
  const parsed = parseQuestionnaire(found ?? "") as Parsed;
  check(parsed.ok === true, "정상 셋 JSON", parsed);
  if (parsed.ok) {
    check(parsed.questions.map((q) => q.kind).join(",") === "single,multi,text", "kind 셋", parsed.questions.map((q) => q.kind));
    check(parsed.questions[0].recommended === "GATEWAY_TIMEOUT만", "single 추천");
    check(JSON.stringify(parsed.questions[1].recommended) === JSON.stringify(["승인"]), "multi 추천");
    check(parsed.questions[2].options === undefined && parsed.questions[2].recommended === "2회, 100ms/300ms", "text는 추천 문장만");
    check(parsed.questions[0].options?.[0].description === "일시 오류만 재시도", "선택지 설명을 남긴다");
  }

  const withOptions = parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "횟수", kind: "text", options: [{ label: "버림" }], recommended: "2회" }] }));
  check(withOptions.ok === true && withOptions.questions[0].options === undefined && withOptions.questions[0].recommended === "2회", "text의 options는 버린다", withOptions);

  check(findQuestionnaireBlock("```aether-questions\n{\"questions\":[]}\n") === null, "닫히지 않은 상자");
  const closedThenOpen = `${boxed(sampleRaw)}\n말\n\`\`\`aether-questions\n{"questions":[]}`;
  check(findQuestionnaireBlock(closedThenOpen) === sampleRaw, "뒤에 닫히지 않은 상자가 있으면 앞의 닫힌 상자");

  mustFail(parseQuestionnaire("{"), "JSON 오류", "JSON");
  mustFail(parseQuestionnaire(""), "빈 글", "JSON");
  mustFail(parseQuestionnaire("   \n  "), "공백만 있는 글", "JSON");
  check(findQuestionnaireBlock(boxed("")) === "", "빈 상자의 안쪽은 빈 글");
  mustFail(parseQuestionnaire(findQuestionnaireBlock(boxed("")) ?? ""), "빈 상자 안은 실패", "JSON");

  mustFail(parseQuestionnaire(JSON.stringify({ questions: [] })), "질문 0개", "질문이 없다");
  mustFail(parseQuestionnaire(JSON.stringify({ questions: Array.from({ length: 11 }, () => ({})) })), "질문 11개", "10개");

  mustFail(parseQuestionnaire(JSON.stringify({ questions: [textQuestion("질문")] })), "id 형식 위반", "id");
  mustFail(parseQuestionnaire(JSON.stringify({ questions: [textQuestion("a".repeat(33))] })), "id 33자", "id");
  const dup = parseQuestionnaire(JSON.stringify({ questions: [textQuestion("q1", "하나"), textQuestion("q1", "둘")] })) as Parsed;
  mustFail(dup, "id 겹침", "겹친다");

  const oneOption = { questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "하나만" }], recommended: "하나만" }] };
  const seven = {
    questions: [{
      id: "q1",
      text: "고르기",
      kind: "multi",
      options: ["가", "나", "다", "라", "마", "바", "사"].map((label) => ({ label })),
      recommended: ["가"],
    }],
  };
  mustFail(parseQuestionnaire(JSON.stringify(oneOption)), "선택지 1개", "2~6");
  mustFail(parseQuestionnaire(JSON.stringify(seven)), "선택지 7개", "2~6");
  mustFail(
    parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "같은" }, { label: "같은" }] }] })),
    "label 겹침",
    "label이 겹친다",
  );

  mustFail(parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "가".repeat(301), kind: "text" }] })), "text 301자", "300");
  const ok300 = parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "가".repeat(300), kind: "text", recommended: "ㅇ" }] })) as Parsed;
  check(ok300.ok === true, "text 300자는 된다", ok300);
  mustFail(
    parseQuestionnaire(JSON.stringify({
      questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "가".repeat(81) }, { label: "짧음" }] }],
    })),
    "label 81자",
    "80자",
  );
  const ok80 = parseQuestionnaire(JSON.stringify({
    questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "가".repeat(80) }, { label: "짧음" }], recommended: "짧음" }],
  })) as Parsed;
  check(ok80.ok === true, "label 80자는 된다", ok80);

  const mismatched = parseQuestionnaire(JSON.stringify({
    questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "A" }, { label: "B" }], recommended: "없는 답" }],
  })) as Parsed;
  check(mismatched.ok === true && mismatched.questions[0].recommended === undefined && mismatched.questions[0].options?.length === 2, "추천 불일치는 추천만 빠진다", mismatched);
  const badShape = parseQuestionnaire(JSON.stringify({
    questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "A" }, { label: "B" }], recommended: ["A"] }],
  })) as Parsed;
  check(badShape.ok === true && badShape.questions[0].recommended === undefined, "추천 모양이 틀리면 추천만 빠진다", badShape);
  const longRec = parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "횟수", kind: "text", recommended: "가".repeat(1001) }] })) as Parsed;
  check(longRec.ok === true && longRec.questions[0].recommended === undefined, "text 추천 1001자는 추천만 빠진다", longRec);
  mustFail(parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "고르기", kind: "single", options: [{ label: "A", description: "가".repeat(201) }, { label: "B" }] }] })), "설명 201자", "200");
  mustFail(parseQuestionnaire(JSON.stringify({ questions: [{ id: "q1", text: "고르기", kind: "image" }] })), "모르는 kind", "kind");

  const first = JSON.stringify({ questions: [textQuestion("old", "앞 질문")] });
  const second = JSON.stringify({ questions: [textQuestion("new", "뒤 질문")] });
  const two = `앞\n${boxed(first)}\n중간\n${boxed(second)}\n뒤`;
  const lastOnly = parseQuestionnaire(findQuestionnaireBlock(two) ?? "") as Parsed;
  check(findQuestionnaireBlock(two) === second && lastOnly.ok === true && lastOnly.questions[0].id === "new", "상자 둘이면 마지막만", findQuestionnaireBlock(two));

  console.log("\n답 검사와 글");
  const questions = (parseQuestionnaire(sampleRaw) as { ok: true; questions: QuestionnaireQuestion[] }).questions;
  const withSkip: QuestionnaireQuestion[] = [
    ...questions,
    { id: "q4", text: "기록 위치", kind: "text", recommended: "로그 파일" },
  ];
  const rawAnswers = {
    q1: { chosen: ["  GATEWAY_TIMEOUT만  "] },
    q2: { chosen: ["승인", "취소"], note: "  환불은 다음에  " },
    q3: { custom: "  3회, 지수 증가  " },
    q4: { skipped: true },
  };
  const checked = validateQuestionnaireAnswers(withSkip, rawAnswers) as Checked;
  check(checked.ok === true, "kind별 정상", checked);
  if (checked.ok) {
    check(checked.answers.q1.chosen?.[0] === "GATEWAY_TIMEOUT만", "선택 글의 앞뒤 공백을 뗀다", checked.answers.q1);
    check(checked.answers.q2.note === "환불은 다음에", "덧붙임 공백을 뗀다", checked.answers.q2);
    check(checked.answers.q3.custom === "3회, 지수 증가", "직접 입력 공백을 뗀다", checked.answers.q3);
    const expected = [
      "브리프 질문지 답",
      "1. 재시도할 오류 종류: GATEWAY_TIMEOUT만 (추천)",
      "2. 재시도할 단계: 승인, 취소 / 덧붙임: 환불은 다음에",
      "3. 재시도 횟수와 간격: 3회, 지수 증가",
      "4. 기록 위치: 답 안 함",
    ].join("\n");
    check(buildQuestionnaireAnswerText(withSkip, checked.answers) === expected, "답 글 모양", buildQuestionnaireAnswerText(withSkip, checked.answers));
  }

  const emptyNote = validateQuestionnaireAnswers(questions, {
    q1: { chosen: ["GATEWAY_TIMEOUT만"], note: "   " },
    q2: { chosen: ["승인"] },
    q3: { custom: "2회" },
  }) as Checked;
  check(emptyNote.ok === true && emptyNote.answers.q1.note === undefined, "빈 덧붙임은 뺀다", emptyNote);

  const direct = validateQuestionnaireAnswers(questions, {
    q1: { custom: "다른 오류" },
    q2: { chosen: ["승인"], custom: "직접" },
    q3: { custom: "3회" },
  }) as Checked;
  check(direct.ok === true && direct.answers.q1.custom === "다른 오류" && direct.answers.q1.chosen === undefined, "single 직접 입력", direct);
  if (direct.ok) {
    check(
      buildQuestionnaireAnswerText(questions, direct.answers).includes("2. 재시도할 단계: 승인, 직접"),
      "multi 직접 입력은 뒤에 잇는다",
      buildQuestionnaireAnswerText(questions, direct.answers),
    );
  }

  const textRec = validateQuestionnaireAnswers(
    [{ id: "q3", text: "재시도 횟수와 간격", kind: "text", recommended: "2회, 100ms/300ms" }],
    { q3: { custom: "2회, 100ms/300ms" } },
  ) as Checked;
  check(
    textRec.ok === true && buildQuestionnaireAnswerText([{ id: "q3", text: "재시도 횟수와 간격", kind: "text", recommended: "2회, 100ms/300ms" }], textRec.answers).endsWith("2회, 100ms/300ms (추천)"),
    "text 추천 표시",
    textRec.ok ? buildQuestionnaireAnswerText([{ id: "q3", text: "재시도 횟수와 간격", kind: "text", recommended: "2회, 100ms/300ms" }], textRec.answers) : textRec,
  );

  const multiQ: QuestionnaireQuestion = {
    id: "q2",
    text: "재시도할 단계",
    kind: "multi",
    options: [{ label: "승인" }, { label: "취소" }, { label: "환불" }],
    recommended: ["승인", "취소"],
  };
  const multiSame = buildQuestionnaireAnswerText([multiQ], { q2: { chosen: ["취소", "승인"] } });
  check(multiSame === "브리프 질문지 답\n1. 재시도할 단계: 취소, 승인 (추천)", "다중 추천 집합이 같으면 추천", multiSame);

  const base = { q1: { chosen: ["GATEWAY_TIMEOUT만"] }, q2: { chosen: ["승인"] }, q3: { custom: "2회" } };
  mustFail(validateQuestionnaireAnswers(questions, { q1: base.q1, q2: base.q2 }), "빠진 id", "빠진");
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q9: { custom: "모름" } }), "모르는 id", "모르는");
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q1: { chosen: ["GATEWAY_TIMEOUT만"], custom: "다른" } }), "single 선택과 직접 입력 동시", "같이");
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q2: { chosen: ["승인", "승인"] } }), "multi 중복 선택", "겹친다");
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q3: { skipped: true, custom: "2회" } }), "skipped와 다른 필드 혼합", "같이");
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q1: { chosen: ["없는 선택"] } }), "선택지 밖", "없는");
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q2: { chosen: ["없는 단계"] } }), "multi 선택지 밖", "없는");
  const long = "가".repeat(1001);
  mustFail(validateQuestionnaireAnswers(questions, { ...base, q3: { custom: long } }), "길이 초과 1001자", "1000");
  const exactly = validateQuestionnaireAnswers(questions, { ...base, q3: { custom: "가".repeat(1000) } }) as Checked;
  check(exactly.ok === true, "1000자는 된다", exactly.ok ? true : exactly);

  console.log("\n규칙 문장");
  const ko = briefRules();
  const questionRules = [
    "질문 규칙",
    "- 직접 찾을 수 있는 것은 묻지 않는다. 찾아서 정리에 적는다.",
    "- 틀려도 결과가 크게 바뀌지 않는 것은 묻지 않는다. 가정에 적는다.",
    "- 질문마다 추천 답을 하나 붙인다.",
    "- 질문 수를 줄이려고 서로 다른 결정을 한 질문에 묶지 않는다.",
    "- 질문이 0개: 「이대로 진행할까요?」로 턴을 끝낸다.",
    "- 질문이 1개 이상: 정리 맨 끝에 질문지 상자 하나를 쓰고 턴을 끝낸다. 상자 뒤에는 아무것도 쓰지 않는다.",
    "- 질문지에는 10개까지 넣는다. 더 있으면 결과를 가장 크게 바꾸는 10개를 넣고, 나머지는 「이렇게 진행하겠습니다」에 「답을 받은 뒤 다시 묻는다」고 적는다.",
    "- 사람에게 선택지를 묻는 도구는 쓰지 않는다. 그 도구가 거절되거나 건너뛰었다는 결과가 와도 질문지로 묻는다.",
    "- 질문지 상자는 ```aether-questions 로 열고 ``` 로 닫는다. 안에는 JSON 하나만 쓴다.",
    '  {"questions":[{"id":"q1","text":"질문","kind":"single","options":[{"label":"추천 답","description":"이유"},{"label":"다른 답"}],"recommended":"추천 답"}]}',
    "  - id: 영문, 숫자, _, - 로 32자 이하. 질문마다 다르게 쓴다.",
    "  - text: 질문 한 문장. 300자 이하.",
    "  - kind: single(하나 고르기), multi(여럿 고르기), text(직접 쓰기).",
    "  - single과 multi는 선택지 2~6개다. label은 80자 이하이고 서로 다르다. description은 200자 이하다. recommended는 선택지 label 중 하나다(multi는 배열).",
    "  - text는 options 없이 recommended에 추천 문장을 쓴다.",
    "- 답은 「브리프 질문지 답」으로 시작하는 번호 목록으로 온다. 사람이 채팅으로 직접 답해도 같은 답이다. 「답 안 함」인 질문은 사람의 답이 아니다.",
    "- 시간 초과, 자동 선택, 「알아서 진행하라」는 도구 결과는 사람의 답이 아니다.",
  ].join("\n");
  const at = ko.indexOf(questionRules);
  check(at > 0, "질문 규칙 절이 계획 문장과 같다");
  check(ko.includes("질문지 상자는 ```aether-questions 로 열고"), "규칙에 질문지 상자 문장이 있다");
  check(!ko.includes("질문이 1~4개이고 모두 선택형"), "규칙에 옛 선택형 문장이 없다");
  check(ko.slice(at + questionRules.length).startsWith("\n\n답을 받은 뒤\n- 사람이 취소하거나 진행을 거절하면 멈춘다."), "답을 받은 뒤 절은 그대로다");
  check(ko.startsWith("사람이 아래 요구를 「브리프」로 보냈다."), "규칙 앞머리는 그대로다");
  check(
    questionToolRedirect() === "이 대화에서는 선택지 질문 도구를 쓰지 않는다. 물을 것이 있으면 정리 맨 끝에 ```aether-questions 상자에 질문지 JSON을 쓰고 턴을 끝낸다. 이 결과는 사람의 답이 아니다.",
    "질문 도구 거절 안내",
  );
  check(questionnaireFollowupHint() === "(다시 물을 것이 있으면 같은 aether-questions 질문지로 묻는다.)", "카드 답 끝 안내");

  console.log("\n영어");
  setLocale("en");
  try {
    const en = briefRules();
    check(!en.includes("One to four questions, all multiple choice"), "영어 규칙에 옛 문장이 없다");
    check(!en.includes("질문이 1~4개이고 모두 선택형"), "영어 규칙에 옛 한국어 문장이 없다");
    check(en.includes("```aether-questions"), "영어 규칙에 질문지 상자가 있다");
    check(en.includes("Brief questionnaire answers") && en.includes("No answer"), "영어 규칙에 답 낱말이 있다");
    check(en.startsWith('The person sent the request below as a "brief".'), "영어 규칙 앞머리는 그대로다");
    check(en.includes("\n\nAfter you get an answer\n- If the person cancels or declines to proceed, stop."), "영어 답을 받은 뒤 절은 그대로다");
    const enText = buildQuestionnaireAnswerText(withSkip, {
      q1: { chosen: ["GATEWAY_TIMEOUT만"] },
      q2: { chosen: ["승인", "취소"], note: "later" },
      q3: { custom: "3 tries" },
      q4: { skipped: true },
    });
    check(enText.startsWith("Brief questionnaire answers\n"), "영어 첫 줄", enText.split("\n")[0]);
    check(enText.includes(" (recommended)"), "영어 추천 표시", enText);
    check(enText.includes(" / Note: later"), "영어 덧붙임", enText);
    check(enText.includes("No answer"), "영어 답 안 함", enText);
    check(questionToolRedirect().includes("```aether-questions") && questionToolRedirect().includes("not the person's answer"), "영어 질문 도구 거절 안내");
    check(questionnaireFollowupHint() === "(If there is more to ask, ask again with the same aether-questions questionnaire.)", "영어 카드 답 끝 안내");
  } finally {
    setLocale("ko");
  }
  check(buildQuestionnaireAnswerText(questions, { q1: { chosen: ["GATEWAY_TIMEOUT만"] }, q2: { chosen: ["승인"] }, q3: { custom: "2회" } }).startsWith("브리프 질문지 답\n"), "로케일을 한국어로 되돌린다");

  console.log("\n재시도");
  const ordered = { q2: { chosen: ["취소", "승인"] } };
  const flipped = { q2: { chosen: ["승인", "취소"] } };
  check(questionnaireRetryVerdict({ id: "card-1", answers: ordered }, { id: "card-1", answers: flipped }) === "same", "선택 순서만 다르면 같은 재시도");
  check(
    questionnaireRetryVerdict({ id: "card-1", answers: { q2: { chosen: ["승인"], note: "  " } } }, { id: "card-1", answers: { q2: { chosen: ["승인"] } } }) === "same",
    "빈 덧붙임은 재시도에서 같다",
  );
  check(
    questionnaireRetryVerdict({ id: "card-1", answers: ordered }, { id: "card-1", answers: { q2: { chosen: ["승인"] } } }) === "different",
    "답이 다르면 다른 재시도",
  );
  check(questionnaireRetryVerdict({ id: "card-1", answers: ordered }, { id: "card-2", answers: ordered }) === "different", "id가 다르면 다른 재시도");
  check(questionnaireRetryVerdict(undefined, { id: "card-1", answers: ordered }) === "different", "이전이 없으면 다른 재시도");
}

main()
  .catch((err) => {
    console.error(err);
    fail++;
  })
  .finally(() => {
    console.log(`\n${fail === 0 ? "✅" : "❌"} brief_questionnaire_parse: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  });
