/**
 * Phase 3 인증 mock 테스트 (프론트·실폰·serve·whois CLI 0회). Claude 호출 0(게이트는 세션 전에 동작).
 *   [단위] tailscale 전략(resolver mock)·clientAddr 대역·게이트 401/통과·JWT 만료/변조·로그인 시도 제한
 *   [스모크] off 무마찰 · password 로그인→쿠키→보호라우트→SSE쿠키→로그아웃→연속 실패 잠김 · 시크릿 fail-fast
 * 주의: 테스트 픽스처 시크릿은 실 시크릿 아님. config 전에 env를 세팅하려 auth 모듈은 동적 import.
 */
process.env.AETHER_ALLOWED_LOGINS = "user@example.com";
process.env.AETHER_JWT_SECRET = "test-only-mock-secret-do-not-use-in-prod-xxxxxxxx"; // 테스트 픽스처

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import zlib from "node:zlib";
import { inspect } from "node:util";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8801;
const cookieOf = (r: { headers: http.IncomingHttpHeaders }) => (r.headers["set-cookie"]?.[0] ?? "").split(";")[0];
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

// ───────────────────────── 단위 테스트 ─────────────────────────
async function unitTests() {
  console.log("\n[단위] tailscale 전략 · clientAddr · 게이트 · JWT");
  const { createTailscaleStrategy, createPasswordStrategy, createAuthMiddleware } = await import("../middleware/auth");
  const { signSession, verifySession } = await import("../auth/jwt");

  const tsReq = (ip: string, port = 1234) => ({ socket: { remoteAddress: ip, remotePort: port } }) as any;

  // B1 허용(화이트리스트 일치)
  const allow = createTailscaleStrategy({ resolver: async () => ({ login: "user@example.com" }) });
  check((await allow.authenticate(tsReq("100.67.9.98")))?.via === "tailscale", "B1 tailscale 허용(화이트리스트 일치)");

  // B2 거부(화이트리스트 밖)
  const other = createTailscaleStrategy({ resolver: async () => ({ login: "other@example.com" }) });
  check((await other.authenticate(tsReq("100.67.9.98"))) === null, "B2 tailscale 거부(화이트리스트 밖)");

  // B3 거부(resolver null)
  const nullRes = createTailscaleStrategy({ resolver: async () => null });
  check((await nullRes.authenticate(tsReq("100.67.9.98"))) === null, "B3 tailscale 거부(resolver null)");

  // B4 거부(resolver throw → catch → null)
  const throwRes = createTailscaleStrategy({ resolver: async () => { throw new Error("timeout"); } });
  check((await throwRes.authenticate(tsReq("100.67.9.98"))) === null, "B4 tailscale 거부(resolver throw)");

  // B5 대역 검증: 비-Tailscale IP는 resolver 호출 전에 거부
  let resolverCalled = false;
  const bandGuard = createTailscaleStrategy({ resolver: async () => { resolverCalled = true; return { login: "user@example.com" }; } });
  const nonTs = await bandGuard.authenticate(tsReq("203.0.113.5"));
  check(nonTs === null && !resolverCalled, "B5 비-Tailscale 대역(203.0.113.5) 거부 + resolver 미호출");
  // ::ffff: 정규화 후에도 Tailscale 대역이면 통과
  check((await allow.authenticate(tsReq("::ffff:100.67.9.98")))?.via === "tailscale", "B5 ::ffff: 정규화 후 통과");
  // 리뷰 #3/#4: IPv6 대역 강화
  check((await allow.authenticate(tsReq("fd7a:115c:a1e0::1")))?.via === "tailscale", "B5 Tailscale IPv6(fd7a:115c:a1e0::/48) 통과");
  let r2 = false;
  const bandV6 = createTailscaleStrategy({ resolver: async () => { r2 = true; return { login: "user@example.com" }; } });
  check((await bandV6.authenticate(tsReq("fd7a:dead:beef::1"))) === null && !r2, "B5 타 ULA(fd7a:dead:..) 거부 + resolver 미호출");
  check((await allow.authenticate(tsReq("::ffff:fd7a:1"))) === null, "B5 ::ffff:fd7a 위장 IPv6 거부");
  check((await allow.authenticate(tsReq("100.64.0.1%eth0"))) === null, "B5 zone-id(%eth0) 비정규 주소 거부");

  // 게이트: 거부 → 401 JSON, 통과 → next + req.auth
  const runGate = (strategy: any, req: any) =>
    new Promise<{ status: number; nexted: boolean; auth: any }>((resolve) => {
      const res: any = {
        _c: 0,
        status(c: number) { this._c = c; return this; },
        json() { resolve({ status: this._c, nexted: false, auth: undefined }); return this; },
      };
      createAuthMiddleware(strategy)(req, res, () => resolve({ status: 200, nexted: true, auth: req.auth }));
    });
  const denied = await runGate(nullRes, tsReq("100.67.9.98"));
  check(denied.status === 401 && !denied.nexted, "게이트 거부 → 401 JSON(next 안 함)");
  const okGate = await runGate(allow, tsReq("100.67.9.98"));
  check(okGate.nexted && okGate.auth?.login === "user@example.com", "게이트 통과 → next + req.auth 주입");

  // password 전략 단위(verify DI)
  const pwOk = createPasswordStrategy({ verify: async () => true });
  check((await pwOk.authenticate({ cookies: { aether_session: "t" } } as any))?.via === "password", "password 전략: 유효쿠키 통과");
  check((await pwOk.authenticate({ cookies: {} } as any)) === null, "password 전략: 쿠키 없으면 거부");

  // Bearer: 쿠키 없음 + 유효/잘못된 헤더, 쿠키 우선(잘못된 Bearer 무시)
  const pwBearer = createPasswordStrategy({
    verify: async (t) => t === "good",
  });
  check(
    (await pwBearer.authenticate({ cookies: {}, headers: { authorization: "Bearer good" } } as any))?.via === "password",
    "password 전략: 쿠키 없음 + 유효 Bearer → 통과",
  );
  check(
    (await pwBearer.authenticate({ cookies: {}, headers: { authorization: "Bearer bad" } } as any)) === null,
    "password 전략: 쿠키 없음 + 잘못된 Bearer → null",
  );
  check(
    (await pwBearer.authenticate({
      cookies: { aether_session: "good" },
      headers: { authorization: "Bearer bad" },
    } as any))?.via === "password",
    "password 전략: 유효 쿠키 + 잘못된 Bearer → 쿠키로 통과",
  );

  // C7 JWT 만료(과거 exp) · C8 변조
  const expired = await signSession(Math.floor(Date.now() / 1000) - 10); // 이미 만료
  check((await verifySession(expired)) === false, "C7 JWT 만료 토큰 거부");
  const good = await signSession("30d");
  check((await verifySession(good)) === true, "C7 정상 토큰 통과(대조군)");
  const tampered = good.slice(0, -3) + (good.endsWith("a") ? "bbb" : "aaa");
  check((await verifySession(tampered)) === false, "C8 JWT 변조 토큰 거부");

  // E 로그인 시도 제한(시계 주입)
  const { createLoginLimiter } = await import("../auth/loginLimiter");
  let clock = 0;
  const lim = createLoginLimiter({ maxFailures: 3, lockMs: 60_000, now: () => clock });
  check(lim.acquire() === 0 && lim.acquire() === 1, "E1 검사 중엔 두 번째 시도 거부(병렬 대조 차단)");
  lim.release(false);
  check(lim.acquire() === 0, "E1 끝나면 다시 시도 가능");
  lim.release(false);
  lim.acquire();
  lim.release(true); // 성공 → 실패 수 초기화
  for (let i = 0; i < 2; i++) { lim.acquire(); lim.release(false); }
  check(lim.acquire() === 0, "E2 성공이 실패 수를 0으로 되돌림(2번 틀려도 안 잠김)");
  lim.release(false); // 3번째 연속 실패 → 잠김
  check(lim.acquire() === 60, "E3 연속 실패 한도 → 잠김, 남은 초 반환");
  clock = 59_500;
  check(lim.acquire() === 1, "E3 잠김 남은 0.5초는 1초로 올림");
  clock = 60_000;
  check(lim.acquire() === 0, "E4 잠김 시간이 지나면 풀림");
  lim.release(false);

  // E6 피어별 잠금: 한 기기가 잠겨도 다른 기기는 통과하고, 전체 상한에 닿으면 모두 거절
  {
    let t = 0;
    const l = createLoginLimiter({ maxFailures: 2, lockMs: 60_000, globalMaxFailures: 5, now: () => t });
    for (let i = 0; i < 2; i++) { l.acquire("100.64.0.9"); l.release(false); }
    check(l.acquire("100.64.0.9") === 60, "E6 피어 A는 연속 실패로 잠김");
    check(l.acquire("100.64.0.10") === 0, "E6 피어 B는 통과(다른 기기의 실패에 막히지 않음)");
    l.release(false); // 전체 실패 3번째
    for (let i = 0; i < 2; i++) { l.acquire("100.64.0.11"); l.release(false); } // 전체 실패 5번째
    check(l.acquire("100.64.0.13") === 60, "E6 전체 상한 도달 뒤엔 새 피어도 거절");
  }

  // E7 전체 실패는 15분 창으로 센다: 한 기기가 잠금이 풀릴 때마다 5번씩 틀려도 전체가 잠기지 않는다
  {
    let t = 0;
    const l = createLoginLimiter({ maxFailures: 5, lockMs: 60_000, now: () => t });
    for (let cycle = 0; cycle < 6; cycle++) {
      if (cycle) t += 60_001;
      for (let i = 0; i < 5; i++) { l.acquire("100.64.0.9"); l.release(false); }
    }
    check(l.acquire("100.64.0.10") === 0, "E7 창 밖의 실패는 전체 상한에 쌓이지 않는다");
    l.release(true);
  }

  // W limitWhois: 같은 ip 합치기·결과 기억·동시 조회 상한
  {
    const { limitWhois } = await import("../auth/tailscale");
    let calls = 0, live = 0, peak = 0, t = 0;
    const slow = limitWhois(async () => { calls++; live++; peak = Math.max(peak, live); await delay(20); live--; return null; }, { now: () => t });
    await Promise.all(Array.from({ length: 20 }, (_, i) => slow("100.64.0.1", 1000 + i)));
    check(calls === 1, "W1 같은 ip 동시 20개 → 조회 1번", `calls=${calls}`);
    await slow("100.64.0.1", 1);
    check(calls === 1, "W2 기억 시간 안의 재호출(실패 결과 포함)은 조회 0번", `calls=${calls}`);
    t = 6000;
    await slow("100.64.0.1", 1);
    check(calls === 2, "W2 시간이 지나면 한 번 더 조회", `calls=${calls}`);
    calls = 0; peak = 0;
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => slow(`100.64.1.${i}`, 1)));
    check(peak <= 8 && calls === 8 && many.every((m) => m === null), "W3 서로 다른 ip 20개 → 동시 조회 8개 이하, 넘은 호출은 null", `peak=${peak} calls=${calls}`);
  }

  // H 오류 핸들러는 파서 거절 시 로그를 남기지 않고, 그 밖에는 오류 속성(요청 본문 등)을 찍지 않는다
  {
    const { errorHandler } = await import("../middleware/hardening");
    const run = (err: unknown) => {
      const seen: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => { seen.push(a.map((x) => inspect(x)).join(" ")); };
      const res: any = { headersSent: false, locals: {}, setHeader() {}, status() { return this; }, json() { return this; } };
      try { errorHandler(err, {} as any, res, () => {}); } finally { console.error = orig; }
      return seen.join("\n");
    };
    const parserErr = Object.assign(new SyntaxError("bad json"), { type: "entity.parse.failed", status: 400, body: "예시표식-본문" });
    check(!run(parserErr).includes("예시표식"), "H1 파서 거절은 요청 본문을 로그에 남기지 않는다");
    const other = run(Object.assign(new Error("boom"), { body: "예시표식-본문" }));
    check(other.includes("boom") && !other.includes("예시표식"), "H1 일반 오류는 메시지만 찍고 오류 속성은 찍지 않는다");
  }
}

