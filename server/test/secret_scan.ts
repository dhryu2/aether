/**
 * 비밀값 검사(scripts/secret-scan.mjs, .githooks, .claude/hooks/secret-guard.mjs): 임시 git 저장소에서 실제 커밋과 push를 막는지 본다.
 * 시험용 키 모양은 이 파일 자체가 걸리지 않도록 조각을 이어 만든다. 저장소의 설정은 건드리지 않는다. 모델 호출 0.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-secret-")));
const work = path.join(tmp, "work");
const bare = path.join(tmp, "remote.git");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(tmp, "home"), GIT_CONFIG_NOSYSTEM: "1" };
for (const k of Object.keys(env)) if (k.startsWith("GIT_") && k !== "GIT_CONFIG_NOSYSTEM") delete env[k];
const git = (...a: string[]) => spawnSync("git", a, { cwd: work, env, encoding: "utf8" });
const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), s); };
const commit = (msg = "테스트") => { git("add", "-A"); return git("commit", "-q", "-m", msg); };

const KEY = "sk-" + "ant-" + "Zq7Lm2Vx9Rt4Kp8Ws3Yn6Bd1";
const GH = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

fs.mkdirSync(path.join(tmp, "home"));
fs.mkdirSync(work);
spawnSync("git", ["init", "-q", "-b", "main", "--bare", bare], { env });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
git("config", "core.hooksPath", path.join(REPO, ".githooks"));
git("remote", "add", "origin", bare);

write("a.txt", "평범한 내용\n");
check(commit().status === 0, "평범한 내용은 커밋된다");

write("a.txt", `평범한 내용\nconst k = "${KEY}";\n`);
const blocked = commit();
check(blocked.status !== 0 && /Anthropic 키/.test(blocked.stderr) && /a\.txt:2/.test(blocked.stderr), "키가 든 커밋을 막고 위치를 알린다", blocked.stderr);
check(!blocked.stderr.includes(KEY) && !blocked.stdout.includes(KEY), "걸린 값은 출력하지 않는다");
git("checkout", "-q", "--", ".");
git("reset", "-q", "--hard");

write("b.txt", "내용\n");
const msg = commit(`설명 ${GH}`);
check(msg.status !== 0 && /GitHub 토큰/.test(msg.stderr), "커밋 메시지의 토큰도 막는다", msg.stderr);
git("reset", "-q", "--hard");
fs.rmSync(path.join(work, "b.txt"), { force: true });

write(".env", "A=1\n");
check(commit().status !== 0, ".env 파일 커밋을 막는다");
git("reset", "-q", "--hard");
fs.rmSync(path.join(work, ".env"), { force: true });
write(".env.example", "A=\n");
check(commit("예시").status === 0, ".env.example은 커밋된다");

// 개인 고유값과 .env의 실제 값은 저장소 밖 파일과 .env에서 읽어 그대로 찾는다
const LITERAL = "my-private-host";
fs.writeFileSync(path.join(work, ".git", "secret-scan-literals.txt"), `${LITERAL}\n`);
write("c.md", `주소 ${LITERAL}.net\n`);
const lit = commit();
check(lit.status !== 0 && /개인 고유값/.test(lit.stderr) && !lit.stderr.includes(LITERAL), "등록한 개인 고유값을 막는다", lit.stderr);
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "c.md"), { force: true });

fs.mkdirSync(path.join(work, "server"));
fs.writeFileSync(path.join(work, "server/.env"), "AETHER_JWT_SECRET=plain-value-without-shape\nAETHER_HOST=example-host-name\n");
write(".gitignore", "server/.env\n");
commit("무시");
write("d.txt", "v=plain-value-without-shape\n");
const envHit = commit();
check(envHit.status !== 0 && /AETHER_JWT_SECRET/.test(envHit.stderr), ".env의 비밀 항목 값을 막는다", envHit.stderr);
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "d.txt"), { force: true });
write("d.txt", "v=example-host-name\n");
check(commit("비밀 아님").status === 0, ".env의 비밀이 아닌 항목은 막지 않는다");

write("home.txt", `경로 ${env.HOME}/project\n`);
check(commit().status !== 0, "내 홈 폴더 경로를 막는다");
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "home.txt"), { force: true });

for (const ok of ["icon@2x.png", "scope@1.2.3", "a@example.com", 'password: "changeme-example1"', "postgres://u:pw12@127.0.0.1:5432/x"]) {
  write("ok.txt", `${ok}\n`);
  const r = commit("오탐 아님");
  check(r.status === 0, `오탐이 아니다: ${ok}`, r.stderr);
}
write("pw.txt", 'pass' + 'word: "correct-horse-1"\n');
check(commit().status !== 0, "코드에 적은 비밀번호를 막는다");
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "pw.txt"), { force: true });

// push: 훅을 건너뛰고 만든 커밋도 push에서 잡힌다
check(git("push", "-q", "origin", "main").status === 0, "깨끗한 커밋은 push된다");
write("e.txt", `${GH}\n`);
git("add", "-A");
check(git("commit", "-q", "--no-verify", "-m", "건너뜀").status === 0, "(준비) git 훅을 건너뛴 커밋");
const push = git("push", "-q", "origin", "main");
check(push.status !== 0 && /GitHub 토큰/.test(push.stderr) && !push.stderr.includes(GH), "push에서 다시 잡는다", push.stderr);
check(spawnSync("git", ["--git-dir", bare, "log", "--all", "--oneline", "--grep", "건너뜀"], { env, encoding: "utf8" }).stdout === "", "막힌 커밋은 원격에 없다");
git("reset", "-q", "--hard", "HEAD~1");
write("f.txt", "새 내용\n");
commit("새 커밋");
check(git("push", "-q", "origin", "main").status === 0, "되돌린 뒤에는 push된다");

// Claude 쪽 우회 차단
const guard = (command: string, cwd = work) => {
  const r = spawnSync("node", [path.join(REPO, ".claude/hooks/secret-guard.mjs")], { input: JSON.stringify({ tool_input: { command }, cwd }), encoding: "utf8", env });
  return /"permissionDecision":"deny"/.test(r.stdout);
};
for (const c of ["git commit --no-verify -m x", "git add . && git commit -n -m x", "git commit -anm x", "git push --no-verify", "git -c core.hooksPath=/dev/null commit -m x", "git config --unset core.hooksPath", "git config core.hooksPath /dev/null", "gh api -X PUT repos/o/r/contents/LICENSE -f content=x"]) {
  check(guard(c), `막는다: ${c}`);
}
for (const c of ["git commit -m '--no-verify 설명'", "git push origin main", "git push -n", "git status", "ls -n", "gh api repos/o/r/contents/LICENSE", "git log --grep=commit -n 3", 'git config core.hooksPath "$PWD/.githooks"', "git config core.hooksPath"]) {
  check(!guard(c), `막지 않는다: ${c}`);
}
git("config", "--unset", "core.hooksPath");
check(guard("git commit -m x"), "git 훅이 꺼져 있으면 커밋을 막는다");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} secret_scan: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
