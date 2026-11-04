/**
 * 자격 폐기 시험(프로세스 안, 임시 데이터 폴더): 서명 키가 비밀번호 해시와 세대 값에 묶이는지,
 * 로그아웃한 토큰만 폐기되는지, 열린 SSE 스트림이 자격이 사라지면 닫히는지, 옛 푸시 구독이 탈락하는지.
 * 주의: config 전에 env를 세팅해야 하므로 auth 모듈은 동적 import. 값은 전부 시험용 예시.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-revoke-"));
const HASH_A = bcrypt.hashSync("example-pass-A1", 4);
const HASH_B = bcrypt.hashSync("example-pass-B2", 4);
process.env.AETHER_DATA_DIR = dataDir;
process.env.AETHER_AUTH_MODE = "password";
process.env.AETHER_JWT_SECRET = "test-only-mock-secret-do-not-use-in-prod-xxxxxxxx";
process.env.AETHER_PASSWORD_HASH = HASH_A;
process.env.AETHER_BCRYPT_COST = "4";
delete process.env.AETHER_ALLOWED_LOGINS;

const { signSession, verifySession, revokeSession } = await import("../auth/jwt");
const { savePasswordHash, currentPasswordHash, revokeTokenId, isTokenRevoked } = await import("../auth/passwordHash");

const stateFile = path.join(dataDir, "auth-state.json");
const pwFile = path.join(dataDir, "auth-password.json");
let pass = 0, fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}
const clean = () => {
  for (const f of [stateFile, pwFile]) fs.rmSync(f, { recursive: true, force: true });
  process.env.AETHER_PASSWORD_HASH = HASH_A;
};
const epochOf = () => JSON.parse(fs.readFileSync(stateFile, "utf8")).epoch as string;

try {
  console.log("\n[키 묶기] 서명 키는 비밀번호 해시와 세대 값에 묶인다");
  clean();
  {
    const t0 = await signSession();
    check(await verifySession(t0), "대조군: 발급한 토큰은 통과");
    process.env.AETHER_PASSWORD_HASH = HASH_B;
    check(!(await verifySession(t0)), "1 .env 해시를 바꾸면 옛 토큰 거부");
  }
  clean();
  {
    const t0 = await signSession();
    savePasswordHash(HASH_B);
    check(!(await verifySession(t0)), "2 비밀번호를 저장하면 옛 토큰 거부");
    const t1 = await signSession();
    check(await verifySession(t1), "2 새 토큰은 통과");
    fs.rmSync(pwFile);
    check(!(await verifySession(t0)), "2 저장 파일을 지워도 옛 토큰은 되살아나지 않는다");
    check(!(await verifySession(t1)), "2 지운 뒤엔 저장 때 발급한 토큰도 거부(해시가 바뀜)");
    fs.rmSync(stateFile);
    check(!(await verifySession(t0)), "3 상태 파일까지 지워도 옛 토큰은 거부(세대 값이 새로 생김)");
  }
  clean();
  {
    const t0 = await signSession();
    fs.writeFileSync(pwFile, "{깨짐");
    check(currentPasswordHash() === undefined, "4 깨진 저장 파일이면 해시를 읽지 못한 것으로 본다(env로 넘어가지 않음)");
    check(!(await verifySession(t0)), "4 그때 옛 토큰은 거부");
  }
  clean();
  {
    const t0 = await signSession();
    fs.writeFileSync(stateFile, "{깨짐");
    check(!(await verifySession(t0)), "5 상태 파일이 깨져도 throw 없이 거부");
    const t1 = await signSession();
    check(await verifySession(t1), "5 새 로그인 토큰은 통과(상태 파일이 새로 생김)");
  }
  clean();
  {
    const t0 = await signSession();
    fs.rmSync(stateFile);
    fs.mkdirSync(stateFile);
    check(!(await verifySession(t0)), "6 상태 파일 자리가 폴더면 검증은 거부");
    check(await signSession().then(() => false, () => true), "6 그때 발급은 거부(reject)");
    fs.rmSync(stateFile, { recursive: true });
  }
  clean();
  {
    const t0 = await signSession();
    const before = epochOf();
    fs.mkdirSync(pwFile);
    let threw = false;
    try { savePasswordHash(HASH_B); } catch { threw = true; }
    check(threw && epochOf() !== before, "7 해시 쓰기가 실패해도 세대 값은 먼저 바뀐다");
    fs.rmSync(pwFile, { recursive: true });
    check(!(await verifySession(t0)), "7 그때 옛 토큰은 거부");
  }

  console.log("\n[폐기] 로그아웃한 토큰만 무효");
  clean();
  {
    const t = await signSession();
    const t2 = await signSession();
    revokeTokenId("expired-example", Math.floor(Date.now() / 1000) - 10);
    await revokeSession(t);
    check(!(await verifySession(t)) && (await verifySession(t2)), "8 폐기한 토큰만 거부하고 같은 때 발급한 다른 토큰은 통과");
    const before = fs.readFileSync(stateFile, "utf8");
    await revokeSession("not-a-token");
    await revokeSession(t2.slice(0, -3) + "AAA");
    check(fs.readFileSync(stateFile, "utf8") === before, "8 위조 문자열은 파일을 바꾸지 못한다");
    check(!isTokenRevoked("expired-example") && !before.includes("expired-example"), "8 만료 지난 항목은 정리된다");
  }

  console.log("\n[SSE] 자격이 사라지면 열린 스트림이 닫힌다");
  const { useTempDiary } = await import("./support/tempDb");
  const tempDb = await useTempDiary("revoke");
  const { config } = await import("../config");
  const { createAuthMiddleware, createOffStrategy, createPasswordStrategy } = await import("../middleware/auth");
  const { sessionManager } = await import("../sessions/SessionManager");
  const { streamRouter } = await import("../routes/stream");
  const { notifyRouter } = await import("../routes/notify");
  const { presenceRouter } = await import("../routes/presence");
  const { MOCK_PROVIDER, mockEntry } = await import("./support/mockProvider");
  const { __registerProviderForTest } = await import("../providers/registry");
  const unregister = __registerProviderForTest(mockEntry);
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  (config as { heartbeatMs: number }).heartbeatMs = 50; // 심장박동마다 자격을 다시 본다

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const live = sessionManager.create({ cwd: config.projectRootReal ?? config.projectRoot, provider: MOCK_PROVIDER });
  const mount = (strategy: any) => {
    const app = express();
    app.use(cookieParser());
    app.use(createAuthMiddleware(strategy));
    app.use("/api/sessions", streamRouter);
    app.use("/api/notify", notifyRouter);
    app.use("/api/presence", presenceRouter);
    const server = app.listen(0);
    return new Promise<{ base: string; server: typeof server }>((resolve) =>
      server.once("listening", () => resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
  };
  const paths = [`/api/sessions/${live.id}/stream?since=0`, "/api/notify/stream", "/api/presence/stream"];
  const aborts: AbortController[] = [];
  const openStream = async (base: string, p: string, token?: string) => {
    const ac = new AbortController();
    aborts.push(ac);
    const res = await fetch(base + p, { headers: token ? { Cookie: `aether_session=${token}` } : {}, signal: ac.signal });
    const reader = res.body!.getReader();
    const done = (async () => { try { while (!(await reader.read()).done); return true; } catch { return true; } })();
    return { status: res.status, closedWithin: (ms: number) => Promise.race([done, sleep(ms).then(() => false)]) };
  };
  try {
    const pw = await mount(createPasswordStrategy());
    clean();
    {
      const t = await signSession();
      const hs = await Promise.all(paths.map((p) => openStream(pw.base, p, t)));
      check(hs.every((h) => h.status === 200), "S0 유효 토큰으로 세 스트림이 열린다");
      savePasswordHash(HASH_B);
      const closed = await Promise.all(hs.map((h) => h.closedWithin(2000)));
      check(closed.every(Boolean), "S1 비밀번호를 바꾸면 세 스트림이 모두 닫힌다", closed.join(","));
    }
    clean();
    {
      const t = await signSession();
      const t2 = await signSession();
      const hs = await Promise.all(paths.map((p) => openStream(pw.base, p, t)));
      const other = await openStream(pw.base, paths[1]!, t2);
      await revokeSession(t);
      const closed = await Promise.all(hs.map((h) => h.closedWithin(2000)));
      check(closed.every(Boolean), "S2 로그아웃한 토큰의 스트림은 닫힌다", closed.join(","));
      check(!(await other.closedWithin(500)), "S2 같은 때 연 다른 토큰의 스트림은 유지");
    }
    clean();
    {
      const t = await signSession(Math.floor(Date.now() / 1000) + 1);
      const hs = await Promise.all(paths.map((p) => openStream(pw.base, p, t)));
      const closed = await Promise.all(hs.map((h) => h.closedWithin(3500)));
      check(hs.every((h) => h.status === 200) && closed.every(Boolean), "S3 토큰이 만료되면 스트림이 닫힌다", closed.join(","));
    }
    const off = await mount(createOffStrategy());
    {
      const hs = await Promise.all(paths.map((p) => openStream(off.base, p)));
      savePasswordHash(HASH_B);
      const closed = await Promise.all(hs.map((h) => h.closedWithin(500)));
      check(!closed.some(Boolean), "S4 인증 off 스트림은 비밀번호가 바뀌어도 유지");
    }
    pw.server.close(); off.server.close();
  } finally {
    for (const ac of aborts) ac.abort();
    sessionManager.delete(live.id);
    unregister();
    tempDb.dispose();
  }

  console.log("\n[푸시] 자격이 바뀌면 옛 구독으로 보내지 않는다");
  {
    const webpush = (await import("web-push")).default;
    const keys = webpush.generateVAPIDKeys();
    process.env.AETHER_VAPID_PUBLIC = keys.publicKey;
    process.env.AETHER_VAPID_PRIVATE = keys.privateKey;
    let sent = 0;
    (webpush as { sendNotification: unknown }).sendNotification = async () => { sent++; return {}; }; // 실제 네트워크 없음
    const { addSubscription, notifyPush, removeSubscription } = await import("../push");
    const { config } = await import("../config");
    const sub = (n: number) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: "example-p256dh", auth: "example-auth" } });
    const payload = { title: "t", body: "b", sessionId: "s" };
    const subsFile = path.join(dataDir, "push-subs.json");
    clean();
    addSubscription(sub(1));
    check(notifyPush(payload).attempted === 1, "P0 구독 추가 뒤 전송 시도 1");
    savePasswordHash(HASH_B);
    const after = notifyPush(payload);
    check(after.attempted === 0 && after.reason === "no-subscribers", "P1 비밀번호를 바꾸면 옛 구독으로 보내지 않는다", JSON.stringify(after));
    check(!fs.readFileSync(subsFile, "utf8").includes("push.example.test/1"), "P2 탈락한 구독은 저장 파일에서도 빠진다");
    addSubscription(sub(1));
    check(notifyPush(payload).attempted === 1, "P3 같은 endpoint를 다시 등록하면 새 자격으로 살아난다");
    fs.rmSync(pwFile);
    check(notifyPush(payload).attempted === 0, "P4 저장 파일을 지우면 탈락");
    addSubscription(sub(1));
    process.env.AETHER_PASSWORD_HASH = HASH_B;
    check(notifyPush(payload).attempted === 0, "P5 .env 해시를 바꾸면 탈락");
    clean();
    addSubscription(sub(3));
    fs.writeFileSync(pwFile, "{깨짐");
    check(notifyPush(payload).attempted === 0 && fs.readFileSync(subsFile, "utf8").includes("push.example.test/3"), "P7 저장 파일을 읽지 못하는 동안엔 보내지 않되 구독은 지우지 않는다");
    fs.rmSync(pwFile);
    check(notifyPush(payload).attempted === 1, "P7 파일이 복구되면 알림이 다시 나간다");
    removeSubscription(sub(3).endpoint);
    clean();
    (config as { authMode: string }).authMode = "off";
    addSubscription(sub(2));
    savePasswordHash(HASH_B);
    check(notifyPush(payload).attempted === 1, "P6 인증 off에서는 자격 비교 없이 보낸다");
    (config as { authMode: string }).authMode = "password";
  }
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
