/**
 * 서버 종료 절차가 어떤 정리 실패에도 프로세스를 끝내는지 본다.
 * 윈도우는 폴더 fsync를 EPERM으로 거절하는데, 그 때문에 오류 기록의 close가 실패하자 process.exit에 닿지 못해
 * 서버가 영구히 남았고 앱 안 업데이트가 설치로 넘어가지 못했다. 맥에서도 폴더 fsync 실패를 흉내 내 같은 길을 시험한다.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorJournal } from "../observability/journal";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aether-shutdown-"));
const preload = path.join(tmp, "preload.mjs");
const FAILING_OPEN = `
import fs from "node:fs/promises";
import { statSync } from "node:fs";
const open = fs.open;
fs.open = async (p, ...rest) => {
  const h = await open.call(fs, p, ...rest);
  if (statSync(p).isDirectory()) h.sync = async () => { throw Object.assign(new Error("EPERM: fsync"), { code: "EPERM" }); };
  return h;
};
setTimeout(() => { Promise.reject(new Error("시험용 오류")); }, 4000);
`;
fs.writeFileSync(preload, FAILING_OPEN);

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

try {
  // 1. 폴더 fsync가 실패해도 서버는 종료 코드를 내고 끝난다.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AETHER_") && k !== "PORT" && k !== "NODE_ENV") env[k] = v;
  const data = path.join(tmp, "data");
  fs.mkdirSync(data);
  Object.assign(env, { AETHER_DATA_DIR: data, AETHER_ERROR_DIR: path.join(data, "errors"), AETHER_HOST: "127.0.0.1", AETHER_AUTH_MODE: "off", AETHER_PROJECT_ROOT: data, AETHER_WEB_AUTO_BUILD: "false", PORT: String(await freePort()) });
  const child = spawn(process.execPath, ["--import", "tsx", "--import", preload, "index.ts"], { cwd: serverDir, env, stdio: "ignore" });
  const code = await new Promise<number | string>((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve("시간 초과"); }, 30_000);
    child.once("exit", (c) => { clearTimeout(t); resolve(c ?? "신호"); });
  });
  assert.equal(code, 1, "정리 실패 뒤에도 서버가 끝나야 한다");
  assert.equal(fs.existsSync(path.join(data, "aether.sqlite.server.lock")), false, "끝나면서 DB 잠금을 풀어야 한다");
  console.log("  PASS 폴더 fsync 실패에도 서버가 끝난다");

  // 2. 윈도우에서는 폴더 fsync를 부르지 않으므로 오류가 파일에 남고 close도 실패하지 않는다.
  const realOpen = fsp.open;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  fsp.open = (async (p: string, ...rest: []) => {
    const h = await realOpen.call(fsp, p, ...rest);
    if (fs.statSync(p).isDirectory()) h.sync = async () => { throw Object.assign(new Error("EPERM: fsync"), { code: "EPERM" }); };
    return h;
  }) as typeof fsp.open;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const dir = path.join(tmp, "journal");
    const j = new ErrorJournal({ directory: dir });
    const r = await j.record(new Error("기록"), { component: "test", operation: "test.failure" });
    assert.equal(r.durable, true);
    await j.close();
    const events = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    assert.equal(events.length, 1);
    assert(fs.statSync(path.join(dir, events[0]!)).size > 0, "오류 줄이 파일에 남아야 한다");
  } finally {
    Object.defineProperty(process, "platform", platform);
    fsp.open = realOpen;
  }
  console.log("  PASS 윈도우에서 오류가 파일에 남고 close가 성공한다");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
