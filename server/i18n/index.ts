import { reportError } from "../observability/report";
// 서버 i18n 엔진 — 단일사용자라 서버 전역 로케일 1개(프론트가 /api/locale로 통지). 디스크 영속으로 재시작 생존.
//  · 짧은 UI/notice 문자열 → 중앙 사전(st).
//  · 큰 LLM 프롬프트 블록 → 각 모듈에 { ko, en }로 두고 pick(...)으로 선택(중앙 사전 비대화 방지).
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { Dict, Entry, Locale } from "./types";
import { notify } from "./notify";
import { notice } from "./notice";
import { routes } from "./routes";

export type { Locale, Entry, Dict } from "./types";
export const LOCALES: Locale[] = ["ko", "en"];

const LOCALE_FILE = path.join(config.dataDir, "locale");

function loadLocale(): Locale {
  try {
    const v = fs.readFileSync(LOCALE_FILE, "utf8").trim();
    if (v === "ko" || v === "en") return v;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "i18n", operation: "i18n.locale.load" });
    /* 최초 실행 등 — 파일 없음 */
  }
  return "ko";
}

let currentLocale: Locale = loadLocale();

export function getLocale(): Locale {
  return currentLocale;
}

/** 로케일 변경 + 디스크 영속(재시작 후에도 푸시 알림·프롬프트 언어 유지). 프론트 /api/locale에서 호출. */
export function setLocale(locale: Locale): void {
  if (locale !== "ko" && locale !== "en") return;
  currentLocale = locale;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(LOCALE_FILE, locale, "utf8");
  } catch (e) {
    void reportError(e, { component: "i18n", operation: "i18n.locale.save" });
    console.error("[aether] 로케일 영속 실패:", e);
  }
}

/** { ko, en } 쌍에서 현재 로케일 값을 선택 — 큰 LLM 프롬프트 블록용 헬퍼. */
export function pick<T>(byLocale: Record<Locale, T>): T {
  return byLocale[currentLocale];
}

// 중앙 사전(짧은 문자열) — 네임스페이스 병합.
const dict: Dict = {
  ...notify,
  ...notice,
  ...routes,
};

/** 현재 서버 로케일로 번역 + {param} 치환. 키 미존재 시 키 자체 반환. */
export function st(key: string, params?: Record<string, string | number>): string {
  const entry: Entry | undefined = dict[key];
  let s = entry ? entry[currentLocale] : undefined;
  if (s === undefined) {
    void reportError(new Error("미등록 번역 키"), { component: "i18n", operation: "i18n.key.missing", severity: "warning", context: { key } });
    console.warn(`[aether][i18n] 미등록 키: ${key}`);
    return key;
  }
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
