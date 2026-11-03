/**
 * 설치본 푸시 키 만들기 시험. 임시 폴더만 쓴다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { ensurePushKeys } from "../setup/pushKeys";

let failed = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) failed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-pushkeys-"));
const file = path.join(dir, ".env");
try {
  fs.writeFileSync(file, "AETHER_JWT_SECRET=keep-me\r\nAETHER_VAPID_PUBLIC=half-left\r\n");
  const env: NodeJS.ProcessEnv = {};
  ensurePushKeys(file, env);
  const saved = fs.readFileSync(file, "utf8");
  ok("공개키와 개인키를 환경에 넣는다", !!env.AETHER_VAPID_PUBLIC && !!env.AETHER_VAPID_PRIVATE);
  ok("같은 값을 파일에 저장한다", saved.includes(`AETHER_VAPID_PUBLIC=${env.AETHER_VAPID_PUBLIC}\n`) && saved.includes(`AETHER_VAPID_PRIVATE=${env.AETHER_VAPID_PRIVATE}\n`));
  ok("다른 줄은 그대로 둔다", saved.includes("AETHER_JWT_SECRET=keep-me"));
  ok("반쪽만 남은 옛 키를 지운다", !saved.includes("half-left"));
  if (process.platform !== "win32") ok("파일 권한은 본인만 읽기", (fs.statSync(file).mode & 0o777) === 0o600);

  const before = saved;
  const loaded: NodeJS.ProcessEnv = parseEnv(saved);
  ensurePushKeys(file, loaded);
  ok("다시 시작해도 키가 바뀌지 않는다", fs.readFileSync(file, "utf8") === before && loaded.AETHER_VAPID_PUBLIC === env.AETHER_VAPID_PUBLIC);

  const blocked: NodeJS.ProcessEnv = {};
  let threw = false;
  try { ensurePushKeys(path.join(dir, "missing", "dir", ".env"), blocked); } catch { threw = true; }
  ok("저장에 실패하면 이번 실행에서도 키를 쓰지 않는다", threw && !blocked.AETHER_VAPID_PUBLIC);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `실패 ${failed}건` : "모두 통과");
process.exit(failed ? 1 : 0);
