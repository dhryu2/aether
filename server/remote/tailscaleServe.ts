/**
 * 설정 화면의 「폰에서 쓰기」. `tailscale serve`로 같은 망의 기기에 HTTPS 주소를 열고 닫는다.
 * 비밀번호 로그인 + 루프백 바인드일 때만 켠다. 인증 off면 망 전체에 무인증으로 열리고,
 * tailscale 인증은 serve를 거치면 소켓 주소가 루프백이라 모든 요청을 거절한다(clientAddr).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { config } from "../config";
import { resolveTailscaleCli } from "../auth/tailscale";
import type { RemoteAccessResponse } from "../../shared/http";

const execFileP = promisify(execFile);
const CLI_TIMEOUT_MS = 5000;
const CONSENT_WAIT_MS = 10 * 60_000;

let waiting: ChildProcess | null = null;
let consentUrl: string | undefined;
let lastError: string | undefined;

const serveArgs = () => ["serve", "--bg", `--https=${config.port}`, `http://127.0.0.1:${config.port}`];
const command = () => ["tailscale", ...serveArgs()].join(" ");
const supported = () => config.authMode === "password" && ["127.0.0.1", "localhost"].includes(config.host.trim().toLowerCase());
const run = (cli: string, args: string[]) => execFileP(cli, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true }).then((r) => r.stdout);

type ServeConfig = {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
};

/** serve 설정에서 이 서버를 가리키는 HTTPS 주소를 찾는다. 사용자가 직접 다른 앞문 포트로 열었어도 찾는다. */
function findOurs(serve: ServeConfig, dns: string): string | undefined {
  for (const [hostPort, web] of Object.entries(serve.Web ?? {})) {
    if (!hostPort.startsWith(`${dns}:`)) continue;
    try {
      const proxy = new URL(web.Handlers?.["/"]?.Proxy ?? "");
      if (Number(proxy.port) === config.port && ["127.0.0.1", "localhost"].includes(proxy.hostname)) return hostPort;
    } catch { /* 파일 공유 같은 다른 핸들러 */ }
  }
  return undefined;
}

type Observed = { state: "noTailscale" | "offline" | "unknown" } | { state: "off" | "conflict"; cli: string } | { state: "on"; cli: string; hostPort: string };

async function observe(): Promise<Observed> {
  const cli = resolveTailscaleCli();
  if (!cli) return { state: "noTailscale" };
  let dns: string | undefined;
  try {
    const st = JSON.parse(await run(cli, ["status", "--json"])) as { BackendState?: string; Self?: { DNSName?: string } };
    dns = st.BackendState === "Running" ? st.Self?.DNSName?.replace(/\.$/, "") : undefined;
  } catch { /* 앱이나 데몬이 꺼져 있다 */ }
  if (!dns) return { state: "offline" };
  let serve: ServeConfig;
  try {
    serve = JSON.parse(await run(cli, ["serve", "status", "--json"])) as ServeConfig;
  } catch {
    return { state: "unknown" }; // 모르는 채로 켜면 남의 설정을 덮을 수 있다
  }
  const hostPort = findOurs(serve, dns);
  if (hostPort) return { state: "on", cli, hostPort };
  return serve.TCP?.[String(config.port)] ? { state: "conflict", cli } : { state: "off", cli };
}

export async function remoteAccessStatus(): Promise<RemoteAccessResponse> {
  const base = { command: command() };
  if (!supported()) return { ...base, state: "unsupported" };
  const seen = await observe();
  if (seen.state === "on") {
    consentUrl = lastError = undefined;
    return { ...base, state: "on", url: `https://${seen.hostPort.replace(/:443$/, "")}` };
  }
  if (waiting) return { ...base, state: "consent", consentUrl };
  if (seen.state === "unknown") return { ...base, state: "offline", error: lastError };
  return { ...base, state: seen.state, consentUrl, error: lastError };
}

/** 켠다. HTTPS가 아직 꺼진 망이면 CLI가 허용 링크를 찍고 허용될 때까지 기다리므로, 링크를 받으면 먼저 답한다. */
export async function enableRemoteAccess(): Promise<RemoteAccessResponse> {
  if (!supported() || waiting) return remoteAccessStatus();
  const seen = await observe();
  if (seen.state !== "off" || waiting) return remoteAccessStatus();
  consentUrl = lastError = undefined;
  await new Promise<void>((answer) => {
    // cwd를 설치 폴더 밖에 둔다. 기다리는 동안 업데이트가 폴더를 바꿔도 윈도우에서 잠기지 않는다.
    const child = spawn(seen.cli, serveArgs(), { cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    waiting = child;
    let out = "";
    const timer = setTimeout(() => child.kill(), CONSENT_WAIT_MS);
    const read = (chunk: Buffer) => {
      out += chunk.toString();
      const url = /https:\/\/\S+(?=\s)/.exec(out)?.[0];
      if (url) { consentUrl = url; answer(); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const finish = (failure?: string) => {
      clearTimeout(timer);
      if (waiting === child) waiting = null;
      if (failure) { lastError = failure.trim().slice(0, 500); consentUrl = undefined; }
      answer();
    };
    child.on("error", (e) => finish(e.message));
    // 신호로 끝난 것은 취소나 시간 초과다. 오류로 보이지 않고 처음 상태로 돌아간다.
    child.on("close", (code, signal) => {
      if (signal) consentUrl = undefined;
      finish(code ? out || `exit ${code}` : undefined);
    });
  });
  return remoteAccessStatus();
}

/** 끈다. 허용을 기다리는 중이면 기다림만 취소한다. */
export async function disableRemoteAccess(): Promise<RemoteAccessResponse> {
  if (waiting) {
    const child = waiting;
    await new Promise((done) => { child.once("close", done); child.kill(); });
    return remoteAccessStatus();
  }
  if (supported()) {
    const seen = await observe();
    if (seen.state === "on") {
      const front = seen.hostPort.slice(seen.hostPort.lastIndexOf(":") + 1);
      await run(seen.cli, ["serve", `--https=${front}`, "off"]).catch((e: { stderr?: string; message: string }) => {
        lastError = (e.stderr || e.message).trim().slice(0, 500);
      });
    }
  }
  return remoteAccessStatus();
}
