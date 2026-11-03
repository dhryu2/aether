/**
 * 시험용 임시 SQLite 파일. 운영 파일(server/data/aether.sqlite)에는 닿지 않는다.
 * 만든 시험이 끝나면 dispose로 연결을 닫고 폴더를 지운다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetDatabaseForTest, configureDatabase } from "../../db/sqlite";

export type TempDatabase = { dir: string; file: string; dispose(): void };

export function useTempDatabase(label: string): TempDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aether-db-${label}-`));
  const file = path.join(dir, "aether.sqlite");
  configureDatabase({ path: file });
  return {
    dir,
    file,
    dispose() {
      __resetDatabaseForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 임시 SQLite를 만들고 세션 일기를 연다. 세션을 만드는 시험은 이 일기가 있어야 저장된다. */
export async function useTempDiary(label: string): Promise<TempDatabase> {
  const tempDb = useTempDatabase(label);
  await (await import("../../db/sessionDiary")).openSessionDiary();
  return tempDb;
}
