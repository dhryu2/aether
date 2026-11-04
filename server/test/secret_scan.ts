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
// 루트에 새 파일을 둘 수 없으므로 시험 파일은 server/ 아래에 쓴다.
const rel = (f: string) => (f.includes("/") || f === ".gitignore" || f === ".env" ? f : `server/${f}`);
const write = (f: string, s: string) => { const p = path.join(work, rel(f)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const writeAt = (f: string, s: string) => { const p = path.join(work, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const clean = (...files: string[]) => { git("reset", "-q", "--hard"); for (const f of files) fs.rmSync(path.join(work, rel(f)), { force: true }); };
const commit = (msg = "테스트") => { git("add", "-A"); return git("commit", "-q", "-m", msg); };

const KEY = "sk-" + "ant-" + "Zq7Lm2Vx9Rt4Kp8Ws3Yn6Bd1";
const GH = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

fs.mkdirSync(path.join(tmp, "home"));
fs.mkdirSync(work);
spawnSync("git", ["init", "-q", "-b", "main", "--bare", bare], { env });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@users.noreply.github.com");
git("config", "user.name", "t");
git("config", "core.hooksPath", path.join(REPO, ".githooks"));
git("remote", "add", "origin", bare);

fs.writeFileSync(path.join(work, ".git", "secret-scan-literals.txt"), "placeholder-value\n");
write("a.txt", "평범한 내용\n");
const noList2 = (fs.renameSync(path.join(work, ".git", "secret-scan-literals.txt"), path.join(work, ".git", "l.txt")), commit("목록 없음"));
check(noList2.status !== 0 && /고유값 목록이 없어/.test(noList2.stderr), "고유값 목록이 없으면 막는다", noList2.stderr);
fs.renameSync(path.join(work, ".git", "l.txt"), path.join(work, ".git", "secret-scan-literals.txt"));
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
fs.rmSync(path.join(work, "server/b.txt"), { force: true });

write(".env", "A=1\n");
check(commit().status !== 0, ".env 파일 커밋을 막는다");
git("reset", "-q", "--hard");
fs.rmSync(path.join(work, ".env"), { force: true });
write("server/.env.example", "A=\n");
check(commit("예시").status === 0, ".env.example은 커밋된다");

// 개인 고유값과 .env의 실제 값은 저장소 밖 파일과 .env에서 읽어 그대로 찾는다
const LITERAL = "my-private-host";
fs.writeFileSync(path.join(work, ".git", "secret-scan-literals.txt"), `${LITERAL}\n`);
write("c.txt", `주소 ${LITERAL}.net\n`);
const lit = commit();
check(lit.status !== 0 && /개인 고유값/.test(lit.stderr) && !lit.stderr.includes(LITERAL), "등록한 개인 고유값을 막는다", lit.stderr);
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "server/c.txt"), { force: true });

fs.writeFileSync(path.join(work, "server/.env"), "AETHER_JWT_SECRET=plain-value-without-shape\nAETHER_HOST=example-host-name\n");
write(".gitignore", "server/.env\n");
commit("무시");
write("d.txt", "v=plain-value-without-shape\n");
const envHit = commit();
check(envHit.status !== 0 && /AETHER_JWT_SECRET/.test(envHit.stderr), ".env의 비밀 항목 값을 막는다", envHit.stderr);
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "server/d.txt"), { force: true });
write("d.txt", "v=example-host-name\n");
check(commit("비밀 아님").status === 0, ".env의 비밀이 아닌 항목은 막지 않는다");

write("home.txt", `경로 ${env.HOME}/project\n`);
check(commit().status !== 0, "내 홈 폴더 경로를 막는다");
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "server/home.txt"), { force: true });

for (const ok of ["icon@2x.png", "scope@1.2.3", "a@example.com", 'password: "changeme-example1"', "postgres://u:pw12@127.0.0.1:5432/x"]) {
  write("ok.txt", `${ok}\n`);
  const r = commit("오탐 아님");
  check(r.status === 0, `오탐이 아니다: ${ok}`, r.stderr);
}
write("pw.txt", 'pass' + 'word: "correct-horse-1"\n');
check(commit().status !== 0, "코드에 적은 비밀번호를 막는다");
git("reset", "-q", "--hard"); fs.rmSync(path.join(work, "server/pw.txt"), { force: true });

