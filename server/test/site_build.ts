/**
 * 다운로드 사이트 빌드(scripts/build-site.mjs): 임시 폴더의 가짜 설치 파일로 version.json의 크기·해시, 파일 누락 실패, 출력 폴더 보호.
 * 저장소의 build/ 폴더는 건드리지 않는다. 모델 호출 0.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TERMS_VERSION } from "../../shared/terms";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO, "scripts/build-site.mjs");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-site-")));
const inst = path.join(tmp, "inst"); fs.mkdirSync(inst);
const notes = path.join(tmp, "notes"); fs.mkdirSync(notes);
const pkg = path.join(tmp, "package.json"); fs.writeFileSync(pkg, JSON.stringify({ version: "0.0.0", aetherReleaseVersion: "1.2.3" }));
fs.writeFileSync(path.join(notes, "1.2.3.md"), "- 첫째 </script><b>\n둘째 줄\n");
const WIN = "Aether-1.2.3-win-x64.exe", MAC = "Aether-1.2.3-mac-arm64.pkg";
const winBytes = crypto.randomBytes(12345), macBytes = crypto.randomBytes(67890);
fs.writeFileSync(path.join(inst, WIN), winBytes);
fs.writeFileSync(path.join(inst, MAC), macBytes);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

const run = (out: string, extra: string[] = []) => spawnSync(process.execPath, [SCRIPT, "--installers", inst, "--out", out, "--notes-dir", notes, "--pkg", pkg, ...extra], { encoding: "utf8" });

const out = path.join(tmp, "site");
const r = run(out, ["--released-at", "2026-11-02T01:02:03.000Z"]);
check(r.status === 0, "정상 빌드 성공", r.stderr);
const vj = JSON.parse(fs.readFileSync(path.join(out, "version.json"), "utf8"));
check(vj.version === "1.2.3" && vj.releasedAt === "2026-11-02T01:02:03.000Z", "버전과 공개 시각");
check(Object.keys(vj).sort().join() === "files,notes,releasedAt,version", "version.json 최상위 키");
const fw = vj.files.find((f: { os: string }) => f.os === "win"), fm = vj.files.find((f: { os: string }) => f.os === "mac");
check(fw.arch === "x64" && fw.name === WIN && fw.size === winBytes.length && fw.sha256 === sha(winBytes), "윈도우 파일 크기·해시", fw);
check(fm.arch === "arm64" && fm.name === MAC && fm.size === macBytes.length && fm.sha256 === sha(macBytes), "맥 파일 크기·해시", fm);
check(Object.keys(fw).sort().join() === "arch,name,os,sha256,size", "files 항목 키");
check(vj.notes.startsWith("- 첫째"), "notes는 notes 파일 내용");
check(sha(fs.readFileSync(path.join(out, WIN))) === fw.sha256 && sha(fs.readFileSync(path.join(out, MAC))) === fm.sha256, "복사된 설치 파일이 원본과 같다");
check(fs.existsSync(path.join(out, "icon.png")), "마스코트 이미지 복사");
const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
check(!html.includes("__VERSION_JSON__") && !html.includes("__NOSCRIPT_FILES__"), "템플릿 자리 치환됨");
check((html.match(/<\/script>/g) ?? []).length === 2, "notes의 </script>가 스크립트를 끊지 못한다(이스케이프)");
const inline = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
check(JSON.parse(inline).files.length === 2 && JSON.parse(inline).notes.includes("</script>"), "인라인 JSON이 version.json과 같다");
check(html.includes(`href="${WIN}"`), "스크립트 없이도 받을 수 있는 링크(noscript)");
check(!/src="https?:|<link[^>]+href="https?:|@import|url\(\s*["']?https?:/.test(html), "외부 자원 참조 없음");
check(/<title>Aether — /.test(html) && !/document\.title=[^;]*version/.test(html), "탭 제목에 버전을 넣지 않는다");
check(html.includes('href="https://github.com/dhryu2/aether"') && html.includes('href="#features"'), "GitHub 링크와 페이지 안 링크");
check(fs.readdirSync(out).sort().join() === [MAC, WIN, "PretendardVariable.woff2", "geist-mono-latin-400-normal.woff2", "icon.png", "index.html", "terms", "version.json"].sort().join(), "출력은 정해진 8개 항목뿐", fs.readdirSync(out));

const termsPage = fs.readFileSync(path.join(out, "terms", `${TERMS_VERSION}.html`), "utf8");
check(html.includes(`href="terms/${TERMS_VERSION}.html"`), "footer가 지금 판의 사용 조건을 가리킨다");
check(termsPage.includes("모든 문제와 손해의 책임은 사용자에게 있습니다") && termsPage.includes("You are solely responsible"), "사용 조건: 사용자 책임");
check(termsPage.includes("법률이 허용하는 최대 범위") && termsPage.includes("maximum extent permitted by law"), "사용 조건: 면책 범위");
check(termsPage.includes("개발자는 사용자 정보를 수집하지 않습니다") && termsPage.includes("AI 서비스의 약관을 따릅니다") && termsPage.includes("푸시 서버"), "사용 조건: 수집 안 함과 외부 통신");
check((termsPage.match(/<li>/g) ?? []).length === 20, "사용 조건: 한국어와 영어 각 10개 조항");
check(!/src="https?:|<link|@import/.test(termsPage), "사용 조건: 외부 자원 참조 없음");

// 다시 빌드하면 이전 결과를 지우고 새로 만든다
fs.writeFileSync(path.join(out, "stale.txt"), "x");
check(run(out).status === 0 && !fs.existsSync(path.join(out, "stale.txt")), "재빌드는 이전 결과를 비운다");

// 설치 파일이 없으면 실패하고 출력도 만들지 않는다
fs.renameSync(path.join(inst, MAC), path.join(tmp, "hidden.pkg"));
const out2 = path.join(tmp, "site2");
const miss = run(out2);
check(miss.status === 1 && /설치 파일이 없습니다/.test(miss.stderr) && !fs.existsSync(out2), "설치 파일이 없으면 실패(출력 없음)", miss.stderr);
fs.renameSync(path.join(tmp, "hidden.pkg"), path.join(inst, MAC));
fs.renameSync(path.join(notes, "1.2.3.md"), path.join(tmp, "n.md"));
const noNotes = run(out2);
check(noNotes.status === 1 && /내용 파일이 없습니다/.test(noNotes.stderr), "notes 파일이 없으면 실패", noNotes.stderr);
fs.renameSync(path.join(tmp, "n.md"), path.join(notes, "1.2.3.md"));
check(run(out2, ["--released-at", "nope"]).status === 1, "잘못된 공개 시각 거절");

// 공개 시각은 ISO로 정규화한다
const out3 = path.join(tmp, "site3");
check(run(out3, ["--released-at", "2026-11-02"]).status === 0 && JSON.parse(fs.readFileSync(path.join(out3, "version.json"), "utf8")).releasedAt === "2026-11-02T00:00:00.000Z", "공개 시각은 toISOString으로 정규화");

// 서버 스키마와 같은 한도: notes 4000자는 통과, 4001자는 실패
fs.writeFileSync(path.join(notes, "1.2.3.md"), "가".repeat(4000));
const out4 = path.join(tmp, "site4");
check(run(out4).status === 0, "notes 4000자는 통과");
fs.writeFileSync(path.join(notes, "1.2.3.md"), "가".repeat(4001));
const tooLong = run(out4 + "x");
check(tooLong.status === 1 && /4000자를 넘습니다/.test(tooLong.stderr) && !fs.existsSync(out4 + "x"), "notes 4001자는 실패(출력 없음)", tooLong.stderr);
fs.writeFileSync(path.join(notes, "1.2.3.md"), "- 첫째 </script><b>\n둘째 줄\n");
// 만든 version.json은 서버의 실제 검증기로 통과해야 한다(어긋나면 설치본이 못 읽는다)
const { createUpdateChecker } = await import("../update/check");
const served = fs.readFileSync(path.join(out, "version.json"), "utf8");
const ck = createUpdateChecker({ url: "https://dl.example", current: "0.0.0", fetchFn: (async () => new Response(served)) as typeof fetch, warn: () => undefined });
await ck.checkNow();
check(ck.status().latest === "1.2.3" && ck.status().available, "build-site의 version.json을 서버 검증기가 받아들인다", ck.status());

// 설치 파일 폴더가 출력 폴더와 같거나 그 안이면 실패하고 원본을 지우지 않는다
const same = spawnSync(process.execPath, [SCRIPT, "--installers", inst, "--out", inst, "--notes-dir", notes, "--pkg", pkg], { encoding: "utf8" });
check(same.status === 1 && fs.existsSync(path.join(inst, WIN)), "출력 폴더가 설치 파일 폴더와 같으면 실패(원본 보존)", same.stderr);
const outer = path.join(tmp, "outer"); fs.mkdirSync(path.join(outer, "inner"), { recursive: true }); fs.writeFileSync(path.join(outer, "version.json"), "{}");
fs.copyFileSync(path.join(inst, WIN), path.join(outer, "inner", WIN)); fs.copyFileSync(path.join(inst, MAC), path.join(outer, "inner", MAC));
const inside = spawnSync(process.execPath, [SCRIPT, "--installers", path.join(outer, "inner"), "--out", outer, "--notes-dir", notes, "--pkg", pkg], { encoding: "utf8" });
check(inside.status === 1 && fs.existsSync(path.join(outer, "inner", WIN)), "설치 파일 폴더가 출력 폴더 안이면 실패(원본 보존)", inside.stderr);

// 사이트 결과물이 아닌 파일이 든 폴더는 지우지 않는다
const other = path.join(tmp, "mine"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "keep.txt"), "소중");
const guard = run(other);
check(guard.status === 1 && fs.readFileSync(path.join(other, "keep.txt"), "utf8") === "소중", "다른 파일이 든 출력 폴더는 지우지 않는다", guard.stderr);

// 앱 안 업데이트 서명: 맞는 키, 다른 키, 키 없음
{
  const pair = crypto.generateKeyPairSync("ed25519");
  const pubFile = path.join(tmp, "pub.txt");
  fs.writeFileSync(pubFile, pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") + "\n");
  const signed = (out: string, key: crypto.KeyObject | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.AETHER_UPDATE_SIGNING_KEY;
    if (key) env.AETHER_UPDATE_SIGNING_KEY = key.export({ type: "pkcs8", format: "der" }).toString("base64");
    return spawnSync(process.execPath, [SCRIPT, "--installers", inst, "--out", out, "--notes-dir", notes, "--pkg", pkg, "--public-key", pubFile], { encoding: "utf8", env });
  };
  const good = path.join(tmp, "signed");
  const r = signed(good, pair.privateKey);
  const sig = fs.existsSync(path.join(good, "version.json.sig")) ? fs.readFileSync(path.join(good, "version.json.sig"), "utf8").trim() : "";
  check(r.status === 0 && crypto.verify(null, fs.readFileSync(path.join(good, "version.json")), pair.publicKey, Buffer.from(sig, "base64")), "저장한 version.json 바이트에 대한 서명을 만든다", r.stderr);
  const wrong = signed(path.join(tmp, "wrong-key"), crypto.generateKeyPairSync("ed25519").privateKey);
  check(wrong.status === 1 && wrong.stderr.includes("공개키"), "개인키가 공개키와 다르면 실패", wrong.stderr);
  const none = path.join(tmp, "no-key");
  const nr = signed(none, undefined);
  check(nr.status === 0 && !fs.existsSync(path.join(none, "version.json.sig")) && nr.stderr.includes("AETHER_UPDATE_SIGNING_KEY"), "키가 없으면 경고하고 서명 파일을 만들지 않는다", nr.stderr);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} site_build: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
