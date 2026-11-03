/** DB 서버 잠금: 살아 있는 다른 프로세스가 쥐면 막고, 죽은 프로세스의 잠금은 넘겨받는다. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireServerLock } from "../db/serverLock";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-lock-"));
const db = path.join(dir, "aether.sqlite");
const lock = `${db}.server.lock`;

// 살아 있는 다른 프로세스가 쥐고 있으면 기다리다 거절한다.
const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
try {
  fs.writeFileSync(lock, String(other.pid));
  await assert.rejects(acquireServerLock(db, 300), /같은 DB를 쓰고 있다/);
} finally {
  other.kill("SIGKILL");
}
await new Promise((r) => other.once("exit", r));

// 쥔 프로세스가 죽었으면 넘겨받는다.
await acquireServerLock(db, 300);
assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));

// 이미 내가 쥐었으면 그대로 통과한다.
await acquireServerLock(db, 300);

console.log("✅ server_lock 통과");
