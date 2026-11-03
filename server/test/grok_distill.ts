/**
 * Grok 배경 작업 격리 계약 테스트 (Phase 10d) — 모델 호출 0.
 *
 * 10a S12 레시피가 글자 그대로 나가는지, 실패·빈 글을 성공으로 치지 않는지를 고정한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokdistill-"));
process.env.AETHER_DATA_DIR ??= DATA_DIR;
process.env.AETHER_DISTILL_TIMEOUT_MS = "3000";
process.env.AETHER_GROK_DISTILL_MODEL = "grok-4.5";

const SOURCE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokhome-src-"));
fs.writeFileSync(path.join(SOURCE_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "FAKE" } }), { mode: 0o644 });
fs.writeFileSync(path.join(SOURCE_HOME, "config.toml"), "[mcp]\nservers = []\n");
fs.mkdirSync(path.join(SOURCE_HOME, "skills"), { recursive: true });
process.env.GROK_HOME = SOURCE_HOME;

const { makeFakeGrokBin } = await import("./support/fakeGrokStdio");
const fake = makeFakeGrokBin();
process.env.AETHER_GROK_BIN = fake.bin;

await import("../providers/registry");
const { resetGrokBinCache } = await import("../providers/grok/transport");
resetGrokBinCache();
const {
  DISTILL_DISALLOWED_TOOLS,
  distillArgv,
  parseDistillStream,
  runGrokDistill,
  runGrokDistillObserved,
} = await import("../providers/grok/distill");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

type Call = { method: string; params: Record<string, unknown> };
function observe(): { file: string; read: () => Call[] } {
  const file = path.join(DATA_DIR, `calls-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_GROK_CALLS_FILE = file;
  return {
    file,
    read: () =>
      fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Call)
        : [],
  };
}

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokdistill-cwd-"));
const seen = observe();
const text = await runGrokDistill("한 줄로 요약해줘", CWD);
const calls = seen.read();
check(text === "받음: 한 줄로 요약해줘", "배경 작업이 모델 답을 돌려준다", text);

// 옵션 없이 부르면 모델 고르기용 목록 조회(agent stdio)도 __spawn을 남기므로, 배경 작업 본 실행(-p)만 고른다.
const spawn = calls.find((c) => c.method === "__spawn" && (c.params.argv as string[] | undefined)?.[0] === "-p");
check(!!spawn, "프로세스 관측 기록이 남았다");
const isolatedHome = String(spawn?.params?.grokHome ?? "");
check(!!isolatedHome && isolatedHome !== SOURCE_HOME, "① 사용자 설정 폴더가 아니라 임시 폴더로 띄운다", { isolatedHome, SOURCE_HOME });
const homeEntries = spawn?.params?.homeEntries as { name: string; mode: string }[] | undefined;
check(
  JSON.stringify(homeEntries) === JSON.stringify([{ name: "auth.json", mode: "600" }]),
  "① 임시 폴더엔 인증 파일 하나뿐이고 권한이 0600이다",
  homeEntries,
);
check(spawn?.params?.grokMemory === "0", "① GROK_MEMORY=0", spawn?.params?.grokMemory);

const argv = (spawn?.params?.argv as string[]) ?? [];
check(argv.includes("-p"), "② grok -p 로 뜬다");
check(argv.includes("--tools") && argv[argv.indexOf("--tools") + 1] === "todo_write", "② --tools todo_write");
check(argv.includes("--disallowed-tools") && argv[argv.indexOf("--disallowed-tools") + 1] === DISTILL_DISALLOWED_TOOLS, "② 금지 도구 목록이 글자 그대로다");
check(argv.includes("--no-subagents") && argv.includes("--disable-web-search") && argv.includes("--always-approve"), "② 하위 에이전트·웹 검색을 끈다");
check(argv.includes("--max-turns") && argv[argv.indexOf("--max-turns") + 1] === "4", "② --max-turns 4");
check(argv.includes("-m") && argv[argv.indexOf("-m") + 1] === "grok-4.5", "② 못 박은 모델 grok-4.5");
check(typeof argv[argv.indexOf("--cwd") + 1] === "string" && argv[argv.indexOf("--cwd") + 1] !== CWD, "③ 세션 작업 폴더가 아니라 빈 폴더에서 돈다");

const recipe = distillArgv("x", "grok-4.5", "/tmp/empty");
const missing = [
  "run_terminal_cmd",
  "run_terminal_command",
  "search_replace",
  "web_search",
  "web_fetch",
  "read_file",
  "list_dir",
  "grep",
  "Agent",
].filter((t) => !DISTILL_DISALLOWED_TOOLS.split(",").includes(t));
check(missing.length === 0, `② 꺼야 하는 도구가 하나도 안 빠졌다 (빠진 것: ${missing.join(", ") || "없음"})`);
check(recipe.includes("--disallowed-tools"), "② 레시피에 금지 플래그가 있다");

check(!fs.existsSync(isolatedHome), "④ 끝나면 임시 설정 폴더가 남지 않는다", isolatedHome);
check(fs.existsSync(path.join(SOURCE_HOME, "config.toml")), "사용자의 진짜 설정 폴더는 건드리지 않는다");

const parsedTool = parseDistillStream(JSON.stringify({ type: "tool_call", toolName: "run_terminal_command" }) + "\n");
check(parsedTool.toolAttempts.includes("run_terminal_command"), "도구 시도 줄을 관측에 남긴다", parsedTool.toolAttempts);
const streamed = parseDistillStream(
  ['{"type":"thought","data":"hmm"}', '{"type":"text","data":"DIST"}', '{"type":"text","data":"ILL-OK"}', '{"type":"end","stopReason":"end_turn"}'].join("\n"),
);
check(streamed.text === "DISTILL-OK", "streaming-json 본문은 type=text 의 data 조각을 이어 붙인다", streamed.text);
const noisy = parseDistillStream('{"type":"result","result":"받음: x"}\n(node:1) Warning: The NO_COLOR env is ignored due to the FORCE_COLOR env being set.\n');
check(noisy.text === "받음: x", "Node 경고 줄은 본문이 아니다", noisy.text);
{
  const json = '{"slots":[{"id":"target_screen","name":"고칠 화면"}]}';
  const parsed = parseDistillStream(`${JSON.stringify({ type: "result", result: json })}\n`);
  const text = parsed.text.trim();
  check(text === json && parsed.parseFailed === false, "JSON 객체 답 하나가 바뀌지 않고 돌아온다", text);
}

// 프로세스를 띄우는 경로에서도 JSON 객체 답 하나가 한 번만, 그대로 돌아온다(가짜 프로세스는 「받음: 」을 붙인다).
observe();
{
  const json = '{"slots":[{"id":"target_screen","name":"고칠 화면"}]}';
  const out = await runGrokDistill(json, CWD);
  check(out === `받음: ${json}`, "실행 경로에서 JSON 객체 답 하나가 바뀌지 않고 한 번만 돌아온다", out);
}

observe();
const clean = await runGrokDistillObserved("관측", CWD);
check(clean.exitCode === 0, "정상 실행의 종료 코드는 0이다", clean.exitCode);
check(clean.toolAttempts.length === 0 && clean.homeEntries.every((n) => n === "auth.json"), "실행이 스스로 격리 상태를 관측한다", clean);
const metaOnly = parseDistillStream(JSON.stringify({ type: "tool_call", toolName: "search_tool" }) + "\n" + JSON.stringify({ type: "result", result: "ok" }));
check(metaOnly.toolAttempts.length === 0, "search_tool 메타 도구는 격리 파손으로 세지 않는다");

observe();
const leaky = await runGrokDistillObserved("@@tool@@ 셸을 열어라", CWD);
check(leaky.toolAttempts.includes("run_terminal_command"), "격리가 깨져 셸 시도가 있으면 관측에 잡힌다", leaky.toolAttempts);

const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grokhome-empty-"));
process.env.GROK_HOME = EMPTY_HOME;
let authError = "";
try {
  await runGrokDistill("안 돌아야 한다", CWD);
} catch (e) {
  authError = String((e as Error)?.message ?? e);
}
check(authError.includes("로그인") || authError.toLowerCase().includes("credential"), "⑤ 인증 정보가 없으면 이유를 밝히고 멈춘다", authError.slice(0, 120));
check(!authError.includes(SOURCE_HOME), "⑤ 그 문구에 설정 폴더 절대 경로를 싣지 않는다", authError.slice(0, 120));
check(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("aether-grok-distill-home-")).length === 0, "⑤ 실패해도 임시 폴더를 남기지 않는다");
process.env.GROK_HOME = SOURCE_HOME;

const t0 = Date.now();
let slowError = "";
try {
  await runGrokDistill("@@hang@@ 오래 걸리는 작업", CWD);
} catch (e) {
  slowError = String((e as Error)?.message ?? e);
}
const elapsed = Date.now() - t0;
check(elapsed < 12_000, "⑥ 시간 상한을 넘기면 매달리지 않고 돌아온다", `${elapsed}ms`);
check(slowError.length > 0, "⑥ 중단된 실행은 오류로 올라온다(빈 결과를 성공으로 위장하지 않는다)", slowError.slice(0, 80));

let emptyError = "";
try {
  await runGrokDistill("@@empty@@", CWD);
} catch (e) {
  emptyError = String((e as Error)?.message ?? e);
}
check(emptyError.length > 0, "빈 글을 성공으로 치면 안 된다", emptyError.slice(0, 80));

let failError = "";
try {
  await runGrokDistill("@@fail@@", CWD);
} catch (e) {
  failError = String((e as Error)?.message ?? e);
}
check(failError.length > 0, "⑦ 실패 종료는 오류로 올라온다", failError.slice(0, 80));

observe();
const blind = await runGrokDistillObserved("@@badjson@@", CWD);
check(!!blind.observeFailed, "⑧ 스트림 파싱이 실패하면 그 사실을 남긴다(깨끗하다고 속이지 않는다)", blind.observeFailed);

{
  const stubborn = fs.mkdtempSync(path.join(os.tmpdir(), "aether-grok-distill-home-stub-"));
  fs.writeFileSync(path.join(stubborn, "auth.json"), "{}");
  const { removeTempDirForTest } = await import("../providers/grok/distill");
  fs.chmodSync(stubborn, 0o500);
  let threw = false;
  try {
    removeTempDirForTest(stubborn);
  } catch {
    threw = true;
  }
  check(!threw, "임시 폴더를 못 지워도 예외를 밖으로 내보내지 않는다");
  fs.chmodSync(stubborn, 0o700);
  fs.rmSync(stubborn, { recursive: true, force: true });
}

fs.rmSync(fake.dir, { recursive: true, force: true });
fs.rmSync(SOURCE_HOME, { recursive: true, force: true });
fs.rmSync(EMPTY_HOME, { recursive: true, force: true });
fs.rmSync(CWD, { recursive: true, force: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} grok_distill: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
