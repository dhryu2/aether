/**
 * 3c1+3c2 데스크톱 게이트. 모델 0. 라이브 8787 0. 운영 aether 0.
 *   실행: cd server && npm run test:workspace-desktop
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { NotifyIntent } from "../notify/worthNotifying";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, "..");
const REPO = path.resolve(SERVER_DIR, "..");
const DESKTOP = path.join(REPO, "desktop");
const TAURI = path.join(DESKTOP, "src-tauri");
const WEB_DIST = path.join(REPO, "web", "dist");
const IS_WIN = process.platform === "win32";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function walkFiles(dir: string, out: string[] = [], skip = new Set(["target", "node_modules"])): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, out, skip);
    else out.push(abs);
  }
  return out;
}

function killProc(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  if (IS_WIN) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try {
        child.kill();
      } catch {
        /* */
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* */
    }
  }
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(
  port: number,
  method: string,
  p: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function startPasswordServer(port: number): { child: ChildProcess; logs: () => string } {
  const TEST_HASH = bcrypt.hashSync("testpw123", 4);
  const SECRET = "test-only-mock-secret-do-not-use-in-prod-xxxxxxxx";
  const base = { ...process.env };
  for (const k of ["AETHER_AUTH_MODE", "AETHER_JWT_SECRET", "AETHER_PASSWORD_HASH", "AETHER_ALLOWED_LOGINS"]) {
    delete base[k];
  }
  let logs = "";
  const child = spawn("npx", ["tsx", "index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...base,
      PORT: String(port),
      AETHER_MODEL: "haiku",
      ANTHROPIC_API_KEY: "",
      AETHER_AUTH_MODE: "password",
      AETHER_JWT_SECRET: SECRET,
      AETHER_PASSWORD_HASH: TEST_HASH,
      AETHER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "aether-desk-pw-")),
    },
    detached: !IS_WIN,
    stdio: ["ignore", "pipe", "pipe"],
    shell: IS_WIN,
  });
  child.stdout?.on("data", (d) => (logs += d));
  child.stderr?.on("data", (d) => (logs += d));
  return { child, logs: () => logs };
}

async function stopChild(child: ChildProcess) {
  killProc(child, "SIGTERM");
  await delay(400);
}

async function waitPort(port: number, pathName = "/api/health", timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await req(port, "GET", pathName)).status === 200) return true;
    } catch {
      /* */
    }
    await delay(250);
  }
  return false;
}

/** cargo 실행 파일이 PATH 또는 홈의 cargo bin에 있는지. 없으면 창 스모크를 띄우지 않는다. */
function cargoPresent(): boolean {
  const pathDirs = (process.env.PATH || "").split(IS_WIN ? ";" : ":");
  return (
    pathDirs.some(
      (d) =>
        !!d &&
        (fs.existsSync(path.join(d, "cargo")) || (IS_WIN && fs.existsSync(path.join(d, "cargo.exe")))),
    ) ||
    fs.existsSync(path.join(os.homedir(), ".cargo", "bin", "cargo")) ||
    fs.existsSync(path.join(os.homedir(), ".cargo", "bin", "cargo.exe"))
  );
}

function cargoBin(): string {
  if (IS_WIN) {
    const homeExe = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
    if (fs.existsSync(homeExe)) return homeExe;
    const dirs = (process.env.PATH || "").split(";");
    for (const dir of dirs) {
      if (!dir) continue;
      const exe = path.join(dir, "cargo.exe");
      if (fs.existsSync(exe)) return exe;
      const bare = path.join(dir, "cargo");
      if (fs.existsSync(bare)) return bare;
    }
    return "cargo";
  }
  const home = path.join(os.homedir(), ".cargo", "bin", "cargo");
  return fs.existsSync(home) ? home : "cargo";
}

function cargoEnv(): NodeJS.ProcessEnv {
  const cargoHome = path.join(os.homedir(), ".cargo/bin");
  const sep = IS_WIN ? ";" : ":";
  return {
    ...process.env,
    PATH: `${cargoHome}${sep}${process.env.PATH || ""}`,
  };
}

