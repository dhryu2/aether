/**
 * 작업 제목 파생 — 첫 말에서 뽑기, 폴더 이름을 목록 제목으로 쓰지 않기.
 */
import { clampWorkPreview, deriveWorkTitle, resolveWorkTitle } from "../../shared/workTitle";
import { lastWorkPreview } from "../sessions/workPreview";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`);
  c ? pass++ : fail++;
};

check(deriveWorkTitle("Please fix the login timeout bug") === "Fix the login timeout bug", "영어 인사말을 걷고 첫 문장을 쓴다");
check(deriveWorkTitle("Help me rename session tabs") === "Rename session tabs", "help me 를 걷는다");
check(deriveWorkTitle("세션 탭 이름을 폴더가 아니라 대화 제목으로 바꿔줘") === "세션 탭 이름을 폴더가 아니라 대화 제목으로 바꿔줘", "한국어 첫 문장을 그대로 쓴다");
check(deriveWorkTitle("좀 도와줘 배포가 또 실패했어") === "배포가 또 실패했어", "한국어 앞 군더더기를 걷는다");
check(deriveWorkTitle("/compact") === null, "내용 없는 슬래시 명령은 제목이 아니다");
check(deriveWorkTitle("/security-audit 이 저장소를 감사해줘.\n\n- 조건") === "이 저장소를 감사해줘", "슬래시 명령 단어를 떼고 남은 말로 뽑는다");
check(deriveWorkTitle("/review\n로그인 코드를 봐줘") === "로그인 코드를 봐줘", "명령 뒤 줄바꿈도 공백으로 본다");
check(deriveWorkTitle("```\n로그 내용\n```\n왜 죽었어?") === "로그 내용", "코드 블록으로 시작해도 내용 있는 첫 줄로 뽑는다");
check(deriveWorkTitle("   ") === null, "빈 말은 제목이 아니다");
check(deriveWorkTitle("https://example.com/path fix this") === "Fix this", "URL을 제목에 넣지 않는다");

const long = "A".repeat(80);
const derivedLong = deriveWorkTitle(long);
check(!!derivedLong && derivedLong.length <= 40, "긴 말은 40자 안에서 자른다", `len=${derivedLong?.length}`);

check(resolveWorkTitle("수동", "자동") === "수동", "사람 이름이 자동 제목보다 앞선다");
check(resolveWorkTitle("  ", "자동") === "자동", "빈 사람 이름은 자동 제목으로 간다");
check(resolveWorkTitle(undefined, undefined) === "", "둘 다 없으면 빈 문자열 — 화면이 새 작업으로 채운다");
check(resolveWorkTitle("", "") === "", "공백도 빈 제목이다");
check(clampWorkPreview("  안녕   세상  ") === "안녕 세상", "미리보기는 공백을 접는다");
check(clampWorkPreview("A".repeat(80)).endsWith("…") && clampWorkPreview("A".repeat(80)).length <= 72, "긴 미리보기는 자른다");

const stubCodec = {
  normalize: (ev: { kind?: string; text?: string }) =>
    ev.kind === "assistant" ? [{ type: "text" as const, text: "고쳤습니다", provider: "x", seq: 1, part: 0, ts: 1 }] : [],
};
check(lastWorkPreview([{ seq: 1, ts: 1, kind: "user_msg", text: "  로그인 고쳐줘  " }], stubCodec as never) === "로그인 고쳐줘", "목록 미리보기는 사용자 말을 쓴다");
check(lastWorkPreview([{ seq: 1, ts: 1, kind: "assistant", msg: null }], stubCodec as never) === "고쳤습니다", "목록 미리보기는 모델 본문도 쓴다");

console.log("─".repeat(50));
console.log(`work_title: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
