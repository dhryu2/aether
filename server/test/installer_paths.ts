/**
 * 설치본의 위치 계산과 첫 실행 판정. 임시 폴더만 쓴다. 모델 호출 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths, bundleProgramDir, isFirstRun, scrubInheritedEnv } from "../setup/paths";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const win = appPaths("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u");
check(win.configDir.endsWith("Aether") && win.configDir.includes("Roaming"), "윈도우 설정은 APPDATA 아래", win.configDir);
check(win.defaultDataDir.includes("Local") && win.defaultDataDir.endsWith(path.join("Aether", "data")), "윈도우 데이터는 LOCALAPPDATA 아래", win.defaultDataDir);
const winNoEnv = appPaths("win32", {}, "/h");
check(winNoEnv.configDir === path.join("/h", "AppData", "Roaming", "Aether"), "윈도우 환경변수가 없으면 홈 아래로 대체", winNoEnv.configDir);

const mac = appPaths("darwin", {}, "/Users/u");
check(mac.configDir === path.join("/Users/u", "Library", "Application Support", "Aether"), "맥 설정 폴더", mac.configDir);
check(mac.defaultDataDir === path.join(mac.configDir, "data"), "맥 데이터는 설정 폴더의 data");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aether-paths-"));
const over = appPaths("win32", { AETHER_APP_BASE: base, APPDATA: "x" }, "/h");
check(over.configDir === base && over.defaultDataDir === path.join(base, "data"), "AETHER_APP_BASE가 OS 규칙보다 우선");
check(over.configFile === path.join(base, "config.json") && over.startLog === path.join(base, "start.log"), "파일 이름");

check(isFirstRun(over), "config.json이 없으면 첫 실행");
fs.mkdirSync(over.defaultDataDir);
fs.writeFileSync(over.envFile, "AETHER_JWT_SECRET=x\n");
fs.writeFileSync(path.join(over.defaultDataDir, "auth-password.json"), "{}");
check(isFirstRun(over), "옛 데이터와 .env가 있어도 config.json이 없으면 첫 실행");
fs.writeFileSync(over.configFile, "{}");
check(!isFirstRun(over), "config.json이 있으면 첫 실행이 아님");

check(bundleProgramDir("file:///x/app/server/index.mjs") === path.join("/x/app"), "묶음 파일 위치에서 프로그램 폴더를 알아낸다");
check(bundleProgramDir("file:///x/repo/server/setup/save.ts") === null, "개발 실행(묶음 밖)은 프로그램 폴더가 없다");

const IMPORT_RE = /(from\s+|import\s*\(?\s*)["']\.\/(setup\/|start)/;
check(IMPORT_RE.test('import x from "./setup/paths"') && IMPORT_RE.test('await import("./start")') && IMPORT_RE.test("import './setup/app'"), "금지 import 정규식이 정적·동적·bare import를 잡는다");
check(!IMPORT_RE.test('import x from "./config"'), "금지 import 정규식이 무관한 import는 잡지 않는다");
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
check(!IMPORT_RE.test(src), "index.ts는 setup/·start.ts를 import하지 않음");

// start.ts: 설정 서버·index.ts는 환경을 정한 뒤 동적으로만 불러오고, 시험용 PORT는 지우기 전에 읽는다.
const startSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "start.ts"), "utf8");
check(!/^import .*["']\.\/(setup\/(main|app|save)|index)["']/m.test(startSrc), "start.ts는 설정 서버·index.ts를 정적으로 import하지 않는다");
check(startSrc.indexOf("process.env.PORT") < startSrc.indexOf("scrubInheritedEnv();") && startSrc.indexOf('import("./setup/main")') > startSrc.indexOf("AETHER_DATA_DIR"), "PORT는 지우기 전에 읽고, 설정 서버는 데이터 폴더를 정한 뒤 불러온다");

const env: NodeJS.ProcessEnv = { AETHER_AUTH_MODE: "off", AETHER_DATA_DIR: "/x", AETHER_JWT_SECRET: "s", PORT: "8787", AETHER_APP_BASE: "/b", AETHER_SETUP_NO_BROWSER: "1", PATH: "/bin", TMPDIR: "/t" };
scrubInheritedEnv(env);
check(!("AETHER_AUTH_MODE" in env) && !("AETHER_DATA_DIR" in env) && !("AETHER_JWT_SECRET" in env) && !("PORT" in env), "물려받은 AETHER_*와 PORT를 지운다", Object.keys(env));
check(env.AETHER_APP_BASE === "/b" && env.AETHER_SETUP_NO_BROWSER === "1" && env.PATH === "/bin" && env.TMPDIR === "/t", "시험용 두 변수와 일반 환경은 남긴다");

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} installer_paths: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