type ChildExit = { code: number | null; timedOut: boolean };

function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const t = setTimeout(() => {
      try {
        killProc(child, "SIGKILL");
      } catch {
        /* */
      }
      done({ code: null, timedOut: true });
    }, timeoutMs);
    child.on("exit", (c) => {
      clearTimeout(t);
      done({ code: c, timedOut: false });
    });
  });
}

// ── 1) desktop notify 단위 ──
console.log("\n=== desktop notify 단위 ===");
{
  const { emitDesktopNotify, subscribeDesktopNotify } = await import("../notify/desktop");
  const got: NotifyIntent[] = [];
  const unsub = subscribeDesktopNotify((i) => got.push(i));
  const intent: NotifyIntent = { title: "t1", body: "b1", sessionId: "s1" };
  emitDesktopNotify(intent);
  check(got.length === 1 && got[0]?.title === "t1", "emit 전 구독 1 → 의도 1");
  unsub();
  emitDesktopNotify({ title: "t2", body: "b2", sessionId: "s2" });
  check(got.length === 1, "구독 0 → throw 0·추가 수신 0");
}

// ── 2) password Bearer + notify stream ──
console.log("\n=== password Bearer · notify stream ===");
{
  const PORT = 8817;
  if (String(PORT).includes("8787")) throw new Error("8787");
  const { child } = startPasswordServer(PORT);
  try {
    const up = await waitPort(PORT);
    check(up, "password 픽스처 부팅");
    const login = await req(PORT, "POST", "/api/auth/login", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "testpw123" }),
    });
    let token = "";
    try {
      token = JSON.parse(login.body)?.token ?? "";
    } catch {
      /* */
    }
    check(login.status === 200 && typeof token === "string" && token.length > 10, "로그인 token");
    const sessions = await req(PORT, "GET", "/api/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 목록 본문이 503이어도(워크스페이스/DB) 게이트는 통과해야 한다 — 401이면 Bearer 실패.
    check(sessions.status !== 401, "Bearer로 보호 REST 게이트 통과", `status=${sessions.status}`);
    check((await req(PORT, "GET", "/api/sessions")).status === 401, "쿠키·Bearer 없이 401");

    const sse = await req(PORT, "GET", "/api/sessions/dummy/stream?since=0", {
      headers: { Authorization: `Bearer ${token}` },
    });
    check(sse.status === 404, "Bearer SSE 게이트 통과(없는 id 404)");
    check(!/[?&]token=/.test("/api/sessions/dummy/stream?since=0"), "질의에 token 없음");

    // notify stream
    const notifyOpen = await new Promise<{ status: number; ctype: string }>((resolve, reject) => {
      const r = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/api/notify/stream",
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            ctype: String(res.headers["content-type"] || ""),
          });
          res.resume();
          setTimeout(() => {
            try {
              r.destroy();
            } catch {
              /* */
            }
          }, 100);
        },
      );
      r.on("error", reject);
      r.end();
    });
    check(
      notifyOpen.status === 200 && /text\/event-stream/.test(notifyOpen.ctype),
      "Bearer로 /api/notify/stream → text/event-stream",
    );
    check((await req(PORT, "GET", "/api/notify/stream")).status === 401, "notify 헤더 없으면 401");

    // attachNotify → emit
    const { attachNotify } = await import("../notify/coordinator");
    const { emitDesktopNotify, subscribeDesktopNotify } = await import("../notify/desktop");
    const { sessionManager } = await import("../sessions/SessionManager");
    await (await import("./support/tempDb")).useTempDiary("workspace_desktop"); // 임시 SQLite 일기
    const mock = await import("./support/mockProvider");
    const { __registerProviderForTest } = await import("../providers/registry");
    const { config } = await import("../config");
    const desk: NotifyIntent[] = [];
    const unsub = subscribeDesktopNotify((i) => desk.push(i));
    const unregister = __registerProviderForTest(mock.mockEntry);
    try {
      const cwd = config.projectRootReal ?? config.projectRoot;
      sessionManager.setOnLive((session) =>
        attachNotify(session, (intent) => {
          emitDesktopNotify(intent);
        }),
      );
      const live = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
      void (live as unknown as { requestPermission: (ask: unknown) => Promise<unknown> }).requestPermission({
        toolName: "Bash",
        input: { command: "echo hi" },
        toolUseID: "tool-desk",
        signal: new AbortController().signal,
      });
      await delay(50);
      check(
        desk.length >= 1 && typeof desk[0]?.title === "string" && desk[0]?.sessionId === live.id,
        "attachNotify 알릴 사건 → emit title/sessionId",
        desk[0],
      );
      sessionManager.delete(live.id);
    } finally {
      sessionManager.setOnLive(undefined);
      unregister();
      unsub();
    }
  } finally {
    await stopChild(child);
  }
}

