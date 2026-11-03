/**
 * DB 파일 하나는 서버 프로세스 하나만 쓴다.
 * 세션 일기는 다음 쓰기 위치를 메모리에 들고 쓴다. 다른 서버가 같은 파일에 끼워 쓰면 그 위치가 어긋나
 * 같은 자리에 겹쳐 쓰다 UNIQUE 오류가 나고, 그 세션은 재시작 전까지 저장하지 못한다.
 * 잠금 파일에는 잡은 프로세스 번호를 적는다. 그 프로세스가 죽었으면 남은 파일은 버리고 새로 잡는다.
 */
import fs from "node:fs";

const RETRY_MS = 250;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holder(lockFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 이 DB의 서버 잠금을 잡는다. 다른 살아 있는 서버가 쥐고 있으면 waitMs까지 기다린 뒤 던진다.
 * 기다리는 까닭: launchd 재시작 때 옛 프로세스가 종료 정리를 하는 몇 초 동안 잠금을 쥐고 있다.
 * shortcut: 프로세스 번호 재사용으로 죽은 서버의 잠금을 남이 쥔 것으로 볼 수 있다. 그러면 잠금 파일을 지우면 된다.
 */
export async function acquireServerLock(dbFile: string, waitMs = 8000): Promise<void> {
  const lockFile = `${dbFile}.server.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
      process.once("exit", () => {
        if (holder(lockFile) === process.pid) fs.rmSync(lockFile, { force: true });
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pid = holder(lockFile);
    if (pid === process.pid) return;
    // 번호가 비었으면 다른 프로세스가 막 만들어 아직 못 적었을 수 있다. 1초 넘게 비어 있을 때만 버린다.
    if (pid === null ? Date.now() - mtimeMs(lockFile) > 1000 : !alive(pid)) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`다른 서버(프로세스 ${pid ?? "알 수 없음"})가 같은 DB를 쓰고 있다: ${dbFile}`);
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}
