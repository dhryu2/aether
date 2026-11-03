/**
 * Codex 배경 작업 격리 계약 테스트 (Phase 8f 단위 3) — 모델 호출 0, 사용량 0.
 *
 * 배경 작업(기억 자동 저장·압축·검색 요약·스킬 생성)은 사용자에게 승인 카드를 띄우지 않고 돈다.
 * 그래서 이 실행에 도구가 하나라도 붙어 있으면 아무도 못 본 채로 파일을 읽고 명령을 돌릴 수 있다.
 * 8a가 적대적 실험으로 확정한 격리 구성이 **글자 단위로 그대로 실행되는지**를 여기서 고정한다.
 *
 *   ① 임시 설정 폴더에 **인증 파일 하나만** 권한 0600으로 들어간다(사용자 설정·MCP·플러그인 미상속).
 *   ② 도구 제거 설정이 프로세스 인자로 정확히 실려 나간다.
 *   ③ 스레드가 일회용·읽기 전용·승인 안 물음·빈 작업 폴더·MCP 목록 비움으로 시작한다.
 *   ④ 끝나면 임시 폴더가 남지 않는다.
 *   ⑤ 인증 파일이 없으면 이유를 밝히고 멈춘다(알 수 없는 오류로 실패하지 않는다).
 *   ⑥ 시간 상한을 넘기면 프로세스를 내리고 돌아온다(영원히 매달리지 않는다).
 *
 * 실제 모델로 "정말 도구를 못 쓰나"를 확인하는 것은 `canary:codex`의 적대적 시나리오가 맡는다.
 * 이 파일은 "언제나 그 구성으로 뜨나"를 본다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexdistill-"));
process.env.AETHER_DATA_DIR ??= DATA_DIR;
// 시간 상한 검사를 몇 초 안에 끝내려고 낮춘다(정상 실행은 1초도 안 걸린다).
process.env.AETHER_DISTILL_TIMEOUT_MS = "3000";
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";
// 쓸 모델을 못 박아 "제일 싼 것 고르기" 질문이 끼어들지 않게 한다(그 규칙은 test/distill_model.ts가 본다).
process.env.AETHER_CODEX_DISTILL_MODEL = "gpt-5.4-mini";

/** 사용자의 진짜 설정 폴더인 척하는 곳 — 인증 파일 말고도 여러 개를 넣어 둔다(안 따라오는지 보려고). */
const SOURCE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexhome-src-"));
fs.writeFileSync(path.join(SOURCE_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "FAKE" } }), { mode: 0o644 });
fs.writeFileSync(path.join(SOURCE_HOME, "config.toml"), '[mcp_servers.node_repl]\ncommand = "node"\n');
fs.mkdirSync(path.join(SOURCE_HOME, "skills"), { recursive: true });
process.env.CODEX_HOME = SOURCE_HOME;

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

await import("../providers/registry");
const { DISTILL_CONFIG_OVERRIDES, runCodexDistill, runCodexDistillObserved } = await import("../providers/codex/distill");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