// 내부 정보: 조각을 이어 만들어 이 파일 자체가 걸리지 않게 한다.
const blockedLines: [string, RegExp, string][] = [
  ["Tailscale 주소", /Tailscale 주소/, "https://box." + "tailabc123" + ".ts.net:8787"],
  ["Tailscale IP", /Tailscale IP/, "ip 100." + "102.143.42"],
  ["사설 IP", /사설 IP/, "host 192." + "168.0.12"],
  ["사설 IP 10 대역", /사설 IP/, "host 10." + "20.30.40"],
  ["외장 디스크 경로", /외장 디스크 경로/, "/Vol" + "umes/My_Disk/Projects"],
  ["다른 사람 홈 경로", /내 컴퓨터 경로/, "/Us" + "ers/somebody/x"],
  ["Apple 팀 ID", /Apple 팀 ID/, "DEVELOPMENT_" + "TEAM = ABCDE12345;"],
];
for (const [name, re, line] of blockedLines) {
  write("info.txt", `${line}\n`);
  const r = commit();
  check(r.status !== 0 && re.test(r.stderr) && !r.stderr.includes(line), `막는다: ${name}`, r.stderr);
  clean("info.txt");
}
for (const line of ["/Us" + "ers/me/work", "/Sys" + "tem/Vol" + "umes/Data/x", "/Vol" + "umes/Disk1", "C:/Us" + "ers/x/proj", "version 1.2.3.4", "https://aether.example.ts.net:8787"]) {
  write("okinfo.txt", `${line}\n`);
  const r = commit("오탐 아님");
  check(r.status === 0, `오탐이 아니다: ${line}`, r.stderr);
  git("rm", "-q", "-f", rel("okinfo.txt"));
  commit("정리");
}

// 공개하지 않는 경로: 강제로 추가하거나 빈 파일이어도 막는다.
for (const f of ["docs/x.md", ".private/x", "CLAUDE.md", "AGENTS.md", "HANDOFF.md", "SPEC.md", "PRODUCT.md", "PHASE0_RESULTS.md", "mobile/a.dart", "server/spikes/a.ts", ".claude/agents/a.md", ".claude/skills/a/SKILL.md", ".grok/a.toml", "deploy/dev-postgres/up.sh", "deploy/notify.sh", "graphify-out/g.json"]) {
  writeAt(f, "");
  git("add", "-f", f);
  const r = git("commit", "-q", "-m", "x");
  check(r.status !== 0 && /공개하지 않는 경로/.test(r.stderr), `막는다: ${f}`, r.stderr);
  git("reset", "-q");
  fs.rmSync(path.join(work, f), { force: true });
}
for (const [f, name] of [["notes.md", "새 파일"], ["newdir/x.ts", "새 파일"], ["server/plan.md", "새 문서"], ["deploy/site/plan.md", "새 문서"], ["server/README.en.md", "새 문서"]] as const) {
  writeAt(f, "내용\n");
  git("add", "-f", f);
  const r = git("commit", "-q", "-m", "x");
  check(r.status !== 0 && r.stderr.includes(`허용되지 않은 ${name}`), `막는다: ${f}`, r.stderr);
  git("reset", "-q");
  fs.rmSync(path.join(work, f), { force: true });
}
for (const f of ["README.md", "README.en.md", "server/README.md", "deploy/site/notes/9.9.9.md", "server/new.ts"]) {
  writeAt(f, "내용\n");
  const r = commit("허용");
  check(r.status === 0, `허용한다: ${f}`, r.stderr);
}