// ───────────────────────── 스모크(child process) ─────────────────────────
type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(method: string, p: string, opts: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
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

const TEST_DATA_DIR = process.env.AETHER_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "aether-auth-"));

function startServer(extraEnv: Record<string, string>): { child: ChildProcess; logs: () => string } {
  const base = { ...process.env };
  // 테스트 프로세스의 AETHER 시크릿/모드가 자식에 새지 않게 제거 → extraEnv만 명시 적용
  for (const k of ["AETHER_AUTH_MODE", "AETHER_JWT_SECRET", "AETHER_PASSWORD_HASH", "AETHER_ALLOWED_LOGINS"]) delete base[k];
  let logs = "";
  const child = spawn("npx", ["tsx", "index.ts"], {
    cwd: SERVER_DIR,
    // 운영 데이터 폴더를 쓰면 부팅 복원이 실제 세션 일기에 끼어든다. 단독 실행에서도 임시 폴더를 쓴다.
    env: { ...base, PORT: String(PORT), AETHER_MODEL: "haiku", ANTHROPIC_API_KEY: "", AETHER_DATA_DIR: TEST_DATA_DIR, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (logs += d));
  child.stderr?.on("data", (d) => (logs += d));
  return { child, logs: () => logs };
}
async function stopServer(child: ChildProcess) {
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  await delay(500);
}

async function smokeTests() {
  const TEST_HASH = bcrypt.hashSync("testpw123", 4); // 저cost 테스트 픽스처
  const SECRET = "test-only-mock-secret-do-not-use-in-prod-xxxxxxxx";

  // ── off 모드 ──
  console.log("\n[스모크] off 모드(무마찰)");
  {
    const { child } = startServer({}); // AETHER_AUTH_MODE 미설정 = off
    await waitHealthy();
    check((await req("GET", "/api/sessions")).status === 200, "A1 off: GET /api/sessions 200(인증 없이)");
    const healthOff = await req("GET", "/api/health");
    check(healthOff.status === 200, "A3 off: health 200");
    let authOff: unknown;
    try { authOff = JSON.parse(healthOff.body)?.auth; } catch { authOff = undefined; }
    check(authOff === "off", "A3 off: health.auth===off");
    check((await req("POST", "/api/auth/password", { headers: { "content-type": "application/json" }, body: JSON.stringify({ current: "a", next: "bbbbbbbb" }) })).status === 404, "off: POST /api/auth/password 404");
    check((await req("POST", "/api/auth/logout", { headers: { Cookie: "aether_session=stale-example" } })).status === 200, "off: 묵은 쿠키로 로그아웃해도 200");
    await stopServer(child);
  }

  // ── password 모드 ──
  console.log("\n[스모크] password 모드");
  {
    const { child } = startServer({ AETHER_AUTH_MODE: "password", AETHER_JWT_SECRET: SECRET, AETHER_PASSWORD_HASH: TEST_HASH });
    const up = await waitHealthy();
    check(up, "password: 부팅 성공(시크릿 충족)");
    check((await req("GET", "/api/sessions")).status === 401, "C4 쿠키 없이 보호라우트 → 401");
    const healthPw = await req("GET", "/api/health");
    check(healthPw.status === 200, "health는 게이트 우회 공개");
    let authPw: unknown;
    try { authPw = JSON.parse(healthPw.body)?.auth; } catch { authPw = undefined; }
    check(authPw === "password", "password: health.auth===password");

    const wrong = await req("POST", "/api/auth/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
    check(wrong.status === 401 && !wrong.headers["set-cookie"], "C2 틀린 비번 → 401(Set-Cookie 없음)");
    let wrongBody: any = {};
    try { wrongBody = JSON.parse(wrong.body); } catch { /* */ }
    check(wrongBody.token === undefined, "로그인 실패 401 body에 token 없음");

    const login = await req("POST", "/api/auth/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
    const setCookie = login.headers["set-cookie"]?.[0] ?? "";
    check(login.status === 200 && /aether_session=/.test(setCookie) && /HttpOnly/i.test(setCookie), "C1 로그인 성공 → httpOnly 쿠키 발급");
    const cookie = setCookie.split(";")[0];
    let loginBody: any = {};
    try { loginBody = JSON.parse(login.body); } catch { /* */ }
    check(typeof loginBody.token === "string" && loginBody.token.length > 0, "로그인 200 body에 token 문자열");
    const bearerToken = loginBody.token as string;

    check((await req("GET", "/api/sessions", { headers: { Cookie: cookie } })).status === 200, "C3 쿠키로 보호라우트 → 200");
    // C5 SSE도 동일 게이트(쿠키 없으면 401, 있으면 게이트 통과 → 세션 없어 404)
    check((await req("GET", "/api/sessions/dummy/stream?since=0")).status === 401, "C5 SSE 쿠키 없이 → 401");
    const sseOk = await req("GET", "/api/sessions/dummy/stream?since=0", { headers: { Cookie: cookie } });
    check(sseOk.status === 404, "C5 SSE 쿠키 있으면 게이트 통과(세션없어 404)", `status=${sseOk.status}`);

    // P 인증 전에는 본문을 풀거나 파싱하지 않는다(깨진 본문은 파싱했다면 400이 된다)
    {
      const J = { "content-type": "application/json" };
      const broken = Buffer.from('{"a":');
      const msg = "/api/sessions/nope/message";
      check((await req("POST", msg, { headers: J, body: broken })).status === 401, "P1 쿠키 없음 + 깨진 JSON → 401");
      check((await req("POST", msg, { headers: { ...J, "content-encoding": "gzip" }, body: zlib.gzipSync(broken) })).status === 401, "P2 쿠키 없음 + 깨진 JSON의 gzip → 401");
      check((await req("POST", msg, { headers: { ...J, "content-encoding": "gzip", Cookie: cookie }, body: zlib.gzipSync(Buffer.from("{}")) })).status === 415, "P3 쿠키 + gzip 본문 → 415");
      const big = (n: number) => Buffer.from(JSON.stringify({ x: "a".repeat(n) }));
      check((await req("POST", msg, { headers: { ...J, Cookie: cookie }, body: big(1_000_000) })).status !== 413, "P4 쿠키 + 1MB 메시지 본문은 큰 한도로 파싱(413 아님)");
      check((await req("POST", "/api/sessions", { headers: { ...J, Cookie: cookie }, body: big(300_000) })).status === 413, "P5 쿠키 + 300KB 다른 POST → 413(전역 한도 유지)");
    }

    // Bearer 스모크(쿠키 헤더 없이). 목록이 워크스페이스 이유로 503이어도 게이트(비-401)면 통과.
    {
      const br = await req("GET", "/api/sessions", { headers: { Authorization: `Bearer ${bearerToken}` } });
      check(br.status !== 401 && (br.status === 200 || br.status === 503), "Bearer로 GET /api/sessions 게이트 통과", `status=${br.status}`);
    }
    const sseBearer = await req("GET", "/api/sessions/dummy/stream?since=0", {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    check(sseBearer.status === 404, "Bearer로 SSE 게이트 통과(세션없어 404)", `status=${sseBearer.status}`);
    check((await req("GET", "/api/sessions")).status === 401, "쿠키·Bearer 없이 401");

    // C6 로그아웃 → 쿠키 만료
    const logout = await req("POST", "/api/auth/logout", { headers: { Cookie: cookie } });
    const clearCookie = logout.headers["set-cookie"]?.[0] ?? "";
    check(logout.status === 200 && /aether_session=;|Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(clearCookie), "C6 로그아웃 → 쿠키 clear", clearCookie.slice(0, 40));
    check((await req("GET", "/api/sessions", { headers: { Cookie: cookie } })).status === 401, "R1 로그아웃한 토큰은 쿠키로 다시 쓸 수 없다(401)");
    check((await req("GET", "/api/sessions", { headers: { Authorization: `Bearer ${bearerToken}` } })).status === 401, "R1 같은 토큰을 Bearer로 써도 401");

    // L 로그인 잠금: JSON 아닌 요청은 실패 횟수에 들지 않고, 기기별로 따로 센다
    const loginWith = (pw: string, extra: Record<string, string> = {}) =>
      req("POST", "/api/auth/login", { headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ password: pw }) });
    {
      const plain: number[] = [];
      for (let i = 0; i < 6; i++) plain.push((await req("POST", "/api/auth/login", { headers: { "content-type": "text/plain" }, body: "x" })).status);
      check(plain.every((s) => s === 400), "L1 비밀번호 없는 요청 6번은 모두 400", plain.join(","));
      check((await loginWith("testpw123")).status === 200, "L1 그 뒤에도 올바른 로그인은 200");
      const xff = { "x-forwarded-for": "100.64.0.9" };
      for (let i = 0; i < 5; i++) await loginWith("nope", xff);
      check((await loginWith("testpw123", xff)).status === 429, "L2 같은 기기는 5번 틀리면 잠김");
      check((await loginWith("testpw123", { "x-forwarded-for": "100.64.0.10" })).status === 200, "L2 다른 기기는 로그인된다");
    }
    const cookie2 = cookieOf(await loginWith("testpw123")); // E5 잠금 전에 받아 둔 쿠키(비밀번호 변경 경로 시험용)

    // E5 연속 5번 틀리면 잠김 — 맞는 비번도 429(위 로그인 성공으로 실패 수는 0에서 시작)
    const fives: number[] = [];
    for (let i = 0; i < 5; i++) fives.push((await loginWith("nope")).status);
    check(fives.every((s) => s === 401), "E5 1~5번째 틀린 비번은 401", fives.join(","));
    const locked = await loginWith("testpw123");
    check(
      locked.status === 429 && Number(locked.headers["retry-after"]) > 0 && !locked.headers["set-cookie"],
      "E5 잠긴 뒤엔 맞는 비번도 429 + Retry-After(쿠키 없음)",
      `status=${locked.status} retry=${locked.headers["retry-after"]}`,
    );
    check((await req("POST", "/api/auth/login", { headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: zlib.gzipSync(Buffer.from('{"password":"x"}')) })).status === 415, "P6 로그인 + gzip 본문 → 415");
    const pwChange = await req("POST", "/api/auth/password", { headers: { "content-type": "application/json", Cookie: cookie2 }, body: JSON.stringify({ current: "nope-nope", next: "newpass-1234" }) });
    check(pwChange.status === 403, "L3 로그인이 잠겨도 비밀번호 변경 경로는 따로 센다(틀린 현재 비밀번호 → 403)", `status=${pwChange.status}`);
    await stopServer(child);
  }

  // ── D1 시크릿 fail-fast ──
  console.log("\n[스모크] D 시크릿/모드 fail-fast(보안)");
  {
    const { child, logs } = startServer({ AETHER_AUTH_MODE: "password", AETHER_PASSWORD_HASH: TEST_HASH }); // JWT_SECRET 누락
    const up = await waitHealthy(5000);
    check(!up && /AETHER_JWT_SECRET 미설정|AETHER_JWT_SECRET\(\.env\)/.test(logs()), "D1 JWT_SECRET 없으면 부팅 실패", up ? "떴음(실패)" : "안 뜸");
    await stopServer(child);
  }
  // D2 authMode 오타 → fail-closed(리뷰 #1/#6: fail-open 차단)
  {
    const { child, logs } = startServer({ AETHER_AUTH_MODE: "Password" }); // 대문자 오타
    const up = await waitHealthy(5000);
    check(!up && /AETHER_AUTH_MODE는 off\|tailscale\|password/.test(logs()), "D2 authMode 오타 → 부팅 거부(fail-closed)", up ? "떴음(위험!)" : "안 뜸");
    await stopServer(child);
  }
  // D3 약한 JWT 시크릿 → 부팅 실패(리뷰 #2/#5)
  {
    const { child, logs } = startServer({ AETHER_AUTH_MODE: "password", AETHER_JWT_SECRET: "short", AETHER_PASSWORD_HASH: TEST_HASH });
    const up = await waitHealthy(5000);
    check(!up && /너무 짧/.test(logs()), "D3 약한 JWT 시크릿(<32B) → 부팅 실패", up ? "떴음(위험!)" : "안 뜸");
    await stopServer(child);
  }
  // D4 인증 없이 루프백 밖에 묶으면 부팅 거부
  {
    const { child, logs } = startServer({ AETHER_AUTH_MODE: "off", AETHER_HOST: "0.0.0.0" });
    const up = await waitHealthy(5000);
    check(!up && /인증 없이 이 주소/.test(logs()), "D4 off + 루프백 밖 주소 → 부팅 거부", up ? "떴음(위험!)" : "안 뜸");
    await stopServer(child);
  }
}

async function main() {
  await unitTests();
  await smokeTests();
  console.log("\n" + "─".repeat(56));
  console.log(`Phase 3 인증: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
