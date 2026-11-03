/**
 * 시스템 제어 라우트(인증 게이트 뒤 mount). 운영자 전용 — 가장 민감(프로세스 생명주기).
 *   GET  /api/system/info      서버 정보(읽기 전용)
 *   GET  /api/system/update    새 버전 확인 결과와 앱 안 업데이트 진행 상태(updateUrl이 비면 enabled=false)
 *   POST /api/system/update/check    지금 새 버전 확인
 *   POST /api/system/update/install  앱 안 업데이트 시작(설치할 수 없거나 새 버전이 없으면 400, 진행 중이면 409)
 *   POST /api/system/update/cancel   설치 시작 전까지 취소
 *   GET  /api/system/remote-access  폰에서 쓰기(tailscale serve) 상태
 *   POST /api/system/remote-access  폰에서 쓰기 켜기
 *   DELETE /api/system/remote-access  폰에서 쓰기 끄기, 허용 대기 취소
 *   GET  /api/system/logs      서버 로그 마지막 N줄
 *   GET  /api/system/backups   DB 백업 목록과 복원 예약·지난 결과
 *   POST /api/system/backups   DB 수동 백업(이미 진행 중이면 409)
 *   POST /api/system/backups/restore    {id} 다음 서버 시작 때 그 백업으로 DB 교체 예약
 *   DELETE /api/system/backups/restore  복원 예약 취소
 *   POST /api/system/restart   백엔드 프로세스 재시작
 *
 * 재시작 원리: launchd plist의 KeepAlive(SuccessfulExit=false)는 '0이 아닌 종료'를 재기동 신호로 본다.
 * index.ts의 onListenError와 동일 패턴 — 정상종료(exit 0)는 죽은 채 두고, exit(1)만 재기동을 유도한다.
 * ThrottleInterval=10 때문에 재기동까지 최대 ~10초 지연될 수 있다(프론트는 SSE 백오프로 자동 재연결).
 */
import { Router, type Request, type Response } from "express";
import pkg from "../package.json" with { type: "json" };
import { config } from "../config";
import type { BackupListResponse, ServerInfoResponse, ServerLogLevel, ServerLogResponse, UpdateStatusResponse } from "../../shared/http";
import { BACKUP_NAME, BackupBusyError, backupRunning, createBackup, listBackups } from "../db/backups";
import { cancelRestore, RestoreNotFoundError, restoreStatus, scheduleRestore } from "../db/restore";
import { database } from "../db/sqlite";
import { disableRemoteAccess, enableRemoteAccess, remoteAccessStatus } from "../remote/tailscaleServe";
import { reportError } from "../observability/report";
import { readServerLog, serverLogDir } from "../observability/serverLog";
import { st } from "../i18n";
import { termsUrl } from "../../shared/terms";
import { updateChecker } from "../update/check";
import { updateInstaller } from "../update/install";

export const systemRouter = Router();

function updateStatus(): UpdateStatusResponse {
  return { ...updateChecker.status(), ...updateInstaller.status() };
}

systemRouter.get("/info", (_req: Request, res: Response) => {
  // 여섯 칸을 손으로 적는다. config나 process.env를 펼치면 비밀이 새어 나갈 수 있다.
  const body: ServerInfoResponse = {
    version: pkg.version,
    dataDir: config.dataDir,
    port: config.port,
    authMode: config.authMode,
    projectRoot: config.projectRoot,
    termsUrl: termsUrl((pkg as { aetherUpdateUrl?: string }).aetherUpdateUrl),
  };
  res.json(body);
});

systemRouter.get("/update", (_req: Request, res: Response) => {
  res.json(updateStatus());
});

systemRouter.post("/update/check", async (_req: Request, res: Response) => {
  await updateChecker.checkNow();
  res.json(updateStatus());
});

systemRouter.post("/update/install", (_req: Request, res: Response) => {
  const s = updateStatus();
  if (!s.canInstall || !s.available) return void res.status(400).json(s);
  if (!updateInstaller.start()) return void res.status(409).json(updateStatus());
  res.status(202).json(updateStatus());
});

systemRouter.post("/update/cancel", (_req: Request, res: Response) => {
  updateInstaller.cancel();
  res.json(updateStatus());
});

systemRouter.get("/remote-access", async (_req: Request, res: Response) => {
  res.json(await remoteAccessStatus());
});

systemRouter.post("/remote-access", async (_req: Request, res: Response) => {
  res.json(await enableRemoteAccess());
});

systemRouter.delete("/remote-access", async (_req: Request, res: Response) => {
  res.json(await disableRemoteAccess());
});

systemRouter.get("/logs", (req: Request, res: Response) => {
  const rawLines = req.query.lines ?? "200";
  const level = req.query.level ?? "log";
  if (typeof rawLines !== "string" || !/^\d+$/.test(rawLines) || (level !== "log" && level !== "warn" && level !== "error")) {
    res.status(400).json({ error: st("routes.system.logQueryInvalid") });
    return;
  }
  const lines = Math.min(1000, Math.max(1, Number(rawLines)));
  const body: ServerLogResponse = { entries: readServerLog({ dir: serverLogDir(), lines, minLevel: level as ServerLogLevel }) };
  res.json(body);
});

function backupList(): BackupListResponse {
  return { items: listBackups(config.backupDir), running: backupRunning(), keep: config.backupKeep, ...restoreStatus(config.dbPath) };
}

systemRouter.get("/backups", (_req: Request, res: Response) => {
  res.json(backupList());
});

systemRouter.post("/backups", async (_req: Request, res: Response) => {
  try {
    // 서버 자신의 연결로 백업한다. 다른 연결을 쓰면 서버의 쓰기마다 백업이 다시 시작된다.
    const item = await createBackup(database(), {
      dir: config.backupDir,
      kind: "manual",
      keep: config.backupKeep,
      protectId: restoreStatus(config.dbPath).pending?.id,
    });
    res.status(201).json({ item });
  } catch (err) {
    if (err instanceof BackupBusyError) {
      res.status(409).json({ error: st("routes.system.backupBusy") });
      return;
    }
    void reportError(err, { component: "database", operation: "database.backup" });
    res.status(500).json({ error: st("routes.system.backupFailed") });
  }
});

systemRouter.post("/backups/restore", (req: Request, res: Response) => {
  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !BACKUP_NAME.test(id)) {
    res.status(400).json({ error: st("routes.system.backupIdInvalid") });
    return;
  }
  try {
    scheduleRestore(config.dbPath, config.backupDir, id);
  } catch (err) {
    if (err instanceof RestoreNotFoundError) {
      res.status(404).json({ error: st("routes.system.backupNotFound") });
      return;
    }
    throw err;
  }
  res.json(backupList());
});

systemRouter.delete("/backups/restore", (_req: Request, res: Response) => {
  cancelRestore(config.dbPath);
  res.json(backupList());
});

systemRouter.post("/restart", (_req: Request, res: Response) => {
  console.log("[aether] UI 요청으로 백엔드 재시작 — process.exit(1) → launchd 재기동");
  res.json({ ok: true });
  // 응답이 완전히 flush된 뒤 종료(finish). 리버스 프록시(tailscale serve)까지 200이 전달되도록 보장.
  const bye = () => process.exit(1);
  res.on("finish", bye);
  setTimeout(bye, 1500); // finish 누락 대비 안전망
});
