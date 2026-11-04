/**
 * 실제 vite로 화면 빌드가 build-info.json을 올바르게 남기는지 — 임시 저장소 사본에서만 돈다(운영 web/dist 불가침).
 * 성공 빌드는 build-info를 만들고, 문법 오류 빌드는 기존 dist와 build-info를 그대로 둬야 한다. 모델 호출 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo, runViteBuild } from "../routes/static";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}
function copy(rel: string, root: string) {
  const to = path.join(root, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(REPO, rel), to);
}

// 임시 저장소 모양: web/(vite.config 사본 + 최소 소스 + node_modules 링크), server/observability, shared/agentEvent.ts
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aether-wbr-"));
for (const f of ["web/vite.config.ts", "web/package.json", "server/observability/webBuildHash.ts", "server/observability/release.ts", "server/providers/modelEnv.ts", "shared/agentEvent.ts"]) copy(f, root);
fs.symlinkSync(path.join(REPO, "web", "node_modules"), path.join(root, "web", "node_modules"));
fs.mkdirSync(path.join(root, "web", "src"), { recursive: true });
fs.writeFileSync(path.join(root, "web", "index.html"), '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>');
const main = path.join(root, "web", "src", "main.ts");
fs.writeFileSync(main, "console.log('v1')");
const webDir = path.join(root, "web");
const dist = path.join(webDir, "dist");

const r1 = runViteBuild(webDir);
const info1 = readBuildInfo(dist);
check(r1.ok && !!info1 && fs.existsSync(path.join(dist, "index.html")), "성공 빌드는 dist와 build-info.json을 만든다", r1.error ?? "");
check(!fs.readdirSync(webDir).some((n) => n.startsWith(".dist-")), "임시 빌드 폴더가 남지 않는다");

// 문법 오류 빌드: 기존 dist·build-info가 그대로여야 한다
const raw1 = fs.readFileSync(path.join(dist, "build-info.json"), "utf8");
const html1 = fs.readFileSync(path.join(dist, "index.html"), "utf8");
fs.writeFileSync(main, "const = = ;;{{{");
const r2 = runViteBuild(webDir);
check(!r2.ok, "문법 오류 빌드는 실패로 보고한다", r2.error ?? "");
check(fs.readFileSync(path.join(dist, "build-info.json"), "utf8") === raw1, "실패한 빌드 뒤에도 build-info.json이 그대로다");
check(fs.readFileSync(path.join(dist, "index.html"), "utf8") === html1, "실패한 빌드 뒤에도 기존 화면이 그대로다");
check(!fs.readdirSync(webDir).some((n) => n.startsWith(".dist-")), "실패 뒤에도 임시 폴더가 남지 않는다");

// 소스를 고치면 다시 성공하고 해시가 달라진다
fs.writeFileSync(main, "console.log('v2')");
const r3 = runViteBuild(webDir);
check(r3.ok && readBuildInfo(dist)?.sourceHash !== info1?.sourceHash, "고친 뒤 빌드는 새 해시의 build-info를 남긴다");

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} web_build_real: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
