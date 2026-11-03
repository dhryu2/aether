import { FailureTracker } from "../providers/failureTracking";
/**
 * 기본 whois resolver (DI 디폴트 구현). `tailscale whois --json <ip:port>`로 신원 조회.
 * ⚠️ exec 금지(명령 주입) — execFile만. ip:port는 호출 전 clientAddr가 Tailscale 대역으로 검증한 값만.
 * ⚠️ --json은 ip:port 인자보다 앞에(tailscale CLI 인자순서 함정).
 * launchd는 PATH가 비어 CLI를 못 찾음 → 설정 경로, PATH, 알려진 설치 위치 순으로 찾는다.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { findOnPath } from "../providers/installed";
import type { IdentityResolver } from "./types";

const failures = new FailureTracker();

const execFileP = promisify(execFile);

/** PATH에 없을 때 보는 설치 위치(맥 앱 안쪽, 윈도우 기본 설치). 파일이 있는지만 본다. */
const KNOWN_LOCATIONS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", ...[process.env.ProgramFiles, process.env.ProgramW6432, "C:\\Program Files"].filter((d): d is string => !!d).map((d) => path.win32.join(d, "Tailscale", "tailscale.exe"))];
const MISS_TTL_MS = 10_000; // 못 찾았을 때 다시 찾기까지(설치 직후 대응, 요청마다 디스크를 훑지 않게)

let found: string | null = null;
let missAt = 0;
let warned = false;

/** 시험용: 찾은 결과와 경고 기억을 비운다. */
export function resetTailscaleCliCache() { found = null; missAt = 0; warned = false; }

/** tailscale 실행 파일 — 설정 경로 → PATH → 알려진 위치. 못 찾으면 null(10초간 기억). */
export function resolveTailscaleCli(known: readonly string[] = KNOWN_LOCATIONS): string | null {
  if (config.tailscaleCli) return config.tailscaleCli;
  if (found) return found;
  if (Date.now() - missAt < MISS_TTL_MS) return null;
  const hit = findOnPath("tailscale") ?? known.find((f) => fs.existsSync(f)) ?? null;
  if (hit) return (found = hit);
  missAt = Date.now();
  return null;
}

export const tailscaleResolver: IdentityResolver = async (ip, port) => {
  const cli = resolveTailscaleCli();
  if (!cli) {
    // 실행 파일이 없는 것은 설정 문제다. 요청마다 오류를 쌓지 않고 한 번만 알린다.
    if (!warned) { warned = true; console.warn("[aether] tailscale 실행 파일을 찾지 못해 신원 확인을 거절합니다. AETHER_TAILSCALE_CLI로 경로를 지정하세요."); }
    return null;
  }
  try {
    const { stdout } = await execFileP(cli, ["whois", "--json", `${ip}:${port}`], {
      timeout: 3000,
    });
    const login = JSON.parse(stdout)?.UserProfile?.LoginName;
    failures.clear("auth.identity.resolve");
    return typeof login === "string" && login ? { login } : null;
  } catch (error) {
    const e = error as { code?: string | number; killed?: boolean; status?: number };
    // whois의 정상 노드 부재(종료 1)와 실행 시간 초과는 인증 거절로 끝낸다.
    if (e.code !== 1 && e.status !== 1 && !e.killed && e.code !== "ETIMEDOUT") {
      failures.report(error, { component: "auth", operation: "auth.identity.resolve", severity: "warning" });
    }
    return null; // 노드 미발견/타임아웃/파싱 실패 → 인증 거부(게이트가 401)
  }
};
