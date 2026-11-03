/**
 * 맥 설치 스크립트(preinstall, postinstall, 제거 명령)를 가짜 HOME과 가짜 launchctl·pkgutil로 돌린다. 맥에서만 돈다.
 * 이 맥의 실제 LaunchAgents·Applications·서비스(com.aether.backend 포함)에는 닿지 않는다. 모델 호출 0.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("맥이 아니라 건너뜀");
  process.exit(0);
}

const MAC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "installer", "mac");
let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-macscripts-")));
const HOME = path.join(tmp, "home with space");
const FAKEBIN = path.join(tmp, "fakebin");
const LOG = path.join(tmp, "calls.log");
fs.mkdirSync(FAKEBIN);
for (const [name, body] of [
  ["launchctl", `#!/bin/bash\necho "launchctl $*" >> "${LOG}"\n[ "$1" = print ] && exit 1\nexit 0\n`],
  ["pkgutil", `#!/bin/bash\necho "pkgutil $*" >> "${LOG}"\nexit 0\n`],
]) {
  fs.writeFileSync(path.join(FAKEBIN, name), body, { mode: 0o755 });
}
const env: NodeJS.ProcessEnv = { PATH: `${FAKEBIN}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME, AETHER_PKG_HOME: HOME, TMPDIR: tmp };
const run = (script: string, input = "") => spawnSync("bash", [script, "x.pkg"], { env, input, encoding: "utf8" });
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");

// 먼저 격리를 검사한다: 가짜 HOME은 임시 폴더 아래이고 진짜 홈이 아니며, PATH의 launchctl은 가짜다.
const realHome = os.userInfo().homedir;
check(HOME.startsWith(tmp + path.sep) && HOME !== realHome && !HOME.startsWith(path.join(realHome, "Library")), "가짜 HOME은 임시 폴더 아래이고 진짜 홈이 아니다", HOME);
const probe = spawnSync("bash", ["-c", "launchctl probe-isolation"], { env, encoding: "utf8" });
check(probe.status === 0 && calls().includes("probe-isolation"), "PATH의 launchctl은 가짜다(진짜 서비스에 닿지 않는다)");
fs.writeFileSync(LOG, "");

const APP = path.join(HOME, "Applications", "Aether");
const CONFIG = path.join(HOME, "Library", "Application Support", "Aether");
const PLIST = path.join(HOME, "Library", "LaunchAgents", "com.aether.app.plist");
const put = (f: string, body = "x") => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const payload = () => { for (const d of ["bin", "node", "web"]) put(path.join(APP, d, "f")); put(path.join(APP, "server", "index.mjs")); };

console.log("preinstall");
payload();
put(path.join(APP, "mydata", "keep.txt"));
put(path.join(APP, "notes.txt"));
let r = run(path.join(MAC, "scripts", "preinstall"));
check(r.status === 0 && ["bin", "node", "server", "web"].every((d) => !fs.existsSync(path.join(APP, d))), "이전 설치의 bin·node·server·web을 지운다", r.stderr);
check(fs.existsSync(path.join(APP, "mydata", "keep.txt")) && fs.existsSync(path.join(APP, "notes.txt")), "프로그램 폴더 안의 사용자 폴더와 파일은 남긴다");
check(calls().includes("launchctl bootout") && calls().includes("com.aether.app") && !calls().includes("com.aether.backend"), "com.aether.app만 내리고 com.aether.backend에는 닿지 않는다", calls());
fs.rmSync(APP, { recursive: true });
put(path.join(APP, "server", "mine.txt"));
put(path.join(APP, "web", "mine.txt"));
r = run(path.join(MAC, "scripts", "preinstall"));
check(r.status === 0 && fs.existsSync(path.join(APP, "server", "mine.txt")) && fs.existsSync(path.join(APP, "web", "mine.txt")), "Aether 표시(server/index.mjs)가 없는 폴더는 지우지 않는다");
fs.rmSync(APP, { recursive: true });

console.log("postinstall");
const scripts = path.join(tmp, "scripts");
fs.cpSync(path.join(MAC, "scripts"), scripts, { recursive: true });
fs.copyFileSync(path.join(MAC, "com.aether.app.plist.template"), path.join(scripts, "com.aether.app.plist.template"));
r = run(path.join(scripts, "postinstall"));
check(r.status === 1 && !fs.existsSync(PLIST), "프로그램 폴더가 없으면 코드 1로 끝나고 등록하지 않는다", r.status);
payload();
put(path.join(HOME, "Desktop", "dummy"));
fs.rmSync(path.join(HOME, "Desktop", "dummy"));
fs.writeFileSync(LOG, "");
r = run(path.join(scripts, "postinstall"));
const plist = fs.existsSync(PLIST) ? fs.readFileSync(PLIST, "utf8") : "";
check(r.status === 0 && plist.length > 0, "정상 설치에서 LaunchAgent를 만든다", r.stderr);
check(spawnSync("plutil", ["-lint", PLIST]).status === 0, "만든 plist가 유효하다");
check(!plist.includes("__") && plist.includes(`${APP}/node/bin/node`) && plist.includes(`${APP}/server/index.mjs`), "자리표시자가 모두 채워지고 공백 경로가 그대로 들어간다");
check(!plist.includes(".grok") && !plist.includes(realHome) && plist.includes(`${HOME}/.local/bin`), "PATH에 개인 경로(.grok, 진짜 홈)가 없다");
check(plist.includes(`<string>${path.join(CONFIG, "tmp")}</string>`) && fs.statSync(path.join(CONFIG, "tmp")).mode % 0o1000 === 0o700, "TMPDIR가 설정 폴더의 tmp이고 폴더는 0700이다");
check(plist.includes("<string>com.aether.app</string>") && !calls().includes("com.aether.backend") && calls().includes("launchctl bootstrap"), "등록은 com.aether.app이고 com.aether.backend에는 닿지 않는다", calls());
check(!fs.existsSync(path.join(CONFIG, "config.json")) && !fs.existsSync(path.join(CONFIG, "data")), "설정·데이터는 만들지 않는다(첫 실행 판정 유지)");
const link = path.join(HOME, "Desktop", "Aether.webloc");
check(fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === path.join(CONFIG, "Aether.webloc"), "바탕화면 링크가 설정 폴더를 가리킨다");
// 남의 링크와 파일은 덮지 않는다
fs.rmSync(link);
fs.symlinkSync("/tmp/elsewhere", link);
run(path.join(scripts, "postinstall"));
check(fs.readlinkSync(link) === "/tmp/elsewhere", "다른 곳을 가리키는 같은 이름의 링크는 덮지 않는다");
fs.rmSync(link);
fs.writeFileSync(link, "mine");
run(path.join(scripts, "postinstall"));
check(!fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(link, "utf8") === "mine", "같은 이름의 일반 파일은 덮지 않는다");
fs.rmSync(link);
r = run(path.join(scripts, "postinstall"));
check(r.status === 0 && fs.lstatSync(link).isSymbolicLink(), "재설치(덮어쓰기)도 성공하고 링크를 만든다");

console.log("제거 명령");
const uninstall = path.join(APP, "bin", "Uninstall Aether.command");
fs.copyFileSync(path.join(MAC, "Uninstall Aether.command"), uninstall);
fs.chmodSync(uninstall, 0o755);
put(path.join(CONFIG, "data", "aether.sqlite"));
put(path.join(CONFIG, "config.json"), "{}");
put(path.join(APP, "mydata", "keep.txt"));
fs.rmSync(link);
fs.symlinkSync("/tmp/elsewhere", link);
fs.writeFileSync(LOG, "");
const uninstallRun = (input: string) => spawnSync("bash", [uninstall], { env, input, encoding: "utf8" });
r = uninstallRun("");
check(r.status === 0 && ["bin", "node", "server", "web"].every((d) => !fs.existsSync(path.join(APP, d))), "프로그램 하위 폴더를 지운다", r.stderr);
check(fs.existsSync(path.join(CONFIG, "data", "aether.sqlite")) && fs.existsSync(path.join(CONFIG, "config.json")), "데이터 질문에 답이 없으면 설정과 데이터를 남긴다(기본 아니오)");
check(fs.existsSync(path.join(APP, "mydata", "keep.txt")), "프로그램 폴더 안의 사용자 폴더는 남긴다");
check(!fs.existsSync(PLIST) && fs.readlinkSync(link) === "/tmp/elsewhere", "plist는 지우고 남의 바탕화면 링크는 남긴다");
check(calls().includes("com.aether.app") && !calls().includes("com.aether.backend") && calls().includes("pkgutil --forget com.aether.app --volume"), "서비스 해제·영수증 삭제는 com.aether.app만", calls());
// 표시 없는 폴더 거절
fs.rmSync(path.join(APP, "mydata"), { recursive: true });
put(path.join(APP, "server", "mine.txt"));
put(path.join(APP, "bin", "other"));
fs.copyFileSync(path.join(MAC, "Uninstall Aether.command"), uninstall);
r = uninstallRun("y\n");
check(r.status === 1 && fs.existsSync(path.join(APP, "server", "mine.txt")) && fs.existsSync(path.join(CONFIG, "config.json")), "Aether 표시가 없으면 아무것도 지우지 않고 코드 1이다");
// 예를 고르면 지운다
put(path.join(APP, "server", "index.mjs"));
r = uninstallRun("y\n");
check(r.status === 0 && !fs.existsSync(CONFIG), "데이터 질문에 y면 설정 폴더를 지운다", r.stderr);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} installer_mac_scripts: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
