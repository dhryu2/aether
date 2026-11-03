/**
 * Grok 자식 프로세스에 넘길 환경 (Phase 10c · D14/D15).
 *
 * 허브 비밀은 `modelEnv()`가 걷어낸다. 그 위에 Grok 자체 기억과 관측 전송을 프로세스 단위로만 끈다.
 * 사용자 전역 `~/.grok/config.toml`은 디스크에서 고치지 않는다.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { modelEnv } from "../modelEnv";
import { resolveLaunch } from "../installed";
import { resolveGrokBin } from "./transport";

/** 사용자 Grok 설정 폴더. 테스트는 GROK_HOME으로 가린다. */
export function grokAuthHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

/** Aether가 띄운 Grok 프로세스에 항상 얹는 값. */
export const GROK_CHILD_EXTRA: Record<string, string> = {
  GROK_MEMORY: "0",
  GROK_TELEMETRY_ENABLED: "0",
  GROK_TELEMETRY_TRACE_UPLOAD: "0",
  GROK_EXTERNAL_OTEL: "0",
};

/**
 * 대화 세션 프로세스에만 더 얹는 값.
 * Grok 질문 카드는 자체 시간 제한(기본 30분)이 지나면 답 없이 닫히고 모델이 계속한다.
 * 사람이 폰에서 늦게 답해도 카드가 기다리게 끈다(M4 실측: 제한을 30초로 줄이자 Aether 연결에서도 닫혔다, F15).
 */
export const GROK_SESSION_EXTRA: Record<string, string> = {
  GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "false",
};

/** 걸러진 허브 환경 + D14 관측 끄기. `extra`는 그 뒤에 얹는다. */
export function grokChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return modelEnv({ ...GROK_CHILD_EXTRA, ...(extra ?? {}) });
}

/**
 * Grok CLI를 띄운다. 대화 ACP(`GrokStdio`)가 아닌 로그인·배경 작업이 여기를 탄다.
 * 환경은 항상 `grokChildEnv()`를 지난다 — 호출자가 env를 잊어도 허브 비밀이 안 샌다.
 */
export function spawnGrokCli(
  args: readonly string[],
  extra?: Record<string, string>,
  opts?: Pick<SpawnOptions, "detached" | "cwd">,
): ChildProcess {
  const launch = resolveLaunch(resolveGrokBin());
  const child = spawn(launch.command, [...launch.args, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: grokChildEnv(extra),
    cwd: opts?.cwd,
    detached: opts?.detached ?? false,
  });
  return child;
}
