/**
 * 모델 프로세스에 넘기는 환경 게이트 (Phase 8f · 위험 R21) — 모델 호출 0.
 *
 * 지키려는 문장 하나: **"모델은 이 허브의 비밀을 볼 수 없다."**
 *
 * 서버는 `.env`를 읽고 뜨므로 로그인 서명키·비밀번호 해시·푸시 개인키가 프로세스 환경에 있다.
 * 그 환경이 모델 프로세스로 통째로 상속되면, 모델은 승인 없이 되는 읽기 명령 하나로 그걸 본다.
 * 그 출력은 경로 기반 가리기에도 안 걸린다 — 우리 마스킹은 "비밀이 든 파일을 읽었을 때"를 보기 때문이다.
 *
 * 여기서 세 가지를 반증한다.
 *   ① 비밀 이름은 걸러지고, 설정값과 사용자 도구의 환경변수는 그대로 남는다.
 *   ② 일부러 넘긴 값(`extra`)은 걸러낸 **뒤에** 얹힌다 — 배경 작업의 격리 설정 폴더가 이 통로로 간다.
 *      (8f는 8g의 지식 도구 토큰도 여기로 갈 것이라 적어 뒀지만, 8g 실측에서 통로를 바꿨다: 같은 계정의
 *       아무 프로세스나 `ps eww`로 남의 환경변수를 읽으므로 토큰은 환경에 아예 두지 않고 스레드 시작
 *       설정으로만 넘긴다. `providers/knowledgeBridge.ts` 참조.)
 *   ③ 모델 프로세스를 띄우는 자리가 실제로 이 함수를 쓴다(자식이 관측한 이름 목록으로 확인).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-modelenv-"));
process.env.AETHER_DATA_DIR ??= DATA_DIR;
process.env.AETHER_CODEX_SHUTDOWN_GRACE_MS = "500";
process.env.AETHER_CODEX_DISTILL_MODEL = "gpt-5.4-mini";

// 실제로 새면 안 되는 값들을 심어 둔다(값은 이 프로세스 안에서만 산다).
process.env.AETHER_JWT_SECRET = "SECRET-JWT-DO-NOT-LEAK";
process.env.AETHER_PASSWORD_HASH = "SECRET-HASH-DO-NOT-LEAK";
process.env.AETHER_VAPID_PRIVATE = "SECRET-VAPID-DO-NOT-LEAK";
process.env.AETHER_DATABASE_URL = "postgres://admin:SECRET-DB-DO-NOT-LEAK@127.0.0.1:1/none";
process.env.AETHER_OLLAMA_URL = "http://127.0.0.1:11434";
// 사용자의 다른 도구가 쓰던 값 — 이건 지우면 안 된다(지우면 모델이 쓰던 명령이 갑자기 안 된다).
process.env.GITHUB_TOKEN = "user-tool-token";

const SOURCE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aether-modelenv-home-"));
fs.writeFileSync(path.join(SOURCE_HOME, "auth.json"), "{}");
process.env.CODEX_HOME = SOURCE_HOME;

const { makeFakeCodexBin } = await import("./support/fakeAppServer");
const fake = makeFakeCodexBin();
process.env.AETHER_CODEX_BIN = fake.bin;

const { isAetherSecretName, modelEnv } = await import("../providers/modelEnv");
const { runCodexDistill } = await import("../providers/codex/distill");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

// ── ① 무엇을 거르고 무엇을 남기나 ──

for (const name of ["AETHER_JWT_SECRET", "AETHER_PASSWORD_HASH", "AETHER_VAPID_PRIVATE", "AETHER_MCP_TOKEN", "AETHER_DATABASE_URL"]) {
  check(isAetherSecretName(name), `① 비밀로 판정한다: ${name}`);
}
for (const name of ["AETHER_MODEL", "AETHER_DATA_DIR", "AETHER_CODEX_BIN", "AETHER_OLLAMA_URL", "GITHUB_TOKEN", "PATH", "HOME"]) {
  check(!isAetherSecretName(name), `① 설정값·남의 것은 안 건드린다: ${name}`);
}

const env = modelEnv();
check(!("AETHER_JWT_SECRET" in env), "① 로그인 서명키가 빠진다");
check(!("AETHER_PASSWORD_HASH" in env), "① 비밀번호 해시가 빠진다");
check(!("AETHER_VAPID_PRIVATE" in env), "① 푸시 개인키가 빠진다");
check(!("AETHER_DATABASE_URL" in env), "① DB 접속 주소(관리 계정 비밀번호 포함)가 빠진다");
check(!Object.values(env).some((v) => String(v).includes("SECRET-DB-DO-NOT-LEAK")), "① 어느 변수 값에도 DB 비밀번호가 없다");
check(env.GITHUB_TOKEN === "user-tool-token", "① 사용자 도구의 환경변수는 그대로 남는다");
check(!!env.PATH && !!env.HOME, "① PATH·HOME은 그대로 남는다(명령이 계속 돌아야 한다)");
check(env.AETHER_CODEX_BIN === fake.bin, "① 비밀이 아닌 설정값은 그대로 남는다");

// ── ② 일부러 넘긴 값은 걸러낸 뒤에 얹힌다(8g 지식 도구 토큰의 통로) ──

const withToken = modelEnv({ AETHER_MCP_TOKEN: "explicitly-given" });
check(withToken.AETHER_MCP_TOKEN === "explicitly-given", "② 명시해서 넘긴 토큰은 살아남는다(실수로 새는 것과 구분된다)");
check(!("AETHER_JWT_SECRET" in withToken), "② 그래도 비밀은 여전히 빠진다");

// ── ③ 모델 프로세스를 띄우는 자리가 실제로 이 함수를 쓴다 ──
//   가짜 app-server가 자기 환경에서 본 `AETHER_` 이름을 남긴다(값은 안 남긴다 — 기록 파일이 새 비밀
//   저장소가 되면 안 되므로). 배경 작업 실행이 그 자리 중 하나다.

const CALLS = path.join(DATA_DIR, "calls.jsonl");
process.env.FAKE_CALLS_FILE = CALLS;
await runCodexDistill("환경 확인", DATA_DIR);
const spawn = fs
  .readFileSync(CALLS, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { method: string; params: any })
  .find((c) => c.method === "__spawn");
const childNames: string[] = spawn?.params?.aetherEnvNames ?? [];
check(childNames.length > 0, "③ 자식 프로세스의 환경을 관측했다", childNames.length);
check(!childNames.some((n) => isAetherSecretName(n)), "③ 자식 프로세스 환경에 비밀 이름이 하나도 없다", childNames.filter((n) => isAetherSecretName(n)));
check(childNames.includes("AETHER_CODEX_BIN"), "③ 비밀이 아닌 설정값은 자식에게도 그대로 간다");

// ── 정리 ──
fs.rmSync(fake.dir, { recursive: true, force: true });
fs.rmSync(SOURCE_HOME, { recursive: true, force: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} model_env: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
