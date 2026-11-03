/**
 * 설치본의 푸시 알림 키. 키가 없으면 만들어 .env에 저장한다. 새 설치와 이미 설치한 곳이 같은 길을 지난다.
 * 키가 바뀌면 기존 구독이 모두 끊기므로, 저장에 실패하면 이번 실행에서도 쓰지 않는다.
 */
import fs from "node:fs";
import webpush from "web-push";
import { writeAtomic } from "./save";

export function ensurePushKeys(envFile: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.AETHER_VAPID_PUBLIC?.trim() && env.AETHER_VAPID_PRIVATE?.trim()) return;
  const keys = webpush.generateVAPIDKeys();
  let kept = "";
  try { kept = fs.readFileSync(envFile, "utf8"); } catch { /* 처음 만든다 */ }
  kept = kept.split(/\r?\n/).filter((l) => l.trim() && !/^\s*AETHER_VAPID_(PUBLIC|PRIVATE)\s*=/.test(l)).map((l) => `${l}\n`).join("");
  writeAtomic(envFile, `${kept}AETHER_VAPID_PUBLIC=${keys.publicKey}\nAETHER_VAPID_PRIVATE=${keys.privateKey}\n`, 0o600);
  env.AETHER_VAPID_PUBLIC = keys.publicKey;
  env.AETHER_VAPID_PRIVATE = keys.privateKey;
}
