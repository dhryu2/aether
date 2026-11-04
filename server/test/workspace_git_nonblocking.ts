/**
 * 폴더 목록과 세션 목록의 git이 이벤트 루프를 막지 않는다 — 모델 호출 0.
 *
 * PATH 앞에 1초 자는 가짜 git을 두고, 읽기 요청 중 이벤트 루프의 최대 간격을 잰다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-nonblock-")));
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-nonblock-data-"));
process.env.AETHER_PROJECT_ROOT = T;
process.env.AETHER_WORKTREE_DIR = path.join(T, "wt");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
});

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("nonblock");
const mock = await import("./support/mockProvider");
const { __registerProviderForTest } = await import("../providers/registry");
const express = (await import("express")).default;
const { sessionsRouter } = await import("../routes/sessions");
const { fsRouter } = await import("../routes/fs");
__registerProviderForTest(mock.mockEntry);

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 240)}`}`);
  cond ? pass++ : fail++;
}
const g = (a: string[], cwd: string) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const app = express(); app.use(express.json());
app.use("/api/sessions", sessionsRouter); app.use("/api/fs", fsRouter);
const srv = app.listen(0, "127.0.0.1"); await new Promise<void>((r) => srv.once("listening", () => r()));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const repo = fs.realpathSync(fs.mkdtempSync(path.join(T, "repo-")));
g(["init", "-q", "-b", "main"], repo); fs.writeFileSync(path.join(repo, "a.txt"), "x\n"); g(["add", "-A"], repo); g(["commit", "-q", "-m", "i"], repo);
const create = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo, provider: "mock3", isolateWorkspace: true, permissionMode: "manual" }) });
const made = await create.json() as { id: string; cwd: string };
fs.writeFileSync(path.join(made.cwd, "dirty.txt"), "d\n"); // 복사본을 더럽힌다

// 가짜 git: 호출을 기록하고 1초 잔 뒤 진짜 git으로 넘긴다.
const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const bin = path.join(T, "slowbin"); fs.mkdirSync(bin);
const calls = path.join(T, "calls.log"); fs.writeFileSync(calls, "");
fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho x >> ${calls}\nsleep 1\nexec ${real} "$@"\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const callCount = () => fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length;

/** 요청이 도는 동안 20ms 타이머의 최대 간격(ms). */
async function maxGap(run: () => Promise<unknown>): Promise<number> {
  let last = Date.now(); let max = 0;
  const t = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last); last = now; }, 20);
  await run();
  clearInterval(t);
  return max;
}

{
  let body: any;
  const gap = await maxGap(async () => { body = await (await fetch(`${base}/api/fs/list?path=${encodeURIComponent(repo)}`)).json(); });
  check(body.canCopy === true, "폴더 목록의 canCopy가 true", body.canCopy);
  check(gap < 400, "폴더 목록 중 이벤트 루프가 막히지 않는다", gap);
}
{
  let body: any;
  const gap = await maxGap(async () => { body = await (await fetch(`${base}/api/sessions`)).json(); });
  const row = body.sessions?.find((s: any) => s.id === made.id);
  check(row?.needsApply === true, "세션 목록 행에 needsApply true", row);
  check(gap < 400, "세션 목록 중 이벤트 루프가 막히지 않는다", gap);
}
{
  const before = callCount();
  sessionManager.presenceSnapshot();
  await fetch(`${base}/api/sessions/stats`);
  check(callCount() === before, "접속 스냅숏과 통계는 git을 부르지 않는다", callCount() - before);
}
{
  // 목록 조회(git 1초) 도중 세션을 지우면 지운 행이 응답에 남지 않아야 한다.
  const pending = sessionManager.listWithCopyState();
  await new Promise((r) => setTimeout(r, 200));
  sessionManager.delete(made.id, { purge: true });
  const rows = await pending;
  check(!rows.some((x) => x.id === made.id), "조회 중 지운 세션은 응답에 남지 않는다", rows.find((x) => x.id === made.id));
}
srv.close();
console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
