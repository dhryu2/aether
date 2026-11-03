/**
 * DB 백업 파일의 만들기·목록·정리. 설정 > 백업 화면과 CLI(db/backup.ts)가 함께 쓴다.
 * 이름 규칙에 맞는 파일만 다룬다. 사람이 같은 폴더에 둔 다른 파일은 목록에서 빼고 지우지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import type { BackupItem } from "../../shared/http";

export const BACKUP_NAME = /^aether-(before-restore-)?\d{8}T\d{6}Z\.sqlite$/;

export class BackupBusyError extends Error {
  constructor() {
    super("백업이 이미 진행 중이다");
  }
}

let running: Promise<unknown> | null = null;
export const backupRunning = (): boolean => running !== null;

function kindOf(name: string): BackupItem["kind"] {
  return name.startsWith("aether-before-restore-") ? "beforeRestore" : "manual";
}

/** 이름 안의 UTC 시각(20261030T010203Z)을 ISO로 바꾼다. */
function stampOf(name: string): string {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name)!;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** 최신순. 폴더가 없으면 빈 목록이다. */
export function listBackups(dir: string): BackupItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items: BackupItem[] = [];
  for (const id of names) {
    if (!BACKUP_NAME.test(id)) continue;
    try {
      const st = fs.statSync(path.join(dir, id));
      if (st.isFile()) items.push({ id, kind: kindOf(id), createdAt: stampOf(id), sizeBytes: st.size });
    } catch {
      /* 읽는 사이 사라진 파일은 건너뛴다. */
    }
  }
  return items.sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
}

const STALE_PARTIAL_MS = 60 * 60 * 1000;

/** 수동 백업만 오래된 것부터 지운다. 복원 전 백업과 protectId는 지키고, protectId도 남길 개수에는 센다. */
export function pruneManual(dir: string, keep: number, protectId?: string): void {
  // 백업 중 프로세스가 죽어 남은 임시 파일. 진행 중인 백업 것은 최근에 쓰였으므로 mtime으로 가린다.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^aether-.*\.sqlite.*\.partial$/.test(name)) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_PARTIAL_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    /* 정리 실패는 백업 자체를 막지 않는다. */
  }
  const manual = listBackups(dir).filter((b) => b.kind === "manual");
  for (const b of manual.slice(keep)) {
    if (b.id !== protectId) fs.rmSync(path.join(dir, b.id), { force: true });
  }
}

/**
 * 받은 연결(서버는 자기 연결)로 백업한다. 다른 연결의 쓰기가 끼면 SQLite 백업이 처음부터 다시 돌기 때문이다.
 * 임시 이름(.partial)에 쓰고 끝나면 바꿔서, 중간 파일이 목록에 보이지 않는다.
 */
export function createBackup(
  db: DatabaseSync,
  opts: { dir: string; kind: BackupItem["kind"]; keep?: number; protectId?: string },
): Promise<BackupItem> {
  if (running) return Promise.reject(new BackupBusyError());
  const job = (async () => {
    fs.mkdirSync(opts.dir, { recursive: true });
    // 같은 초에 이미 있는 이름이면 1초씩 밀어 덮어쓰지 않는다.
    let ms = Date.now();
    let id: string;
    do {
      const stamp = new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      id = `aether-${opts.kind === "beforeRestore" ? "before-restore-" : ""}${stamp}.sqlite`;
      ms += 1000;
    } while (fs.existsSync(path.join(opts.dir, id)));
    const out = path.join(opts.dir, id);
    const tmp = `${out}.${process.pid}.partial`; // 서버와 CLI가 같은 임시 파일에 쓰지 않게 pid를 넣는다
    try {
      await backup(db, tmp);
      fs.renameSync(tmp, out);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    if (opts.kind === "manual" && opts.keep !== undefined) pruneManual(opts.dir, opts.keep, opts.protectId);
    return { id, kind: opts.kind, createdAt: stampOf(id), sizeBytes: fs.statSync(out).size };
  })();
  running = job;
  const clear = () => {
    running = null;
  };
  job.then(clear, clear);
  return job;
}
