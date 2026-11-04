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
export function resetTailscaleCliCache() { found = null; missAt = 0; warned = false; limited = limitWhois(runWhois); }

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

/**
 * 조회를 ip 기준으로 합치고 결과(성공·실패 모두)를 ttlMs 기억하며, 동시 조회가 maxInFlight를 넘으면 null로 거절한다.
 * 요청마다 프로세스를 띄우는 비용을 묶는 장치다. rejection은 기억하지 않고 그대로 넘긴다.
 * shortcut: 신원 변경 반영이 ttlMs만큼 늦다, 더 빨리 반영해야 하면 ttl을 줄인다.
 */
export function limitWhois(resolve: IdentityResolver, opts: { ttlMs?: number; maxInFlight?: number; now?: () => number } = {}): IdentityResolver {
  const ttlMs = opts.ttlMs ?? 5000;
  const maxInFlight = opts.maxInFlight ?? 8;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; id: { login: string } | null }>();
  const inflight = new Map<string, Promise<{ login: string } | null>>();
  return async (ip, port) => {
    const hit = cache.get(ip);
    if (hit && now() - hit.at < ttlMs) return hit.id;
    const pending = inflight.get(ip);
    if (pending) return pending;
    if (inflight.size >= maxInFlight) return null;
    const run = resolve(ip, port).then((id) => {
      if (cache.size >= 1024) cache.clear();
      cache.set(ip, { at: now(), id });
      return id;
    }).finally(() => inflight.delete(ip));
    inflight.set(ip, run);
    return run;
  };
}

const runWhois: IdentityResolver = async (ip, port) => {
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

// 모듈에 한 벌만 둔다 — selectStrategy()가 라우트 묶음마다 불리므로 전략 안에 두면 상한이 전략 수만큼 곱해진다.
let limited = limitWhois(runWhois);
export const tailscaleResolver: IdentityResolver = (ip, port) => limited(ip, port);
