/**
 * 실행 중에도 안전한 SQLite 백업. WAL에 있는 최근 기록까지 담는다(파일 복사가 아니라 SQLite 백업 API).
 * 사용: npm run db:backup [-- --dir <폴더>]
 *   원본은 서버 설정의 DB 파일이다. 기본 출력은 config.backupDir이고 수동 백업을 backupKeep개만 남긴다.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { createBackup } from "./backups";
import { restoreStatus } from "./restore";
import { openDatabaseAt } from "./sqlite";

async function main(): Promise<void> {
  const at = process.argv.indexOf("--dir");
  const dir = at >= 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : config.backupDir;
  if (!fs.existsSync(config.dbPath)) throw new Error(`DB 파일이 없다: ${config.dbPath}`);
  const item = await createBackup(openDatabaseAt(config.dbPath), { dir, kind: "manual", keep: config.backupKeep, protectId: restoreStatus(config.dbPath).pending?.id });
  console.log(`[backup] ${path.join(dir, item.id)} (${item.sizeBytes}바이트)`);
}

main().catch((err) => {
  console.error("[backup] 실패:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
