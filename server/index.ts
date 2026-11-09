/**
 * Aether 백엔드 부팅. 상시 단일 Node 프로세스(Next.js 아님 — live 세션 보유 필요).
 *
 * 미들웨어 순서(load-bearing, 바꾸지 말 것):
 *   helmet → compression(SSE filter) → cookie-parser → /api/sessions 인증 게이트 → express.json(limit)
 *   → /api/health (공개) → /api/auth (공개)
 *   → 보호 라우터 → streamRouter(SSE 먼저) → sessionsRouter → /api/search(보호) → /api/fs(보호)
 *   → /api 404 가드 → static + SPA fallback → 에러 핸들러(맨 끝)
 *
 * 인증은 기본 off(config.authMode). 게이트는 /api/sessions 앞에만(health·auth는 공개 = 로그인 경로 보장).
 */
import express from "express";
import pkg from "./package.json" with { type: "json" };
import { startErrorCollection, reportError, getErrorJournal } from "./observability/report";
import { errorRequestContext, errorsRouter } from "./observability/http";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { config } from "./config";
import { sseSafeCompression, errorHandler } from "./middleware/hardening";
import { createAuthMiddleware, selectStrategy } from "./middleware/auth";
import { MIN_JWT_SECRET_BYTES } from "./auth/jwt";
import { resolveTailscaleCli } from "./auth/tailscale";
import { currentPasswordHash } from "./auth/passwordHash";
import { createStaticAddon } from "./routes/static";
import { authRouter } from "./routes/auth";
import { fsRouter } from "./routes/fs";
import { sessionsRouter } from "./routes/sessions";
import { providersRouter } from "./routes/providers";
import { searchRouter } from "./routes/search";
import { reviewRouter } from "./routes/review";
import { streamRouter } from "./routes/stream";
import { presenceRouter } from "./routes/presence";
import { pushRouter } from "./routes/push";
import { notifyRouter } from "./routes/notify";
import { providerAuthRouter } from "./routes/providerAuth";
import { systemRouter } from "./routes/system";
import { updateInstaller } from "./update/install";
import { localeRouter } from "./routes/locale";
import { st } from "./i18n";
import { listProviders } from "./providers/registry";
import { deliverWebPush } from "./push";
import { emitDesktopNotify } from "./notify/desktop";
import { attachNotify } from "./notify/coordinator";
import type { NotifyIntent } from "./notify/worthNotifying";
import { autoResumeRouter } from "./routes/autoResume";
import { idleSleepRouter } from "./routes/idleSleep";
import { titleSummaryRouter } from "./routes/titleSummary";
import { sessionManager } from "./sessions/SessionManager";
import { purgeOrphanAttachments } from "./sessions/attachments";
import { configureCanonical } from "./db/canonical";
import { configureDatabase } from "./db/sqlite";
import { installServerLog, serverLogDir } from "./observability/serverLog";
import { probeDatabase } from "./db/status";

// 오류 수집기도 같은 파일에 쓰므로 수집 시작 전에 경로를 정한다.
configureDatabase({ path: config.dbPath });
startErrorCollection(config.errorDir);
// import 시점에 찍힌 console 출력은 파일에 못 남는다(여기서부터 기록).
installServerLog({ dir: serverLogDir() });

// 미처리 오류 뒤에는 프로세스 상태를 신뢰할 수 없다. 로그만 남기고 계속 살려 두지 않고,
// launchd KeepAlive가 깨끗한 프로세스로 다시 띄우게 한다.
process.on("unhandledRejection", (reason) => {
  void reportError(reason, { component: "process", operation: "process.unhandled_rejection", severity: "fatal" });
  console.error("[aether] unhandledRejection:", reason);
  process.exitCode = 1;
  void shutdown(1);
});
process.on("uncaughtException", (err) => {
  void reportError(err, { component: "process", operation: "process.uncaught_exception", severity: "fatal" });
  console.error("[aether] uncaughtException:", err);
  process.exitCode = 1;
  void shutdown(1);
});

