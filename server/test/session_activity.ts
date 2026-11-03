/** 사이드바 최근 활동 시각 판정 — provider 원본이 아닌 중립 사건 기준. */
import { affectsLastActivity } from "../sessions/eventSemantics";
import type { AetherEvent } from "../types";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  cond ? pass++ : fail++;
}

const codec = {
  normalize(ev: AetherEvent): Array<{ type: string; severity?: "warn" }> {
    const mark = (ev as AetherEvent & { mark?: string }).mark;
    if (mark === "commands") return [{ type: "commands_available" }, { type: "usage_update" }];
    if (mark === "text") return [{ type: "text" }];
    if (mark === "warn") return [{ type: "provider_notice", severity: "warn" }];
    if (mark === "info") return [{ type: "provider_notice" }];
    if (mark === "done") return [{ type: "turn_completed" }];
    return [];
  },
};
const raw = (mark: string) => ({ seq: 1, ts: 1, kind: "fake", msg: {}, mark }) as unknown as AetherEvent;

check(!affectsLastActivity(raw("commands"), codec), "동일 command/usage 상태 알림은 최근 활동을 바꾸지 않는다");
check(!affectsLastActivity({ seq: 2, ts: 2, kind: "status", status: "completed" }, codec), "세션 status만으로 최근 활동을 바꾸지 않는다");
check(!affectsLastActivity({ seq: 3, ts: 3, kind: "ctx", totalTokens: 1, maxTokens: 10 }, codec), "문맥 사용량만으로 최근 활동을 바꾸지 않는다");
check(!affectsLastActivity(raw("info"), codec), "화면에 안 보이는 정보성 provider 알림은 최근 활동을 바꾸지 않는다");
check(affectsLastActivity(raw("text"), codec), "새 모델 본문은 최근 활동이다");
check(affectsLastActivity(raw("done"), codec), "대화 결과 푸터는 최근 활동이다");
check(affectsLastActivity(raw("warn"), codec), "사람에게 보이는 provider 경고는 최근 활동이다");
check(affectsLastActivity({ seq: 4, ts: 4, kind: "user_msg", text: "안녕" }, codec), "새 사용자 메시지는 최근 활동이다");
check(
  affectsLastActivity({ seq: 5, ts: 5, kind: "question_resolved", id: "q", answered: true, answers: [["A"]] }, codec),
  "사람의 카드 응답은 최근 활동이다",
);

console.log(`\n${fail === 0 ? "✅" : "❌"} session_activity: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
