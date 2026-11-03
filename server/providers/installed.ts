/**
 * 실행 프로그램이 이 맥에 있는가. 절대경로면 그 파일을, 이름뿐이면 PATH의 폴더를 차례로 본다.
 * provider 이름을 모른다. 어댑터가 자기 실행 파일 경로를 넘긴다.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProviderAuth, ProviderAvailability } from "./types";

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    // 없거나 실행 권한이 없는 파일이다. 설치 확인의 정상 결과다.
    return false;
  }
}

/** PATH의 폴더를 차례로 훑어 실행 파일의 절대경로를 찾는다. 없으면 null. 외부 프로그램(which)을 부르지 않는다. */
export function findOnPath(name: string): string | null {
  // PATHEXT가 있으면(Windows) 확장자가 붙은 실행 파일(.cmd 등)을 먼저 본다. 확장자 없는 이름은 셸 스크립트일 수 있다.
  const exts = [...(process.env.PATHEXT ?? "").split(";").filter(Boolean), ""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (executable(file)) return file;
    }
  }
  return null;
}

/**
 * 윈도우의 npm `.cmd` 래퍼가 가리키는 진짜 파일을 돌려준다. 아니거나 못 풀면 null.
 * Node는 `.cmd`를 셸 없이 띄우지 못하고(EINVAL), 셸을 쓰면 인자 이스케이프가 위험해서 대상을 직접 띄운다.
 */
function cmdTarget(bin: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32" || !bin.toLowerCase().endsWith(".cmd")) return null;
  try {
    // 새 npm 래퍼는 `"%dp0%\…"`, 옛 래퍼는 `"%~dp0\…"`로 적는다. 앞쪽 줄에도 있어 마지막 것이 실제 대상이다.
    const rest = [...fs.readFileSync(bin, "utf8").matchAll(/"%~?dp0%?\\?([^"]*)"/gi)].map((m) => m[1]);
    const last = rest[rest.length - 1];
    if (!last) return null;
    const target = path.join(path.dirname(bin), last.replace(/\\/g, "/"));
    return fs.existsSync(target) ? target : null;
  } catch {
    // 읽지 못하면 풀지 않고 원래 경로를 쓴다(지금과 같은 실패).
    return null;
  }
}

/** 실행할 command와 그 앞에 붙일 인자. `.cmd`면 대상이 .exe는 그대로, 그 밖(JS)은 node로 띄운다. */
export function resolveLaunch(bin: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const target = cmdTarget(bin, platform);
  if (!target) return { command: bin, args: [] };
  return target.toLowerCase().endsWith(".exe") ? { command: target, args: [] } : { command: process.execPath, args: [target] };
}

/** 실행 파일 하나만 받는 곳(SDK 등)용. `.cmd`가 .exe를 가리킬 때만 풀고, JS 대상은 풀 수 없어 원래 값을 쓴다. */
export function resolveExecutablePath(bin: string, platform: NodeJS.Platform = process.platform): string {
  const { command, args } = resolveLaunch(bin, platform);
  // shortcut: JS를 가리키는 .cmd(node 필요)는 단일 경로로 못 넘겨 풀지 않는다. 그런 claude 설치가 생기면 SDK executable 옵션을 쓴다.
  return args.length === 0 ? command : bin;
}

export function isCommandInstalled(bin: string): boolean {
  if (bin.includes(path.sep) || bin.includes("/")) return executable(bin);
  return findOnPath(bin) !== null;
}

/** 실행 프로그램과 로그인이 필요한 provider의 확인. 프로그램이 없으면 로그인은 묻지 않는다. */
export async function cliAvailability(bin: string, auth: ProviderAuth): Promise<ProviderAvailability> {
  if (!isCommandInstalled(bin)) return { available: false, reason: "not_installed" };
  try {
    return (await auth.status()).loggedIn ? { available: true } : { available: false, reason: "logged_out" };
  } catch {
    // 상태 조회 실패는 각 어댑터가 이미 기록한다. 여기서는 고를 수 없다고만 답한다.
    return { available: false, reason: "check_failed" };
  }
}
