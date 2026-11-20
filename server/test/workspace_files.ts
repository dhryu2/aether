/**
 * 작업 폴더 파일 목록·읽기 라우트 — 모델 호출 0. 임시 데이터 폴더와 임시 git 저장소만 쓴다.
 * 목록(git / 비git)·경계 거절·비밀 가림·정상 읽기(글자·이진·절단)를 본다.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-wsfiles-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-wsfiles-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("workspace_files");
const express = (await import("express")).default;
const { filesRouter, walkFiles } = await import("../routes/files");
const { config } = await import("../config");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  cond ? pass++ : fail++;
}
function eq(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    check(true, name);
  } catch {
    check(false, name, { actual, expected });
  }
}

const app = express();
app.use("/api/files", filesRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const get = async (url: string) => {
  const r = await fetch(base + url);
  return { status: r.status, json: (await r.json()) as any };
};
const content = (id: string, p: string) => get(`/api/files/${id}/content?path=${encodeURIComponent(p)}`);

function git(args: string[], cwd: string) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}
function seed(cwd: string): string {
  const id = randomUUID();
  fs.mkdirSync(path.join(DATA, id), { recursive: true });
  fs.writeFileSync(path.join(DATA, id, "meta.json"), JSON.stringify({ id, cwd, provider: "claude", resumeKey: "k", name: "파일 시험", createdAt: Date.now() - 1000 }));
  return id;
}
const put = (root: string, rel: string, data: string | Buffer = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

// ── git 저장소 ──
const repo = path.join(ROOT, "repo");
fs.mkdirSync(repo);
git(["init", "-q"], repo);
put(repo, "tracked.ts", "export const a = 1;\n");
put(repo, "src/deep/한글 파일.md", "안녕");
put(repo, ".gitignore", "ignored.log\n");
put(repo, ".env", "SECRET=1");
git(["add", "-A", "-f"], repo);
git(["commit", "-q", "-m", "init"], repo);
put(repo, "untracked.txt");
put(repo, "ignored.log");
put(repo, "bin.dat", Buffer.from([1, 2, 0, 3]));
put(repo, "big.txt", "a".repeat(config.diffMaxBytes + 1000));
put(repo, ".env.local", "S=1");
fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "link-to-env"));
fs.symlinkSync(path.join(ROOT, "missing.txt"), path.join(repo, "dangling"));
put(ROOT, "outside.txt", "밖");
fs.symlinkSync(path.join(ROOT, "outside.txt"), path.join(repo, "link-out"));
fs.mkdirSync(path.join(ROOT, "outdir"));
put(path.join(ROOT, "outdir"), "x.txt", "밖");
fs.symlinkSync(path.join(ROOT, "outdir"), path.join(repo, "ld")); // 중간 폴더가 밖을 가리키는 링크
fs.symlinkSync(path.join(repo, ".git"), path.join(repo, "lg")); // .git을 가리키는 링크
fs.mkdirSync(path.join(repo, "emptydir"));
const sRepo = seed(repo);

sessionManager.restoreFromDisk();
const list = await get(`/api/files/${sRepo}`);
const files: string[] = list.json.files;
eq("목록 응답", [list.status, list.json.truncated], [200, false]);
check(files.includes("tracked.ts") && files.includes("untracked.txt") && files.includes("src/deep/한글 파일.md"), "추적·미추적 파일이 나온다", files);
check(!files.includes("ignored.log"), ".gitignore 대상은 빠진다");
check(!files.some((f) => /(^|\/)\.env/i.test(f)), ".env는 빠진다(추적 중이어도)");
check(!files.some((f) => f.startsWith(".git/")), ".git 내부는 없다");
check(files.indexOf("tracked.ts") < files.indexOf("src/deep/한글 파일.md"), "얕은 경로가 먼저 온다");

// ── 거절·가림 ──
eq("상위 경로 400", (await content(sRepo, "../outside.txt")).status, 400);
eq("밖의 절대 경로 400", (await content(sRepo, path.join(ROOT, "outside.txt"))).status, 400);
eq("밖을 가리키는 링크 400", (await content(sRepo, "link-out")).status, 400);
eq("끊긴 링크 400", (await content(sRepo, "dangling")).status, 400);
eq("폴더 400", (await content(sRepo, "emptydir")).status, 400);
eq("중간 폴더가 밖을 가리키는 링크 400", (await content(sRepo, "ld/x.txt")).status, 400);
eq("NUL이 든 경로 400", (await content(sRepo, "a\0b")).status, 400);
eq("배열로 온 path 400", (await get(`/api/files/${sRepo}/content?path=tracked.ts&path=.env`)).status, 400);
eq("path 없음 400", (await get(`/api/files/${sRepo}/content`)).status, 400);
eq("없는 파일 404", (await content(sRepo, "nope.txt")).status, 404);
eq("잘못된 세션 id 404", (await get("/api/files/not-an-id")).status, 404);
eq("없는 세션 404", (await get(`/api/files/${randomUUID()}`)).status, 404);
for (const p of [".env", ".ENV", ".env/", ".git/config", "lg/config", "link-to-env", ".env.local"]) {
  const r = await content(sRepo, p);
  eq(`비밀은 가린다: ${p}`, [r.status, r.json.redacted, r.json.text], [200, true, undefined]);
}

// ── 정상 읽기 ──
const ok = await content(sRepo, "tracked.ts");
eq("글자 파일 본문", [ok.status, ok.json.text, ok.json.truncated], [200, "export const a = 1;\n", false]);
eq("한글 경로 본문", (await content(sRepo, "src/deep/한글 파일.md")).json.text, "안녕");
eq("NUL 파일은 이진", (await content(sRepo, "bin.dat")).json.binary, true);
const big = (await content(sRepo, "big.txt")).json;
check(big.truncated === true && big.text.length <= config.diffMaxBytes, "상한을 넘으면 앞부분만 온다", { truncated: big.truncated, len: big.text?.length });

// ── git이 아닌 폴더 ──
const plain = path.join(ROOT, "plain");
put(plain, "a.txt");
put(plain, "sub/b.txt");
put(plain, "node_modules/x/index.js");
put(plain, ".hidden/h.txt");
put(plain, ".env");
put(plain, "id.pem");
fs.symlinkSync(path.join(plain, "sub"), path.join(plain, "linkdir"));
const sPlain = seed(plain);
sessionManager.restoreFromDisk();
eq("비git 목록", (await get(`/api/files/${sPlain}`)).json, { files: ["a.txt", "sub/b.txt"], truncated: false });
const w = await walkFiles(plain, 1);
check(w.files.length === 1 && w.truncated, "walkFiles 상한을 넘으면 truncated");

console.log(`\n${fail === 0 ? "✅" : "❌"} workspace_files: ${pass} pass / ${fail} fail`);
server.close();
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
