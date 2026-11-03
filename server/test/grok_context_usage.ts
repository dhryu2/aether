/**
 * Grok 문맥 점유량 파서. 모델 호출 0.
 * 실행: tsx test/grok_context_usage.ts
 */
import { GROK_CONTEXT_WINDOW, contextUsageFromGrokNotice } from "../providers/grok/contextUsage";

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const live = contextUsageFromGrokNotice({
  sessionId: "01a0280b-580b-72e1-8736-48a0fb7913fc",
  update: { sessionUpdate: "tool_call", title: "Web search:" },
  _meta: { totalTokens: 15918, eventId: "01a0280b-580b-72e1-8736-48a0fb7913fc-85" },
});
check(live?.totalTokens === 15918, "실측 _meta.totalTokens를 점유량으로 읽는다", live);
check(live?.maxTokens === GROK_CONTEXT_WINDOW, "창 크기가 없으면 공식 창을 쓴다", live);

const titled = contextUsageFromGrokNotice({
  update: { sessionUpdate: "session_info_update", title: "Orca-style Project Session Tab Grouping" },
});
check(titled == null, "제목만 있는 session_info_update는 점유량이 아니다", titled);

const sized = contextUsageFromGrokNotice({
  _meta: { totalTokens: 272158, maxTokens: 400000 },
});
check(sized?.totalTokens === 272158 && sized?.maxTokens === 400000, "스트림이 준 창 크기를 공식 창보다 앞세운다", sized);

const legacy = contextUsageFromGrokNotice({
  update: { sessionUpdate: "session_info_update", used: 1200, size: 258400 },
});
check(legacy?.totalTokens === 1200 && legacy?.maxTokens === 258400, "옛 used/size도 읽는다", legacy);

check(contextUsageFromGrokNotice({}) == null, "빈 알림은 점유량이 없다");
check(contextUsageFromGrokNotice(null) == null, "null은 점유량이 없다");
check(contextUsageFromGrokNotice({ _meta: { eventId: "x" } }) == null, "토큰 없는 _meta는 점유량이 없다");
check(contextUsageFromGrokNotice({ _meta: { totalTokens: -1 } }) == null, "음수는 점유량이 아니다");

if (fail) {
  console.log(`\n❌ ${fail} 실패 / ${pass} 통과`);
  process.exit(1);
}
console.log(`\n✅ 전체 ${pass}개 통과`);
