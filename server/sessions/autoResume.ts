/**
 * 한도가 풀리면 이어 가기 — 순수 판별과 설정.
 *
 * 공통 계층은 중립 사건 셋만 본다: 한도 막힘 알림(provider_notice rate_limit blocked), 턴 종료(turn_completed),
 * 사람이 보낸 글(user_msg). provider 이름·원본 모양은 모른다.
 */
import fs from "node:fs";
import path from "node:path";
import { reportError } from "../observability/report";
import { config } from "../config";
import { st } from "../i18n";
import { isBlockedRateLimit, resetsAtMs } from "../notify/worthNotifying";
import type { AetherEvent } from "../types";
import type { AgentEvent } from "../../shared/agentEvent";

export const AUTO_RESUME_MAX_ATTEMPTS = 3;
/** 풀리는 시각을 모를 때의 시도 간격(n번째 시도 앞). */
export const AUTO_RESUME_INTERVALS_MS = [30, 60, 120].map((m) => m * 60_000);
/** 풀리는 시각 뒤에 더하는 여유. */
export const AUTO_RESUME_MARGIN_MS = 60_000;
export const AUTO_RESUME_TEXT_MAX = 2000;

/**
 * 다음 시도 시각(ms). 풀리는 시각이 지금보다 뒤면 그 시각 + 여유, 아니면 지금 + 간격[attempts].
 * resetsAt은 초든 ms든 받는다.
 */
export function nextAttemptAt(attempts: number, resetsAt: number | undefined, now = Date.now()): number {
  if (resetsAt) {
    const reset = resetsAtMs(resetsAt);
    if (reset > now) return reset + AUTO_RESUME_MARGIN_MS;
  }
  return now + AUTO_RESUME_INTERVALS_MS[Math.min(attempts, AUTO_RESUME_INTERVALS_MS.length - 1)];
}

/** 세션마다 붙는 "막혀서 멈춘 턴" 추적 상태. */
export type AutoResumeTrack = {
  turnOpen: boolean;
  /** 이번 턴에 본 한도 막힘. until은 ms. */
  blocked?: { until?: number };
  /** 턴 밖에서 본 한도 막힘. 입력 없이 스스로 열린 턴은 시작을 알기 전에 막힘이 먼저 올 수 있다. */
  idleBlocked?: { until?: number };
  /** 막혀서 끝난 뒤 아직 새 입력이 없다. 이때의 성공 턴은 막힌 일을 이어 간 것이 아니다. */
  awaitingInput?: boolean;
  /** 직전 턴이 실패로 끝났는지. 막힘 알림이 실패보다 늦게 오는 경우를 위한 것. */
  lastEnd?: "failed" | "other";
};

export type AutoResumeVerdict = { type: "blocked"; until?: number } | { type: "settled" };

/**
 * 사건 하나를 보고 "막혀서 멈춘 턴이 끝났다"/"턴이 정상으로 끝났다"를 판별한다. 한 원본 사건 안의 여러 중립 사건은 배열 순서대로 본다.
 * 턴 밖에서 온 막힘은 그 자리에서 아무것도 돌려주지 않고, 다음 턴이 실패하면 막힘으로 판정한다.
 */
export function trackAutoResume(state: AutoResumeTrack, ev: AetherEvent, agentEvents: readonly AgentEvent[]): AutoResumeVerdict | undefined {
  if (ev.kind === "user_msg") {
    state.turnOpen = true;
    state.blocked = undefined;
    state.lastEnd = undefined;
    state.idleBlocked = undefined;
    state.awaitingInput = false;
    return undefined;
  }
  let verdict: AutoResumeVerdict | undefined;
  for (const a of agentEvents) {
    if (isBlockedRateLimit(a)) {
      const until = a.resetsAt ? resetsAtMs(a.resetsAt) : undefined;
      if (state.turnOpen) {
        state.blocked = { until: until ?? state.blocked?.until };
      } else if (state.lastEnd === "failed") {
        verdict = { type: "blocked", until };
        state.lastEnd = "other";
        state.awaitingInput = true;
      } else {
        state.idleBlocked = { until: until ?? state.idleBlocked?.until };
      }
    } else if (a.type === "turn_completed") {
      if (a.status === "failed") {
        const seen = state.blocked ?? state.idleBlocked;
        if (seen) {
          verdict = { type: "blocked", until: seen.until };
          state.lastEnd = "other";
          state.awaitingInput = true;
        } else {
          state.lastEnd = "failed";
        }
      } else {
        if (a.status !== "ok" || !state.awaitingInput) verdict = { type: "settled" };
        state.lastEnd = "other";
      }
      state.turnOpen = false;
      state.blocked = undefined;
      state.idleBlocked = undefined;
    }
  }
  return verdict;
}

// ── 설정(켜기·기본 문장) — 서버 전역 하나. 로케일 파일과 같은 방식으로 데이터 폴더에 둔다. ──

export type AutoResumeSettings = { enabled: boolean; text: string; defaultText: string };

const settingsFile = () => path.join(config.dataDir, "auto-resume.json");

/** 읽는 시점에 기본 문장을 채운다. 파일이 없거나 깨졌으면 켜짐 + 기본 문장. */
export function readAutoResumeSettings(): AutoResumeSettings {
  const defaultText = st("autoResume.defaultText");
  let enabled = true;
  let text = "";
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { enabled?: unknown; text?: unknown };
    if (typeof raw.enabled === "boolean") enabled = raw.enabled;
    if (typeof raw.text === "string") text = raw.text.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") void reportError(e, { component: "session", operation: "auto_resume.settings.load" });
  }
  return { enabled, text: text || defaultText, defaultText };
}

/** 부분 갱신. text가 빈 문자열이면 기본 문장으로 되돌린다(저장값을 비운다). */
export function writeAutoResumeSettings(patch: { enabled?: boolean; text?: string }): AutoResumeSettings {
  const cur = readAutoResumeSettings();
  const stored = {
    enabled: patch.enabled ?? cur.enabled,
    text: patch.text !== undefined ? patch.text.trim() : cur.text === cur.defaultText ? "" : cur.text,
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(stored), "utf8");
  return readAutoResumeSettings();
}

// ── 서버 재시작으로 끊긴 턴 표시 — 종료 직전에 쓰고 다음 부팅이 읽으면서 지운다. ──

const restartCutFile = () => path.join(config.dataDir, "restart-cut.json");

export function writeRestartCut(ids: string[]): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(restartCutFile(), JSON.stringify({ ids, at: Date.now() }), "utf8");
}

/** 표시 파일을 읽고 지운다. 없거나 깨졌으면 빈 집합. */
export function takeRestartCut(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(restartCutFile(), "utf8")) as { ids?: unknown };
    fs.rmSync(restartCutFile(), { force: true });
    return new Set(Array.isArray(raw.ids) ? raw.ids.filter((x): x is string => typeof x === "string") : []);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      void reportError(e, { component: "session", operation: "auto_resume.restart_cut.load" });
      fs.rmSync(restartCutFile(), { force: true });
    }
    return new Set();
  }
}
