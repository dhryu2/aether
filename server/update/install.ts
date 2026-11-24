/**
 * 앱 안 업데이트. 서명된 version.json으로 설치 파일을 받아 검사한 뒤, 설치를 넘기고 서버를 끝낸다.
 * 윈도우는 설치 프로그램(aether.nsi)이, 맥은 앱 안의 apply-update.sh가 설치와 되돌리기를 맡는다.
 * 약속: updates 폴더의 ok-<버전>은 새 서버가 떴다는 표시, rolled-back은 되돌렸다는 표시(내용은 실패한 버전)다.
 * 자동 실행 장치 아래의 설치본에서만 켜진다. 업데이트 주소가 없으면 꺼진다.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { config } from "../config";
import { createBackup } from "../db/backups";
import { restoreStatus } from "../db/restore";
import { database } from "../db/sqlite";
import { appPaths, bundleProgramDir } from "../setup/paths";
import { VersionMetaError, fetchVerifiedMeta, isNewerVersion, normalizeUpdateUrl, verifySignature } from "./check";
import type { UpdateInstallFailure, UpdateInstallState } from "../../shared/http";

/** 윈도우 감시 프로그램(host.nsi)과 맞춘 종료 코드. 이 코드로 끝나면 감시 프로그램이 설치 파일을 실행한다. */
export const EXIT_CODE_INSTALL = 75;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const STALL_MS = 30_000;
const EXIT_DELAY_MS = 800;
const CLEANUP_DELAY_MS = 2 * 60_000;
const HANDOFF_WAIT_MS = 5 * 60_000; // 맥: 넘겨받은 쪽이 앱을 끄지 못하고 끝났을 때 installing에 영원히 머물지 않게 한다
const ROLLED_BACK = "rolled-back";
const UPDATE_LOG = "update.log"; // 되돌린 뒤 원인을 볼 수 있게 남긴다

type Target = { os: "win" | "mac"; arch: "x64" | "arm64"; staged: string; pattern: RegExp };

/** 이 컴퓨터에 맞는 설치 파일 종류. 배포하지 않는 조합이면 null이다. */
export function targetFor(platform: NodeJS.Platform, arch: string): Target | null {
  if (platform === "win32" && arch === "x64") return { os: "win", arch: "x64", staged: "Aether-update.exe", pattern: /^Aether-(\d+\.\d+\.\d+)-win-x64\.exe$/ };
  if (platform === "darwin" && arch === "arm64") return { os: "mac", arch: "arm64", staged: "Aether-update.dmg", pattern: /^Aether-(\d+\.\d+\.\d+)-mac-arm64\.dmg$/ };
  return null;
}

// 시험이 이 경로로 불러온다.
export { verifySignature };

class InstallError extends Error {
  constructor(readonly reason: UpdateInstallFailure) {
    super(reason);
  }
}

export interface UpdateInstallerOptions {
  /** 설정의 updateUrl 원문. */
  url: string;
  current: string;
  publicKey: string | undefined;
  /** 자동 실행 장치 아래의 설치본인가. */
  supervised: boolean;
  platform: NodeJS.Platform;
  arch: string;
  updatesDir: string;
  fetchFn?: typeof fetch;
  /** 설치 직전 DB 백업. 실패하면 설치하지 않는다. */
  beforeHandoff: () => Promise<void>;
  /** 설치 프로그램에 넘기고 서버가 끝낼 종료 코드를 돌려준다. null이면 넘겨받은 쪽이 앱을 끄므로 서버는 스스로 끝내지 않는다. */
  handoff: (stagedFile: string, version: string) => Promise<number | null>;
  stallMs?: number;
  handoffWaitMs?: number;
  cleanupDelayMs?: number;
  warn?: (msg: string) => void;
}

