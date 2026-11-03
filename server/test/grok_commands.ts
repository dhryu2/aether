/**
 * Grok 명령 메뉴 필터 — handshake 원본에서 실행 가능한 것만 남긴다 (10i).
 */
import { grokMenuCommands, withGrokBuiltins } from "../providers/grok/commands";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  cond ? pass++ : fail++;
}

const cmds = grokMenuCommands([
  { name: "compact", description: "Compact conversation history" },
  { name: "dashboard" },
  { name: "/memory" },
  { name: "rewind" },
  { name: "fork" },
  { name: "remember" },
  { name: "plan" },
  { name: "clear" },
  { name: "new" },
  { name: "help" },
  { name: "settings" },
]);
const names = cmds.map((c) => c.name);
check(names.includes("compact"), "실행 가능 compact를 남긴다", names);
check(names.includes("plan"), "handshake가 준 실행 가능 plan을 남긴다", names);
check(names.includes("clear") && cmds.find((c) => c.name === "clear")?.uiAction === undefined, "handshake가 준 clear도 실행기로 남긴다", names);
check(!cmds.some((c) => c.name === "memory"), "/memory는 Grok 자체 기억 도구라 광고하지 않는다");
check(!names.includes("dashboard"), "터미널 전용 dashboard를 뺀다");
check(!names.includes("new") && !names.includes("help") && !names.includes("settings"), "화면이 맡는 기본 명령은 실행기 목록에서 뺀다", names);
check(!names.includes("rewind") && !names.includes("fork"), "아직 없는 rewind/fork를 광고하지 않는다");
check(!names.includes("remember"), "Grok 기억 도구 remember를 광고하지 않는다");
check(names.filter((n) => n === "compact").length === 1, "compact만 하드코딩한 목록이 아니다 — handshake에서 온다");
check(grokMenuCommands([]).length === 0, "빈 handshake면 빈 목록이다");
check(grokMenuCommands([{ name: "dashboard" }, { name: "rewind" }]).length === 0, "올릴 게 없으면 빈 메뉴다");
const withoutClear = grokMenuCommands([{ name: "compact" }]);
check(!withoutClear.some((c) => c.name === "clear"), "실측 handshake는 clear를 안 준다", withoutClear);
check(withGrokBuiltins(withoutClear).some((c) => c.name === "clear" && c.uiAction === undefined), "내장이 handshake에 없는 clear를 채운다");
check(withGrokBuiltins([]).some((c) => c.name === "clear"), "handshake가 비어도 내장 clear는 있다");
check(withGrokBuiltins(cmds).filter((c) => c.name === "clear").length === 1, "이미 있는 clear를 중복하지 않는다");

console.log(`\n${fail === 0 ? "✅" : "❌"} grok_commands: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
