/**
 * 쉬는 세션 잠재우기 대기 시간 — 서버 전역 하나. 검색 요약 스위치와 같이 데이터 폴더의 파일에 둔다.
 * 저장값이 있으면 config.idleSleepMs보다 우선한다. 잠재우기 훑기가 매번 읽으므로 재시작 없이 다음 훑기부터 적용된다.
 */
import fs from "node:fs";
import path from "node:path";
import { reportError } from "../observability/report";
import { config } from "../config";

/** 고를 수 있는 값(분). 0은 끄기다. */
export const IDLE_SLEEP_CHOICES_MIN = [0, 15, 30, 60] as const;

const settingFile = () => path.join(config.dataDir, "idle-sleep.json");

/** 대기 시간(ms). 0이면 끈다. 파일이 없거나 깨졌거나 허용 밖 값이면 config 값. */
export function readIdleSleepMs(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(settingFile(), "utf8")) as { minutes?: unknown };
    if (typeof raw.minutes === "number" && (IDLE_SLEEP_CHOICES_MIN as readonly number[]).includes(raw.minutes)) return raw.minutes * 60_000;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "session", operation: "session.idle_sleep_setting.load" });
  }
  return config.idleSleepMs;
}

/** 허용된 분 값만 받는다(호출부가 먼저 거른다). 저장 뒤 적용되는 값을 돌려준다. */
export function writeIdleSleepMinutes(minutes: number): number {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${settingFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ minutes }), "utf8");
  fs.renameSync(tmp, settingFile());
  return readIdleSleepMs();
}
