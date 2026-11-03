/**
 * 숫자 환경변수 fail-closed와 지식 쓰기 승인 스위치 검증.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
  pass++;
}

function probe(env: Record<string, string>, expression = "import('./config.ts').then(()=>console.log('OK'))") {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", expression], {
    cwd: serverDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const bad = probe({ AETHER_BUFFER_CAP: "-1" });
ok("음수 buffer cap은 부팅 거부", bad.status !== 0 && bad.stderr.includes("AETHER_BUFFER_CAP"));

const nan = probe({ AETHER_DISTILL_TIMEOUT_MS: "abc" });
ok("NaN timeout은 부팅 거부", nan.status !== 0 && nan.stderr.includes("AETHER_DISTILL_TIMEOUT_MS"));

const defaults = probe({}, "import('./config.ts').then(({config})=>console.log(JSON.stringify({summary:config.searchSummarize})))");
ok("검색 요약 기본 ON", defaults.status === 0 && defaults.stdout.includes('\"summary\":true'));
const off = probe(
  { AETHER_SEARCH_SUMMARIZE: "0" },
  "import('./config.ts').then(({config})=>console.log(JSON.stringify({summary:config.searchSummarize})))",
);
ok("검색 요약은 0으로 끌 수 있다", off.status === 0 && off.stdout.includes('\"summary\":false'));

// ── 설정 파일(AETHER_CONFIG) ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-cfgfile-"));
const write = (name: string, body: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
};
const show = "import('./config.ts').then(({config})=>console.log('R'+JSON.stringify({port:config.port,cap:config.bufferCap,helmet:config.helmet,wt:config.worktreeDir})))";
const parse = (out: string) => JSON.parse(out.split("\n").find((l) => l.startsWith("R{"))!.slice(1));

const base = probe({ AETHER_CONFIG: "" }, show);
ok("① 설정 파일이 없으면 기본값 그대로", base.status === 0 && parse(base.stdout).port === 8787 && parse(base.stdout).cap === 2000 && parse(base.stdout).helmet === true);

const good = write("good.json", JSON.stringify({ port: 9001, bufferCap: 77, helmet: false, worktreeDir: "/tmp/aether-wt-x" }));
const applied = probe({ AETHER_CONFIG: good }, show);
const a = parse(applied.stdout);
ok("② 설정 파일 값이 반영된다", applied.status === 0 && a.port === 9001 && a.cap === 77 && a.helmet === false && a.wt === "/tmp/aether-wt-x" && applied.stdout.includes(good));

const over = probe({ AETHER_CONFIG: good, PORT: "9100", AETHER_BUFFER_CAP: "5" }, show);
ok("③ 환경변수가 파일 값을 이긴다(이름만 경고)", over.status === 0 && parse(over.stdout).port === 9100 && parse(over.stdout).cap === 5 && over.stderr.includes("PORT") && !over.stderr.includes("9001"));

const broken = probe({ AETHER_CONFIG: write("broken.json", "{ port: ") });
ok("④ JSON 문법이 깨지면 부팅 거부", broken.status !== 0 && broken.stderr.includes("AETHER_CONFIG"));

const leak = probe({ AETHER_CONFIG: write("leak.json", '{"port": 1, "note": "fake-leak-value" oops}') });
ok("④ 깨진 JSON의 오류 출력에 파일 원문이 없다", leak.status !== 0 && leak.stderr.includes("JSON 문법 오류") && !leak.stderr.includes("fake-leak-value"));

const missing = probe({ AETHER_CONFIG: path.join(dir, "없음.json") });
ok("⑤ 가리킨 파일이 없으면 부팅 거부", missing.status !== 0 && missing.stderr.includes("AETHER_CONFIG"));

const secret = probe({ AETHER_CONFIG: write("secret.json", JSON.stringify({ port: 9001, jwtSecret: "fake-not-real" })) });
ok("⑥ 비밀 키가 있으면 부팅 거부(값은 안 찍는다)", secret.status !== 0 && secret.stderr.includes("jwtSecret") && !secret.stderr.includes("fake-not-real"));

for (const k of ["mcpToken", "AETHER_MCP_TOKEN", "apiKey", "privateKey"]) {
  const r = probe({ AETHER_CONFIG: write("tok.json", JSON.stringify({ [k]: "fake-not-real" })) });
  ok(`⑥ 비밀 이름 ${k}도 부팅 거부`, r.status !== 0 && r.stderr.includes(k) && !r.stderr.includes("fake-not-real"));
}

const wrongType = probe({ AETHER_CONFIG: write("type.json", JSON.stringify({ port: "9001" })) });
ok("⑦ 타입이 틀리면 부팅 거부", wrongType.status !== 0 && wrongType.stderr.includes("port"));
const outOfRange = probe({ AETHER_CONFIG: write("range.json", JSON.stringify({ port: 70000 })) });
ok("⑦ 범위 밖 값도 환경변수와 똑같이 거부", outOfRange.status !== 0 && outOfRange.stderr.includes("port"));

const unknown = probe({ AETHER_CONFIG: write("unknown.json", JSON.stringify({ port: 9001, futureKey: 1 })) }, show);
ok("⑧ 모르는 키는 경고만 하고 부팅", unknown.status === 0 && unknown.stderr.includes("futureKey") && parse(unknown.stdout).port === 9001);

const tilde = probe({ AETHER_CONFIG: write("tilde.json", JSON.stringify({ worktreeDir: "~/aether-wt-y" })) }, show);
ok("파일의 ~/ 경로는 홈 폴더로 풀린다", tilde.status === 0 && parse(tilde.stdout).wt === path.join(os.homedir(), "aether-wt-y"));
const tildeEnv = probe({ AETHER_WORKTREE_DIR: "~/x" }, show);
ok("환경변수 경로의 기존 동작은 그대로다(~ 안 풂)", tildeEnv.status === 0 && parse(tildeEnv.stdout).wt === path.resolve("~/x"));

const relogin = probe({ AETHER_CONFIG: write("rl.json", JSON.stringify({ enableProviderRelogin: false })) }, "import('./config.ts').then(({config})=>console.log('R'+JSON.stringify({on:config.enableProviderRelogin,by:config.reloginDisabledBy})))");
ok("파일로 끄면 reloginDisabledBy가 파일 키를 가리키고 모르는 키 경고가 없다", relogin.status === 0 && parse(relogin.stdout).on === false && parse(relogin.stdout).by === "enableProviderRelogin" && !relogin.stderr.includes("모르는"));

// ── 오류 폴더·tailscale 기본값 ──
const showDirs = "import('./config.ts').then(({config})=>console.log('R'+JSON.stringify({err:config.errorDir,data:config.dataDir,ts:config.tailscaleCli})))";
const dd = probe({ AETHER_CONFIG: "", AETHER_ERROR_DIR: "", AETHER_DATA_DIR: "", NODE_ENV: "production" }, showDirs);
ok("errorDir 기본은 NODE_ENV와 상관없이 <dataDir>/errors, tailscaleCli 기본은 빈 값", dd.status === 0 && parse(dd.stdout).err === path.join(parse(dd.stdout).data, "errors") && parse(dd.stdout).ts === "");
const dd2 = probe({ AETHER_CONFIG: "", AETHER_ERROR_DIR: "", AETHER_DATA_DIR: path.join(dir, "d") }, showDirs);
ok("AETHER_DATA_DIR를 주면 그 아래 errors", parse(dd2.stdout).err === path.join(dir, "d", "errors"));
const dd3 = probe({ AETHER_CONFIG: write("ed.json", JSON.stringify({ errorDir: path.join(dir, "fileErr") })), AETHER_ERROR_DIR: "", AETHER_DATA_DIR: path.join(dir, "d") }, showDirs);
ok("설정 파일 errorDir가 데이터 폴더 기본보다 우선", parse(dd3.stdout).err === path.join(dir, "fileErr"));
const dd4 = probe({ AETHER_CONFIG: write("ed2.json", JSON.stringify({ errorDir: path.join(dir, "fileErr") })), AETHER_ERROR_DIR: path.join(dir, "envErr") }, showDirs);
ok("AETHER_ERROR_DIR 환경변수가 설정 파일보다 우선", parse(dd4.stdout).err === path.join(dir, "envErr"));

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n✅ 전체 ${pass}개 통과`);
