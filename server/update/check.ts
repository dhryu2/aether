/**
 * 새 버전 확인. 배포 사이트의 <updateUrl>/version.json을 부팅 1분 뒤와 이후 6시간마다 가져와 메모리에만 둔다.
 * 보내는 것은 없다(사람 정보·설치 식별자 없는 GET 한 번). 다만 배포 서버에는 접속 IP가 남을 수 있다. updateUrl이 비면 기능 전체가 꺼진다.
 * 실패는 조용히 마지막 값을 유지하고 경고를 한 번만 남긴다. 재시도는 없다(다음 주기에 다시 한다).
 */
import crypto from "node:crypto";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { config } from "../config";
import type { UpdateStatusResponse } from "../../shared/http";

export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 6 * 3_600_000;
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 1024 * 1024;

export const versionJson = z.object({
  version: z.string().max(40),
  releasedAt: z.string().max(40),
  notes: z.string().max(4000),
  files: z.array(z.object({
    os: z.enum(["win", "mac"]),
    arch: z.enum(["x64", "arm64"]),
    name: z.string().max(200),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).max(20),
});

/** 숫자 세 칸(x.y.z)만 인정한다. 사전 표기(-beta 등)나 다른 모양은 null. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** latest가 current보다 높은 정식 버전일 때만 true. 어느 쪽이든 모양이 다르면 업데이트로 치지 않는다. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** http(s)만 받는다. 사용자 이름·비밀번호·질의·조각이 있으면 거절한다(로그와 설치본에 비밀이 남지 않게). 끝의 슬래시를 정리한 기준 주소, 그 밖이면 null. */
export function normalizeUpdateUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function readLimitedBytes(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("응답 본문이 없습니다");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("응답이 너무 큽니다");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 공개키(SPKI DER, base64)로 서명을 확인한다. 키나 서명 모양이 잘못돼도 false다. */
export function verifySignature(data: Buffer, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, data, key, Buffer.from(signatureBase64.trim(), "base64"));
  } catch {
    return false;
  }
}

const SIGNATURE_MAX_BYTES = 1024;

/** 서명된 version.json을 얻지 못한 이유. network는 받기 실패, signature는 서명이 없거나 틀렸거나 모양이 다른 경우다. */
export class VersionMetaError extends Error {
  constructor(readonly reason: "network" | "signature") {
    super(reason);
  }
}

/** version.json과 서명을 받아, 내용을 해석하기 전에 서명부터 확인한 값만 돌려준다. */
export async function fetchVerifiedMeta(base: string, publicKey: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<z.infer<typeof versionJson>> {
  const get = async (name: string, max: number) => {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetchFn(`${base}/${name}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
    if (!res.ok) throw new VersionMetaError(res.status === 404 && name.endsWith(".sig") ? "signature" : "network");
    return readLimitedBytes(res, max);
  };
  const raw = await get("version.json", MAX_BODY_BYTES);
  const sig = await get("version.json.sig", SIGNATURE_MAX_BYTES);
  if (!verifySignature(raw, sig.toString("utf8"), publicKey)) throw new VersionMetaError("signature");
  const parsed = versionJson.safeParse(JSON.parse(raw.toString("utf8")));
  if (!parsed.success) throw new VersionMetaError("signature");
  return parsed.data;
}

export interface UpdateCheckerOptions {
  /** 설정의 updateUrl 원문. */
  url: string;
  current: string;
  /** 있으면 서명이 맞는 version.json만 받아들인다. 없으면(개발 실행처럼 설치할 수 없는 곳) 서명 없이 링크만 보인다. */
  publicKey?: string;
  fetchFn?: typeof fetch;
  warn?: (msg: string) => void;
}

export function createUpdateChecker(opts: UpdateCheckerOptions) {
  const base = normalizeUpdateUrl(opts.url);
  const fetchFn = opts.fetchFn ?? fetch;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let last: z.infer<typeof versionJson> | undefined;
  let checkedAt: string | undefined;
  let warned = false;
  let timers: NodeJS.Timeout[] = [];

  if (opts.url.trim() && !base) warn("[aether update] updateUrl이 사용자 이름·질의·조각이 없는 http 또는 https 주소가 아니어서 새 버전 확인을 끕니다");

  async function checkNow(): Promise<void> {
    if (!base) return;
    try {
      if (opts.publicKey) {
        last = await fetchVerifiedMeta(base, opts.publicKey, fetchFn);
      } else {
        const res = await fetchFn(`${base}/version.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" }, redirect: "error" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        last = versionJson.parse(JSON.parse((await readLimitedBytes(res, MAX_BODY_BYTES)).toString("utf8")));
      }
      checkedAt = new Date().toISOString();
      warned = false;
    } catch (e) {
      if (!warned) {
        warned = true;
        warn(`[aether update] 새 버전 확인에 실패했습니다(마지막 값을 유지합니다): ${e instanceof Error ? e.name + (e.name === "ZodError" || e.name === "SyntaxError" ? "" : ": " + e.message) : "알 수 없는 오류"}`);
      }
    }
  }

  function start(): void {
    if (!base || timers.length) return;
    const first = setTimeout(() => {
      void checkNow();
      const every = setInterval(() => void checkNow(), CHECK_EVERY_MS);
      every.unref();
      timers.push(every);
    }, FIRST_CHECK_MS);
    first.unref();
    timers.push(first);
  }

  function stop(): void {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
  }

  function status(): Omit<UpdateStatusResponse, "canInstall" | "install" | "rolledBackVersion"> {
    if (!base) return { enabled: false, current: opts.current, available: false };
    if (!last) return { enabled: true, current: opts.current, available: false, pageUrl: `${base}/` };
    return {
      enabled: true,
      current: opts.current,
      latest: last.version,
      available: isNewerVersion(last.version, opts.current),
      pageUrl: `${base}/`, // 원격이 주는 링크는 쓰지 않는다
      notes: last.notes,
      checkedAt,
    };
  }

  return { checkNow, start, stop, status };
}

/** 서버가 쓰는 기본 확인기. 설정의 updateUrl과 이 서버의 버전으로 만든다. */
export const updateChecker = createUpdateChecker({ url: config.updateUrl, current: pkg.aetherReleaseVersion, publicKey: (pkg as { aetherUpdatePublicKey?: string }).aetherUpdatePublicKey });
