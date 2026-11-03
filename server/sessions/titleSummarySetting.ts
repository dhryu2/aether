/**
 * 세션 제목 자동 요약 켜기·끄기 — 서버 전역 하나. 검색 요약 설정과 같은 방식으로 데이터 폴더의 파일에 둔다.
 * 파일이 없거나 깨졌으면 켜짐. 새 세션 첫 말마다 읽으므로 재시작 없이 다음 세션부터 적용된다.
 */
import fs from "node:fs";
import path from "node:path";
import { reportError } from "../observability/report";
import { config } from "../config";

const settingFile = () => path.join(config.dataDir, "title-summary.json");

export function readTitleSummarize(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(settingFile(), "utf8")) as { enabled?: unknown };
    if (typeof raw.enabled === "boolean") return raw.enabled;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "sessions", operation: "title_summary_setting.load" });
  }
  return true;
}

export function writeTitleSummarize(enabled: boolean): boolean {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${settingFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled }), "utf8");
  fs.renameSync(tmp, settingFile());
  return readTitleSummarize();
}
