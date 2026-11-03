/**
 * 폴더 고르기 서버 시험 (프론트 없이). Claude 모델 호출 0(메시지 미전송).
 *   A: 작업 폴더 해소 순수 함수(절대 경로·`~`·`..` 정리·UNC/널/상대 거부·보호 폴더 거부·범위 제한 없음)
 *   B: GET /api/fs/list HTTP 계약(폴더만·정렬·링크·숨김·deny·상태 번호·5000개 상한)
 *   C: 경로 없이/다른 임시 폴더로 세션 생성
 * 임시 홈과 임시 폴더만 쓴다 — 레포/상위 프로젝트 비오염.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8802;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}
function reasonOf(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e) { return (e as { reason?: string }).reason ?? "(원인 없음)"; }
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-fslist-")));
const home = path.join(tmp, "home");
const base = path.join(home, "base"); // 기본 폴더(AETHER_PROJECT_ROOT)
const other = path.join(tmp, "other"); // 기본 폴더 밖(옛 규칙이면 거부되던 곳)

// ───────── A: 순수 함수 ─────────
async function testA() {
  console.log("\n[A] 작업 폴더 해소(순수 함수)");
  for (const d of [path.join(base, "a"), path.join(base, "b"), path.join(home, ".ssh"), path.join(home, "Library", "Caches"), path.join(home, "AppData"), other]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(base, "afile.txt"), "x");
  fs.symlinkSync(path.join(home, ".ssh"), path.join(base, "keys"));
  process.env.HOME = home;
  process.env.AETHER_PROJECT_ROOT = base; // config import 전에 설정
  const { resolveWorkFolder, parseFolderInput, isSensitivePath, samePath } = await import("../sessions/safePath");
  check(resolveWorkFolder(path.join(base, "a")) === path.join(base, "a"), "A 임시 절대 폴더 통과(실제 경로 반환)");
  check(resolveWorkFolder("") === base && resolveWorkFolder(undefined) === base, "A 빈 값 = 기본 폴더");
  check(resolveWorkFolder("~") === home && resolveWorkFolder("~/base") === base, "A `~` = 홈");
  check(resolveWorkFolder(path.join(base, "a", "..", "b")) === path.join(base, "b"), "A a/../b 정리");
  check(parseFolderInput(path.join(base, "x", "..", "y")) === path.join(base, "y"), "A parseFolderInput은 파일시스템을 안 건드린다");
  check(reasonOf(() => resolveWorkFolder("base/a")) === "invalid", "A 상대경로 invalid");
  check(reasonOf(() => resolveWorkFolder("../../..")) === "invalid", "A ../../.. invalid");
  check(reasonOf(() => resolveWorkFolder("a\0b")) === "invalid", "A 널 문자 invalid");
  check(reasonOf(() => resolveWorkFolder("//srv/share")) === "invalid", "A //srv/share invalid");
  check(reasonOf(() => resolveWorkFolder("\\\\srv\\share")) === "invalid", "A \\\\srv\\share invalid");
  check(reasonOf(() => resolveWorkFolder(path.join(tmp, "nope"))) === "not_found", "A 없는 경로 not_found");
  check(reasonOf(() => resolveWorkFolder(path.join(base, "afile.txt"))) === "not_directory", "A 파일 not_directory");
  check(reasonOf(() => resolveWorkFolder(path.join(home, ".ssh"))) === "denied", "A 홈 .ssh denied");
  const caseInsensitive = fs.existsSync(path.join(home, ".SSH")); // 맥 기본 디스크처럼 대소문자를 가리지 않는가
  check(reasonOf(() => resolveWorkFolder(path.join(home, ".SSH"))) === (caseInsensitive ? "denied" : "not_found"), "A 홈 .SSH(대소문자) " + (caseInsensitive ? "denied" : "없는 경로(대소문자 구분 디스크)"));
  check(reasonOf(() => resolveWorkFolder("/\\srv\\share")) === "invalid" && reasonOf(() => resolveWorkFolder("\\/srv/share")) === "invalid", "A `/\\srv`·`\\/srv` 혼합 구분자 UNC invalid");
  check(reasonOf(() => resolveWorkFolder("/" + "a".repeat(5000))) === "invalid", "A 너무 긴 이름은 invalid(500이 아님)");
  check(reasonOf(() => resolveWorkFolder(path.join(base, "keys"))) === "denied", "A 홈 .ssh로 가는 링크 denied");
  check(reasonOf(() => resolveWorkFolder(path.join(home, "Library", "Caches"))) === "denied", "A 홈 Library/Caches denied");
  check(reasonOf(() => resolveWorkFolder(path.join(home, "AppData"))) === "denied", "A 홈 AppData denied");
  check(isSensitivePath(path.join(home, ".SSH")) && !isSensitivePath(path.join(home, "work")) && !isSensitivePath(path.join(other, "Library")), "A 보호 판정(대소문자 무시, 홈 밖 Library는 아님)");
  check(resolveWorkFolder(other) === other, "A 예전 범위 밖 폴더가 이제 통과(바뀐 동작)");
  check(samePath(base, path.join(base, "a", "..")) && !samePath(base, path.join(base, "a")), "A samePath");
  const { resolveWorkFolderAsync } = await import("../sessions/safePath");
  check((await resolveWorkFolderAsync(other)) === other, "A 비동기판도 같은 결과");
  let asyncReason: string | null = null;
  try { await resolveWorkFolderAsync(path.join(home, ".ssh")); } catch (e) { asyncReason = (e as { reason?: string }).reason ?? null; }
  check(asyncReason === "denied", "A 비동기판 보호 폴더 denied");
  // 홈을 다른 표기로 적어 보호 폴더를 피하려는 시도(동기·비동기 둘 다)
  const asyncReasonOf = async (p: string) => { try { await resolveWorkFolderAsync(p); return null; } catch (e) { return (e as { reason?: string }).reason ?? "(원인 없음)"; } };
  const upperSsh = home.toUpperCase() + "/.ssh";
  if (fs.existsSync(upperSsh)) {
    check(reasonOf(() => resolveWorkFolder(upperSsh)) === "denied", "A 홈 접두어를 대문자로 바꿔도 denied(동기)");
    check((await asyncReasonOf(upperSsh)) === "denied", "A 홈 접두어를 대문자로 바꿔도 denied(비동기)");
  } else console.log("  ⏭  대소문자를 구분하는 디스크라 홈 접두어 대문자 시험 건너뜀");
  const dataSsh = "/System/Volumes/Data" + path.join(home, ".ssh");
  if (process.platform === "darwin" && fs.existsSync(dataSsh)) {
    check(reasonOf(() => resolveWorkFolder(dataSsh)) === "denied", "A /System/Volumes/Data 표기로도 denied(동기)");
    check((await asyncReasonOf(dataSsh)) === "denied", "A /System/Volumes/Data 표기로도 denied(비동기)");
    check(reasonOf(() => resolveWorkFolder(path.join("/System/Volumes/Data" + home, "Library", "Caches"))) === "denied", "A /System/Volumes/Data 표기의 Library 하위도 denied");
  } else console.log("  ⏭  맥이 아니거나 /System/Volumes/Data 표기가 없어 건너뜀");
}

// ───────── B/C: HTTP (통제된 임시 루트 + 자식 서버) ─────────
type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(method: string, p: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
async function waitHealthy(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await req("GET", "/api/health")).status === 200) return true; } catch { /* not up */ }
    await delay(300);
  }
  return false;
}
function startServer(extraEnv: Record<string, string>): ChildProcess {
  const base = { ...process.env };
  for (const k of ["AETHER_PROJECT_ROOT", "AETHER_AUTH_MODE", "AETHER_JWT_SECRET", "AETHER_PASSWORD_HASH", "AETHER_ALLOWED_LOGINS"]) delete base[k];
  const child = spawn("npx", ["tsx", "index.ts"], {
    cwd: SERVER_DIR,
    env: { ...base, PORT: String(PORT), AETHER_MODEL: "haiku", ANTHROPIC_API_KEY: "", ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}
async function stopServer(child: ChildProcess) {
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  await delay(600);
}

async function testBC() {
  console.log("\n[B/C] /api/fs/list HTTP 계약 + 세션 생성");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-dataB-"));
  const wide = path.join(tmp, "wide");
  fs.mkdirSync(path.join(base, "alpha", "child"), { recursive: true });
  fs.mkdirSync(path.join(base, "item2"));
  fs.mkdirSync(path.join(base, "item10"));
  fs.mkdirSync(path.join(base, ".hidden"));
  fs.mkdirSync(path.join(base, "node_modules"));
  fs.mkdirSync(path.join(base, ".GIT")); // 대소문자 deny 시험(APFS 비구분, 케이스 보존)
  fs.writeFileSync(path.join(base, ".env"), "SECRET=x");
  fs.symlinkSync(other, path.join(base, "outlink")); // 기본 폴더 밖으로 가는 링크 → 목록에 나온다
  fs.symlinkSync(path.join(base, "nope"), path.join(base, "broken")); // 깨진 링크 → 빠진다
  fs.mkdirSync(wide);
  for (let i = 0; i < 5001; i++) fs.mkdirSync(path.join(wide, `d${i}`));
  const nm = path.join(base, "node_modules");

  const child = startServer({ AETHER_PROJECT_ROOT: base, AETHER_DATA_DIR: dataDir, HOME: home });
  const get = async (p: string) => req("GET", `/api/fs/list?path=${encodeURIComponent(p)}`);
  try {
    check(await waitHealthy(), "B 임시 서버 기동");

    const res = await get(base);
    const list = JSON.parse(res.body);
    const names: string[] = list.entries.map((e: any) => e.name);
    check(res.status === 200 && ["alpha", "item2", "item10", "outlink"].every((n) => names.includes(n)), "B 폴더 목록", names.join(","));
    check(!["node_modules", ".env", ".hidden", ".GIT", "afile.txt", "broken", "keys"].some((n) => names.includes(n)), "B 파일·보호 이름·숨김·깨진 링크·.ssh 링크 제외");
    check(names.indexOf("item2") < names.indexOf("item10"), "B 숫자순 정렬(item2가 item10보다 앞)");
    check(list.path === base && list.name === "base" && list.parent === home, "B path는 실제 위치, name·parent");
    check(list.crumbs[list.crumbs.length - 1].path === base && list.crumbs[0].path === path.parse(base).root, "B crumbs 끝=지금 폴더, 처음=루트");
    check(list.entries.every((e: any) => path.isAbsolute(e.path) && typeof e.hidden === "boolean"), "B 각 항목 path 절대경로·hidden");
    check(list.entries.find((e: any) => e.name === "outlink")?.path === path.join(base, "outlink"), "B 범위 밖 링크 항목 path = 링크 자리");
    check(typeof list.canCopy === "boolean" && list.truncated === false, "B canCopy·truncated");

    const sub = JSON.parse((await get(path.join(base, "alpha"))).body);
    check(sub.entries.some((e: any) => e.name === "child" && e.path === path.join(base, "alpha", "child")), "B 하위 진입");

    const hidden = JSON.parse((await req("GET", `/api/fs/list?path=${encodeURIComponent(base)}&showHidden=1`)).body);
    const hnames: string[] = hidden.entries.map((e: any) => e.name);
    check(hnames.includes(".hidden") && hidden.entries.find((e: any) => e.name === ".hidden").hidden === true && !hnames.includes("node_modules") && !hnames.includes(".GIT") && !hnames.includes(".env"), "B showHidden=1 → .hidden 나옴, deny는 여전히 빠짐");

    check((await get(nm)).status === 403, "B node_modules 안 403");
    check((await get(path.join(base, ".GIT"))).status === 403, "B .GIT 진입 403(대소문자)");
    check((await get(path.join(tmp, "nope"))).status === 404, "B 없는 경로 404");
    check((await get(path.join(base, "item2", "..", "afile"))).status === 404, "B 없는 파일 이름 404");
    fs.writeFileSync(path.join(base, "afile.txt"), "x");
    check((await get(path.join(base, "afile.txt"))).status === 400, "B 파일 400");
    check((await get("base/alpha")).status === 400, "B 상대경로 400");
    check((await get(path.join(home, ".ssh"))).status === 403, "B 홈 .ssh 403");
    check((await get(path.join(base, "keys"))).status === 403, "B 홈 .ssh로 가는 링크 403");
    const dataHome = "/System/Volumes/Data" + home;
    if (process.platform === "darwin" && fs.existsSync(dataHome)) {
      const viaData = JSON.parse((await req("GET", `/api/fs/list?path=${encodeURIComponent(dataHome)}&showHidden=1`)).body);
      const dn: string[] = (viaData.entries ?? []).map((e: any) => e.name);
      check(dn.includes("base") && !dn.includes(".ssh") && !dn.includes("Library"), "B 다른 표기의 홈을 열어도 .ssh·Library는 목록에서 빠진다", dn.join(","));
    }
    const noPath = JSON.parse((await req("GET", "/api/fs/list")).body);
    check(noPath.path === base, "B path 없으면 기본 폴더");
    const tilde = JSON.parse((await get("~")).body);
    check(tilde.path === home, "B `~` = 홈");

    const big = JSON.parse((await get(wide)).body);
    check(big.entries.length === 5000 && big.truncated === true, "B 폴더 5001개 → 5000개 + truncated", `${big.entries.length}`);

    const places = await req("GET", "/api/fs/places");
    const pj = JSON.parse(places.body);
    check(places.status === 200 && pj.home === home && pj.favorites[0].kind === "home" && Array.isArray(pj.devices), "B /api/fs/places 계약");

  } finally {
    await stopServer(child);
  }

  // C: 경로 없이 / 기본 폴더 밖 임시 폴더로 세션 생성(메시지 미전송 → 모델 호출 0).
  //   로그인 상태를 읽어야 하므로 HOME은 바꾸지 않은 별도 서버로 돈다.
  const childC = startServer({ AETHER_PROJECT_ROOT: base, AETHER_DATA_DIR: dataDir });
  try {
    check(await waitHealthy(), "C 임시 서버 기동");
    const post = async (body: object) => req("POST", "/api/sessions", { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const first = await post({ provider: "claude", model: "haiku" });
    if (first.status === 409) {
      // 이 환경에서 Claude 로그인 확인이 안 되면 세션 생성 자체가 막힌다. cwd 규칙은 cwd_check.ts가 mock provider로 따로 본다.
      console.log("  ⏭  Claude 로그인이 확인되지 않는 환경이라 C 세션 생성 확인을 건너뜀");
    } else {
      const noCwd = JSON.parse(first.body);
      check(noCwd.cwd === base, "C 경로 없이 생성 = 기본 폴더", noCwd.cwd);
      const outside = JSON.parse((await post({ provider: "claude", model: "haiku", cwd: other })).body);
      check(outside.cwd === other, "C 기본 폴더 밖 임시 폴더로 생성 가능", outside.cwd);
      const sessions = JSON.parse((await req("GET", "/api/sessions")).body).sessions;
      const s = sessions.find((x: any) => x.id === outside.id);
      check(!!s && typeof s.displayName === "string" && typeof s.createdAt === "number", "C 세션 list에 displayName+createdAt");
    }
  } finally {
    await stopServer(childC);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await testA();
  await testBC();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + "─".repeat(56));
  console.log(`폴더 고르기: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