// 패치 해석: 내용 줄이 머리글처럼 생기거나 줄바꿈 글자가 섞여도 뒤의 키를 놓치지 않는다.
const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);
const tricks: [string, string][] = [
  ["앞줄이 ++ x", `++ x\nconst k = "${KEY}";\n`],
  ["앞줄이 ++ i;", `++ i;\n${KEY}\n`],
  ["앞줄이 ++ /dev/null", `++ /dev/null\n${KEY}\n`],
  ["맨 CR 뒤의 키", `a\r${KEY}\n`],
  ["U+2028 뒤의 키", `a${U2028}${KEY}\n`],
  ["U+2029 뒤의 키", `a${U2029}${KEY}\n`],
  ["맨 CR 뒤 diff 조각 뒤의 키", `x\rdiff --git a/q b/q\r${KEY}\n`],
];
for (const [name, body] of tricks) {
  write("trick.txt", body);
  const r = commit();
  check(r.status !== 0 && /Anthropic 키/.test(r.stderr) && !r.stderr.includes(KEY), `막는다: ${name}`, r.stderr);
  clean("trick.txt");
}
write("multi.txt", "l1\nl2\nl3\nl4\nl5\n");
commit("기준");
write("multi.txt", `++ x\nl2\nl3\nl4\n${KEY}\n`);
const multi = commit();
check(multi.status !== 0 && /Anthropic 키/.test(multi.stderr) && /multi\.txt:5/.test(multi.stderr), "같은 파일의 다음 hunk에 있는 키도 막고 줄 번호를 맞춘다", multi.stderr);
clean();
write("plus.txt", "++ y\n++ i;\n-- z\n");
check(commit("머리글 모양 내용").status === 0, "머리글처럼 생긴 내용이라도 키가 없으면 커밋된다");

// 훅이 없는 임시 저장소에서 스크립트를 직접 돌려, git 설정이 출력 모양을 바꿔도 막히는지 본다.
const plain = path.join(tmp, "plain");
fs.mkdirSync(plain);
const pgit = (...a: string[]) => spawnSync("git", a, { cwd: plain, env, encoding: "utf8" });
pgit("init", "-q", "-b", "main");
pgit("config", "user.email", "t@users.noreply.github.com");
pgit("config", "user.name", "t");
fs.writeFileSync(path.join(plain, ".git", "secret-scan-literals.txt"), "placeholder-value\n");
const pw = (f: string, c: string | Buffer) => fs.writeFileSync(path.join(plain, f), c);
const pcommit = (m = "t") => { pgit("add", "-A"); return pgit("commit", "-q", "-m", m); };
const scan = (range: string, extraEnv: NodeJS.ProcessEnv = {}) => spawnSync("node", [path.join(REPO, "scripts/secret-scan.mjs"), "--range", range], { cwd: plain, env: { ...env, ...extraEnv }, encoding: "utf8" });
pw("base.txt", "기준\n");
pcommit("기준");
let nth = 0;
const keyFile = () => { pw("k.txt", `v${nth++} ${KEY}\n`); return pcommit(); };
for (const [name, cfg] of [["color.ui=always", ["color.ui", "always"]], ["diff.noprefix=true", ["diff.noprefix", "true"]], ["diff.external", ["diff.external", "true"]]] as const) {
  pgit("config", cfg[0], cfg[1]);
  keyFile();
  const r = scan("HEAD~1..HEAD");
  check(r.status !== 0 && /Anthropic 키/.test(r.stderr), `git 설정 ${name}여도 키를 잡는다`, r.stderr);
  pgit("config", "--unset", cfg[0]);
}
pw(".gitattributes", "*.txt diff=hide\n");
pcommit("속성");
pgit("config", "diff.hide.textconv", "echo hidden");
keyFile();
const tc = scan("HEAD~1..HEAD");
check(tc.status !== 0 && /Anthropic 키/.test(tc.stderr), "textconv 드라이버가 있어도 키를 잡는다", tc.stderr);
pgit("config", "--unset", "diff.hide.textconv");
pw(".gitattributes", "*.txt -diff\n");
pcommit("이진 취급");
keyFile();
const nodiff = scan("HEAD~1..HEAD");
check(nodiff.status !== 0 && /Anthropic 키/.test(nodiff.stderr), "*.txt -diff 속성이 있어도 키를 잡는다", nodiff.stderr);
pw(".gitattributes", "");
pcommit("속성 제거");
pw("nul.txt", Buffer.from(["\0", KEY, "\n"].join("")));
pcommit("NUL");
const nul = scan("HEAD~1..HEAD");
check(nul.status !== 0 && /Anthropic 키/.test(nul.stderr), "NUL 한 글자 뒤의 키도 잡는다", nul.stderr);
fs.renameSync(path.join(plain, "base.txt"), path.join(plain, ".env"));
pcommit("이름만 바꿈");
const ren = scan("HEAD~1..HEAD");
check(ren.status !== 0 && /올리면 안 되는 파일/.test(ren.stderr), "순수 이름 변경으로 만든 .env도 잡는다", ren.stderr);

