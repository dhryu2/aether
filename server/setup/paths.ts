/**
 * 설치본의 고정 위치 계산과 첫 실행 판정. 환경변수·OS를 인자로 받아 순수하게 계산한다(시험 용이).
 * 설치 프로그램은 설정 폴더에 쓰지 않으므로 config.json 유무가 곧 "첫 실행인가"다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppPaths {
  /** config.json·.env·start.log가 있는 폴더 */
  configDir: string;
  /** config.json에 dataDir이 없을 때의 기본 데이터 폴더 */
  defaultDataDir: string;
  configFile: string;
  envFile: string;
  startLog: string;
}

export function appPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): AppPaths {
  const base = env.AETHER_APP_BASE?.trim();
  let configDir: string;
  let defaultDataDir: string;
  if (base) {
    // 시험용: 설정·데이터를 이 폴더 하나에 가둔다.
    configDir = path.resolve(base);
    defaultDataDir = path.join(configDir, "data");
  } else if (platform === "win32") {
    configDir = path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "Aether");
    // 로밍 프로필이 SQLite를 동기화하지 않도록 데이터만 LOCALAPPDATA에 둔다.
    defaultDataDir = path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "Aether", "data");
  } else {
    configDir = path.join(home, "Library", "Application Support", "Aether");
    defaultDataDir = path.join(configDir, "data");
  }
  return {
    configDir,
    defaultDataDir,
    configFile: path.join(configDir, "config.json"),
    envFile: path.join(configDir, ".env"),
    startLog: path.join(configDir, "start.log"),
  };
}

export function isFirstRun(p: AppPaths = appPaths()): boolean {
  return !fs.existsSync(p.configFile);
}

/**
 * 설치본은 config.json과 .env만 믿는다. 부모 환경의 AETHER_*·PORT가 설정 파일을 이기지 않도록 지운다.
 * 시험용 AETHER_APP_BASE·AETHER_SETUP_NO_BROWSER와 자동 실행 장치의 표시 AETHER_SUPERVISED만 남긴다.
 */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv = process.env): void {
  const keep = new Set(["AETHER_APP_BASE", "AETHER_SETUP_NO_BROWSER", "AETHER_SUPERVISED"]);
  for (const k of Object.keys(env)) if ((k.startsWith("AETHER_") && !keep.has(k)) || k === "PORT") delete env[k];
}

/**
 * 묶음에 빌드 때 넣은 배포 주소(package.json aetherUpdateUrl)를 AETHER_UPDATE_URL로 쓸지 정한다. 쓸 값, 아니면 undefined.
 * 환경변수(.env 포함)와 config.json의 updateUrl이 있으면 그쪽이 이기므로 주입하지 않는다.
 */
export function bundledUpdateUrl(injected: unknown, configFile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof injected !== "string" || !injected.trim()) return undefined;
  if (env.AETHER_UPDATE_URL !== undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (parsed && typeof parsed === "object" && "updateUrl" in parsed) return undefined;
  } catch {
    // 설정 파일을 못 읽으면 config.ts가 부팅을 거부하므로 여기서는 주입만 판단한다.
  }
  return injected.trim();
}

/**
 * 설치본의 프로그램 폴더(= 묶음 파일 server/index.mjs 위치의 부모). 묶음 밖(개발 실행)이면 null이다.
 * 재설치가 프로그램 폴더 안을 지우므로 사용자 데이터·작업 폴더를 그 안에 두지 못하게 막는 데 쓴다.
 */
export function bundleProgramDir(metaUrl: string = import.meta.url): string | null {
  const f = fileURLToPath(metaUrl);
  return path.basename(f) === "index.mjs" ? path.dirname(path.dirname(f)) : null;
}

/** 아직 없는 경로도 비교할 수 있게, 존재하는 가장 깊은 조상만 실제 경로로 바꾼다(심볼릭 링크 우회 방지). */
function realish(p: string): string {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

/** child가 parent와 같거나 그 안인가. 윈도우·맥(기본 대소문자 무시)에서는 대소문자를 무시한다. */
export function isInsideDir(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const ci = platform === "win32" || platform === "darwin";
  const norm = (x: string) => (ci ? realish(x).toLowerCase() : realish(x));
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}
