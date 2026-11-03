/** 시험·실험 파일을 데이터 폴더 지정 없이 직접 돌려도 운영 server/data가 아닌 임시 폴더를 쓴다. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..");
const live = path.join(server, "data");

if (process.env.ISOLATION_CHILD) {
  const { config } = await import("../config");
  console.log(JSON.stringify({ dataDir: config.dataDir, dbPath: config.dbPath, env: process.env.AETHER_DATA_DIR }));
  process.exit(0);
}

function configFrom(file: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ISOLATION_CHILD: "1" };
  delete env.AETHER_DATA_DIR;
  const r = spawnSync("npx", ["tsx", file], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

function assertIsolated(where: string, got: { dataDir: string; dbPath: string; env: string }) {
  assert.ok(got.dataDir.startsWith(os.tmpdir()), `${where}: ${got.dataDir}`);
  assert.ok(!got.dbPath.startsWith(live + path.sep), `${where}: ${got.dbPath}`);
  assert.equal(got.env, got.dataDir, where); // 띄우는 서버도 같은 폴더를 물려받는다.
}

assertIsolated("test/", configFrom(fileURLToPath(import.meta.url)));

console.log("✅ test_data_isolation 통과");
