/**
 * 설치본의 입구. 개인 운영 맥의 launchd는 index.ts를 직접 띄우므로 이 파일을 거치지 않는다.
 * 실패는 콘솔 창이 없는 환경에서도 보이도록 <설정 폴더>/start.log에 남기고 코드 1로 끝낸다(자동 실행 장치가 다시 띄운다).
 */
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import pkg from "./package.json" with { type: "json" };
import { appPaths, bundledUpdateUrl, isFirstRun, scrubInheritedEnv } from "./setup/paths";

const p = appPaths();

const LOG_MAX = 1024 * 1024;

// index.ts의 치명 오류(잠금·DB·listen)는 console.error로만 나온다. 비정상 종료 때 이유를 남기려고 마지막 몇 줄을 들고 있는다.
const recentErrors: string[] = [];
const printError = console.error;
console.error = (...args: unknown[]) => {
  recentErrors.push(format(...args));
  if (recentErrors.length > 5) recentErrors.shift();
  printError(...args);
};

function log(msg: string): void {
  try {
    fs.mkdirSync(p.configDir, { recursive: true });
    if (fs.existsSync(p.startLog) && fs.statSync(p.startLog).size > LOG_MAX) fs.truncateSync(p.startLog, 0);
    fs.appendFileSync(p.startLog, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // 로그를 못 써도 stderr에는 남는다.
  }
  printError(msg);
}

// index.ts는 부팅을 기다리지 않고 비동기로 시작하므로, 그 안의 실패(잠금·DB·listen)는 여기서 종료 코드와 마지막 오류로 남긴다.
process.on("exit", (c) => {
  if (!c) return;
  log(`프로세스가 종료 코드 ${c}로 끝났습니다.`);
  for (const e of recentErrors) log(`종료 전 오류: ${e.slice(0, 2000)}`);
});

// 첫 실행의 설정 서버만 시험용 PORT를 받는다(윈도우 시험 프롬프트). 평소 실행은 config.json의 포트만 따르므로 지운다.
const setupPort = Number(process.env.PORT);
scrubInheritedEnv();

try {
  if (isFirstRun(p)) {
    // index.ts는 불러오지 않는다(DB·부팅 부작용 없음). 설정 서버가 쓰는 config.ts가 import 때 환경을 읽으므로 먼저 정한다.
    log(`첫 실행입니다: ${path.basename(p.configFile)}이 없어 설정 서버를 시작합니다.`);
    process.env.AETHER_DATA_DIR = p.defaultDataDir;
    process.env.AETHER_RELEASE = pkg.version;
    const { startSetupServer } = await import("./setup/main");
    await startSetupServer({
      paths: p,
      startPort: Number.isInteger(setupPort) && setupPort >= 1024 && setupPort <= 65535 ? setupPort : 8787,
      log,
    });
    // 저장이 끝나면 설정 서버가 코드 1로 끝난다. 자동 실행 장치(윈도우 AetherHost, 맥 LaunchAgent)가 진짜 서버로 다시 띄운다.
    // 자동 실행 없이 수동으로 띄웠다면 재시작 없이 그냥 끝난다 — 저장 때 start.log에 그렇게 안내한다.
  } else {
    if (fs.existsSync(p.envFile)) process.loadEnvFile(p.envFile);
    process.env.AETHER_CONFIG = p.configFile;
    // 새 버전 확인 주소: .env나 config.json에 없으면 빌드 때 묶음에 넣은 값을 쓴다. 없으면 기능이 꺼진다.
    const updateUrl = bundledUpdateUrl((pkg as { aetherUpdateUrl?: unknown }).aetherUpdateUrl, p.configFile);
    if (updateUrl) process.env.AETHER_UPDATE_URL = updateUrl;
    else if (!process.env.AETHER_UPDATE_URL && !(pkg as { aetherUpdateUrl?: unknown }).aetherUpdateUrl) log("경고: 배포 주소 없이 빌드된 묶음입니다. config.json에 updateUrl이 없으면 새 버전 확인은 꺼집니다.");
    // release.ts가 설치 폴더의 부모에서 git을 실행하지 않도록 묶음 버전을 명시한다.
    process.env.AETHER_RELEASE = pkg.version;
    // config.ts가 import 때 환경을 읽으므로 위 설정 뒤에 동적으로 불러온다.
    await import("./index");
  }
} catch (e) {
  log(`부팅 실패: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
}