export function createUpdateInstaller(opts: UpdateInstallerOptions) {
  const base = normalizeUpdateUrl(opts.url);
  const target = targetFor(opts.platform, opts.arch);
  const fetchFn = opts.fetchFn ?? fetch;
  const stallMs = opts.stallMs ?? STALL_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const canInstall = !!(base && target && opts.publicKey && opts.supervised);
  let state: UpdateInstallState = { phase: "idle" };
  let abort: AbortController | undefined;
  let exitFn: (code: number) => void = (code) => process.exit(code);

  const staged = target ? path.join(opts.updatesDir, target.staged) : "";
  const part = `${staged}.part`;

  async function fetchSigned(signal: AbortSignal, expected: string) {
    const meta = await fetchVerifiedMeta(base!, opts.publicKey!, fetchFn, signal);
    // 사용자가 동의한 버전이 서명된 최신 값과 같을 때만 받는다.
    if (meta.version !== expected) throw new InstallError("signature");
    if (!isNewerVersion(meta.version, opts.current)) throw new InstallError("signature");
    const file = meta.files.find((f) => f.os === target!.os && f.arch === target!.arch);
    // 저장 위치는 고정 이름이지만, 주소에 들어가는 이름도 서명된 값 중 약속한 모양만 받는다.
    if (!file || target!.pattern.exec(file.name)?.[1] !== meta.version || file.size > MAX_FILE_BYTES) throw new InstallError("signature");
    return { version: meta.version, file };
  }

  async function download(file: { name: string; size: number; sha256: string }, version: string, ctrl: AbortController) {
    let stall: NodeJS.Timeout | undefined;
    let stalled = false;
    const touch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => { stalled = true; ctrl.abort(); }, stallMs);
    };
    touch();
    try {
      const res = await fetchFn(`${base}/${encodeURIComponent(file.name)}`, { signal: ctrl.signal, redirect: "error" });
      if (!res.ok || !res.body) throw new InstallError("network");
      const hash = crypto.createHash("sha256");
      const out = await fs.promises.open(part, "w");
      const reader = res.body.getReader();
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          touch();
          received += value.byteLength;
          if (received > file.size) throw new InstallError("verify");
          hash.update(value);
          await out.writeFile(value);
          state = { phase: "downloading", version, received, total: file.size };
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        await out.close();
      }
      if (received !== file.size || hash.digest("hex") !== file.sha256) throw new InstallError("verify");
    } catch (e) {
      if (stalled) throw new InstallError("network");
      throw e;
    } finally {
      clearTimeout(stall);
    }
  }

  function classify(e: unknown, cancelled: boolean): UpdateInstallFailure | null {
    if (e instanceof InstallError || e instanceof VersionMetaError) return e.reason;
    if (cancelled) return null;
    if (e instanceof SyntaxError) return "signature";
    if (e && typeof e === "object" && "syscall" in e) return "disk";
    return "network";
  }

  async function run(ctrl: AbortController, expected: string): Promise<void> {
    let version: string | undefined;
    try {
      fs.mkdirSync(opts.updatesDir, { recursive: true });
      fs.rmSync(staged, { force: true });
      fs.rmSync(part, { force: true });
      fs.rmSync(path.join(opts.updatesDir, ROLLED_BACK), { force: true });
      const signed = await fetchSigned(ctrl.signal, expected);
      version = signed.version;
      state = { phase: "downloading", version, received: 0, total: signed.file.size };
      await download(signed.file, version, ctrl);
      if (ctrl.signal.aborted) throw new DOMException("취소", "AbortError");
      abort = undefined; // 여기부터는 취소할 수 없다
      state = { phase: "installing", version };
      fs.renameSync(part, staged);
      await opts.beforeHandoff().catch(() => { throw new InstallError("backup"); });
      const code = await opts.handoff(staged, version).catch((e: unknown) => {
        warn(`[aether update] 설치를 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
        throw new InstallError("handoff");
      });
      if (code !== null) setTimeout(() => exitFn(code), EXIT_DELAY_MS);
      else {
        // 교체 스크립트가 앱을 옮기기 전에 끝나면 서버가 그대로 살아 있다. 그때는 실패로 돌린다.
        setTimeout(() => {
          if (state.phase === "installing") state = { phase: "failed", version, reason: "handoff" };
        }, opts.handoffWaitMs ?? HANDOFF_WAIT_MS).unref();
      } // 화면이 설치 단계를 한 번은 볼 수 있게 조금 뒤에 끝낸다
    } catch (e) {
      abort = undefined;
      const reason = classify(e, ctrl.signal.aborted);
      try {
        fs.rmSync(part, { force: true });
        fs.rmSync(staged, { force: true });
      } catch {
        // 백신 등이 잡고 있으면 다음 시도나 정리 때 지운다. 여기서 던지면 서버 전체가 내려간다.
      }
      if (reason) warn(`[aether update] 업데이트 실패: ${reason}`);
      state = reason ? { phase: "failed", version, reason } : { phase: "idle" };
    }
  }

  /** 시작했으면 true. 이미 진행 중이거나 쓸 수 없으면 false. */
  function start(expected: string): boolean {
    if (!canInstall || state.phase === "downloading" || state.phase === "checking" || state.phase === "installing") return false;
    abort = new AbortController();
    state = { phase: "checking" };
    void run(abort, expected);
    return true;
  }

  /** 설치 프로그램에 넘기기 전까지만 취소된다. */
  function cancel(): boolean {
    if (!abort) return false;
    abort.abort();
    return true;
  }

  /** 지난 업데이트가 되돌려졌으면 실패한 버전. 그 뒤 더 높은 버전을 설치했다면 무시한다. */
  function rolledBackVersion(): string | undefined {
    try {
      const v = fs.readFileSync(path.join(opts.updatesDir, ROLLED_BACK), "utf8").trim();
      return isNewerVersion(v, opts.current) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  function status() {
    return { canInstall, install: state, rolledBackVersion: rolledBackVersion() };
  }

  /** 서버가 요청을 받을 수 있게 된 뒤 부른다. 설치 프로그램이 이 표시를 기다리고, 받은 파일은 조금 뒤 치운다. */
  function markHealthy(): void {
    // 같은 계정의 다른 서버와 개발 실행이 설치본의 표시를 쓰거나 파일을 치우면 안 된다.
    if (!opts.supervised || !fs.existsSync(opts.updatesDir)) return;
    try {
      fs.writeFileSync(path.join(opts.updatesDir, `ok-${opts.current}`), "");
    } catch (e) {
      warn(`[aether update] 정상 표시를 남기지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => {
      if (state.phase !== "idle") return;
      try {
        for (const n of fs.readdirSync(opts.updatesDir)) {
          // 아직 끝나지 않은 설치 프로그램이 잡고 있으면 다음 기회에 치운다.
          if (n !== ROLLED_BACK && n !== UPDATE_LOG) fs.rmSync(path.join(opts.updatesDir, n), { force: true, recursive: true });
        }
      } catch {
        // 치우기는 덤이다.
      }
    }, opts.cleanupDelayMs ?? CLEANUP_DELAY_MS).unref();
  }

  return { start, cancel, status, markHealthy, onExit: (fn: (code: number) => void) => { exitFn = fn; } };
}

const execFileAsync = promisify(execFile);

/**
 * 맥: dmg 안의 새 앱을 대기 폴더(<설정 폴더>/update/Aether.app)로 꺼내 서명을 검사한 뒤, 앱 안의 교체 스크립트에 넘긴다.
 * 교체 스크립트는 스스로 세션에서 떨어져 앱을 끄고 바꾸고 다시 연다. 실패하면 이전 앱으로 되돌리고 rolled-back에 버전을 적는다.
 */
export async function handoffMac(dmg: string, version: string, configDir: string, programDir: string): Promise<void> {
  const staged = path.join(configDir, "update", "Aether.app");
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "aether-dmg-"));
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  try {
    try {
      await execFileAsync("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt]);
      await execFileAsync("ditto", [path.join(mnt, "Aether.app"), staged]);
    } finally {
      await execFileAsync("hdiutil", ["detach", mnt, "-force"]).catch(() => undefined);
      try { fs.rmdirSync(mnt); } catch { /* 붙어 있던 볼륨이 아직 남았으면 비어 있지 않을 수 있다. 임시 폴더라 둬도 된다. */ }
    }
    await execFileAsync("codesign", ["--verify", "--deep", "--strict", staged]);
  } catch (e) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw e;
  }
  await execFileAsync("/bin/bash", [path.join(programDir, "..", "apply-update.sh"), "--detach"], {
    env: { ...process.env, AETHER_APP_BASE: configDir, AETHER_UPDATE_VERSION: version },
  });
}

const updatesDir = path.join(appPaths().configDir, "updates");
const programDir = bundleProgramDir();
const supervised = process.env.AETHER_SUPERVISED === "1" && programDir !== null;
delete process.env.AETHER_SUPERVISED; // 에이전트의 자식 프로세스에 물려주지 않는다

/** 서버가 쓰는 기본 인스턴스. */
export const updateInstaller = createUpdateInstaller({
  url: config.updateUrl,
  current: pkg.aetherReleaseVersion,
  publicKey: (pkg as { aetherUpdatePublicKey?: string }).aetherUpdatePublicKey,
  supervised,
  platform: process.platform,
  arch: process.arch,
  updatesDir,
  beforeHandoff: async () => {
    await createBackup(database(), { dir: config.backupDir, kind: "manual", keep: config.backupKeep, protectId: restoreStatus(config.dbPath).pending?.id });
  },
  handoff: async (staged, version) => {
    if (process.platform !== "darwin") return EXIT_CODE_INSTALL;
    await handoffMac(staged, version, appPaths().configDir, programDir!);
    return null;
  },
});
