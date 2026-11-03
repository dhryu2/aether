/**
 * 서버 로그 파일. console 출력을 데이터 폴더의 server.jsonl에도 한 줄씩 남기고, 설정 화면이 읽어 가게 한다.
 * 비밀 마스킹은 하지 않는다 — 비밀번호·해시를 console에 찍지 않는 것이 전제다.
 */
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { config } from "../config";
import type { ServerLogEntry, ServerLogLevel } from "../../shared/http";

const MAX_MSG_BYTES = 16 * 1024;
const LEVEL_RANK: Record<ServerLogLevel, number> = { log: 0, warn: 1, error: 2 };

/** 부팅과 라우트가 함께 쓰는 로그 폴더. 파일 이름은 세션 폴더 판별과 겹치지 않게 events.jsonl을 피한다. */
export function serverLogDir(): string {
  return path.join(config.dataDir, "logs");
}

const fileOf = (dir: string, n: number) => path.join(dir, n === 0 ? "server.jsonl" : `server.${n}.jsonl`);

export function installServerLog(opts: { dir: string; maxBytes?: number; keep?: number }): void {
  const { dir } = opts;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 4;
  const orig = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  let fd: number | undefined;
  let size = 0;
  let busy = false; // 재진입 방지
  let off = false;

  const open = () => {
    fd = fs.openSync(fileOf(dir, 0), "a", 0o600);
    size = fs.fstatSync(fd).size;
  };
  let rotateAt = maxBytes; // rename이 실패하면 올려서 매 호출마다 회전을 재시도하지 않게 한다
  const rotate = () => {
    if (fd !== undefined) fs.closeSync(fd); // 윈도우는 열린 파일을 rename할 수 없다
    fd = undefined;
    const tmp = `${fileOf(dir, 0)}.rotating`;
    try {
      fs.renameSync(fileOf(dir, 0), tmp);
    } catch {
      open(); // 현재 파일을 못 옮기면 보관본은 그대로 두고 계속 쓴다
      rotateAt = size + maxBytes;
      return;
    }
    rotateAt = maxBytes;
    try {
      fs.rmSync(fileOf(dir, keep), { force: true });
      for (let n = keep - 1; n >= 1; n--) if (fs.existsSync(fileOf(dir, n))) fs.renameSync(fileOf(dir, n), fileOf(dir, n + 1));
    } catch { /* 밀지 못해도 아래에서 server.1로 덮어쓴다 */ }
    try { fs.renameSync(tmp, fileOf(dir, 1)); } catch { fs.rmSync(tmp, { force: true }); }
    open();
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    open();
  } catch (e) {
    orig.error("[aether] 서버 로그 파일을 열지 못해 파일 기록을 끈다", e);
    return;
  }

  const wrap = (name: keyof typeof orig, level: ServerLogLevel) => {
    console[name] = (...args: unknown[]) => {
      (orig[name] as (...a: unknown[]) => void).apply(console, args);
      if (busy || off) return;
      busy = true;
      try {
        let msg = util.format(...args);
        if (Buffer.byteLength(msg) > MAX_MSG_BYTES) msg = Buffer.from(msg).subarray(0, MAX_MSG_BYTES).toString() + "…(잘림)";
        const line = JSON.stringify({ t: new Date().toISOString(), level, msg }) + "\n";
        if (fd === undefined) open();
        if (size > 0 && size + Buffer.byteLength(line) > rotateAt) rotate();
        size += fs.writeSync(fd!, line);
      } catch (e) {
        off = true;
        orig.error("[aether] 서버 로그 파일 쓰기에 실패해 파일 기록을 끈다", e);
      } finally {
        busy = false;
      }
    };
  };
  wrap("log", "log");
  wrap("info", "log");
  wrap("debug", "log");
  wrap("warn", "warn");
  wrap("error", "error");
}

/** shortcut: 파일 전체를 읽는다(최대 5MiB×4). 상한을 크게 올리면 역방향 읽기로 바꾼다. */
export function readServerLog(opts: { dir: string; lines: number; minLevel?: ServerLogLevel }): ServerLogEntry[] {
  const min = LEVEL_RANK[opts.minLevel ?? "log"];
  const out: ServerLogEntry[] = [];
  for (let n = 0; out.length < opts.lines; n++) {
    let text: string;
    try {
      text = fs.readFileSync(fileOf(opts.dir, n), "utf8");
    } catch {
      if (n === 0) continue; // 첫 파일이 없어도 회전본은 있을 수 있다
      break;
    }
    const rows = text.split("\n");
    for (let i = rows.length - 1; i >= 0 && out.length < opts.lines; i--) {
      if (!rows[i]) continue;
      try {
        const e = JSON.parse(rows[i]) as ServerLogEntry;
        if (typeof e?.msg === "string" && e.level in LEVEL_RANK && LEVEL_RANK[e.level] >= min) out.push(e);
      } catch { /* 깨진 줄은 건너뛴다 */ }
    }
  }
  return out.reverse();
}
