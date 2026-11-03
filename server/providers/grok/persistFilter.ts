import { FailureTracker } from "../failureTracking";
/**
 * Grok ACP 이벤트의 디스크 축소 (Phase 10c · D2.3).
 *
 * 라이브는 받은 그대로, 디스크에는 자른·가린 것만. 청크는 codec이 라이브 전용으로 걸러 여기까지 안 온다.
 */
import { config } from "../../config";
import { st } from "../../i18n";
import { isControlEvent, type AetherEvent } from "../../types";
import { clampString } from "../../sessions/persistFilter";
import { commandTokens, isSecretPath } from "../../sessions/secretPaths";
import type { ProviderPersistFilter } from "../../sessions/codec/types";

const jsonFailures = new FailureTracker();

const redactedResult = () => st("notice.persist.redactedResult");

function clampJson(value: unknown, max: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return clampString(value, max);
  let text: string;
  try {
    text = JSON.stringify(value);
    jsonFailures.clear("session.json.encode");
  } catch (error) {
    jsonFailures.report(error, { component: "session", operation: "session.json.encode", severity: "warning" });
    return value;
  }
  return text.length > max ? clampString(text, max) : value;
}

function looksSecretPath(v: unknown): boolean {
  return typeof v === "string" && isSecretPath(v);
}

function shrinkUpdate(update: Record<string, unknown>, max: number): Record<string, unknown> {
  const next: Record<string, unknown> = { ...update };
  let changed = false;
  for (const key of ["title", "kind", "status"] as const) {
    if (typeof next[key] !== "string") continue;
    const clamped = clampString(next[key] as string, max);
    if (clamped !== next[key]) {
      next[key] = clamped;
      changed = true;
    }
  }
  if (next.rawInput && typeof next.rawInput === "object") {
    const raw = { ...(next.rawInput as Record<string, unknown>) };
    const path = raw.file_path ?? raw.path ?? raw.command;
    if (looksSecretPath(path) || (typeof raw.command === "string" && commandTokens(String(raw.command)).some((t) => isSecretPath(t)))) {
      if ("content" in raw) raw.content = redactedResult();
      if ("new_string" in raw) raw.new_string = redactedResult();
      if ("old_string" in raw) raw.old_string = redactedResult();
      if ("blob" in raw) raw.blob = redactedResult();
      if ("data" in raw) raw.data = redactedResult();
      changed = true;
    }
    if (typeof raw.command === "string") {
      const cmd = clampString(raw.command, max);
      if (cmd !== raw.command) {
        raw.command = cmd;
        changed = true;
      }
    }
    for (const k of Object.keys(raw)) {
      if (typeof raw[k] === "string" && (k === "content" || k === "blob" || k === "data" || k === "diff")) {
        const v = looksSecretPath(raw.file_path ?? raw.path) ? redactedResult() : clampString(raw[k] as string, max);
        if (v !== raw[k]) {
          raw[k] = v;
          changed = true;
        }
      }
    }
    next.rawInput = raw;
  }
  if ("content" in next) {
    const c = clampJson(next.content, max);
    if (c !== next.content) {
      next.content = c;
      changed = true;
    }
  }
  if ("rawOutput" in next) {
    const o = clampJson(next.rawOutput, max);
    if (o !== next.rawOutput) {
      next.rawOutput = o;
      changed = true;
    }
  }
  return changed ? next : update;
}

export class GrokPersistFilter implements ProviderPersistFilter {
  restore(): void {
    /* Grok는 호출과 결과가 같은 항목 계열로 오거나, 시크릿 추적이 rawInput 경로로 한 이벤트 안에서 끝난다. */
  }

  apply(ev: AetherEvent): AetherEvent | null {
    if (isControlEvent(ev, "permission_request")) {
      const input = ev.req.input ?? {};
      const next = { ...input };
      let changed = false;
      if (typeof next.command === "string") {
        const cmd = clampString(next.command, config.persistMaxFieldChars);
        if (cmd !== next.command) {
          next.command = cmd;
          changed = true;
        }
      }
      const path = next.path ?? next.file_path;
      if (looksSecretPath(path)) {
        for (const k of ["content", "new_string", "old_string", "diff"]) {
          if (k in next) {
            next[k] = redactedResult();
            changed = true;
          }
        }
      }
      return changed ? { ...ev, req: { ...ev.req, input: next } } : ev;
    }
    if (ev.kind !== "grok") return ev;
    const msg = ev.msg as { method?: unknown; params?: unknown };
    if (typeof msg?.method === "string" && (msg.method.startsWith("_x.ai/") || msg.method.startsWith("x.ai/"))) return null;
    if (msg?.method !== "session/update") return ev;
    const params = msg.params as { update?: Record<string, unknown> } | undefined;
    const update = params?.update;
    if (!update || typeof update !== "object") return ev;
    const shrunk = shrinkUpdate(update, config.persistMaxFieldChars);
    if (shrunk === update) return ev;
    return { ...ev, msg: { ...msg, params: { ...params, update: shrunk } } } as AetherEvent;
  }
}
