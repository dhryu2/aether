/**
 * 검색 결과 요약 켜기·끄기 — 서버 전역 하나. 자동 재개 설정과 같이 데이터 폴더의 파일에 둔다.
 * 저장값이 있으면 config.searchSummarize보다 우선한다. 읽는 쪽이 매번 읽으므로 재시작 없이 다음 검색부터 적용된다.
 */
import fs from "node:fs";
import path from "node:path";
import { reportError } from "../observability/report";
import { config } from "../config";

const settingFile = () => path.join(config.dataDir, "search-summary.json");

/** 파일이 없거나 깨졌으면 config 값. */
export function readSearchSummarize(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(settingFile(), "utf8")) as { enabled?: unknown };
    if (typeof raw.enabled === "boolean") return raw.enabled;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "search", operation: "search.summary_setting.load" });
  }
  return config.searchSummarize;
}

export function writeSearchSummarize(enabled: boolean): boolean {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${settingFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled }), "utf8");
  fs.renameSync(tmp, settingFile());
  return readSearchSummarize();
}
