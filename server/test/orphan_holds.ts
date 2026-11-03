/**
 * 재시작 뒤 미해결 카드 정리. 실행: npx tsx server/test/orphan_holds.ts
 */
import { orphanHoldResolves } from "../sessions/orphanHolds";
import { isControlEvent } from "../types";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e?: unknown) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c || e === undefined ? "" : " — " + JSON.stringify(e)}`);
  c ? pass++ : fail++;
};

{
  const out = orphanHoldResolves([
    { kind: "question_request", req: { id: "q1" } },
    { kind: "permission_request", req: { id: "p1" } },
    { kind: "plan_request", req: { id: "pl1" } },
  ]);
  check(out.some((e) => isControlEvent(e, "question_resolved") && e.id === "q1" && e.answered === false), "미해결 질문은 넘어감");
  check(out.some((e) => isControlEvent(e, "permission_resolved") && e.id === "p1" && e.decision === "deny"), "미해결 권한은 거부");
  check(out.some((e) => isControlEvent(e, "plan_resolved") && e.id === "pl1" && e.decision === "cancel"), "미해결 계획은 취소");
}

{
  const out = orphanHoldResolves([
    { kind: "question_request", req: { id: "q1" } },
    { kind: "question_resolved", id: "q1" },
    { kind: "permission_request", req: { id: "p1" } },
    { kind: "permission_resolved", id: "p1" },
  ]);
  check(out.length === 0, "이미 닫힌 카드는 다시 안 닫는다", out);
}

console.log(`────────────────────────────────────────────────────────`);
console.log(`orphan_holds: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
