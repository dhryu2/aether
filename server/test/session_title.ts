/**
 * 요약 세션 제목 — 임시 제목을 요약으로 바꾸고, 직접 지은 이름과 실패 경로를 지킨다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PresenceSession } from "../../shared/http";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-session-title-"));

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("session_title"); // 임시 SQLite 일기
const { cleanSummarizedTitle } = await import("../sessions/sessionTitle");
const { config } = await import("../config");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`);
  c ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("\n=== 모델 답 다듬기 ===");
check(cleanSummarizedTitle("세션 제목 자동 요약") === "세션 제목 자동 요약", "제목은 그대로 쓴다");
check(cleanSummarizedTitle('"세션 제목 개선"\n"세션 제목 개선"') === "세션 제목 개선", "따옴표와 두 번 이어 붙은 답을 걷는다");
check(cleanSummarizedTitle("제목: **로그인 오류 수정**.") === "로그인 오류 수정", "머리말과 markdown을 걷는다");
check(cleanSummarizedTitle("") === null, "빈 답은 제목이 아니다");
check(cleanSummarizedTitle("A".repeat(41)) === null, "제목치고 긴 답은 대답으로 보고 버린다");

const unregister = __registerProviderForTest(mock.mockEntry);
const services = mock.mockEntry.services as { distill: (prompt: string, cwd: string) => Promise<string> };
const cwd = config.projectRootReal ?? config.projectRoot;
const presence: PresenceSession[] = [];
const unsubPresence = sessionManager.subscribePresence((u) => presence.push(u));
const displayNameOf = (id: string) => sessionManager.list().find((s) => s.id === id)?.displayName;
const firstPrompt = "세션 제목이 이상한 값으로 나온다. 이 부분을 고쳐줘";
const draft = "세션 제목이 이상한 값으로 나온다";

/** 답을 손으로 풀어 주는 가짜 배경 작업. 호출한 프롬프트를 모은다. */
function holdDistill() {
  const calls: string[] = [];
  let release: (answer: string | Error) => void = () => {};
  services.distill = (prompt) => {
    calls.push(prompt);
    return new Promise((resolve, reject) => {
      release = (answer) => (answer instanceof Error ? reject(answer) : resolve(answer));
    });
  };
  return { calls, release: (answer: string | Error) => release(answer) };
}

console.log("\n=== 첫 프롬프트 ===");
{
  const d = holdDistill();
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  check(displayNameOf(live.id) === "", "만든 직후 제목은 비어 있어 화면이 기본 문구를 쓴다");
  await live.push(firstPrompt);
  check(displayNameOf(live.id) === draft, "답을 기다리지 않고 임시 제목이 뜬다", displayNameOf(live.id));
  check(d.calls.length === 1 && d.calls[0].includes(firstPrompt), "첫 프롬프트로 한 번 요약을 부른다");
  d.release("세션 제목 개선");
  await sleep(10);
  check(displayNameOf(live.id) === "세션 제목 개선", "요약 제목으로 바뀐다", displayNameOf(live.id));
  check(presence.at(-1)?.id === live.id && presence.at(-1)?.displayName === "세션 제목 개선", "실시간 갱신으로 화면에 알린다");
  await live.push("다음 말");
  check(d.calls.length === 1, "다음 말은 요약을 부르지 않는다");
  sessionManager.delete(live.id);
}

console.log("\n=== 직접 지은 이름 ===");
{
  const d = holdDistill();
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await live.push(firstPrompt);
  sessionManager.setName(live.id, "내가 지은 이름");
  d.release("세션 제목 개선");
  await sleep(10);
  check(displayNameOf(live.id) === "내가 지은 이름", "요약이 늦게 와도 직접 지은 이름을 덮지 않는다", displayNameOf(live.id));
  sessionManager.delete(live.id);

  const named = holdDistill();
  const namedLive = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, name: "처음부터 이름" });
  await namedLive.push(firstPrompt);
  check(named.calls.length === 0, "이름이 있으면 요약을 부르지 않는다");
  sessionManager.delete(namedLive.id);
}

console.log("\n=== 실패와 중단 ===");
{
  const d = holdDistill();
  const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await live.push(firstPrompt);
  d.release(new Error("배경 작업 실패 시험"));
  await sleep(10);
  check(displayNameOf(live.id) === draft, "실패하면 임시 제목이 남는다", displayNameOf(live.id));
  sessionManager.delete(live.id);

  const late = holdDistill();
  const deleted = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await deleted.push(firstPrompt);
  const metaFile = path.join(config.dataDir, deleted.id, "meta.json");
  sessionManager.delete(deleted.id);
  late.release("삭제 뒤 제목");
  await sleep(10);
  const leftover = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, "utf8") : "";
  check(!leftover.includes("삭제 뒤 제목"), "삭제한 세션에 늦은 요약을 저장하지 않는다");

  const slash = holdDistill();
  const slashLive = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await slashLive.push("/compact");
  check(slash.calls.length === 0, "슬래시 명령은 요약하지 않는다");
  sessionManager.delete(slashLive.id);

  const withArgs = holdDistill();
  const argsLive = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  await argsLive.push("/security-audit 이 저장소를 감사해줘");
  check(displayNameOf(argsLive.id) === "이 저장소를 감사해줘", "요청이 붙은 슬래시 명령은 남은 말로 임시 제목을 만든다", displayNameOf(argsLive.id));
  check(withArgs.calls.length === 1 && !withArgs.calls[0].includes("/security-audit"), "요약에는 명령 단어를 빼고 넘긴다");
  withArgs.release("저장소 감사");
  sessionManager.delete(argsLive.id);
}

unsubPresence();
unregister();
console.log(`\n결과: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