// 영숫자가 이어진 큰 파일도 빨리 끝나고, 진짜 주소 안 비밀번호는 여전히 잡는다.
{
  pw("big.txt", "a".repeat(1_000_000) + "\n");
  pcommit("큰 파일");
  const t0 = Date.now();
  const big = spawnSync("node", [path.join(REPO, "scripts/secret-scan.mjs"), "--range", "HEAD~1..HEAD"], { cwd: plain, env, encoding: "utf8", timeout: 20_000 });
  check(big.status === 0 && Date.now() - t0 < 10_000, "영숫자 1MB 한 줄도 10초 안에 끝난다", { ms: Date.now() - t0, status: big.status });
  pw("addr.txt", "url = " + "https://svc:" + "Zq7pass9Rt" + "@db.corp.net/x\n");
  pcommit("주소");
  const addr = scan("HEAD~1..HEAD");
  check(addr.status !== 0 && /주소 안의 비밀번호/.test(addr.stderr), "주소 안의 비밀번호는 여전히 잡는다", addr.stderr);
}

// 출력 형식을 읽지 못하면 조용히 통과하지 않고 실패한다
const stubDir = path.join(tmp, "stub");
fs.mkdirSync(stubDir);
const realGit = spawnSync("which", ["git"], { env, encoding: "utf8" }).stdout.trim();
fs.writeFileSync(path.join(stubDir, "git"), `#!/bin/sh\ncase " $* " in *" log "*|*" diff "*) echo "알 수 없는 출력"; exit 0;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
const odd = scan("HEAD", { PATH: `${stubDir}${path.delimiter}${process.env.PATH}` });
check(odd.status !== 0 && /git 출력 형식을 읽지 못했습니다/.test(odd.stderr), "git 출력 형식을 읽지 못하면 실패한다", odd.stderr.slice(0, 300));

// 작성자 메일
git("config", "user.email", "me@" + "gmail.com");
write("author.txt", "내용\n");
const badAuthor = commit();
check(badAuthor.status !== 0 && /작성자 메일/.test(badAuthor.stderr), "noreply가 아닌 작성자를 막는다", badAuthor.stderr);
git("config", "user.email", "t@users.noreply.github.com");
clean("author.txt");

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
const guardInput = (tool_input: Record<string, string>, cwd = work) => {
  const r = spawnSync("node", [path.join(REPO, ".claude/hooks/secret-guard.mjs")], { input: JSON.stringify({ tool_input, cwd }), encoding: "utf8", env });
  return /"permissionDecision":"deny"/.test(r.stdout);
};
const guard = (command: string, cwd = work) => guardInput({ command }, cwd);
for (const c of ["git add -f docs/x.md", "git add --force .private", "git add -Af .", "git config user.email a@b.c", "git config --global user.name x", "git -c user.email=a@b.c commit -m x", "GIT_AUTHOR_EMAIL=a@b.c git commit -m x", "echo x >> scripts/secret-scan-allow.txt", "sed -i '' s/a/b/ scripts/secret-scan-allow.txt"]) {
  check(guard(c), `막는다: ${c}`);
}
for (const c of ["git add server/a.ts", "git add -A", "git config user.email", "git config --get user.name", "cat scripts/secret-scan-allow.txt", "cat scripts/secret-scan-allow.txt; echo x > /tmp/a", "git commit -m 'git add -f 설명'"]) {
  check(!guard(c), `막지 않는다: ${c}`);
}
check(guardInput({ file_path: "/x/scripts/secret-scan-allow.txt" }), "허용 목록 직접 수정을 막는다");
check(!guardInput({ file_path: "/x/server/a.ts" }), "다른 파일 수정은 막지 않는다");
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
