/**
 * 설치 묶음 검사(deploy/installer/check-bundle.mjs). 임시 폴더만 쓴다. 모델 호출 0.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "installer", "check-bundle.mjs");
const SECRET = "s3cr3t-value-for-test-0123456789";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bundlecheck-"));
const envFile = path.join(tmp, "fake.env");
const VAPID = "vapid-private-value-abcdef123456";
const PUB = "vapid-public-value-abcdef123456";
fs.writeFileSync(envFile, `AETHER_JWT_SECRET=${SECRET}\nAETHER_VAPID_PRIVATE=${VAPID}\nAETHER_VAPID_PUBLIC=${PUB}\nAETHER_AUTH_MODE=password\nAETHER_ENABLE_THING=true\nPORT=8787\nAETHER_PROJECT_ROOT=/home/someone/projects-long-path\nSHORT=abc\n`);

/** 깨끗한 묶음을 만들고 mutate로 오염시킨 뒤 검사한다. */
function run(name: string, mutate?: (root: string) => void, env: string[] = ["--env", envFile], procEnv: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(tmp, "bundle-"));
  for (const d of ["server/node_modules/pkg/test", "server/node_modules/pkg/data", "web/dist"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "server/index.mjs"), "console.log('password');\n");
  fs.writeFileSync(path.join(root, "web/dist/index.html"), "<html></html>");
  mutate?.(root);
  const r = spawnSync(process.execPath, [SCRIPT, root, ...env], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...procEnv } });
  return { name, code: r.status, out: `${r.stdout}${r.stderr}` };
}

const put = (rel: string, body = "x") => (root: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

const clean = run("깨끗");
check(clean.code === 0, "깨끗한 묶음은 통과(node_modules 안의 test·data 폴더와 흔한 문자열은 무시)", clean.out);

for (const [name, rel] of [
  [".env", "server/.env"],
  [".env.local", ".env.local"],
  ["sqlite 파일", "server/aether.sqlite"],
  ["sqlite wal 파일", "server/aether.sqlite-wal"],
  ["auth-password.json", "server/auth-password.json"],
  ["node_modules 안의 .env", "server/node_modules/pkg/.env"],
  ["data 폴더", "server/data/x.txt"],
  ["test 폴더", "server/test/a.ts"],
  ["spikes 폴더", "server/spikes/a.ts"],
  ["logs 폴더", "server/logs/a.log"],
  ["prod.env", "server/prod.env"],
  ["pem 파일", "server/cert.pem"],
  [".npmrc", "server/.npmrc"],
  ["sqlite 보조 파일", "server/aether.sqlite-journal"],
]) {
  const r = run(name, put(rel));
  // 폴더는 폴더 경로로 보고된다.
  const reported = /\/(data|test|spikes|logs)\//.test(rel) ? path.posix.dirname(rel) : rel;
  check(r.code === 1 && r.out.includes(reported), `${name}가 있으면 실패`, r);
}

const leak = run("값 유출", put("web/dist/app.js", `var k="${SECRET}";`));
check(leak.code === 1 && leak.out.includes("AETHER_JWT_SECRET"), "저장소 .env의 비밀 값과 같은 문자열이 있으면 실패", leak.out);
check(!leak.out.includes(SECRET), "오류 출력에 값 자체는 없다");

const vap = run("vapid 유출", put("web/dist/app.js", `var k="${VAPID}";`));
check(vap.code === 1 && vap.out.includes("AETHER_VAPID_PRIVATE") && !vap.out.includes(VAPID), "AETHER_VAPID_PRIVATE 값도 대조한다(값은 출력하지 않는다)", vap.out);
const pub = run("공개 키", put("web/dist/app.js", `var k="${PUB}"; var r="/home/someone/projects-long-path"; var s="abc"; var t="8787 true";`));
check(pub.code === 0, "공개 키, 비밀이 아닌 설정 값, 짧은 값, 흔한 값은 대조에서 뺀다", pub.out);

const link = run("밖을 가리키는 링크", (root) => fs.symlinkSync(os.tmpdir(), path.join(root, "web/dist/out")));
check(link.code === 1 && link.out.includes("web/dist/out"), "묶음 밖을 가리키는 링크는 실패");
const inner = run("안쪽 링크", (root) => fs.symlinkSync("../../index.mjs", path.join(root, "server/node_modules/pkg/ln")));
check(inner.code === 0, "묶음 안쪽을 가리키는 링크는 통과", inner.out);

const noEnv = run("env 없음", undefined, ["--env", path.join(tmp, "없음.env")]);
check(noEnv.code === 1 && noEnv.out.includes("--no-secret-compare"), "--env로 준 파일이 없으면 실패한다", noEnv.out);
const viaVar = run("AETHER_BUILD_ENV", put("web/dist/app.js", `var k="${SECRET}";`), [], { AETHER_BUILD_ENV: envFile });
check(viaVar.code === 1 && viaVar.out.includes("AETHER_JWT_SECRET"), "AETHER_BUILD_ENV로 대조할 파일을 지정할 수 있다", viaVar.out);
const skip = run("대조 생략", put("web/dist/app.js", `var k="${SECRET}";`), ["--no-secret-compare"]);
check(skip.code === 0 && skip.out.includes("경고") && skip.out.includes("생략"), "--no-secret-compare를 주면 경고를 찍고 대조를 생략한다", skip.out);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} installer_bundle_check: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
