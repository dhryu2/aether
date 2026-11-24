#!/usr/bin/env node
// 다운로드 사이트 생성: build/installers의 설치 파일 + server/package.json 버전 + deploy/site/notes/<버전>.md
// → build/site/{index.html, icon.png, 글꼴, version.json, 설치 파일}. 빌드 도구 없이 정적 파일만 만든다. 네트워크 전송은 하지 않는다.
// 사용: node scripts/build-site.mjs [--released-at <ISO 시각>]
// 시험용 재정의: --installers --out --notes-dir --pkg --template --icon (기본값은 저장소 경로)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const installers = path.resolve(arg("installers") ?? path.join(REPO, "build/installers"));
const out = path.resolve(arg("out") ?? path.join(REPO, "build/site"));
const termsDir = path.join(REPO, "deploy/site/terms");
const TERMS_VERSION = /TERMS_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(REPO, "shared/terms.ts"), "utf8"))[1];
const notesDir = path.resolve(arg("notes-dir") ?? path.join(REPO, "deploy/site/notes"));
const pkgFile = path.resolve(arg("pkg") ?? path.join(REPO, "server/package.json"));
const template = path.resolve(arg("template") ?? path.join(REPO, "deploy/site/index.html"));
const icon = path.resolve(arg("icon") ?? path.join(REPO, "web/public/icon-512.png"));
const font = path.join(REPO, "web/node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2");
const mono = path.join(REPO, "web/node_modules/@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2");

const NOTES_MAX = 4000;
function fail(msg) { console.error(`사이트 빌드 실패: ${msg}`); process.exit(1); }

const version = JSON.parse(fs.readFileSync(pkgFile, "utf8")).aetherReleaseVersion;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`server/package.json aetherReleaseVersion이 x.y.z 형식이 아닙니다: ${version}`);
const releasedRaw = new Date(arg("released-at") ?? Date.now());
if (Number.isNaN(releasedRaw.getTime())) fail(`--released-at이 시각이 아닙니다: ${arg("released-at")}`);
const releasedAt = releasedRaw.toISOString(); // 서버 스키마(문자열 40자 이하)와 형식을 맞춘다

// 만들 설치 파일은 build-installers.sh가 만드는 두 개로 고정이다. 하나라도 없으면 멈춘다.
const targets = [
  { os: "win", arch: "x64", name: `Aether-${version}-win-x64.exe` },
  { os: "mac", arch: "arm64", name: `Aether-${version}-mac-arm64.pkg` },
];
const notesFile = path.join(notesDir, `${version}.md`);
if (!fs.existsSync(notesFile)) fail(`이번 버전 내용 파일이 없습니다: ${notesFile}`);
for (const t of targets) {
  if (!fs.statSync(path.join(installers, t.name), { throwIfNoEntry: false })?.isFile()) fail(`설치 파일이 없습니다: ${path.join(installers, t.name)}`);
}
for (const f of [template, icon, font, mono, path.join(termsDir, `${TERMS_VERSION}.html`)]) if (!fs.existsSync(f)) fail(`재료 파일이 없습니다: ${f}`);

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}
const files = targets.map((t) => {
  const p = path.join(installers, t.name);
  return { ...t, size: fs.statSync(p).size, sha256: sha256(p) };
});
const notes = fs.readFileSync(notesFile, "utf8").trim();
// 서버(server/update/check.ts)의 version.json 검증이 notes를 4000자까지만 받는다. 넘으면 모든 설치본이 새 버전을 못 알아본다.
if (notes.length > NOTES_MAX) fail(`이번 버전 내용이 ${NOTES_MAX}자를 넘습니다(${notes.length}자): ${notesFile}`);
const versionJson = { version, releasedAt, notes, files };

// 설치 파일 폴더가 출력 폴더와 같거나 그 안이면 출력을 비울 때 원본이 지워진다.
if (installers === out || installers.startsWith(out + path.sep)) fail(`설치 파일 폴더가 출력 폴더와 같거나 그 안에 있습니다: ${installers}`);

// 출력 폴더는 이전 사이트 결과(version.json이 있는 폴더)이거나 비어 있을 때만 비운다.
if (fs.existsSync(out)) {
  const entries = fs.readdirSync(out);
  if (entries.length && !entries.includes("version.json")) fail(`출력 폴더가 사이트 결과물이 아닌 파일을 담고 있어 지우지 않습니다: ${out}`);
  fs.rmSync(out, { recursive: true, force: true });
}
fs.mkdirSync(out, { recursive: true });

for (const t of targets) fs.copyFileSync(path.join(installers, t.name), path.join(out, t.name));
fs.cpSync(termsDir, path.join(out, "terms"), { recursive: true });
fs.copyFileSync(icon, path.join(out, "icon.png"));
fs.copyFileSync(font, path.join(out, path.basename(font))); // shortcut: 2MB 전체 글꼴을 그대로 쓴다, 페이지 첫 표시가 느리다는 보고가 있으면 쓰는 글자만 추리기
fs.copyFileSync(mono, path.join(out, path.basename(mono)));
// 두 글꼴은 SIL OFL 1.1이라 글꼴을 배포할 때 라이선스 원문을 함께 둔다.
fs.copyFileSync(path.join(REPO, "web/node_modules/pretendard/dist/LICENSE.txt"), path.join(out, "Pretendard-LICENSE.txt"));
fs.copyFileSync(path.join(REPO, "web/node_modules/@fontsource/geist-mono/LICENSE"), path.join(out, "GeistMono-LICENSE.txt"));
const versionBytes = Buffer.from(JSON.stringify(versionJson, null, 2) + "\n");
fs.writeFileSync(path.join(out, "version.json"), versionBytes);
// 앱 안 업데이트는 이 서명을 확인한 뒤에만 설치한다. 키가 없으면 사이트는 만들되 버튼 설치는 실패하고 직접 다운로드만 된다.
const signingKey = process.env.AETHER_UPDATE_SIGNING_KEY?.trim();
if (signingKey) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
  const signature = crypto.sign(null, versionBytes, privateKey);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(fs.readFileSync(arg("public-key") ?? path.join(REPO, "deploy/installer/update-public-key.txt"), "utf8").trim(), "base64"), format: "der", type: "spki" });
  if (!crypto.verify(null, versionBytes, publicKey, signature)) fail("서명 개인키가 deploy/installer/update-public-key.txt의 공개키와 맞지 않습니다.");
  fs.writeFileSync(path.join(out, "version.json.sig"), signature.toString("base64") + "\n");
} else {
  console.warn("경고: AETHER_UPDATE_SIGNING_KEY가 없어 version.json.sig를 만들지 않습니다. 앱 안 업데이트가 실패합니다.");
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const inline = JSON.stringify(versionJson).replace(/</g, "\\u003c"); // </script> 방지
const noscript = files.map((f) => `<li><a href="${esc(encodeURI(f.name))}">${esc(f.name)}</a></li>`).join("");
let html = fs.readFileSync(template, "utf8");
for (const key of ["__VERSION_JSON__", "__NOSCRIPT_FILES__"]) if (!html.includes(key)) fail(`템플릿에 ${key} 자리가 없습니다`);
html = html.replace("__VERSION_JSON__", () => inline).replace("__NOSCRIPT_FILES__", () => noscript);
fs.writeFileSync(path.join(out, "index.html"), html);

console.log(`완료: ${out}`);
for (const f of files) console.log(`  ${f.name} ${f.size}B sha256=${f.sha256.slice(0, 12)}…`);
