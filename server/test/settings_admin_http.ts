/** 설정 점검 탭 서버 API 시험(password 모드 실서버): 정보·로그·비밀번호 변경. 임시 데이터 폴더, 라이브와 다른 포트. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8847;
const SECRET = "test-only-mock-secret-do-not-use-in-prod-xxxxxxxx"; // 테스트 픽스처
const ENV_PW = "envpw-12345";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(method: string, p: string, opts: { cookie?: string; json?: unknown; raw?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.json !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    if (opts.json !== undefined) r.write(JSON.stringify(opts.json));
    if (opts.raw !== undefined) r.write(opts.raw);
    r.end();
  });
}
const login = (password: string) => req("POST", "/api/auth/login", { json: { password } });
const cookieOf = (r: Res) => (r.headers["set-cookie"]?.[0] ?? "").split(";")[0];

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-admin-"));
const envHash = bcrypt.hashSync(ENV_PW, 4);
const base = { ...process.env } as Record<string, string | undefined>;
for (const k of ["AETHER_AUTH_MODE", "AETHER_JWT_SECRET", "AETHER_PASSWORD_HASH", "AETHER_ALLOWED_LOGINS"]) delete base[k];
const child: ChildProcess = spawn("npx", ["tsx", "index.ts"], {
  cwd: SERVER_DIR,
  env: {
    ...base, PORT: String(PORT), AETHER_DATA_DIR: dataDir, AETHER_MODEL: "haiku", ANTHROPIC_API_KEY: "", AETHER_BCRYPT_COST: "4",
    AETHER_AUTH_MODE: "password", AETHER_JWT_SECRET: SECRET, AETHER_PASSWORD_HASH: envHash,
  },
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
const stop = async () => { try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } await delay(500); };

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await req("GET", "/api/health")).status === 200; } catch { await delay(300); }
  }
  check(up, "password 모드 서버 부팅");

  // 정보
  check((await req("GET", "/api/system/info")).status === 401, "정보: 인증 없이 401");
  const first = await login(ENV_PW);
  const cookie = cookieOf(first);
  check(first.status === 200 && !!cookie, "env 비밀번호로 로그인");
  const info = await req("GET", "/api/system/info", { cookie });
  const infoBody = JSON.parse(info.body);
  check(info.status === 200 && Object.keys(infoBody).sort().join(",") === "authMode,dataDir,port,projectRoot,termsUrl,version", "정보: 키가 정확히 여섯 개", Object.keys(infoBody).join(","));
  check(!info.body.includes(envHash) && !info.body.includes(SECRET), "정보: 본문에 해시·JWT 비밀 없음");
  check(infoBody.authMode === "password" && infoBody.port === PORT && infoBody.dataDir === dataDir, "정보: 값이 실제 설정과 같다");

  // 로그
  check((await req("GET", "/api/system/logs")).status === 401, "로그: 인증 없이 401");
  await delay(300);
  const logs = await req("GET", "/api/system/logs?lines=1000", { cookie });
  const entries = JSON.parse(logs.body).entries as { level: string; msg: string }[];
  check(logs.status === 200 && entries.length > 0, "로그: 부팅 로그가 파일에 남아 있다", String(entries.length));
  const warns = JSON.parse((await req("GET", "/api/system/logs?level=warn", { cookie })).body).entries as { level: string }[];
  check(warns.every((e) => e.level !== "log"), "로그: 수준 거르기");
  check((await req("GET", "/api/system/logs?lines=abc", { cookie })).status === 400, "로그: lines가 숫자 아니면 400");
  check((await req("GET", "/api/system/logs?lines=1.5", { cookie })).status === 400, "로그: lines가 정수 아니면 400");
  check((await req("GET", "/api/system/logs?level=debug", { cookie })).status === 400, "로그: 모르는 level은 400");
  check(JSON.parse((await req("GET", "/api/system/logs?lines=0", { cookie })).body).entries.length === 1, "로그: lines=0은 1로 자른다");

  // 비밀번호 변경
  const NEW_PW = "새 비밀번호 12345";
  check((await req("POST", "/api/auth/password", { json: { current: ENV_PW, next: NEW_PW } })).status === 401, "비밀번호: 인증 없이 401");
  check((await req("POST", "/api/auth/password", { cookie, json: { current: "틀림틀림틀림", next: NEW_PW } })).status === 403, "비밀번호: 현재 틀리면 403");
  check((await req("POST", "/api/auth/password", { cookie, json: { current: ENV_PW, next: "1234567" } })).status === 400, "비밀번호: 7자는 400");
  check((await req("POST", "/api/auth/password", { cookie, json: { current: ENV_PW, next: "가".repeat(25) } })).status === 400, "비밀번호: 72바이트 초과는 400");
  check(!fs.existsSync(path.join(dataDir, "auth-password.json")), "실패한 요청은 파일을 만들지 않는다");

  const changed = await req("POST", "/api/auth/password", { cookie, json: { current: ENV_PW, next: NEW_PW } });
  const newCookie = cookieOf(changed);
  check(changed.status === 200 && !!newCookie && newCookie !== cookie && typeof JSON.parse(changed.body).token === "string", "비밀번호: 성공 시 새 쿠키");
  check((await req("GET", "/api/system/info", { cookie })).status === 401, "비밀번호: 옛 토큰은 401");
  check((await req("GET", "/api/system/info", { cookie: newCookie })).status === 200, "비밀번호: 새 토큰은 200");
  const file = path.join(dataDir, "auth-password.json");
  check((fs.statSync(file).mode & 0o777) === 0o600, "비밀번호: 저장 파일 권한 0600");
  check(!fs.readFileSync(file, "utf8").includes(NEW_PW), "비밀번호: 파일에 평문 없음");
  check((await login(ENV_PW)).status === 401 && (await login(NEW_PW)).status === 200, "비밀번호: 새 비밀번호만 로그인된다");

  const logText = fs.readFileSync(path.join(dataDir, "logs", "server.jsonl"), "utf8");
  check(!logText.includes(NEW_PW) && !logText.includes(JSON.parse(fs.readFileSync(file, "utf8")).hash), "비밀번호: 서버 로그에 새 비밀번호·해시가 없다");

  // 파서가 거절한 본문(깨진 JSON)의 내용은 서버 로그에 남지 않는다
  const brokenBody = await req("POST", "/api/auth/login", { raw: '{"password":"예시표식-12345' });
  await delay(300);
  check(brokenBody.status === 400 && !fs.readFileSync(path.join(dataDir, "logs", "server.jsonl"), "utf8").includes("예시표식"), "깨진 JSON 본문은 400이고 로그에 본문이 남지 않는다");

  // 파일을 지우면 env 비밀번호로 돌아가지만, 옛 토큰은 되살아나지 않는다(세대 값이 이미 바뀌었다)
  fs.rmSync(file);
  check((await login(ENV_PW)).status === 200, "비밀번호: 파일 삭제 시 env 비밀번호로 로그인");
  check((await req("GET", "/api/system/info", { cookie })).status === 401 && (await req("GET", "/api/system/info", { cookie: newCookie })).status === 401, "비밀번호: 파일을 지워도 옛 토큰은 401(되살아나지 않는다)");

  // 다른 프로세스(재설정 도구와 같은 방식)가 비밀번호를 바꾸면 열린 스트림이 다음 심장박동(15초)에 닫힌다
  const streamCookie = cookieOf(await login(ENV_PW));
  const streamEnded = new Promise<boolean>((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/notify/stream", headers: { Cookie: streamCookie } }, (res) => {
      res.resume();
      res.on("close", () => resolve(true));
    });
    r.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 18000);
  });
  await delay(300);
  const { savePasswordHash } = await import("../auth/passwordHash");
  const OTHER_PW = "다른 프로세스 12345";
  savePasswordHash(bcrypt.hashSync(OTHER_PW, 4), dataDir);
  check(await streamEnded, "다른 프로세스가 비밀번호를 바꾸면 열린 스트림이 18초 안에 닫힌다");
  check((await req("GET", "/api/system/info", { cookie: streamCookie })).status === 401, "그때 옛 쿠키는 401");
  check((await login(OTHER_PW)).status === 200, "새 비밀번호로 로그인된다");
} finally {
  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