// graceful shutdown — 모든 세션 중단 + 보류 권한 정리(launchd KeepAlive 재시작 시 좀비 promise 방지).
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // 정리 중 무엇이 실패해도 프로세스는 끝나야 한다. shuttingDown 때문에 다시 부를 수 없어, 여기서 못 끝내면 서버가 영구히 남는다.
  try {
    const sessions = sessionManager.all();
    // interrupt 병렬화 + 3s 상한(어떤 interrupt가 매달려도 종료 지연 방지). drainPending은 동기·멱등이라 무조건 실행.
    await Promise.race([
      Promise.allSettled(sessions.map((s) => s.interrupt())),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    for (const s of sessions) s.drainPending(st("notice.proto.serverShutdown"));
    // 진행 중이던 재인증 자식 프로세스 정리(좀비 방지) — 등록된 provider 전부.
    //   한 provider를 이름으로 집어 쓰면 새 provider가 등록될 때 그쪽 로그인만 조용히 안 정리된다.
    for (const p of listProviders()) {
      try {
        p.services.auth?.disposeAll();
      } catch (e) {
        void reportError(e, { component: "server", operation: "auth.cleanup" }); console.error(`[aether] ${p.id} 인증 정리 실패:`, e); // 한 provider 실패가 종료를 막지 않게
      }
    }
    await getErrorJournal()?.close(2000);
  } finally {
    process.exit(code);
  }
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

const app = express();
app.use(errorRequestContext);

const staticAddon = createStaticAddon({ enabled: config.serveStatic });

// ── 보안/전송 미들웨어 ──
if (config.helmet) app.use(helmet(staticAddon.helmetOptions()));
if (config.compression) app.use(sseSafeCompression()); // 기본 ON, SSE는 자동 제외
app.use(cookieParser());
// 큰 본문 파싱은 인증 뒤에서만 한다(인증 없는 요청이 40MB 파서나 압축 해제를 돌리지 못하게). 게이트는 파서 앞에 한 번만 둔다.
app.use("/api/sessions", createAuthMiddleware(selectStrategy()));
// 이미지 첨부 메시지 라우트만 큰 한도로 파싱(전역은 256kb 유지 — DoS 표면 축소). 먼저 파싱하면 _body 마킹으로 아래 전역 json은 skip.
// inflate: false — 압축된 요청 본문은 풀지 않고 415로 거절한다(압축 폭탄 방지, 쓰는 클라이언트 없음).
app.post("/api/sessions/:id/message", express.json({ limit: config.imageBodyLimit, inflate: false }));
app.use(express.json({ limit: config.bodyLimit, inflate: false }));

// ── 인증 (기본 off). password 모드는 시크릿 fail-fast + serve loopback 신뢰 ──
if (config.authMode === "off" && !["127.0.0.1", "localhost", "::1"].includes(config.host.trim().toLowerCase())) {
  throw new Error(`AETHER_AUTH_MODE=off인데 AETHER_HOST=${config.host}는 루프백이 아닙니다. 인증 없이 이 주소에 닿는 누구나 에이전트로 명령을 실행할 수 있습니다. AETHER_AUTH_MODE를 password나 tailscale로 바꾸세요.`);
}
if (config.authMode === "password") {
  const jwtSecret = process.env.AETHER_JWT_SECRET;
  if (!jwtSecret) throw new Error("AETHER_AUTH_MODE=password에는 AETHER_JWT_SECRET(.env)가 필요합니다.");
  if (Buffer.byteLength(jwtSecret, "utf8") < MIN_JWT_SECRET_BYTES) {
    throw new Error(`AETHER_JWT_SECRET가 너무 짧습니다 — ${MIN_JWT_SECRET_BYTES}바이트 이상 필요(openssl rand -base64 48).`);
  }
  if (!currentPasswordHash()) throw new Error("AETHER_AUTH_MODE=password에는 비밀번호 해시가 필요합니다. 비밀번호 해시를 읽지 못했다: auth-password.json 또는 AETHER_PASSWORD_HASH(.env)를 확인하세요.");
  app.set("trust proxy", "loopback"); // tailscale serve TLS 종단→loopback 포워딩 뒤 req.secure 판정
}

// ── 공개 엔드포인트(게이트 앞) ──
// liveness만 반환(경로/화이트리스트 경계 미노출 — 운영자는 부팅 로그로 확인).
// database 칸은 Express 생존(HTTP 200)과 DB 생존을 분리한다.
app.get("/api/health", (_req, res) => {
  const database = probeDatabase();
  res.json({ ok: true, version: pkg.aetherReleaseVersion, serverVersion: pkg.version, database, auth: config.authMode });
});
app.use("/api/auth", authRouter); // login/logout — 게이트 앞이라 로그인 경로 보장

// ── 인증 게이트 + 보호 라우터(SSE 포함) ──
app.use("/api/errors", createAuthMiddleware(selectStrategy()), errorsRouter);
app.use("/api/sessions", streamRouter); // SSE 먼저(경로 겹침 없음)
app.use("/api/sessions", sessionsRouter);

app.use("/api/presence", createAuthMiddleware(selectStrategy()));
app.use("/api/presence", presenceRouter);

// provider 모델·effort 카탈로그(D12) — 프론트가 모델 어휘를 하드코딩하지 않게 한다.
app.use("/api/providers", createAuthMiddleware(selectStrategy()));
app.use("/api/providers", providersRouter);

// 과거이력 검색 — 동일 인증 게이트 뒤(보호). 검색 비활성이면 미등록. 검색 파일은 만들지 않는다.
if (config.search) {
  app.use("/api/search", createAuthMiddleware(selectStrategy()));
  app.use("/api/search", searchRouter);
}

// 작업 검토함 — 끝난 세션의 변경·실패·할 일 요약(보호)
app.use("/api/review", createAuthMiddleware(selectStrategy()));
app.use("/api/review", reviewRouter);

// 파일시스템 탐색(FolderPicker) — 동일 인증 게이트 뒤(보호)
app.use("/api/fs", createAuthMiddleware(selectStrategy()));
app.use("/api/fs", fsRouter);

// Web Push 구독(보호) — 공개키는 같은 라우트의 GET /vapid
app.use("/api/push", createAuthMiddleware(selectStrategy()));
app.use("/api/push", pushRouter);

// 데스크톱 알림 SSE(보호) — 판정부 의도를 구독자에게만 전달
app.use("/api/notify", createAuthMiddleware(selectStrategy()));
app.use("/api/notify", notifyRouter);

// provider 원격 재인증(보호) — 가장 민감(마스터 creds 통로). 인증 게이트 안쪽 + tailnet 경계.
//   경로는 provider별 하나뿐이다. 구 경로 `/api/claude-auth/*`는 프론트 전환과 함께 8d-3에서 지웠다(D9).
app.use("/api/provider-auth", createAuthMiddleware(selectStrategy()));
app.use("/api/provider-auth", providerAuthRouter);

// 시스템 제어(재시작) — 운영자 전용. 프로세스 생명주기라 인증 게이트 뒤 + tailnet 경계 안쪽에만 노출.
app.use("/api/system", createAuthMiddleware(selectStrategy()));
app.use("/api/system", systemRouter);

// 자동 재개 설정(보호) — 한도가 풀리면 이어 가기의 켜기·기본 문장.
app.use("/api/auto-resume", createAuthMiddleware(selectStrategy()));
app.use("/api/auto-resume", autoResumeRouter);

// 쉬는 세션 잠재우기 대기 시간(보호) — 고를 수 있는 값은 서버가 정한다.
app.use("/api/idle-sleep", createAuthMiddleware(selectStrategy()));
app.use("/api/idle-sleep", idleSleepRouter);

// 세션 제목 자동 요약 스위치(보호).
app.use("/api/title-summary", createAuthMiddleware(selectStrategy()));
app.use("/api/title-summary", titleSummaryRouter);

// UI 언어 통지(보호) — 서버 전역 로케일 설정(LLM 프롬프트·푸시 알림 언어).
app.use("/api/locale", createAuthMiddleware(selectStrategy()));
app.use("/api/locale", localeRouter);

// API 404는 항상 JSON(SPA fallback이 HTML로 가로채는 것 방지)
app.use("/api/{*splat}", (_req, res) => {
  res.status(404).json({ error: st("routes.common.apiNotFound") });
});

// ── 빌드된 프론트(단일포트 선택 장착). 없거나 꺼져 있으면 내부 skip ──
staticAddon.mount(app);

// ── 에러 핸들러(반드시 맨 끝) ──
app.use(errorHandler);

// 크래시로 정리되지 못한 임시 첨부 파일 청소(D3) — 살아있는 세션이 아직 없는 지금이 유일하게 안전한 시점.
purgeOrphanAttachments();
// 같은 이유로, 각 provider가 강제 종료로 남긴 임시 자원도 치운다(예: 배경 작업의 임시 설정 폴더 — 복제된 인증 파일이 있다).
for (const p of listProviders()) {
  try { p.services.cleanupAtBoot?.(); } catch (e) { void reportError(e, { component: "server", operation: "provider.boot_cleanup" }); }
}
// 세션이 살아날 때마다 알림 판정부를 붙인다. 본체는 웹 푸시·데스크톱 출구를 모른다.
const notifyOut = (intent: NotifyIntent) => {
  deliverWebPush(intent);
  emitDesktopNotify(intent);
};
sessionManager.setOnLive((session) => attachNotify(session, notifyOut));
sessionManager.setNotifyOut(notifyOut); // 자동 재개 포기·전송 실패 알림

// 세션 목록 복원 수는 boot에서 채운다. 일기 정본을 연 뒤에만 세고, 그 전에 파일을 읽지 않는다.
let restored = 0;

// HTTP로 loopback 바인드. HTTPS 종단은 tailscale serve가 담당(tailnet HTTPS → 127.0.0.1:port 포워딩).
// 인증서 발급·자동갱신 일체를 Tailscale에 위임 → 앱은 평문 HTTP만 서빙(cert 파일/핫리로드 불필요).
updateInstaller.onExit((code) => void shutdown(code));

const onListen = () => {
  updateInstaller.markHealthy();
  console.log(`[aether] 백엔드 기동 → http://${config.host}:${config.port} (HTTPS 종단=tailscale serve)`);
  if (restored) console.log(`[aether] 세션 ${restored}개 복원 — message 시 resume`);
  console.log(`[aether] 작업 폴더 범위 제한 없음, 기본 폴더 ${config.projectRoot}`);
  if (config.authMode === "tailscale" && !resolveTailscaleCli()) {
    console.warn("[aether] 경고: 인증이 tailscale인데 tailscale 실행 파일을 찾지 못했습니다. 모든 요청이 거절됩니다. AETHER_TAILSCALE_CLI로 경로를 지정하세요");
  }
  // 쉬는 세션을 잠재운다. 대기 시간은 훑을 때마다 설정에서 읽는다.
  setInterval(() => {
    sessionManager.sweepIdle(Date.now()).catch((e) => void reportError(e, { component: "session", operation: "session.sleep.sweep" }));
  }, 60_000).unref();
  console.log(`[aether] 기본 모델: ${listProviders().map((e) => `${e.id}=${e.defaultModel ?? "계정 기본"}`).join(", ")} · 데이터: ${config.dataDir}`);
  console.log(
    `[aether] 플래그: auth=${config.authMode} helmet=${config.helmet} ` +
      `compression=${config.compression} static=${config.serveStatic} partial=${config.includePartialMessages}`,
  );
};

// listen 실패(예: 재시작 직후 포트 미해제 EADDRINUSE)는 치명 — uncaughtException으로 삼켜 '살아있지만 리스닝 안 함'
// 좀비가 되면 KeepAlive도 재시작 안 함. 명시적으로 종료해 launchd가 깨끗이 다시 띄우게 한다.
const onListenError = (e: Error) => {
  console.error(`[aether] listen 실패(치명, 프로세스 종료 → 재시작 유도): ${String(e?.message ?? e)}`);
  void reportError(e, { component: "process", operation: "server.listen", severity: "fatal" }).finally(() => shutdown(1));
};

async function boot() {
  // 같은 DB를 쓰는 서버가 이미 있으면 아무것도 쓰지 않고 끝낸다. 부팅 복원이 그 서버의 세션 일기에 끼어들기 때문이다.
  try {
    const { acquireServerLock } = await import("./db/serverLock");
    await acquireServerLock(config.dbPath);
    staticAddon.prepare(); // 잠금을 잡은 서버만 화면 빌드를 확인·재생성한다
  } catch (err) {
    console.error("[aether] DB 잠금을 잡지 못해 종료한다:", err instanceof Error ? err.message : err);
    void reportError(err, { component: "server", operation: "server.lock", severity: "fatal" }).finally(() => shutdown(1));
    return;
  }
  // 예약된 DB 복원은 아무도 DB를 쓰기 전에, 세션 일기를 열기 전에 적용한다.
  const { applyPendingRestore } = await import("./db/restore");
  await applyPendingRestore({ dbPath: config.dbPath, backupDir: config.backupDir });
  try {
    const { openSessionDiary, loadSessionDiaries } = await import("./db/sessionDiary");
    const { listDiarySources } = await import("./sessions/persistence");
    await openSessionDiary();
    await loadSessionDiaries(listDiarySources());
    // 일기 표가 열린 뒤에만 글자 색인을 연다. 실패해도 검색 파일로 되돌리지 않고, 프로세스를 끄지 않는다.
    let blockSessionLetter: () => void = () => undefined;
    try {
      const letter = await import("./db/sessionLetter");
      blockSessionLetter = letter.blockSessionLetter;
      const { rebuildSessionLetters } = await import("./search/rebuildLetter");
      await letter.openSessionLetter();
      await rebuildSessionLetters();
    } catch (err) {
      void reportError(err, { component: "search", operation: "search.initialize" });
      blockSessionLetter();
      const msg = err instanceof Error ? err.message : "unknown";
      console.error("[aether] 세션 글자 색인을 열지 못했다", msg);
    }
    restored = sessionManager.restoreFromDisk();
  } catch (err) {
    void reportError(err, { component: "server", operation: "session.diary.open" }); console.error("[aether] 세션 일기를 데이터베이스로 열지 못했다. 파일로 되돌리지 않는다.", err);
    configureCanonical({ diary: "blocked" });
    try {
      restored = sessionManager.restoreFromDisk();
    } catch (listErr) {
      void reportError(listErr, { component: "server", operation: "session.list.restore" }); console.error("[aether] 세션 목록 복원 실패:", listErr);
      restored = 0;
    }
  }
  app.listen(config.port, config.host, onListen).on("error", onListenError);
  (await import("./update/check")).updateChecker.start();
}

void boot();