type Call = { method: string; params: Record<string, any> };
/** 가짜 서버가 흘린 관측 기록을 읽는다(프로세스를 서버 코드가 직접 내리므로 질문을 보낼 통로가 없다). */
function observe(): { file: string; read: () => Call[] } {
  const file = path.join(DATA_DIR, `calls-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_CALLS_FILE = file;
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

// ────────────────────────────────────────────────────────────────────────────
// 정상 실행 — 격리 구성이 그대로 나가는가
// ────────────────────────────────────────────────────────────────────────────

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexdistill-cwd-"));
const seen = observe();
const text = await runCodexDistill("한 줄로 요약해줘", CWD);
const calls = seen.read();

check(text === "받음: 한 줄로 요약해줘", "배경 작업이 모델 답을 돌려준다", text);

const spawn = calls.find((c) => c.method === "__spawn");
check(!!spawn, "프로세스 관측 기록이 남았다");
const isolatedHome = String(spawn?.params?.codexHome ?? "");
check(!!isolatedHome && isolatedHome !== SOURCE_HOME, "① 사용자 설정 폴더가 아니라 임시 폴더로 띄운다", { isolatedHome, SOURCE_HOME });
check(
  JSON.stringify(spawn?.params?.homeEntries) === JSON.stringify([{ name: "auth.json", mode: "600" }]),
  "① 임시 폴더엔 인증 파일 하나뿐이고 권한이 0600이다(사용자 config·MCP·스킬 미상속)",
  spawn?.params?.homeEntries,
);
check(
  JSON.stringify(spawn?.params?.overrides) === JSON.stringify(DISTILL_CONFIG_OVERRIDES),
  "② 도구 제거 설정이 글자 그대로 실려 나간다",
  spawn?.params?.overrides,
);
// 위 검사는 "적힌 대로 나가는가"만 본다 — 목록에서 한 줄이 사라져도 통과한다. 그래서 꺼야 하는 것들을
//   여기에 따로 적어 대조한다(어느 하나가 빠지면 그 도구가 배경 작업에 다시 붙는다).
const MUST_DISABLE = [
  'web_search="disabled"',
  "features.shell_tool=false",
  "features.apps=false",
  "features.remote_plugin=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.multi_agent=false", // 하위 에이전트 — 8g 카나리에서 모델이 실제로 시도했다
  "features.multi_agent_v2=false", // 현재 기본값이 꺼져도 보안 계약은 기본값에 기대지 않는다
];
const missingDisable = MUST_DISABLE.filter((k) => !DISTILL_CONFIG_OVERRIDES.includes(k));
check(missingDisable.length === 0, `② 꺼야 하는 도구가 하나도 안 빠졌다 (빠진 것: ${missingDisable.join(", ") || "없음"})`);

const start = calls.find((c) => c.method === "thread/start");
check(start?.params?.ephemeral === true, "③ 일회용 스레드(대화 기록을 디스크에 안 남긴다)", start?.params?.ephemeral);
check(start?.params?.sandbox === "read-only", "③ 읽기 전용", start?.params?.sandbox);
check(start?.params?.approvalPolicy === "never", "③ 승인을 묻지 않는다(물어봐도 받을 사람이 없다)", start?.params?.approvalPolicy);
check(JSON.stringify(start?.params?.config) === JSON.stringify({ mcp_servers: {} }), "③ MCP 목록을 비운다(사용자 MCP 미상속 — 8a에서 이걸 빼면 뚫렸다)", start?.params?.config);
check(typeof start?.params?.cwd === "string" && start.params.cwd !== CWD, "③ 세션 작업 폴더가 아니라 빈 폴더에서 돈다", { used: start?.params?.cwd, session: CWD });

const turn = calls.find((c) => c.method === "turn/start");
check(turn?.params?.model === "gpt-5.4-mini", "못 박은 모델이 턴에 실린다", turn?.params?.model);
check(turn?.params?.effort === "low", "받는 것 중 가장 낮은 추론 강도로 돈다", turn?.params?.effort);

check(!fs.existsSync(isolatedHome), "④ 끝나면 임시 설정 폴더가 남지 않는다", isolatedHome);
check(!fs.existsSync(String(start?.params?.cwd)), "④ 끝나면 빈 작업 폴더도 남지 않는다", start?.params?.cwd);
check(fs.existsSync(path.join(SOURCE_HOME, "config.toml")), "사용자의 진짜 설정 폴더는 건드리지 않는다");

// 매 실행이 스스로를 관측한다 — 격리가 언젠가 조용히 깨져도 로그로 드러나게 하는 장치다.
observe();
const clean = await runCodexDistillObserved("관측", CWD);
check(clean.toolAttempts.length === 0 && clean.mcpServers.length === 0 && clean.threadPath === null, "실행이 스스로 격리 상태를 관측한다(정상이면 전부 비어 있다)", clean);

process.env.FAKE_MCP_SERVERS = "node_repl";
observe();
const leaky = await runCodexDistillObserved("관측", CWD);
delete process.env.FAKE_MCP_SERVERS;
check(leaky.mcpServers.includes("node_repl"), "격리가 깨져 MCP 서버가 붙어 있으면 관측에 잡힌다(경보의 근거)", leaky.mcpServers);

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 인증 파일이 없을 때
// ────────────────────────────────────────────────────────────────────────────

const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codexhome-empty-"));
process.env.CODEX_HOME = EMPTY_HOME;
let authError = "";
try {
  await runCodexDistill("안 돌아야 한다", CWD);
} catch (e) {
  authError = String((e as Error)?.message ?? e);
}
check(authError.includes("로그인") || authError.toLowerCase().includes("credential"), "⑤ 인증 정보가 없으면 이유를 밝히고 멈춘다", authError.slice(0, 120));
check(!authError.includes(SOURCE_HOME), "⑤ 그 문구에 설정 폴더 절대 경로를 싣지 않는다(화면·로그로 나가는 글이다)", authError.slice(0, 120));
check(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("aether-codex-distill-home-")).length === 0, "⑤ 실패해도 임시 폴더를 남기지 않는다");
process.env.CODEX_HOME = SOURCE_HOME;

// ────────────────────────────────────────────────────────────────────────────
// ⑥ 시간 상한
// ────────────────────────────────────────────────────────────────────────────

process.env.FAKE_TURN_DELAY_MS = "20000"; // 상한(3초)보다 훨씬 길게 끈다
const slowSeen = observe();
const t0 = Date.now();
let slowError = "";
try {
  await runCodexDistill("@@slow@@ 오래 걸리는 작업", CWD);
} catch (e) {
  slowError = String((e as Error)?.message ?? e);
}
const elapsed = Date.now() - t0;
delete process.env.FAKE_TURN_DELAY_MS;
check(elapsed < 12_000, "⑥ 시간 상한을 넘기면 매달리지 않고 돌아온다", `${elapsed}ms`);
// ★ 빈 문자열을 정상 반환하면 호출자(reflect)가 "수확 없음"을 성공으로 받아들이고 그 대화 구간을
//   영영 다시 안 본다. 끝나지 못한 실행은 반드시 오류로 올라와야 한다.
check(slowError.length > 0, "⑥ 중단된 실행은 오류로 올라온다(빈 결과를 성공으로 위장하지 않는다)", slowError.slice(0, 80));
const slowSpawn = slowSeen.read().find((c) => c.method === "__spawn");
check(!fs.existsSync(String(slowSpawn?.params?.codexHome ?? "")), "⑥ 중단돼도 임시 폴더는 정리된다");

// ⑦ 턴이 실패·중단 상태로 끝나도 마찬가지다 — "끝났다"가 곧 "됐다"는 아니다.
observe();
let failedError = "";
try {
  await runCodexDistill("@@failturn@@ 실패하는 턴", CWD);
} catch (e) {
  failedError = String((e as Error)?.message ?? e);
}
check(failedError.includes("failed"), "⑦ 실패로 끝난 턴은 오류로 올라온다", failedError.slice(0, 80));

// ⑧ 격리 관측이 실패하면 "0개"가 아니라 "모름"으로 남는다(fail-open 금지).
process.env.FAKE_MCP_FAIL = "1";
observe();
const blind = await runCodexDistillObserved("관측 실패", CWD);
delete process.env.FAKE_MCP_FAIL;
check(!!blind.observeFailed, "⑧ MCP 목록 조회가 실패하면 그 사실을 남긴다(깨끗하다고 속이지 않는다)", blind.observeFailed);

// ⑨ 모르는 종류의 항목도 도구 시도로 센다 — 감시 목록을 손으로 적어 두면 새 종류가 조용히 빠져나간다.
observe();
const unknownTool = await runCodexDistillObserved("@@weirdtool@@ 낯선 도구", CWD);
check(unknownTool.toolAttempts.includes("dynamicToolCall"), "⑨ 처음 보는 항목 종류도 도구 시도로 잡는다", unknownTool.toolAttempts);

// JSON 객체 답 하나 — 가짜 서버는 「받음: 」 뒤에 입력을 붙인 assistant 메시지 하나를 보낸다. 그 글이 한 번만, 그대로 돌아온다.
observe();
{
  const json = '{"slots":[{"id":"target_screen","name":"고칠 화면"}]}';
  const out = await runCodexDistill(json, CWD);
  check(out === `받음: ${json}`, "JSON 객체 답 하나가 바뀌지 않고 한 번만 돌아온다", out);
}

// 완료 알림만 오고 assistant 글이 없는 턴. 지금 동작은 빈 문자열이고 예외가 아니다.
observe();
{
  let emptyText: string | undefined;
  let emptyError = "";
  try {
    emptyText = await runCodexDistill("@@instant@@", CWD);
  } catch (e) {
    emptyError = String((e as Error)?.message ?? e);
  }
  check(emptyError === "" && emptyText === "", "완료된 턴의 빈 답은 예외 없이 빈 문자열로 돌아온다", emptyError || emptyText);
}

// ── 정리 ──
fs.rmSync(fake.dir, { recursive: true, force: true });
fs.rmSync(SOURCE_HOME, { recursive: true, force: true });
fs.rmSync(EMPTY_HOME, { recursive: true, force: true });
// ── ⑥ 정리가 실패해도 배경 작업의 결과를 버리지 않는다 (2026-08-19 — 카나리 간헐 실패의 정체) ──
//   죽는 중인 codex가 임시 폴더에 마지막 쓰기를 하면 재귀 삭제가 ENOTEMPTY로 실패한다. 예전엔 그 예외가
//   `finally`를 뚫고 나가 **이미 성공한 결과를 통째로 버렸다** — 그 턴의 기억 저장이 사라진다.
//   여기서는 지울 수 없는 폴더(쓰기 권한 없음)를 만들어 그 상황을 결정적으로 재현한다.
{
  const stubborn = fs.mkdtempSync(path.join(os.tmpdir(), "aether-codex-distill-home-stub-"));
  fs.writeFileSync(path.join(stubborn, "auth.json"), "{}");
  const { removeTempDirForTest } = await import("../providers/codex/distill");
  fs.chmodSync(stubborn, 0o500); // 안의 파일을 못 지우게 만든다 → rmSync가 실패한다
  let threw = false;
  try {
    removeTempDirForTest(stubborn);
  } catch {
    threw = true;
  }
  check(!threw, "⑥ 임시 폴더를 못 지워도 예외를 밖으로 내보내지 않는다(결과를 버리지 않는다)");
  fs.chmodSync(stubborn, 0o700);
  fs.rmSync(stubborn, { recursive: true, force: true });
}

fs.rmSync(CWD, { recursive: true, force: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} codex_distill: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