// ── 3) 정적 검사 ──
console.log("\n=== 정적 검사(껍데기·본체) ===");
{
  const desktopSrc = walkFiles(DESKTOP).filter(
    (p) => !p.includes(`${path.sep}target${path.sep}`) && !p.endsWith("Cargo.lock"),
  );
  const joined = desktopSrc.map((p) => fs.readFileSync(p, "utf8")).join("\n");
  check(!/\bpostgres\b/i.test(joined) && !/postgresql:\/\//i.test(joined), "desktop에 postgres/postgresql:// 0");
  check(!/\bDATABASE_URL\b/.test(joined), "desktop에 DATABASE_URL 0");
  check(!/\b5432\b/.test(joined) && !/\b5433\b/.test(joined), "desktop에 5432/5433 0");
  check(!/\bWebSocket\b/.test(joined) && !/ws:\/\//.test(joined) && !/wss:\/\//.test(joined), "desktop 웹소켓 0");

  const cargo = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
  // 직접 의존 화이트리스트 — [dependencies]·[build-dependencies]·[target.*.dependencies]
  const allow = new Set([
    "tauri",
    "tauri-build",
    "tauri-plugin-notification",
    "tauri-plugin-global-shortcut",
    "serde",
    "serde_json",
  ]);
  const depNames = new Set<string>();
  let section = "";
  for (const line of cargo.split("\n")) {
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) {
      section = sec[1]!;
      continue;
    }
    const isDepSection =
      section === "dependencies" ||
      section === "build-dependencies" ||
      /^target\..+\.dependencies$/.test(section);
    if (!isDepSection) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (m) depNames.add(m[1]!);
  }
  const extra = [...depNames].filter((n) => !allow.has(n));
  check(extra.length === 0, `Cargo 직접 의존 화이트리스트만 (extra: ${extra.join(",") || "없음"})`);
  const banned = [
    "axum",
    "actix-web",
    "warp",
    "rocket",
    "tiny_http",
    "hyper",
    "sqlx",
    "tokio-postgres",
    "postgres",
    "diesel",
    "tungstenite",
    "llama",
    "candle",
    "ort",
    "whisper",
  ];
  check(
    banned.every((b) => !depNames.has(b)),
    "금지 직접 의존 0 (target.*.dependencies 포함)",
  );

  // 자기 반증
  function hasBannedDep(toml: string, name: string): boolean {
    return new RegExp(`^${name}\\s*=`, "m").test(toml);
  }
  function hasTcpBind(src: string): boolean {
    return /TcpListener/.test(src) || /std::net::TcpListener/.test(src) || /\.listen\s*\(/.test(src);
  }
  check(hasBannedDep('axum = "0"\n', "axum"), "자기 반증: axum = \"0\" 감지");
  check(hasTcpBind("TcpListener::bind(\"0.0.0.0:80\")"), "자기 반증: TcpListener::bind 감지");

  const rustSrc = walkFiles(path.join(TAURI, "src"))
    .filter((p) => p.endsWith(".rs"))
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");
  check(!hasTcpBind(rustSrc), "Rust 소스 TcpListener/.listen( 서버 바인드 0");

  for (const dir of ["sessions", "providers", "memory", "search", "skill"]) {
    const hits = walkFiles(path.join(SERVER_DIR, dir)).filter((p) => {
      if (!p.endsWith(".ts")) return false;
      return /\btauri\b/i.test(fs.readFileSync(p, "utf8"));
    });
    check(hits.length === 0, `서버 ${dir}/ tauri 0`);
  }

  check(fs.existsSync(path.join(TAURI, "icons/icon.ico")), "desktop/src-tauri/icons/icon.ico 존재");

  const conf = fs.readFileSync(path.join(TAURI, "tauri.conf.json"), "utf8");
  check(/"withGlobalTauri"\s*:\s*true/.test(conf), "withGlobalTauri true");
  check(/"create"\s*:\s*false/.test(conf), "main 창 create false");
  check(/"frontendDist"\s*:\s*"http:\/\/127\.0\.0\.1:8787"/.test(conf), "frontendDist 불변");
  check(/"devUrl"\s*:\s*"http:\/\/127\.0\.0\.1:8787"/.test(conf), "devUrl 불변");
  check(/"active"\s*:\s*true/.test(conf), "bundle.active true");
  check(/"targets"\s*:\s*\[[^\]]*"msi"/.test(conf), 'targets에 "msi"');
  const cap = fs.readFileSync(path.join(TAURI, "capabilities/default.json"), "utf8");
  check(/127\.0\.0\.1:\*/.test(cap) && /\*\.ts\.net:\*/.test(cap), "remote.urls 두 줄");
  check(!/"urls"\s*:\s*\[[^\]]*"\*"/.test(cap) && !/localhost/.test(cap), "remote에 localhost·* 전체 없음");

  const libRs = fs.readFileSync(path.join(TAURI, "src/lib.rs"), "utf8");
  const shortcutNewIdx = [...libRs.matchAll(/Shortcut::new/g)].map((m) => m.index ?? -1);
  const fnStart = libRs.indexOf("fn desktop_shortcut");
  const fnBodyStart = libRs.indexOf("{", fnStart);
  let depth = 0;
  let fnBodyEnd = -1;
  for (let i = fnBodyStart; i < libRs.length; i++) {
    if (libRs[i] === "{") depth++;
    else if (libRs[i] === "}") {
      depth--;
      if (depth === 0) {
        fnBodyEnd = i;
        break;
      }
    }
  }
  check(
    fnStart >= 0 &&
      fnBodyEnd > fnBodyStart &&
      shortcutNewIdx.length > 0 &&
      shortcutNewIdx.every((i) => i > fnBodyStart && i < fnBodyEnd),
    "Shortcut::new는 desktop_shortcut 몸통에만",
    { shortcutNewIdx, fnBodyStart, fnBodyEnd },
  );
  const registerRegion = libRs.includes("register(desktop_shortcut())");
  const handlerRegion = /with_handler[\s\S]*?desktop_shortcut\(\)/.test(libRs);
  check(registerRegion && handlerRegion, "register·with_handler는 desktop_shortcut()만");
  check(!/localhost.*127\.0\.0\.1|strip_prefix\("http:\/\/localhost"\)/.test(libRs), "localhost 치환 제거");
  const startUrlAt = libRs.indexOf('format!("START_URL={start}")');
  const lastStartWrite =
    /join\("last_start_url"\)/.test(libRs) && /write\([^;]*last_start_url/.test(libRs.replace(/\s+/g, " "));
  check(
    startUrlAt >= 0 && lastStartWrite && libRs.indexOf("last_start_url", startUrlAt) > startUrlAt,
    "lib.rs START_URL 뒤 last_start_url 쓰기",
  );

  const readme = fs.readFileSync(path.join(DESKTOP, "README.md"), "utf8");
  check(readme.includes("cargo tauri build --bundles msi"), "README에 cargo tauri build --bundles msi");
  check(readme.includes("server_url"), "README에 server_url");
  check(readme.includes("last_start_url"), "README에 last_start_url");

  // 이 시험 소스 자신: 라이브 8787 GET/POST·cargo tauri build·rustup target add spawn 금지
  const selfSrc = fs.readFileSync(path.join(TEST_DIR, "workspace_desktop.ts"), "utf8");
  check(!/\bspawn(?:Sync)?\s*\(\s*["']rustup["']/.test(selfSrc), "시험 spawn(rustup) 0");
  check(
    !/\bspawn(?:Sync)?\s*\(\s*["']cargo["'][\s\S]{0,160}?["']tauri["'][\s\S]{0,80}?["']build["']/.test(selfSrc) &&
      !/\bspawn(?:Sync)?\s*\(\s*bin[\s\S]{0,80}?\[[\s\S]{0,40}?["']tauri["'][\s\S]{0,40}?["']build["']/.test(selfSrc),
    "시험 spawn(cargo tauri build) 0",
  );
  check(
    !/req\(\s*8787\b/.test(selfSrc) &&
      !/port:\s*8787\b/.test(selfSrc) &&
      !/\b(?:PORT|FIXTURE_PORT|REJECT_PORT)\s*=\s*8787\b/.test(selfSrc),
    "시험 라이브 8787 요청 0",
  );
}

function sha256DirDigest(dir: string): string {
  const files = walkFiles(dir).sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(path.relative(dir, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex");
}

// ── 5) 허용 창 스모크 (맥 회귀 / 윈도 호스트) ──
const allowTitle = IS_WIN ? "윈도 창 스모크" : "맥 회귀 스모크";
const cargoOk = cargoPresent();
if (!cargoOk) {
  // 통과로 세지 않는다. cargo가 없으면 빌드와 창을 띄우지 않고, 포트 8901·8903도 열지 않는다.
  console.log(`\n=== ${allowTitle} ===`);
  console.log("  ⏭️  cargo가 없어 데스크톱 창 스모크를 건너뛴다");
  console.log("\n=== 거절 스모크 ===");
  console.log("  ⏭️  cargo가 없어 거절 스모크를 건너뛴다");
} else {
console.log(`\n=== ${allowTitle} ===`);
{
  check(cargoOk, "cargo PATH");

  const distBefore = fs.existsSync(WEB_DIST) ? sha256DirDigest(WEB_DIST) : "MISSING";
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "aether-fixture-dist-"));
  const build = spawn("npx", ["vite", "build", "--outDir", tmpOut], {
    cwd: path.join(REPO, "web"),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    shell: IS_WIN,
  });
  let buildLog = "";
  build.stdout?.on("data", (d) => (buildLog += d));
  build.stderr?.on("data", (d) => (buildLog += d));
  const buildCode = await new Promise<number>((resolve) => build.on("exit", (c) => resolve(c ?? 1)));
  check(buildCode === 0, "임시 vite outDir 빌드", buildCode === 0 ? undefined : buildLog.slice(-400));

  const FIXTURE_PORT = 8901;
  if (String(FIXTURE_PORT).includes("8787")) throw new Error("8787");
  const fixture = spawn("npx", ["tsx", "test/visual/fixtureServer.ts", String(FIXTURE_PORT)], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      AETHER_FIXTURE_DIST: tmpOut,
      AETHER_FIXTURE_DESKTOP: "1",
      AETHER_FIXTURE_AUTH: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !IS_WIN,
    shell: IS_WIN,
  });
  let fixtureLog = "";
  fixture.stdout?.on("data", (d) => (fixtureLog += d));
  fixture.stderr?.on("data", (d) => (fixtureLog += d));
  const fixtureUp = await waitPort(FIXTURE_PORT, "/api/health", 30000);
  check(fixtureUp, "픽스처 서버(8787 아님)", fixtureLog.slice(-200));

  const smokeUrl = `http://127.0.0.1:${FIXTURE_PORT}`;
  check(!smokeUrl.includes("8787"), "스모크 origin에 8787 없음");

  const bin = cargoBin();
  const pre = spawn(bin, ["build", "--quiet"], {
    cwd: TAURI,
    env: cargoEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: IS_WIN,
  });
  await new Promise<void>((resolve) => pre.on("exit", () => resolve()));

  let smokeOut = "";
  const smoke = spawn(bin, ["run", "--quiet"], {
    cwd: TAURI,
    env: {
      ...cargoEnv(),
      AETHER_DESKTOP_SMOKE: "1",
      AETHER_DESKTOP_URL: smokeUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !IS_WIN,
    shell: IS_WIN,
  });
  smoke.stdout?.on("data", (d) => {
    smokeOut += d;
    process.stdout.write(d);
  });
  smoke.stderr?.on("data", (d) => {
    smokeOut += d;
    process.stderr.write(d);
  });

  const smokeExit = await waitChildExit(smoke, 90000);

  const startLine = smokeOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("START_URL="));
  const startUrl = startLine?.slice("START_URL=".length) ?? "";
  check(startUrl === smokeUrl, "START_URL=픽스처 origin", { startUrl, smokeUrl });
  check(!!startUrl && !startUrl.includes("8787"), "START_URL에 8787 없음");
  const startAt = smokeOut.indexOf("START_URL=");
  const windowAt = smokeOut.indexOf("SMOKE_WINDOW");
  check(startAt >= 0 && windowAt > startAt, "START_URL 뒤에만 SMOKE_WINDOW");

  for (const line of ["SMOKE_WINDOW", "SMOKE_ROOMS", "SMOKE_NOTIFY", "SMOKE_TRAY", "SMOKE_SHORTCUT", "SMOKE_OK"]) {
    check(smokeOut.includes(line), `${allowTitle} ${line}`);
  }

  if (smokeExit.timedOut) {
    check(false, `${allowTitle} timeout 실패(종료 코드 변환 없음)`, smokeExit);
  } else if (IS_WIN) {
    check(smokeExit.code === 0, `${allowTitle} exit code === 0`, smokeExit);
  } else {
    check(
      smokeOut.includes("SMOKE_OK") && (smokeExit.code === 0 || smokeExit.code === null),
      `${allowTitle} exit code === 0 또는 null`,
      smokeExit,
    );
  }

  try {
    killProc(fixture, "SIGTERM");
  } catch {
    /* */
  }
  await delay(300);
  try {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  } catch {
    /* */
  }

  const distAfter = fs.existsSync(WEB_DIST) ? sha256DirDigest(WEB_DIST) : "MISSING";
  check(distBefore === distAfter, "web/dist sha256 스위트 전후 동일");
}

// ── 6) 거절 스모크 (localhost) ──
console.log("\n=== 거절 스모크 ===");
{
  const REJECT_PORT = 8903;
  if (String(REJECT_PORT).includes("8787")) throw new Error("8787");
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("reject-fixture");
  });
  await new Promise<void>((resolve) => srv.listen(REJECT_PORT, "127.0.0.1", resolve));

  const rejectUrl = `http://localhost:${REJECT_PORT}`;
  let rejectOut = "";
  const bin = cargoBin();
  const rejectChild = spawn(bin, ["run", "--quiet"], {
    cwd: TAURI,
    env: {
      ...cargoEnv(),
      AETHER_DESKTOP_SMOKE: "1",
      AETHER_DESKTOP_URL: rejectUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !IS_WIN,
    shell: IS_WIN,
  });
  rejectChild.stdout?.on("data", (d) => {
    rejectOut += d;
  });
  rejectChild.stderr?.on("data", (d) => {
    rejectOut += d;
  });

  const rejectExit = await waitChildExit(rejectChild, 60000);

  if (rejectExit.timedOut) {
    check(false, "거절 스모크 timeout 실패", rejectExit);
  } else if (rejectExit.code === null) {
    check(false, "거절 스모크 code === null 실패", rejectExit);
  } else {
    check(rejectExit.code !== 0, "거절 스모크 자연 종료 code !== 0", rejectExit);
  }
  check(!rejectOut.includes("SMOKE_WINDOW"), "거절 스모크 SMOKE_WINDOW 없음");
  check(!/^START_URL=/m.test(rejectOut) && !rejectOut.includes("START_URL="), "거절 스모크 START_URL= 없음", {
    tail: rejectOut.slice(-200),
  });
  check(hits === 0, "거절 스모크 픽스처 HTTP 0", { hits });

  await new Promise<void>((resolve) => srv.close(() => resolve()));
}
}

console.log(`\n${fail === 0 ? "✅" : "❌"} workspace_desktop: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
